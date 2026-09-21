const Path = require('path')
const Ffmpeg = require('../libs/fluentFfmpeg')
const fs = require('../libs/fsExtra')
const Logger = require('../Logger')

/**
 * Audio preparation for the ad detection pipeline.
 *
 * Speech recognition wants 16 kHz mono PCM; silence detection wants the same
 * decode pass. Both live here so the pipeline touches ffmpeg in exactly one place.
 */

/**
 * Directory that holds the temporary WAVs. Cleaned up per-episode after use.
 *
 * @returns {string}
 */
function getWorkDir() {
  return Path.join(global.MetadataPath, 'cache', 'addetect')
}

/**
 * Decode an audio file to 16 kHz mono 16-bit WAV.
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @returns {Promise<string>} outputPath
 */
function extractWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    Ffmpeg(inputPath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('error', (err) => {
        Logger.error(`[audioPrep] Failed to extract wav from ${inputPath}`, err)
        reject(err)
      })
      .on('end', () => resolve(outputPath))
      .save(outputPath)
  })
}

/**
 * Decode an audio file and collect the silent spans, used to snap ad
 * boundaries onto a real seam in the audio.
 *
 * @param {string} inputPath
 * @param {Object} [options]
 * @param {number} [options.noiseDb] threshold in dBFS
 * @param {number} [options.minDuration] minimum silence length in seconds
 * @returns {Promise<{start: number, end: number}[]>}
 */
function detectSilences(inputPath, { noiseDb = -35, minDuration = 0.35 } = {}) {
  return new Promise((resolve) => {
    /** @type {{start: number, end: number}[]} */
    const silences = []
    let pendingStart = null

    Ffmpeg(inputPath)
      .noVideo()
      .audioFilters(`silencedetect=noise=${noiseDb}dB:d=${minDuration}`)
      .format('null')
      .on('stderr', (line) => {
        const startMatch = line.match(/silence_start:\s*(-?[\d.]+)/)
        if (startMatch) {
          pendingStart = Math.max(0, parseFloat(startMatch[1]))
          return
        }
        const endMatch = line.match(/silence_end:\s*([\d.]+)/)
        if (endMatch && pendingStart !== null) {
          silences.push({ start: pendingStart, end: parseFloat(endMatch[1]) })
          pendingStart = null
        }
      })
      .on('error', (err) => {
        // Silence detection is an optimisation, never a hard failure - the
        // pipeline still produces usable segments without it.
        Logger.warn(`[audioPrep] silencedetect failed for ${inputPath}: ${err?.message}`)
        resolve(silences)
      })
      .on('end', () => resolve(silences))
      .saveToFile(global.isWin ? 'NUL' : '/dev/null')
  })
}

/**
 * Prepare an episode for transcription: ensure the work dir exists and
 * produce the WAV.
 *
 * @param {string} audioFilePath
 * @param {string} key unique key for this job, usually the episode id
 * @returns {Promise<{wavPath: string, cleanup: () => Promise<void>}>}
 */
async function prepareForTranscription(audioFilePath, key) {
  const workDir = getWorkDir()
  await fs.ensureDir(workDir)
  const wavPath = Path.join(workDir, `${key}.wav`)
  await fs.remove(wavPath).catch(() => null)
  await extractWav(audioFilePath, wavPath)
  return {
    wavPath,
    cleanup: async () => {
      await fs.remove(wavPath).catch((err) => Logger.warn(`[audioPrep] Failed to remove ${wavPath}: ${err?.message}`))
    }
  }
}

module.exports = {
  getWorkDir,
  extractWav,
  detectSilences,
  prepareForTranscription
}
