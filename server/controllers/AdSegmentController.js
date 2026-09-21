const { Request, Response, NextFunction } = require('express')
const Logger = require('../Logger')
const Database = require('../Database')
const SocketAuthority = require('../SocketAuthority')
const AdDetectionManager = require('../managers/AdDetectionManager')
const fs = require('../libs/fsExtra')

/**
 * @typedef RequestUserObject
 * @property {import('../models/User')} user
 *
 * @typedef {Request & RequestUserObject} RequestWithUser
 *
 * @typedef RequestEntityObject
 * @property {import('../models/LibraryItem')} libraryItem
 * @property {import('../models/PodcastEpisode')} episode
 *
 * @typedef {RequestWithUser & RequestEntityObject} RequestWithEpisode
 */

class AdSegmentController {
  /**
   * GET /api/podcasts/:id/episode/:episodeId/ad-segments
   *
   * @param {RequestWithEpisode} req
   * @param {Response} res
   */
  async getSegments(req, res) {
    const segments = await Database.mediaItemAdSegmentModel.getForMediaItem(req.episode.id)
    const transcriptPath = AdDetectionManager.getTranscriptPath(req.episode.id)
    res.json({
      episodeId: req.episode.id,
      status: req.episode.extraData?.adDetectionStatus || null,
      error: req.episode.extraData?.adDetectionError || null,
      transcriptAvailable: await fs.pathExists(transcriptPath),
      segments: segments.map((segment) => segment.toJSONForClient())
    })
  }

  /**
   * POST /api/podcasts/:id/episode/:episodeId/ad-segments
   * Queue AI detection for this episode, or create a segment by hand when a
   * body with startTime/endTime is supplied.
   *
   * @param {RequestWithEpisode} req
   * @param {Response} res
   */
  async createOrDetect(req, res) {
    const { startTime, endTime } = req.body || {}

    // Manual segment creation
    if (startTime !== undefined || endTime !== undefined) {
      const start = Number(startTime)
      const end = Number(endTime)
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) {
        return res.status(400).send('startTime and endTime must be numbers with endTime > startTime >= 0')
      }
      const segment = await Database.mediaItemAdSegmentModel.create({
        mediaItemId: req.episode.id,
        mediaItemType: 'podcastEpisode',
        startTime: start,
        endTime: end,
        confidence: 1,
        label: Database.mediaItemAdSegmentModel.LABELS.includes(req.body.label) ? req.body.label : 'unknown',
        source: 'user',
        enabled: req.body.enabled !== false
      })
      this.emitSegmentsUpdated(req.episode.id, req.libraryItem.id)
      return res.json(segment.toJSONForClient())
    }

