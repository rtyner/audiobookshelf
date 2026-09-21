const Path = require('path')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')
const Database = require('../Database')
const SocketAuthority = require('../SocketAuthority')
const TaskManager = require('./TaskManager')
const audioPrep = require('../utils/audioPrep')
const adSegmentUtils = require('../utils/adSegmentUtils')
// Required as a module rather than destructured so the factories stay
// swappable (tests, and any future runtime provider override).
const providers = require('../providers')

/**
 * Orchestrates transcription + ad detection for podcast episodes.
 *
 * Jobs run one at a time. Transcription is CPU-bound and an unbounded queue
 * would starve playback transcoding on the same box, so concurrency is a
 * deliberate 1 with a plain FIFO queue.
 */

const STATUS = {
  QUEUED: 'queued',
  TRANSCRIBING: 'transcribing',
  DETECTING: 'detecting',
  COMPLETE: 'complete',
  FAILED: 'failed'
}

class AdDetectionManager {
  constructor() {
    /** @type {{episodeId: string, libraryItemId: string, force: boolean, retranscribe: boolean}[]} */
    this.queue = []
    /** @type {string|null} */
    this.currentEpisodeId = null
    this.cancelled = new Set()
  }

  get isProcessing() {
    return !!this.currentEpisodeId
  }

  get transcriptsDir() {
    return Path.join(global.MetadataPath, 'transcripts')
  }

  /**
   * @param {string} episodeId
   * @returns {string}
   */
  getTranscriptPath(episodeId) {
    return Path.join(this.transcriptsDir, `${episodeId}.json`)
  }

  /**
   * Whether ad detection should run for this podcast, honouring the
   * per-podcast override before the server default.
   *
   * @param {import('../models/Podcast')} podcast
   * @returns {boolean}
   */
  isEnabledForPodcast(podcast) {
    if (!Database.serverSettings?.adDetectionEnabled) return false
    const override = podcast?.extraData?.adDetectionEnabled
    if (override === true || override === false) return override
    return true
  }

  /**
   * Queue an episode. Safe to call repeatedly - duplicates are ignored.
   *
   * @param {string} episodeId
   * @param {string} libraryItemId
   * @param {Object} [options]
   * @param {boolean} [options.force] re-run even if it already completed
   * @param {boolean} [options.retranscribe] discard the stored transcript and
   *   transcribe again. Expensive, and only needed when the transcript itself
   *   is bad - re-running detection alone reuses it.
   * @returns {Promise<{queued: boolean, reason?: string}>}
   */
  async queueEpisode(episodeId, libraryItemId, { force = false, retranscribe = false } = {}) {
    if (!Database.serverSettings?.adDetectionEnabled) {
      return { queued: false, reason: 'Ad detection is disabled in server settings' }
    }
    if (this.currentEpisodeId === episodeId || this.queue.some((job) => job.episodeId === episodeId)) {
      return { queued: false, reason: 'Already queued' }
    }

    const episode = await Database.podcastEpisodeModel.findByPk(episodeId)
    if (!episode) return { queued: false, reason: 'Episode not found' }

    const status = episode.extraData?.adDetectionStatus
    if (!force && status === STATUS.COMPLETE) {
      return { queued: false, reason: 'Already processed' }
    }

    this.cancelled.delete(episodeId)
    await this.setStatus(episode, STATUS.QUEUED)
    this.queue.push({ episodeId, libraryItemId, force, retranscribe })
    Logger.info(`[AdDetectionManager] Queued episode ${episodeId} (queue length ${this.queue.length})`)

    this.processQueue()
    return { queued: true }
  }

  /**
   * Remove a not-yet-started job, or mark a running one for cancellation.
   *
   * @param {string} episodeId
   */
  cancelEpisode(episodeId) {
    this.queue = this.queue.filter((job) => job.episodeId !== episodeId)
    if (this.currentEpisodeId === episodeId) {
      this.cancelled.add(episodeId)
    }
  }

  /**
   * Drain the queue. Fire and forget - re-entrant calls return immediately.
   */
  async processQueue() {
    if (this.isProcessing) return
    const job = this.queue.shift()
    if (!job) return

    this.currentEpisodeId = job.episodeId
    try {
      await this.runJob(job)
    } catch (error) {
      Logger.error(`[AdDetectionManager] Job failed for episode ${job.episodeId}`, error)
    } finally {
      this.currentEpisodeId = null
      this.cancelled.delete(job.episodeId)
    }
    // Continue with the next job without growing the stack
    process.nextTick(() => this.processQueue())
  }

