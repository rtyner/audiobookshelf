const Logger = require('../../Logger')
const AdDetectionProvider = require('./AdDetectionProvider')

/**
 * Keyword and phrase scoring over the transcript. No network, no model.
 *
 * This exists for three reasons: it is the fallback when no LLM is configured,
 * it is the deterministic test double for the rest of the pipeline, and it is
 * the only option for users who will not send transcripts to a third party.
 *
 * It is deliberately conservative - it would rather miss an ad than cut content.
 */

/** Phrases that are near-certain ad reads */
const STRONG_PHRASES = [
  'brought to you by',
  'sponsored by',
  'this episode is sponsored',
  'our sponsor',
  'our sponsors',
  'promo code',
  'discount code',
  'use code',
  'offer code',
  'percent off your first',
  'free trial',
  'terms and conditions apply',
  'visit our sponsor',
  'support for this show comes from',
  'support for this podcast comes from',
  'a word from our sponsor'
]

/**
 * Phrases that mark the seam around an ad break rather than the ad itself.
 * A segment containing one is where content resumes, so it ends a run and is
 * not part of it - counting it as ad copy swallows several seconds of show.
 */
const RETURN_PHRASES = ['back to the show', 'back to the episode', "we'll be right back", 'welcome back to the show']

/** Weaker signals - only count when stacked with others */
const WEAK_PHRASES = ['dot com slash', '.com/', 'sign up today', 'limited time', 'head over to', 'go to', 'check out', 'today’s episode is supported', 'exclusive offer', 'no credit card', 'cancel anytime', 'link in the show notes', 'link in the description']

const STRONG_WEIGHT = 1
const WEAK_WEIGHT = 0.35
/** A segment at or above this score is treated as ad copy */
const SEED_THRESHOLD = 1
/** A neighbouring segment at or above this is pulled into an adjacent run */
const BRIDGE_THRESHOLD = 0.35
/** How many neighbours either side may be bridged onto a seed */
const BRIDGE_REACH = 2

class HeuristicAdDetectionProvider extends AdDetectionProvider {
  static get identifier() {
    return 'heuristic'
  }

  /**
   * Score one transcript segment's own text.
   *
   * @param {string} text
   * @returns {number}
   */
  scoreText(text) {
    const lower = (text || '').toLowerCase()
    if (RETURN_PHRASES.some((phrase) => lower.includes(phrase))) return 0
    let score = 0
    for (const phrase of STRONG_PHRASES) {
      if (lower.includes(phrase)) score += STRONG_WEIGHT
    }
    for (const phrase of WEAK_PHRASES) {
      if (lower.includes(phrase)) score += WEAK_WEIGHT
    }
    return score
  }

  /**
   * Segments are scored individually and contiguous runs of ad copy are
   * emitted. Scoring a sliding window and emitting the whole window instead
   * would report several seconds of real content either side of the read.
   *
   * @param {import('../transcription/TranscriptionProvider').Transcript} transcript
   * @returns {Promise<import('../../utils/adSegmentUtils').AdSegment[]>}
   */
  async detect(transcript) {
    const segments = transcript?.segments || []
    if (!segments.length) return []

    const scores = segments.map((segment) => this.scoreText(segment.text))
    const isAd = scores.map((score) => score >= SEED_THRESHOLD)

    // Pull in neighbours that carry some signal, so a read split across a
    // sentence boundary is not cut in half.
    for (let i = 0; i < segments.length; i++) {
      if (scores[i] < SEED_THRESHOLD) continue
      for (let offset = 1; offset <= BRIDGE_REACH; offset++) {
        for (const j of [i - offset, i + offset]) {
          if (j < 0 || j >= segments.length) continue
          if (scores[j] >= BRIDGE_THRESHOLD) isAd[j] = true
        }
      }
    }

    /** @type {import('../../utils/adSegmentUtils').AdSegment[]} */
    const hits = []
    let runStart = -1
    for (let i = 0; i <= segments.length; i++) {
      if (i < segments.length && isAd[i]) {
        if (runStart === -1) runStart = i
        continue
      }
      if (runStart === -1) continue

      const run = segments.slice(runStart, i)
      const runScore = scores.slice(runStart, i).reduce((total, score) => total + score, 0)
      hits.push({
        start: run[0].start,
        end: run[run.length - 1].end,
        // Cap confidence below 1 - a keyword match is evidence, not proof.
        confidence: Math.min(0.85, 0.5 + runScore * 0.05),
        label: 'unknown'
      })
      runStart = -1
    }

    Logger.debug(`[HeuristicAdDetectionProvider] ${hits.length} ad runs from ${segments.length} transcript segments`)
    return hits
  }
}

module.exports = HeuristicAdDetectionProvider
module.exports.STRONG_PHRASES = STRONG_PHRASES
module.exports.WEAK_PHRASES = WEAK_PHRASES
module.exports.RETURN_PHRASES = RETURN_PHRASES
