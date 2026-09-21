/**
 * Base class for ad detection providers.
 *
 * A provider receives a timestamped transcript and returns candidate ad spans.
 * It does not need to merge, clamp or sanity-check them - `adSegmentUtils`
 * post-processes every provider's output identically.
 */
class AdDetectionProvider {
  /** @type {string} */
  static get identifier() {
    throw new Error('Not implemented')
  }

  constructor(config = {}) {
    this.config = config
  }

  get name() {
    return this.constructor.identifier
  }

  /**
   * Throws with a human readable reason if the provider cannot run.
   * @returns {Promise<void>}
   */
  async validate() {}

  /**
   * @param {import('../transcription/TranscriptionProvider').Transcript} _transcript
   * @param {Object} _context
   * @returns {Promise<import('../../utils/adSegmentUtils').AdSegment[]>}
   */
  async detect(_transcript, _context) {
    throw new Error('Not implemented')
  }
}

module.exports = AdDetectionProvider
