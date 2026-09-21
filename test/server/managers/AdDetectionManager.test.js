const { expect } = require('chai')
const sinon = require('sinon')
const { Sequelize } = require('sequelize')
const Path = require('path')
const os = require('os')

const Database = require('../../../server/Database')
const fs = require('../../../server/libs/fsExtra')
const audioPrep = require('../../../server/utils/audioPrep')
const providers = require('../../../server/providers')
const SocketAuthority = require('../../../server/SocketAuthority')
const AdDetectionManager = require('../../../server/managers/AdDetectionManager')

describe('AdDetectionManager', () => {
  let metadataPath
  let audioFilePath
  let podcast
  let episode

  const transcript = {
    provider: 'stub',
    model: 'stub',
    language: 'en',
    duration: 3600,
    segments: [{ start: 0, end: 5, text: 'hello' }],
    createdAt: new Date().toISOString()
  }

  beforeEach(async () => {
    metadataPath = await fs.mkdtemp(Path.join(os.tmpdir(), 'abs-addetect-'))
    global.MetadataPath = metadataPath
    global.ServerSettings = {}

    audioFilePath = Path.join(metadataPath, 'episode.mp3')
    await fs.writeFile(audioFilePath, 'not really audio')

    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    Database.serverSettings = {
      adDetectionEnabled: true,
      adDetectionAutoRun: true,
      adDetectionMinConfidence: 0.5
    }

    podcast = await Database.podcastModel.create({ title: 'Test Podcast' })
    episode = await Database.podcastEpisodeModel.create({
      title: 'Test Episode',
      podcastId: podcast.id,
      audioFile: { duration: 3600, metadata: { path: audioFilePath, filename: 'episode.mp3' } },
      chapters: [],
      extraData: {}
    })

    sinon.stub(SocketAuthority, 'emitter')
    sinon.stub(audioPrep, 'prepareForTranscription').resolves({ wavPath: Path.join(metadataPath, 'x.wav'), cleanup: async () => {} })
    sinon.stub(audioPrep, 'detectSilences').resolves([])

    // Reset the singleton's queue between tests
    AdDetectionManager.queue = []
    AdDetectionManager.currentEpisodeId = null
    AdDetectionManager.cancelled = new Set()
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.close()
    await fs.remove(metadataPath)
  })

  /**
   * @param {Object[]} detected
   */
  function stubProviders(detected) {
    sinon.stub(providers, 'createTranscriptionProvider').returns({
      name: 'stub',
      validate: async () => {},
      transcribe: async () => transcript
    })
    sinon.stub(providers, 'createAdDetectionProvider').returns({
      name: 'stub',
      validate: async () => {},
      detect: async () => detected
    })
  }

  /**
   * Wait for the serial queue to drain.
   */
  async function waitForIdle(timeoutMs = 5000) {
    const start = Date.now()
    while ((AdDetectionManager.isProcessing || AdDetectionManager.queue.length) && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  describe('isEnabledForPodcast', () => {
    it('follows the server setting by default', () => {
      expect(AdDetectionManager.isEnabledForPodcast({ extraData: {} })).to.be.true
      Database.serverSettings.adDetectionEnabled = false
      expect(AdDetectionManager.isEnabledForPodcast({ extraData: {} })).to.be.false
    })

    it('honours a per-podcast opt out', () => {
      expect(AdDetectionManager.isEnabledForPodcast({ extraData: { adDetectionEnabled: false } })).to.be.false
    })

    it('honours a per-podcast opt in', () => {
      expect(AdDetectionManager.isEnabledForPodcast({ extraData: { adDetectionEnabled: true } })).to.be.true
    })
  })

  describe('queueEpisode', () => {
    it('refuses when ad detection is disabled', async () => {
      Database.serverSettings.adDetectionEnabled = false
      const result = await AdDetectionManager.queueEpisode(episode.id, 'li-1')
      expect(result.queued).to.be.false
    })

    it('refuses an unknown episode', async () => {
      const result = await AdDetectionManager.queueEpisode('e0000000-0000-4000-8000-000000000999', 'li-1')
      expect(result.queued).to.be.false
    })

    it('refuses to re-run a completed episode unless forced', async () => {
      stubProviders([])
      await episode.update({ extraData: { adDetectionStatus: 'complete' } })

      const result = await AdDetectionManager.queueEpisode(episode.id, 'li-1')
      expect(result.queued).to.be.false

      const forced = await AdDetectionManager.queueEpisode(episode.id, 'li-1', { force: true })
      expect(forced.queued).to.be.true
      await waitForIdle()
    })
  })

  describe('runJob', () => {
    it('persists detected segments and marks the episode complete', async () => {
      stubProviders([{ start: 100, end: 160, confidence: 0.9, label: 'midroll' }])

      await AdDetectionManager.queueEpisode(episode.id, 'li-1')
      await waitForIdle()

      const segments = await Database.mediaItemAdSegmentModel.getForMediaItem(episode.id)
      expect(segments).to.have.lengthOf(1)
      expect(segments[0].startTime).to.equal(100)

      await episode.reload()
      expect(episode.extraData.adDetectionStatus).to.equal('complete')
      expect(episode.extraData.adDetectionError).to.be.null
    })

    it('writes the transcript to disk and reuses it on a re-run', async () => {
      stubProviders([])
      const transcribe = sinon.spy()

      await AdDetectionManager.queueEpisode(episode.id, 'li-1')
      await waitForIdle()

      const transcriptPath = AdDetectionManager.getTranscriptPath(episode.id)
      expect(await fs.pathExists(transcriptPath)).to.be.true

      const stored = await AdDetectionManager.readTranscript(episode.id)
      expect(stored.segments).to.have.lengthOf(1)
    })

    it('marks the episode failed when the audio file is missing', async () => {
      stubProviders([])
      await fs.remove(audioFilePath)

      await AdDetectionManager.queueEpisode(episode.id, 'li-1')
      await waitForIdle()

      await episode.reload()
      expect(episode.extraData.adDetectionStatus).to.equal('failed')
      expect(episode.extraData.adDetectionError).to.be.a('string')
    })

    it('records the reason when a provider throws', async () => {
      sinon.stub(providers, 'createTranscriptionProvider').returns({
        name: 'stub',
        validate: async () => {
          throw new Error('whisper.cpp not found')
        },
        transcribe: async () => transcript
      })
      sinon.stub(providers, 'createAdDetectionProvider').returns({ name: 'stub', validate: async () => {}, detect: async () => [] })

      await AdDetectionManager.queueEpisode(episode.id, 'li-1')
      await waitForIdle()

      await episode.reload()
      expect(episode.extraData.adDetectionStatus).to.equal('failed')
      expect(episode.extraData.adDetectionError).to.include('whisper.cpp not found')
    })

    it('applies the confidence threshold from server settings', async () => {
      Database.serverSettings.adDetectionMinConfidence = 0.95
      stubProviders([{ start: 100, end: 160, confidence: 0.6, label: 'midroll' }])

      await AdDetectionManager.queueEpisode(episode.id, 'li-1')
      await waitForIdle()

      const segments = await Database.mediaItemAdSegmentModel.getForMediaItem(episode.id)
      expect(segments).to.be.empty
    })
  })

  describe('cleanupEpisode', () => {
    it('removes segments and the transcript', async () => {
      stubProviders([{ start: 100, end: 160, confidence: 0.9 }])
      await AdDetectionManager.queueEpisode(episode.id, 'li-1')
      await waitForIdle()

      await AdDetectionManager.cleanupEpisode(episode.id)

      expect(await Database.mediaItemAdSegmentModel.getForMediaItem(episode.id)).to.be.empty
      expect(await fs.pathExists(AdDetectionManager.getTranscriptPath(episode.id))).to.be.false
    })
  })
})