  /**
   * @param {{episodeId: string, libraryItemId: string, force: boolean, retranscribe: boolean}} job
   */
  async runJob(job) {
    const episode = await Database.podcastEpisodeModel.findByPk(job.episodeId)
    if (!episode) {
      Logger.warn(`[AdDetectionManager] Episode ${job.episodeId} disappeared before processing`)
      return
    }

    const audioFilePath = episode.audioFile?.metadata?.path
    if (!audioFilePath || !(await fs.pathExists(audioFilePath))) {
      await this.fail(episode, 'Episode audio file not found')
      return
    }

    const serverSettings = Database.serverSettings
    const taskTitleString = {
      text: 'Detecting ads',
      key: 'MessageTaskDetectingAds'
    }
    const taskDescriptionString = {
      text: `Detecting ads in episode "${episode.title}"`,
      key: 'MessageTaskDetectingAdsDescription',
      subs: [episode.title]
    }
    const task = TaskManager.createAndAddTask('ad-detection', taskTitleString, taskDescriptionString, false, {
      libraryItemId: job.libraryItemId,
      episodeId: episode.id
    })

    SocketAuthority.emitter('ad_detection_started', { episodeId: episode.id, libraryItemId: job.libraryItemId })

    let cleanup = null
    try {
      const transcriptionProvider = providers.createTranscriptionProvider(serverSettings)
      const detectionProvider = providers.createAdDetectionProvider(serverSettings)
      await detectionProvider.validate()

      // 1. transcript - reuse the stored one unless explicitly re-transcribing
      let transcript = job.retranscribe ? null : await this.readTranscript(episode.id)
      if (!transcript) {
        // Only require a working transcriber when there is nothing to reuse,
        // so re-detecting an already transcribed episode works on a host that
        // has no local speech model installed.
        await transcriptionProvider.validate()
        await this.setStatus(episode, STATUS.TRANSCRIBING)
        const prepared = await audioPrep.prepareForTranscription(audioFilePath, episode.id)
        cleanup = prepared.cleanup
        transcript = await transcriptionProvider.transcribe(prepared.wavPath)
        await this.writeTranscript(episode.id, transcript)
      }

      if (this.cancelled.has(episode.id)) {
        Logger.info(`[AdDetectionManager] Cancelled episode ${episode.id}`)
        await this.setStatus(episode, null)
        TaskManager.taskFinished(task)
        return
      }

      // 2. detect
      await this.setStatus(episode, STATUS.DETECTING)
      const podcast = await Database.podcastModel.findByPk(episode.podcastId)
      const rawSegments = await detectionProvider.detect(transcript, {
        title: episode.title,
        podcastTitle: podcast?.title
      })

      // 3. post-process against the real audio
      const duration = Number(episode.audioFile?.duration) || transcript.duration || 0
      const silences = await audioPrep.detectSilences(audioFilePath).catch(() => [])
      const segments = adSegmentUtils.postProcess(rawSegments, {
        duration,
        minConfidence: Number(serverSettings?.adDetectionMinConfidence) || 0,
        silences
      })

      // 4. persist
      const saved = await Database.mediaItemAdSegmentModel.replaceAiSegments(episode.id, 'podcastEpisode', segments)
      await this.setStatus(episode, STATUS.COMPLETE, {
        adDetectionError: null,
        adDetectionProvider: detectionProvider.name,
        adDetectionTranscriptionProvider: transcriptionProvider.name,
        adDetectionCompletedAt: new Date().toISOString()
      })

      Logger.info(`[AdDetectionManager] Episode ${episode.id} "${episode.title}": ${saved.length} ad segments`)
      SocketAuthority.emitter('ad_segments_updated', {
        episodeId: episode.id,
        libraryItemId: job.libraryItemId,
        status: STATUS.COMPLETE,
        segments: saved.map((segment) => segment.toJSONForClient())
      })
    } catch (error) {
      await this.fail(episode, error?.message || 'Ad detection failed', job.libraryItemId)
    } finally {
      if (cleanup) await cleanup()
      TaskManager.taskFinished(task)
      SocketAuthority.emitter('ad_detection_finished', { episodeId: episode.id, libraryItemId: job.libraryItemId })
    }
  }

