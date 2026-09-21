const { DataTypes, Model } = require('sequelize')

/**
 * An advertisement (or self-promo) span inside a media item, detected by the
 * ad detection pipeline or created/edited by a user.
 *
 * Segments are metadata only - the audio file is never modified - so they can
 * be disabled, edited or deleted without touching playback progress.
 *
 * @typedef MediaItemAdSegmentObject
 * @property {UUIDV4} id
 * @property {UUIDV4} mediaItemId
 * @property {string} mediaItemType
 * @property {number} startTime seconds
 * @property {number} endTime seconds
 * @property {number} confidence 0-1
 * @property {string} label preroll|midroll|postroll|selfpromo|unknown
 * @property {string} source ai|user|imported
 * @property {boolean} enabled
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

const SEGMENT_LABELS = ['preroll', 'midroll', 'postroll', 'selfpromo', 'unknown']
const SEGMENT_SOURCES = ['ai', 'user', 'imported']

class MediaItemAdSegment extends Model {
  constructor(values, options) {
    super(values, options)

    /** @type {UUIDV4} */
    this.id
    /** @type {UUIDV4} */
    this.mediaItemId
    /** @type {string} */
    this.mediaItemType
    /** @type {number} */
    this.startTime
    /** @type {number} */
    this.endTime
    /** @type {number} */
    this.confidence
    /** @type {string} */
    this.label
    /** @type {string} */
    this.source
    /** @type {boolean} */
    this.enabled
    /** @type {Date} */
    this.createdAt
    /** @type {Date} */
    this.updatedAt
  }

  static get LABELS() {
    return SEGMENT_LABELS
  }

  static get SOURCES() {
    return SEGMENT_SOURCES
  }

  /**
   * All segments for a media item, ordered by start time
   *
   * @param {string} mediaItemId
   * @param {string} [mediaItemType]
   * @returns {Promise<MediaItemAdSegment[]>}
   */
  static getForMediaItem(mediaItemId, mediaItemType = 'podcastEpisode') {
    return this.findAll({
      where: { mediaItemId, mediaItemType },
      order: [['startTime', 'ASC']]
    })
  }

  /**
   * Enabled segments for a set of media items, keyed by media item id.
   * Used to attach segments to a playback session without an N+1 query.
   *
   * @param {string[]} mediaItemIds
   * @param {string} [mediaItemType]
   * @returns {Promise<Record<string, Object[]>>}
   */
  static async getEnabledForMediaItems(mediaItemIds, mediaItemType = 'podcastEpisode') {
    if (!mediaItemIds?.length) return {}
    const segments = await this.findAll({
      where: { mediaItemId: mediaItemIds, mediaItemType, enabled: true },
      order: [['startTime', 'ASC']]
    })
    const map = {}
    for (const segment of segments) {
      if (!map[segment.mediaItemId]) map[segment.mediaItemId] = []
      map[segment.mediaItemId].push(segment.toJSONForClient())
    }
    return map
  }

  /**
   * Replace the AI-generated segments for a media item while preserving any
   * segment a user created or edited. An AI segment that overlaps a user
   * segment is dropped - the user's boundary always wins.
   *
   * @param {string} mediaItemId
   * @param {string} mediaItemType
   * @param {import('../utils/adSegmentUtils').AdSegment[]} segments
   * @returns {Promise<MediaItemAdSegment[]>}
   */
  static async replaceAiSegments(mediaItemId, mediaItemType, segments) {
    const existing = await this.getForMediaItem(mediaItemId, mediaItemType)
    const userSegments = existing.filter((s) => s.source === 'user')

    await this.destroy({ where: { mediaItemId, mediaItemType, source: 'ai' } })

    const overlapsUserSegment = (segment) => userSegments.some((u) => segment.startTime < u.endTime && segment.endTime > u.startTime)

    const toCreate = segments
      .map((segment) => ({
        mediaItemId,
        mediaItemType,
        startTime: segment.start,
        endTime: segment.end,
        confidence: segment.confidence ?? 0,
        label: SEGMENT_LABELS.includes(segment.label) ? segment.label : 'unknown',
        source: 'ai',
        enabled: true
      }))
      .filter((segment) => !overlapsUserSegment(segment))

    if (toCreate.length) {
      await this.bulkCreate(toCreate)
    }
    return this.getForMediaItem(mediaItemId, mediaItemType)
  }

  /**
   * Initialize model
   * @param {import('../Database').sequelize} sequelize
   */
  static init(sequelize) {
    super.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true
        },
        mediaItemId: DataTypes.UUID,
        mediaItemType: {
          type: DataTypes.STRING,
          defaultValue: 'podcastEpisode'
        },
        startTime: {
          type: DataTypes.FLOAT,
          allowNull: false
        },
        endTime: {
          type: DataTypes.FLOAT,
          allowNull: false
        },
        confidence: {
          type: DataTypes.FLOAT,
          defaultValue: 0
        },
        label: {
          type: DataTypes.STRING,
          defaultValue: 'unknown'
        },
        source: {
          type: DataTypes.STRING,
          defaultValue: 'ai'
        },
        enabled: {
          type: DataTypes.BOOLEAN,
          defaultValue: true
        }
      },
      {
        sequelize,
        modelName: 'mediaItemAdSegment',
        indexes: [
          {
            name: 'media_item_ad_segments_media_item',
            fields: ['mediaItemId', 'mediaItemType']
          },
          {
            name: 'media_item_ad_segments_start_time',
            fields: ['mediaItemId', 'startTime']
          }
        ]
      }
    )
  }

  /**
   * @returns {MediaItemAdSegmentObject}
   */
  toJSONForClient() {
    return {
      id: this.id,
      mediaItemId: this.mediaItemId,
      mediaItemType: this.mediaItemType,
      startTime: this.startTime,
      endTime: this.endTime,
      confidence: this.confidence,
      label: this.label,
      source: this.source,
      enabled: this.enabled
    }
  }
}

module.exports = MediaItemAdSegment
