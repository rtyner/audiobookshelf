/**
 * Base class for transcription providers.
 *
 * @typedef TranscriptSegment
 * @property {number} start seconds
 * @property {number} end seconds
 * @property {string} text
 *
 * @typedef Transcript
 * @property {string} provider
 * @property {string} model
 * @property {string} language
 * @property {number} duration
 * @property {TranscriptSegment[]} segments
 * @property {string} createdAt ISO timestamp
 */

class TranscriptionProvider {
  /** @type {string} */
  static get identifier() {
    throw new Error('Not implemented')
  }

  /**
   * @param {Object} config
   */
  constructor(config = {}) {
    this.config = config
  }

  get name() {
    return this.constructor.identifier
  }

  /**
   * Throws with a human readable reason if the provider cannot run.
   * Called before any long running work so failures surface immediately.
   *
   * @returns {Promise<void>}
   */
  async validate() {}

  /**
   * @param {string} _wavPath 16 kHz mono wav
   * @param {Object} _options
   * @returns {Promise<Transcript>}
   */
  async transcribe(_wavPath, _options) {
    throw new Error('Not implemented')
  }
}

module.exports = TranscriptionProvider
