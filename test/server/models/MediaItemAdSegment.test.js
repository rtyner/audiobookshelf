const { expect } = require('chai')
const { Sequelize } = require('sequelize')

const Database = require('../../../server/Database')

describe('MediaItemAdSegment', () => {
  const episodeId = 'e0000000-0000-4000-8000-000000000001'

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()
  })

  afterEach(async () => {
    await Database.sequelize.close()
  })

  /**
   * @param {Object} overrides
   */
  function create(overrides = {}) {
    return Database.mediaItemAdSegmentModel.create({
      mediaItemId: episodeId,
      mediaItemType: 'podcastEpisode',
      startTime: 10,
      endTime: 60,
      confidence: 0.9,
      source: 'ai',
      ...overrides
    })
  }

  it('defaults to an enabled ai segment', async () => {
    const segment = await create()
    expect(segment.enabled).to.be.true
    expect(segment.source).to.equal('ai')
    expect(segment.label).to.equal('unknown')
  })

  it('returns segments for a media item ordered by start time', async () => {
    await create({ startTime: 500, endTime: 560 })
    await create({ startTime: 10, endTime: 60 })
    const segments = await Database.mediaItemAdSegmentModel.getForMediaItem(episodeId)
    expect(segments.map((s) => s.startTime)).to.deep.equal([10, 500])
  })

  it('groups enabled segments by media item and omits disabled ones', async () => {
    await create({ startTime: 10, endTime: 60 })
    await create({ startTime: 100, endTime: 160, enabled: false })
    const map = await Database.mediaItemAdSegmentModel.getEnabledForMediaItems([episodeId])
    expect(map[episodeId]).to.have.lengthOf(1)
    expect(map[episodeId][0].startTime).to.equal(10)
  })

  it('returns an empty map for no ids', async () => {
    expect(await Database.mediaItemAdSegmentModel.getEnabledForMediaItems([])).to.deep.equal({})
  })

  describe('replaceAiSegments', () => {
    it('replaces previous ai segments', async () => {
      await create({ startTime: 10, endTime: 60 })
      const result = await Database.mediaItemAdSegmentModel.replaceAiSegments(episodeId, 'podcastEpisode', [{ start: 300, end: 360, confidence: 0.8, label: 'midroll' }])
      expect(result).to.have.lengthOf(1)
      expect(result[0].startTime).to.equal(300)
      expect(result[0].label).to.equal('midroll')
    })

    it('never deletes a user segment', async () => {
      await create({ startTime: 1000, endTime: 1060, source: 'user' })
      const result = await Database.mediaItemAdSegmentModel.replaceAiSegments(episodeId, 'podcastEpisode', [{ start: 300, end: 360, confidence: 0.8 }])
      expect(result).to.have.lengthOf(2)
      expect(result.filter((s) => s.source === 'user')).to.have.lengthOf(1)
    })

    it('drops an ai segment that overlaps a user segment', async () => {
      await create({ startTime: 300, endTime: 400, source: 'user' })
      const result = await Database.mediaItemAdSegmentModel.replaceAiSegments(episodeId, 'podcastEpisode', [
        { start: 350, end: 380, confidence: 0.8 },
        { start: 900, end: 960, confidence: 0.8 }
      ])
      expect(result).to.have.lengthOf(2)
      expect(result.map((s) => s.startTime).sort((a, b) => a - b)).to.deep.equal([300, 900])
    })

    it('falls back to the unknown label for an unrecognised one', async () => {
      const result = await Database.mediaItemAdSegmentModel.replaceAiSegments(episodeId, 'podcastEpisode', [{ start: 300, end: 360, confidence: 0.8, label: 'nonsense' }])
      expect(result[0].label).to.equal('unknown')
    })

    it('clears ai segments when the provider found none', async () => {
      await create()
      const result = await Database.mediaItemAdSegmentModel.replaceAiSegments(episodeId, 'podcastEpisode', [])
      expect(result).to.be.empty
    })
  })

  it('serializes only client-safe fields', async () => {
    const segment = await create()
    expect(Object.keys(segment.toJSONForClient()).sort()).to.deep.equal(['confidence', 'enabled', 'endTime', 'id', 'label', 'mediaItemId', 'mediaItemType', 'source', 'startTime'])
  })
})
