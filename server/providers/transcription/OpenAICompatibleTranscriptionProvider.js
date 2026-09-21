const axios = require('axios')
const nodeFs = require('fs')
const Path = require('path')
const Logger = require('../../Logger')
const TranscriptionProvider = require('./TranscriptionProvider')

/**
 * Transcription through any service exposing the OpenAI audio transcription
 * API shape (`POST {baseUrl}/audio/transcriptions`, `verbose_json`).
 *
 * Verified shapes: OpenAI, Groq, and local faster-whisper / whisper.cpp servers.
 *
 * Note: DeepSeek does not currently serve an audio transcription endpoint, so
 * a DeepSeek-only setup should use the local whisper provider for this stage
 * and DeepSeek for ad detection.
 */
class OpenAICompatibleTranscriptionProvider extends TranscriptionProvider {
  static get identifier() {
    return 'openai-compatible'
  }

  /**
   * @param {Object} config
   * @param {string} config.baseUrl e.g. https://api.openai.com/v1
   * @param {string} config.apiKey
   * @param {string} [config.model]
   * @param {number} [config.timeout]
   */
  constructor(config = {}) {
    super(config)
    this.baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
    this.model = config.model || 'whisper-1'
    this.timeout = config.timeout || 30 * 60 * 1000
  }

  async validate() {
    if (!this.config.apiKey) {
      throw new Error('Remote transcription provider is missing an API key')
    }
  }

  /**
   * @param {string} wavPath
   * @param {Object} [options]
   * @returns {Promise<import('./TranscriptionProvider').Transcript>}
   */
  async transcribe(wavPath, options = {}) {
    await this.validate()

    // Node's global FormData + openAsBlob avoids pulling in a form-data
    // dependency while still streaming the file rather than buffering it.
    // openAsBlob lives on the fs module itself, not on fs.promises
    const blob = await nodeFs.openAsBlob(wavPath, { type: 'audio/wav' })
    const form = new globalThis.FormData()
    form.append('file', blob, Path.basename(wavPath))
    form.append('model', this.model)
    form.append('response_format', 'verbose_json')
    form.append('timestamp_granularities[]', 'segment')
    const language = options.language || this.config.language
    if (language) form.append('language', language)

    const url = `${this.baseUrl}/audio/transcriptions`
    Logger.info(`[OpenAICompatibleTranscriptionProvider] POST ${url} model=${this.model}`)

    const response = await axios.post(url, form, {
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`
      },
      timeout: this.timeout,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    })

    const data = response.data
    const segments = (data?.segments || [])
      .map((segment) => {
        const start = Number(segment?.start)
        const end = Number(segment?.end)
        const text = (segment?.text || '').trim()
        if (!Number.isFinite(start) || !Number.isFinite(end) || !text) return null
        return { start, end, text }
      })
      .filter(Boolean)

    if (!segments.length && data?.text) {
      throw new Error('Transcription provider returned text without segment timestamps - ad detection needs timestamps')
    }

    return {
      provider: OpenAICompatibleTranscriptionProvider.identifier,
      model: this.model,
      language: data?.language || language || 'en',
      duration: Number(data?.duration) || 0,
      segments,
      createdAt: new Date().toISOString()
    }
  }
}

module.exports = OpenAICompatibleTranscriptionProvider
