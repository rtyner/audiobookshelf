/**
 * Shared post-processing for ad segments produced by any detection provider.
 *
 * Providers are allowed to return rough, overlapping, unsorted spans. Everything
 * that makes a span safe to act on during playback happens here so that all
 * providers behave identically.
 *
 * @typedef AdSegment
 * @property {number} start seconds
 * @property {number} end seconds
 * @property {number} [confidence] 0-1
 * @property {string} [label] preroll|midroll|postroll|selfpromo|unknown
 */

const Logger = require('../Logger')

/** Segments closer together than this are merged into one */
const MERGE_GAP_SECONDS = 3
/** Anything shorter than this is noise, not an ad read */
const MIN_SEGMENT_SECONDS = 5
/** No single ad break may exceed this share of the episode */
const MAX_SEGMENT_DURATION_RATIO = 0.25
/** Search window when snapping a boundary to nearby silence */
const SILENCE_SNAP_WINDOW_SECONDS = 4

/**
 * Coerce provider output into well formed segments, dropping anything unusable.
 *
 * @param {any[]} rawSegments
 * @returns {AdSegment[]}
 */
function normalize(rawSegments) {
  if (!Array.isArray(rawSegments)) return []
  return rawSegments
    .map((segment) => {
      const start = Number(segment?.start ?? segment?.startTime)
      const end = Number(segment?.end ?? segment?.endTime)
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null
      let confidence = Number(segment?.confidence)
      if (!Number.isFinite(confidence)) confidence = 0.5
      return {
        start: Math.max(0, start),
        end: Math.max(0, end),
        confidence: Math.min(1, Math.max(0, confidence)),
        label: typeof segment?.label === 'string' ? segment.label : 'unknown'
      }
    })
    .filter((segment) => segment && segment.end > segment.start)
}

/**
 * Sort and merge overlapping or near-adjacent segments. The merged segment
 * keeps the highest confidence and the earliest label of its parts.
 *
 * @param {AdSegment[]} segments
 * @param {number} [gap]
 * @returns {AdSegment[]}
 */
function merge(segments, gap = MERGE_GAP_SECONDS) {
  const sorted = [...segments].sort((a, b) => a.start - b.start)
  const merged = []
  for (const segment of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && segment.start - previous.end <= gap) {
      previous.end = Math.max(previous.end, segment.end)
      previous.confidence = Math.max(previous.confidence, segment.confidence)
    } else {
      merged.push({ ...segment })
    }
  }
  return merged
}

/**
 * Drop segments that are implausible as an ad break, or below the confidence
 * the server is configured to trust.
 *
 * @param {AdSegment[]} segments
 * @param {number} duration episode duration in seconds
 * @param {number} [minConfidence]
 * @returns {AdSegment[]}
 */
function filterImplausible(segments, duration, minConfidence = 0) {
  const maxDuration = duration > 0 ? duration * MAX_SEGMENT_DURATION_RATIO : Infinity
  return segments.filter((segment) => {
    const length = segment.end - segment.start
    if (length < MIN_SEGMENT_SECONDS) return false
    if (length > maxDuration) return false
    if (segment.confidence < minConfidence) return false
    return true
  })
}

/**
 * Clamp every boundary into [0, duration].
 *
 * @param {AdSegment[]} segments
 * @param {number} duration
 * @returns {AdSegment[]}
 */
function clamp(segments, duration) {
  if (!(duration > 0)) return segments
  return segments
    .map((segment) => ({
      ...segment,
      start: Math.min(Math.max(0, segment.start), duration),
      end: Math.min(Math.max(0, segment.end), duration)
    }))
    .filter((segment) => segment.end > segment.start)
}

/**
 * Infer preroll/midroll/postroll from position when the provider did not label
 * a segment, so the UI can describe it without guessing.
 *
 * @param {AdSegment[]} segments
 * @param {number} duration
 * @returns {AdSegment[]}
 */
function labelByPosition(segments, duration) {
  return segments.map((segment) => {
    if (segment.label && segment.label !== 'unknown') return segment
    let label = 'midroll'
    if (segment.start <= 90) label = 'preroll'
    else if (duration > 0 && segment.end >= duration - 90) label = 'postroll'
    return { ...segment, label }
  })
}

/**
 * Move each boundary to the nearest detected silence within a small window.
 * Transcript timestamps land mid-word often enough that skipping on them alone
 * clips speech; silence is the real seam between content and an ad read.
 *
 * @param {AdSegment[]} segments
 * @param {{start: number, end: number}[]} silences
 * @param {number} [window]
 * @returns {AdSegment[]}
 */
function snapToSilence(segments, silences, window = SILENCE_SNAP_WINDOW_SECONDS) {
  if (!silences?.length) return segments

  const snap = (time, preferEdge) => {
    let best = time
    let bestDistance = window
    for (const silence of silences) {
      // Snapping a start backwards to the start of silence, and an end
      // forwards to the end of silence, always errs toward skipping slightly
      // more rather than clipping content.
      const candidate = preferEdge === 'start' ? silence.start : silence.end
      const distance = Math.abs(candidate - time)
      if (distance < bestDistance) {
        best = candidate
        bestDistance = distance
      }
    }
    return best
  }

  return segments.map((segment) => ({
    ...segment,
    start: snap(segment.start, 'start'),
    end: snap(segment.end, 'end')
  }))
}

/**
 * Full post-processing pipeline.
 *
 * @param {any[]} rawSegments
 * @param {Object} options
 * @param {number} options.duration episode duration in seconds
 * @param {number} [options.minConfidence]
 * @param {{start: number, end: number}[]} [options.silences]
 * @returns {AdSegment[]}
 */
function postProcess(rawSegments, { duration, minConfidence = 0, silences = [] }) {
  let segments = normalize(rawSegments)
  segments = clamp(segments, duration)
  segments = merge(segments)
  segments = snapToSilence(segments, silences)
  segments = clamp(segments, duration)
  segments = merge(segments)
  segments = filterImplausible(segments, duration, minConfidence)
  segments = labelByPosition(segments, duration)
  Logger.debug(`[adSegmentUtils] post-processed ${rawSegments?.length || 0} raw segments into ${segments.length}`)
  return segments
}

module.exports = {
  MERGE_GAP_SECONDS,
  MIN_SEGMENT_SECONDS,
  MAX_SEGMENT_DURATION_RATIO,
  normalize,
  merge,
  filterImplausible,
  clamp,
  labelByPosition,
  snapToSilence,
  postProcess
}