  /**
   * @param {import('../models/PodcastEpisode')} episode
   * @param {string} message
   * @param {string} [libraryItemId]
   */
  async fail(episode, message, libraryItemId = null) {
    Logger.error(`[AdDetectionManager] Episode ${episode.id}: ${message}`)
    await this.setStatus(episode, STATUS.FAILED, { adDetectionError: message })
    SocketAuthority.emitter('ad_segments_updated', {
      episodeId: episode.id,
      libraryItemId,
      status: STATUS.FAILED,
      error: message,
      segments: []
    })
  }

  /**
   * @param {import('../models/PodcastEpisode')} episode
   * @param {string|null} status
   * @param {Object} [extra]
   */
  async setStatus(episode, status, extra = {}) {
    const extraData = { ...(episode.extraData || {}), adDetectionStatus: status, ...extra }
    if (status !== STATUS.FAILED && extra.adDetectionError === undefined) {
      extraData.adDetectionError = null
    }
    episode.extraData = extraData
    episode.changed('extraData', true)
    await episode.save()
  }

  /**
   * @param {string} episodeId
   * @returns {Promise<import('../providers/transcription/TranscriptionProvider').Transcript|null>}
   */
  async readTranscript(episodeId) {
    const path = this.getTranscriptPath(episodeId)
    if (!(await fs.pathExists(path))) return null
    try {
      const transcript = JSON.parse(await fs.readFile(path, 'utf8'))
      return transcript?.segments?.length ? transcript : null
    } catch (error) {
      Logger.warn(`[AdDetectionManager] Failed to read transcript ${path}: ${error?.message}`)
      return null
    }
  }

  /**
   * @param {string} episodeId
   * @param {Object} transcript
   */
  async writeTranscript(episodeId, transcript) {
    await fs.ensureDir(this.transcriptsDir)
    await fs.writeFile(this.getTranscriptPath(episodeId), JSON.stringify(transcript))
  }

  /**
   * @param {string} episodeId
   */
  async removeTranscript(episodeId) {
    await fs.remove(this.getTranscriptPath(episodeId)).catch(() => null)
  }

  /**
   * Remove everything this pipeline stored for an episode. Called when an
   * episode is deleted so segments and transcripts do not outlive it.
   *
   * @param {string} episodeId
   */
  async cleanupEpisode(episodeId) {
    this.cancelEpisode(episodeId)
    await Database.mediaItemAdSegmentModel.destroy({ where: { mediaItemId: episodeId, mediaItemType: 'podcastEpisode' } }).catch((error) => {
      Logger.warn(`[AdDetectionManager] Failed to remove segments for ${episodeId}: ${error?.message}`)
    })
    await this.removeTranscript(episodeId)
  }

  /**
   * Queue every episode in a library that has not been processed yet.
   *
   * @param {string} libraryId
   * @param {Object} [options]
   * @param {boolean} [options.force]
   * @param {boolean} [options.retranscribe]
   * @returns {Promise<number>} number of episodes queued
   */
  async backfillLibrary(libraryId, { force = false, retranscribe = false } = {}) {
    const libraryItems = await Database.libraryItemModel.findAll({
      where: { libraryId, mediaType: 'podcast' },
      attributes: ['id', 'mediaId']
    })
    if (!libraryItems.length) return 0

    let queued = 0
    for (const libraryItem of libraryItems) {
      const episodes = await Database.podcastEpisodeModel.findAll({
        where: { podcastId: libraryItem.mediaId },
        attributes: ['id', 'extraData']
      })
      for (const episode of episodes) {
        if (!force && episode.extraData?.adDetectionStatus === STATUS.COMPLETE) continue
        const result = await this.queueEpisode(episode.id, libraryItem.id, { force, retranscribe })
        if (result.queued) queued++
      }
    }
    Logger.info(`[AdDetectionManager] Backfill queued ${queued} episodes for library ${libraryId}`)
    return queued
  }

  /**
   * @returns {{processing: string|null, queued: string[]}}
   */
  getQueueStatus() {
    return {
      processing: this.currentEpisodeId,
      queued: this.queue.map((job) => job.episodeId)
    }
  }
}

module.exports = new AdDetectionManager()
module.exports.STATUS = STATUS
