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
  'a word from our sponsor',
  'back to the show',
  'back to the episode',
  "we'll be right back"
]

/** Weaker signals - only count when stacked with others */
const WEAK_PHRASES = ['dot com slash', '.com/', 'sign up today', 'limited time', 'head over to', 'go to', 'check out', 'today’s episode is supported', 'exclusive offer', 'no credit card', 'cancel anytime', 'link in the show notes', 'link in the description']

const STRONG_WEIGHT = 1
const WEAK_WEIGHT = 0.35
/** Score at or above this over a window marks it as an ad */
const SCORE_THRESHOLD = 1
/** Transcript segments per scoring window */
const WINDOW_SEGMENTS = 6

class HeuristicAdDetectionProvider extends AdDetectionProvider {
  static get identifier() {
    return 'heuristic'
  }

  /**
   * @param {import('../transcription/TranscriptionProvider').Transcript} transcript
   * @returns {Promise<import('../../utils/adSegmentUtils').AdSegment[]>}
   */
  async detect(transcript) {
    const segments = transcript?.segments || []
    if (!segments.length) return []

    /** @type {import('../../utils/adSegmentUtils').AdSegment[]} */
    const hits = []

    for (let i = 0; i < segments.length; i++) {
      const window = segments.slice(i, i + WINDOW_SEGMENTS)
      if (!window.length) continue
      const text = window
        .map((s) => s.text)
        .join(' ')
        .toLowerCase()

      let score = 0
      for (const phrase of STRONG_PHRASES) {
        if (text.includes(phrase)) score += STRONG_WEIGHT
      }
      for (const phrase of WEAK_PHRASES) {
        if (text.includes(phrase)) score += WEAK_WEIGHT
      }

      if (score >= SCORE_THRESHOLD) {
        hits.push({
          start: window[0].start,
          end: window[window.length - 1].end,
          // Cap confidence below 1 - a keyword match is evidence, not proof.
          confidence: Math.min(0.85, 0.5 + score * 0.1),
          label: 'unknown'
        })
      }
    }

    Logger.debug(`[HeuristicAdDetectionProvider] ${hits.length} candidate windows from ${segments.length} transcript segments`)
    return hits
  }
}

module.exports = HeuristicAdDetectionProvider
module.exports.STRONG_PHRASES = STRONG_PHRASES
module.exports.WEAK_PHRASES = WEAK_PHRASES