    // AI detection run
    if (!req.user.isAdminOrUp) {
      Logger.error(`[AdSegmentController] Non-admin user "${req.user.username}" attempted to run ad detection`)
      return res.sendStatus(403)
    }
    const force = req.query.force === '1' || req.body?.force === true
    // Re-transcribing is opt-in: detection alone reuses the stored transcript,
    // which is the cheap and usual case.
    const retranscribe = req.query.retranscribe === '1' || req.body?.retranscribe === true
    const result = await AdDetectionManager.queueEpisode(req.episode.id, req.libraryItem.id, { force, retranscribe })
    if (!result.queued) {
      return res.status(409).send(result.reason || 'Not queued')
    }
    res.json({ queued: true, episodeId: req.episode.id })
  }

  /**
   * PATCH /api/podcasts/:id/episode/:episodeId/ad-segments/:segmentId
   *
   * @param {RequestWithEpisode} req
   * @param {Response} res
   */
  async updateSegment(req, res) {
    const segment = await Database.mediaItemAdSegmentModel.findByPk(req.params.segmentId)
    if (!segment || segment.mediaItemId !== req.episode.id) return res.sendStatus(404)

    const updates = {}
    if (req.body.startTime !== undefined) updates.startTime = Number(req.body.startTime)
    if (req.body.endTime !== undefined) updates.endTime = Number(req.body.endTime)
    if (req.body.enabled !== undefined) updates.enabled = !!req.body.enabled
    if (req.body.label !== undefined && Database.mediaItemAdSegmentModel.LABELS.includes(req.body.label)) {
      updates.label = req.body.label
    }

    const start = updates.startTime ?? segment.startTime
    const end = updates.endTime ?? segment.endTime
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0) {
      return res.status(400).send('startTime and endTime must be numbers with endTime > startTime >= 0')
    }

    // An edited segment becomes the user's - a later detection run must not
    // silently revert their boundaries.
    if (updates.startTime !== undefined || updates.endTime !== undefined) {
      updates.source = 'user'
    }

    await segment.update(updates)
    this.emitSegmentsUpdated(req.episode.id, req.libraryItem.id)
    res.json(segment.toJSONForClient())
  }

  /**
   * DELETE /api/podcasts/:id/episode/:episodeId/ad-segments/:segmentId
   *
   * @param {RequestWithEpisode} req
   * @param {Response} res
   */
  async deleteSegment(req, res) {
    const segment = await Database.mediaItemAdSegmentModel.findByPk(req.params.segmentId)
    if (!segment || segment.mediaItemId !== req.episode.id) return res.sendStatus(404)
    await segment.destroy()
    this.emitSegmentsUpdated(req.episode.id, req.libraryItem.id)
    res.sendStatus(200)
  }

  /**
   * GET /api/podcasts/:id/episode/:episodeId/transcript
   *
   * @param {RequestWithEpisode} req
   * @param {Response} res
   */
  async getTranscript(req, res) {
    const transcript = await AdDetectionManager.readTranscript(req.episode.id)
    if (!transcript) return res.sendStatus(404)
    res.json(transcript)
  }

  /**
   * POST /api/libraries/:id/ad-detection/backfill
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async backfillLibrary(req, res) {
    if (!req.user.isAdminOrUp) {
      Logger.error(`[AdSegmentController] Non-admin user "${req.user.username}" attempted a backfill`)
      return res.sendStatus(403)
    }
    if (!Database.serverSettings.adDetectionEnabled) {
      return res.status(409).send('Ad detection is disabled in server settings')
    }
    const library = await Database.libraryModel.findByPk(req.params.id)
    if (!library) return res.sendStatus(404)
    if (library.mediaType !== 'podcast') {
      return res.status(400).send('Ad detection only applies to podcast libraries')
    }

    const force = req.query.force === '1'
    const retranscribe = req.query.retranscribe === '1'
    // Fire and forget - the queue reports progress over the task socket
    const queued = await AdDetectionManager.backfillLibrary(library.id, { force, retranscribe })
    res.json({ queued })
  }

  /**
   * GET /api/ad-detection/status
   *
   * @param {RequestWithUser} req
   * @param {Response} res
   */
  async getStatus(req, res) {
    if (!req.user.isAdminOrUp) return res.sendStatus(403)
    res.json({
      enabled: !!Database.serverSettings.adDetectionEnabled,
      ...AdDetectionManager.getQueueStatus()
    })
  }

  /**
   * @param {string} episodeId
   * @param {string} libraryItemId
   */
  async emitSegmentsUpdated(episodeId, libraryItemId) {
    const segments = await Database.mediaItemAdSegmentModel.getForMediaItem(episodeId)
    SocketAuthority.emitter('ad_segments_updated', {
      episodeId,
      libraryItemId,
      segments: segments.map((segment) => segment.toJSONForClient())
    })
  }

  /**
   * Loads the library item and episode, and enforces access + write permissions.
   *
   * @param {RequestWithEpisode} req
   * @param {Response} res
   * @param {NextFunction} next
   */
  async middleware(req, res, next) {
    const libraryItem = await Database.libraryItemModel.getExpandedById(req.params.id)
    if (!libraryItem?.media) return res.sendStatus(404)
    if (!libraryItem.isPodcast) return res.sendStatus(400)

    if (!req.user.checkCanAccessLibraryItem(libraryItem)) return res.sendStatus(403)

    const episode = libraryItem.media.podcastEpisodes?.find((ep) => ep.id === req.params.episodeId)
    if (!episode) return res.sendStatus(404)

    if (req.method === 'DELETE' && !req.user.canDelete) {
      Logger.warn(`[AdSegmentController] User "${req.user.username}" attempted to delete without permission`)
      return res.sendStatus(403)
    } else if ((req.method === 'PATCH' || req.method === 'POST') && !req.user.canUpdate) {
      Logger.warn(`[AdSegmentController] User "${req.user.username}" attempted to update without permission`)
      return res.sendStatus(403)
    }

    req.libraryItem = libraryItem
    req.episode = episode
    next()
  }
}

module.exports = new AdSegmentController()
