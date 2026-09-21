const WhisperCppProvider = require('./transcription/WhisperCppProvider')
const OpenAICompatibleTranscriptionProvider = require('./transcription/OpenAICompatibleTranscriptionProvider')
const LlmAdDetectionProvider = require('./addetection/LlmAdDetectionProvider')
const HeuristicAdDetectionProvider = require('./addetection/HeuristicAdDetectionProvider')

/**
 * Factories that turn server settings into provider instances.
 *
 * Adding a provider means adding it to one of these maps - nothing else in the
 * pipeline knows which provider it is talking to.
 */

const TRANSCRIPTION_PROVIDERS = {
  [WhisperCppProvider.identifier]: WhisperCppProvider,
  [OpenAICompatibleTranscriptionProvider.identifier]: OpenAICompatibleTranscriptionProvider
}

const AD_DETECTION_PROVIDERS = {
  [LlmAdDetectionProvider.identifier]: LlmAdDetectionProvider,
  [HeuristicAdDetectionProvider.identifier]: HeuristicAdDetectionProvider
}

/**
 * @param {Object} serverSettings
 * @returns {import('./transcription/TranscriptionProvider')}
 */
function createTranscriptionProvider(serverSettings) {
  const identifier = serverSettings?.adDetectionTranscriptionProvider || WhisperCppProvider.identifier
  const ProviderClass = TRANSCRIPTION_PROVIDERS[identifier]
  if (!ProviderClass) {
    throw new Error(`Unknown transcription provider "${identifier}"`)
  }
  if (ProviderClass === WhisperCppProvider) {
    return new WhisperCppProvider({ model: serverSettings?.adDetectionWhisperModel })
  }
  return new ProviderClass({
    baseUrl: serverSettings?.adDetectionTranscriptionBaseUrl,
    model: serverSettings?.adDetectionTranscriptionModel,
    apiKey: serverSettings?.adDetectionTranscriptionApiKey
  })
}

/**
 * @param {Object} serverSettings
 * @returns {import('./addetection/AdDetectionProvider')}
 */
function createAdDetectionProvider(serverSettings) {
  const identifier = serverSettings?.adDetectionLlmProvider || LlmAdDetectionProvider.identifier
  // "none" means the user wants detection without sending anything to a model
  if (identifier === 'none' || identifier === HeuristicAdDetectionProvider.identifier) {
    return new HeuristicAdDetectionProvider()
  }
  const ProviderClass = AD_DETECTION_PROVIDERS[identifier]
  if (!ProviderClass) {
    throw new Error(`Unknown ad detection provider "${identifier}"`)
  }
  return new ProviderClass({
    baseUrl: serverSettings?.adDetectionLlmBaseUrl,
    model: serverSettings?.adDetectionLlmModel,
    apiKey: serverSettings?.adDetectionLlmApiKey
  })
}

module.exports = {
  TRANSCRIPTION_PROVIDERS,
  AD_DETECTION_PROVIDERS,
  createTranscriptionProvider,
  createAdDetectionProvider
}
