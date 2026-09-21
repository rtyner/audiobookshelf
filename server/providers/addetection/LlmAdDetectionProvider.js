const axios = require('axios')
const Logger = require('../../Logger')
const AdDetectionProvider = require('./AdDetectionProvider')

/**
 * Ad detection with any chat-completions API that speaks the OpenAI request
 * shape. That covers DeepSeek (the default here), OpenAI, Groq, OpenRouter,
 * Together, Ollama, vLLM and llama.cpp's server.
 *
 * The transcript is sent in overlapping windows because a whole episode
 * exceeds a sensible context/cost budget and because a smaller window keeps
 * the model's attention on boundaries. Windows overlap so an ad break that
 * straddles a seam is still seen whole by at least one call.
 */

/** Transcript seconds per request */
const WINDOW_SECONDS = 240
/** Overlap between consecutive windows */
const WINDOW_OVERLAP_SECONDS = 30
/** Model calls in flight at once */
const REQUEST_CONCURRENCY = 2

const SYSTEM_PROMPT = [
  'You identify advertisement segments in podcast transcripts.',
  '',
  'You are given a numbered list of transcript lines. Each line begins with its',
  'start time in seconds in square brackets.',
  '',
  'An advertisement is any span that is not the show content: host-read sponsor',
  'reads, dynamically inserted ads, promo-code reads, and cross-promotion for',
  'other shows or the show’s own paid membership.',
  '',
  'NOT advertisements: the intro/outro music, the host naming the show, listener',
  'mail, content that merely mentions a brand, and interview subjects talking',
  'about their own work.',
  '',
  'Rules:',
  '- Use ONLY start times that appear in the transcript lines you were given.',
  '- Report the full span of an ad read, from its first line to its last line.',
  '- If a span is ambiguous, lower its confidence rather than omitting it.',
  '- If there are no advertisements, return an empty array.',
  '',
  'Respond with JSON only, no prose, in exactly this shape:',
  '{"segments":[{"start":<seconds>,"end":<seconds>,"confidence":<0-1>,"label":"preroll|midroll|postroll|selfpromo"}]}'
].join('\n')

class LlmAdDetectionProvider extends AdDetectionProvider {
  static get identifier() {
    return 'llm'
  }

