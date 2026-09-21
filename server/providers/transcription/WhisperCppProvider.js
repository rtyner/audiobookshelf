const Path = require('path')
const os = require('os')
const child_process = require('child_process')
const axios = require('axios')
const which = require('../../libs/which')
const fs = require('../../libs/fsExtra')
const Logger = require('../../Logger')
const TranscriptionProvider = require('./TranscriptionProvider')

/**
 * Local transcription with whisper.cpp.
 *
 * The binary is NOT auto-downloaded: whisper.cpp does not publish a usable
 * prebuilt binary for every platform Audiobookshelf runs on, and silently
 * installing a CPU-specific build is a worse failure than asking for a path.
 * It is resolved from WHISPER_PATH or PATH, and the bundled Docker image
 * installs it.
 *
 * The GGML model IS auto-downloaded, because those are stable, versionless
 * files served from Hugging Face.
 */

const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'
const KNOWN_MODELS = ['tiny.en', 'tiny', 'base.en', 'base', 'small.en', 'small', 'medium.en', 'medium', 'large-v3-turbo']
const CANDIDATE_BINARY_NAMES = ['whisper-cli', 'whisper-cpp', 'main']

class WhisperCppProvider extends TranscriptionProvider {
  static get identifier() {
    return 'whisper-local'
  }

  /**
   * @param {Object} config
   * @param {string} [config.model] e.g. "base.en"
   * @param {string} [config.binaryPath]
   * @param {string} [config.modelPath]
   * @param {number} [config.threads]
   * @param {string} [config.language]
   */
  constructor(config = {}) {
    super(config)
    this.model = config.model || 'base.en'
    this.threads = config.threads || Math.max(1, Math.min(8, os.cpus().length - 1))
  }

  get modelsDir() {
    return Path.join(global.MetadataPath, 'models')
  }

  get modelPath() {
    if (this.config.modelPath) return this.config.modelPath
    if (process.env.WHISPER_MODEL_PATH) return process.env.WHISPER_MODEL_PATH
    return Path.join(this.modelsDir, `ggml-${this.model}.bin`)
  }

  /**
   * @returns {Promise<string>} absolute path to the whisper binary
   */
  async resolveBinary() {
    if (this.resolvedBinary) return this.resolvedBinary

    const explicit = this.config.binaryPath || process.env.WHISPER_PATH
    if (explicit) {
      if (!(await fs.pathExists(explicit))) {
        throw new Error(`whisper binary not found at ${explicit} (WHISPER_PATH)`)
      }
      this.resolvedBinary = explicit
      return explicit
    }

    for (const name of CANDIDATE_BINARY_NAMES) {
      const found = which.sync(name, { nothrow: true })
      if (found) {
        this.resolvedBinary = found
        return found
      }
    }
    throw new Error(`whisper.cpp not found. Install it and set WHISPER_PATH, or use a remote transcription provider.`)
  }

  /**
   * Download the GGML model if it is not already on disk.
   *
   * @param {(percent: number) => void} [progressCb]
   * @returns {Promise<string>} model path
   */
  async ensureModel(progressCb = null) {
    const modelPath = this.modelPath
    if (await fs.pathExists(modelPath)) return modelPath

    if (!KNOWN_MODELS.includes(this.model)) {
      throw new Error(`Unknown whisper model "${this.model}". Known models: ${KNOWN_MODELS.join(', ')}`)
    }

    await fs.ensureDir(Path.dirname(modelPath))
    const url = `${MODEL_BASE_URL}/ggml-${this.model}.bin`
    const tempPath = `${modelPath}.download`
    Logger.info(`[WhisperCppProvider] Downloading model ${this.model} from ${url}`)

    const response = await axios({ url, method: 'GET', responseType: 'stream', timeout: 0 })
    const total = Number(response.headers['content-length']) || 0
    let downloaded = 0
    let lastReported = 0

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(tempPath)
      response.data.on('data', (chunk) => {
        downloaded += chunk.length
        if (total && progressCb) {
          const percent = Math.floor((downloaded / total) * 100)
          if (percent >= lastReported + 5) {
            lastReported = percent
            progressCb(percent)
          }
        }
      })
      response.data.on('error', reject)
      writer.on('error', reject)
      writer.on('finish', resolve)
      response.data.pipe(writer)
    })

    await fs.move(tempPath, modelPath, { overwrite: true })
    Logger.info(`[WhisperCppProvider] Model saved to ${modelPath}`)
    return modelPath
  }

  async validate() {
    await this.resolveBinary()
  }

  /**
   * @param {string} wavPath
   * @param {Object} [options]
   * @param {string} [options.language]
   * @param {(percent: number) => void} [options.progressCb]
   * @returns {Promise<import('./TranscriptionProvider').Transcript>}
   */
  async transcribe(wavPath, options = {}) {
    const binary = await this.resolveBinary()
    const modelPath = await this.ensureModel(options.progressCb)
    const outputPrefix = wavPath.replace(/\.wav$/i, '')
    const jsonPath = `${outputPrefix}.json`

    const args = ['-m', modelPath, '-f', wavPath, '-oj', '-of', outputPrefix, '-t', String(this.threads), '-np', '-nt']
    const language = options.language || this.config.language
    if (language) args.push('-l', language)

    Logger.info(`[WhisperCppProvider] ${binary} ${args.join(' ')}`)
    await this.run(binary, args)

    if (!(await fs.pathExists(jsonPath))) {
      throw new Error('whisper.cpp produced no JSON output')
    }
    const raw = JSON.parse(await fs.readFile(jsonPath, 'utf8'))
    await fs.remove(jsonPath).catch(() => null)

    return {
      provider: WhisperCppProvider.identifier,
      model: this.model,
      language: raw?.result?.language || language || 'en',
      duration: 0,
      segments: this.parseSegments(raw),
      createdAt: new Date().toISOString()
    }
  }

  /**
   * whisper.cpp writes offsets in milliseconds under transcription[].offsets
   *
   * @param {Object} raw
   * @returns {import('./TranscriptionProvider').TranscriptSegment[]}
   */
  parseSegments(raw) {
    const entries = raw?.transcription || []
    return entries
      .map((entry) => {
        const start = Number(entry?.offsets?.from)
        const end = Number(entry?.offsets?.to)
        const text = (entry?.text || '').trim()
        if (!Number.isFinite(start) || !Number.isFinite(end) || !text) return null
        return { start: start / 1000, end: end / 1000, text }
      })
      .filter(Boolean)
  }

  /**
   * @param {string} binary
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  run(binary, args) {
    return new Promise((resolve, reject) => {
      const proc = child_process.spawn(binary, args, { windowsHide: true })
      let stderr = ''
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
        if (stderr.length > 20000) stderr = stderr.slice(-20000)
      })
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code === 0) return resolve()
        reject(new Error(`whisper.cpp exited with code ${code}: ${stderr.trim().split('\n').slice(-5).join(' | ')}`))
      })
    })
  }
}

module.exports = WhisperCppProvider