  /**
   * @param {Object} config
   * @param {string} [config.baseUrl] default DeepSeek
   * @param {string} config.apiKey
   * @param {string} [config.model]
   * @param {number} [config.timeout]
   * @param {number} [config.temperature]
   */
  constructor(config = {}) {
    super(config)
    this.baseUrl = (config.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
    this.model = config.model || 'deepseek-chat'
    this.timeout = config.timeout || 120000
    this.temperature = config.temperature ?? 0
  }

  async validate() {
    if (!this.config.apiKey && !/(^|\/\/)(localhost|127\.0\.0\.1)/.test(this.baseUrl)) {
      throw new Error('Ad detection LLM provider is missing an API key')
    }
  }

  /**
   * Split the transcript into overlapping time windows.
   *
   * @param {import('../transcription/TranscriptionProvider').TranscriptSegment[]} segments
   * @returns {import('../transcription/TranscriptionProvider').TranscriptSegment[][]}
   */
  buildWindows(segments) {
    if (!segments.length) return []
    const windows = []
    const lastEnd = segments[segments.length - 1].end
    let windowStart = 0

    while (windowStart < lastEnd) {
      const windowEnd = windowStart + WINDOW_SECONDS
      const window = segments.filter((s) => s.end > windowStart && s.start < windowEnd)
      if (window.length) windows.push(window)
      windowStart = windowEnd - WINDOW_OVERLAP_SECONDS
      // Guard against a pathological transcript producing an endless loop
      if (WINDOW_SECONDS <= WINDOW_OVERLAP_SECONDS) break
    }
    return windows
  }

  /**
   * @param {import('../transcription/TranscriptionProvider').TranscriptSegment[]} window
   * @returns {string}
   */
  formatWindow(window) {
    return window.map((segment) => `[${segment.start.toFixed(1)}] ${segment.text}`).join('\n')
  }

  /**
   * @param {import('../transcription/TranscriptionProvider').Transcript} transcript
   * @param {Object} [context]
   * @param {string} [context.title]
   * @param {string} [context.podcastTitle]
   * @returns {Promise<import('../../utils/adSegmentUtils').AdSegment[]>}
   */
  async detect(transcript, context = {}) {
    await this.validate()

    const windows = this.buildWindows(transcript?.segments || [])
    if (!windows.length) return []

    Logger.info(`[LlmAdDetectionProvider] ${windows.length} windows -> ${this.model} at ${this.baseUrl}`)

    /** @type {import('../../utils/adSegmentUtils').AdSegment[]} */
    const results = []
    for (let i = 0; i < windows.length; i += REQUEST_CONCURRENCY) {
      const batch = windows.slice(i, i + REQUEST_CONCURRENCY)
      const settled = await Promise.all(batch.map((window) => this.detectInWindow(window, context).catch((err) => {
        // One bad window must not lose the whole episode.
        Logger.warn(`[LlmAdDetectionProvider] window failed: ${err?.message}`)
        return []
      })))
      for (const segments of settled) results.push(...segments)
    }

    return results
  }

  /**
   * @param {import('../transcription/TranscriptionProvider').TranscriptSegment[]} window
   * @param {Object} context
   * @returns {Promise<import('../../utils/adSegmentUtils').AdSegment[]>}
   */
  async detectInWindow(window, context) {
    const header = [context.podcastTitle && `Podcast: ${context.podcastTitle}`, context.title && `Episode: ${context.title}`].filter(Boolean).join('\n')
    const userContent = [header, header && '', 'Transcript:', this.formatWindow(window)].filter((part) => part !== undefined).join('\n')

    let content = await this.requestCompletion(userContent)
    let parsed = this.parseResponse(content)
    if (parsed === null) {
      // Models occasionally wrap JSON in prose. One retry with a blunter
      // instruction is cheaper than discarding the window.
      Logger.debug('[LlmAdDetectionProvider] malformed JSON, retrying once')
      content = await this.requestCompletion(`${userContent}\n\nReturn ONLY the JSON object. No explanation.`)
      parsed = this.parseResponse(content)
    }
    if (parsed === null) {
      throw new Error('provider did not return parseable JSON')
    }

    const windowStart = window[0].start
    const windowEnd = window[window.length - 1].end
    return parsed
      .map((segment) => ({
        start: Number(segment?.start),
        end: Number(segment?.end),
        confidence: Number(segment?.confidence),
        label: segment?.label
      }))
      .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
      // Reject hallucinated timestamps outside the window the model was shown.
      .filter((segment) => segment.start >= windowStart - 1 && segment.end <= windowEnd + 1)
  }

  /**
   * @param {string} userContent
   * @returns {Promise<string>}
   */
  async requestCompletion(userContent) {
    const url = `${this.baseUrl}/chat/completions`
    const headers = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`

    const body = {
      model: this.model,
      temperature: this.temperature,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      // Supported by DeepSeek and OpenAI; providers that ignore it still work
      // because the response is parsed defensively.
      response_format: { type: 'json_object' }
    }

    const response = await axios.post(url, body, { headers, timeout: this.timeout })
    return response.data?.choices?.[0]?.message?.content || ''
  }

  /**
   * @param {string} content
   * @returns {any[]|null} null when the response could not be parsed
   */
  parseResponse(content) {
    if (!content) return null
    let text = content.trim()

    // Strip markdown fences some providers add despite json_object mode
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenced) text = fenced[1].trim()

    // Fall back to the outermost JSON object in the response
    if (!text.startsWith('{') && !text.startsWith('[')) {
      const first = text.indexOf('{')
      const last = text.lastIndexOf('}')
      if (first === -1 || last <= first) return null
      text = text.slice(first, last + 1)
    }

    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed
      if (Array.isArray(parsed?.segments)) return parsed.segments
      return null
    } catch {
      return null
    }
  }
}

module.exports = LlmAdDetectionProvider
module.exports.SYSTEM_PROMPT = SYSTEM_PROMPT
module.exports.WINDOW_SECONDS = WINDOW_SECONDS
module.exports.WINDOW_OVERLAP_SECONDS = WINDOW_OVERLAP_SECONDS
