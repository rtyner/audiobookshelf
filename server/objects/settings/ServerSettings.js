const Path = require('path')
const packageJson = require('../../../package.json')
const { BookshelfView } = require('../../utils/constants')
const Logger = require('../../Logger')
const User = require('../../models/User')
const { sanitize } = require('../../utils/htmlSanitizer')

/** No detector reports total certainty, so a higher threshold accepts nothing */
const MAX_AD_DETECTION_CONFIDENCE = 0.95

const PATCHABLE_SETTINGS_KEYS = new Set([
  'scannerParseSubtitle',
  'scannerFindCovers',
  'scannerCoverProvider',
  'scannerPreferMatchedMetadata',
  'scannerDisableWatcher',
  'storeCoverWithItem',
  'storeMetadataWithItem',
  'allowIframe',
  'allowedOrigins',
  'backupSchedule',
  'backupsToKeep',
  'maxBackupSize',
  'logLevel',
  'homeBookshelfView',
  'bookshelfView',
  'dateFormat',
  'timeFormat',
  'language',
  'chromecastEnabled',
  'sortingIgnorePrefix',
  'adDetectionEnabled',
  'adDetectionAutoRun',
  'adDetectionAutoSkip',
  'adDetectionMinConfidence',
  'adDetectionTranscriptionProvider',
  'adDetectionWhisperModel',
  'adDetectionTranscriptionBaseUrl',
  'adDetectionTranscriptionModel',
  'adDetectionTranscriptionApiKey',
  'adDetectionLlmProvider',
  'adDetectionLlmBaseUrl',
  'adDetectionLlmModel',
  'adDetectionLlmApiKey'
])

class ServerSettings {
  static patchableSettingsKeys = PATCHABLE_SETTINGS_KEYS
  constructor(settings) {
    this.id = 'server-settings'
    /** @type {string} JWT secret key ONLY used when JWT_SECRET_KEY is not set in ENV */
    this.tokenSecret = null

    // Scanner
    this.scannerParseSubtitle = false
    this.scannerFindCovers = false
    this.scannerCoverProvider = 'google'
    this.scannerPreferMatchedMetadata = false
    this.scannerDisableWatcher = false

    // Metadata - choose to store inside users library item folder
    this.storeCoverWithItem = false
    this.storeMetadataWithItem = false
    this.metadataFileFormat = 'json'

    // Security/Rate limits
    this.rateLimitLoginRequests = 10
    this.rateLimitLoginWindow = 10 * 60 * 1000 // 10 Minutes
    this.allowIframe = false

    // Backups
    this.backupPath = Path.join(global.MetadataPath, 'backups')
    this.backupSchedule = false // If false then auto-backups are disabled
    this.backupsToKeep = 2
    this.maxBackupSize = 1

    // Logger
    this.loggerDailyLogsToKeep = 7
    this.loggerScannerLogsToKeep = 2

    // Bookshelf Display
    this.homeBookshelfView = BookshelfView.DETAIL
    this.bookshelfView = BookshelfView.DETAIL

    // Podcasts
    this.podcastEpisodeSchedule = '0 * * * *' // Every hour

    // Sorting
    this.sortingIgnorePrefix = false
    this.sortingPrefixes = ['the', 'a']

    // Misc Flags
    this.chromecastEnabled = false
    this.dateFormat = 'MM/dd/yyyy'
    this.timeFormat = 'HH:mm'
    this.language = 'en-us'
    this.allowedOrigins = []

    this.logLevel = Logger.logLevel

    this.version = packageJson.version
    this.buildNumber = packageJson.buildNumber

    // Auth settings
    this.authLoginCustomMessage = null
    this.authActiveAuthMethods = ['local']

    // openid settings
    this.authOpenIDIssuerURL = null
    this.authOpenIDAuthorizationURL = null
    this.authOpenIDTokenURL = null
    this.authOpenIDUserInfoURL = null
    this.authOpenIDJwksURL = null
    this.authOpenIDLogoutURL = null
    this.authOpenIDClientID = null
    this.authOpenIDClientSecret = null
    this.authOpenIDTokenSigningAlgorithm = 'RS256'
    this.authOpenIDButtonText = 'Login with OpenId'
    this.authOpenIDAutoLaunch = false
    this.authOpenIDAutoRegister = false
    this.authOpenIDMatchExistingBy = null
    this.authOpenIDMobileRedirectURIs = ['audiobookshelf://oauth']
    this.authOpenIDGroupClaim = ''
    this.authOpenIDAdvancedPermsClaim = ''
    this.authOpenIDSubfolderForRedirectURLs = undefined

    // AI ad detection (podcasts). Opt-in: transcription is expensive and
    // detection may send transcripts to a third party.
    this.adDetectionEnabled = false
    this.adDetectionAutoRun = true
    this.adDetectionAutoSkip = true
    this.adDetectionMinConfidence = 0.7
    this.adDetectionTranscriptionProvider = 'whisper-local'
    this.adDetectionWhisperModel = 'base.en'
    this.adDetectionTranscriptionBaseUrl = null
    this.adDetectionTranscriptionModel = null
    this.adDetectionTranscriptionApiKey = null
    this.adDetectionLlmProvider = 'llm'
    this.adDetectionLlmBaseUrl = 'https://api.deepseek.com/v1'
    this.adDetectionLlmModel = 'deepseek-chat'
    this.adDetectionLlmApiKey = null

    if (settings) {
      this.construct(settings)
    }
  }

  construct(settings) {
    this.tokenSecret = settings.tokenSecret
    this.scannerFindCovers = !!settings.scannerFindCovers
    this.scannerCoverProvider = settings.scannerCoverProvider || 'google'
    this.scannerParseSubtitle = settings.scannerParseSubtitle
    this.scannerPreferMatchedMetadata = !!settings.scannerPreferMatchedMetadata
    this.scannerDisableWatcher = !!settings.scannerDisableWatcher

    this.storeCoverWithItem = !!settings.storeCoverWithItem
    this.storeMetadataWithItem = !!settings.storeMetadataWithItem
    this.metadataFileFormat = settings.metadataFileFormat || 'json'

    this.rateLimitLoginRequests = !isNaN(settings.rateLimitLoginRequests) ? Number(settings.rateLimitLoginRequests) : 10
    this.rateLimitLoginWindow = !isNaN(settings.rateLimitLoginWindow) ? Number(settings.rateLimitLoginWindow) : 10 * 60 * 1000 // 10 Minutes
    this.allowIframe = !!settings.allowIframe

    this.adDetectionEnabled = !!settings.adDetectionEnabled
    this.adDetectionAutoRun = settings.adDetectionAutoRun !== false
    this.adDetectionAutoSkip = settings.adDetectionAutoSkip !== false
    this.adDetectionMinConfidence = !isNaN(settings.adDetectionMinConfidence) && settings.adDetectionMinConfidence !== null ? Number(settings.adDetectionMinConfidence) : 0.7
    // Detectors deliberately never report total certainty - a keyword match is
    // evidence, not proof - so a threshold of 1 silently rejects every segment.
    if (this.adDetectionMinConfidence > MAX_AD_DETECTION_CONFIDENCE) {
      Logger.warn(`[ServerSettings] adDetectionMinConfidence ${this.adDetectionMinConfidence} would reject every segment, clamping to ${MAX_AD_DETECTION_CONFIDENCE}`)
      this.adDetectionMinConfidence = MAX_AD_DETECTION_CONFIDENCE
    } else if (this.adDetectionMinConfidence < 0) {
      this.adDetectionMinConfidence = 0
    }
    this.adDetectionTranscriptionProvider = settings.adDetectionTranscriptionProvider || 'whisper-local'
    this.adDetectionWhisperModel = settings.adDetectionWhisperModel || 'base.en'
    this.adDetectionTranscriptionBaseUrl = settings.adDetectionTranscriptionBaseUrl || null
    this.adDetectionTranscriptionModel = settings.adDetectionTranscriptionModel || null
    this.adDetectionTranscriptionApiKey = settings.adDetectionTranscriptionApiKey || null
    this.adDetectionLlmProvider = settings.adDetectionLlmProvider || 'llm'
    this.adDetectionLlmBaseUrl = settings.adDetectionLlmBaseUrl || 'https://api.deepseek.com/v1'
    this.adDetectionLlmModel = settings.adDetectionLlmModel || 'deepseek-chat'
    this.adDetectionLlmApiKey = settings.adDetectionLlmApiKey || null

    this.backupPath = settings.backupPath || Path.join(global.MetadataPath, 'backups')
    this.backupSchedule = settings.backupSchedule || false
    this.backupsToKeep = settings.backupsToKeep || 2
    this.maxBackupSize = settings.maxBackupSize === 0 ? 0 : settings.maxBackupSize || 1

    this.loggerDailyLogsToKeep = settings.loggerDailyLogsToKeep || 7
    this.loggerScannerLogsToKeep = settings.loggerScannerLogsToKeep || 2

    this.homeBookshelfView = settings.homeBookshelfView || BookshelfView.STANDARD
    this.bookshelfView = settings.bookshelfView || BookshelfView.STANDARD

    this.sortingIgnorePrefix = !!settings.sortingIgnorePrefix
    this.sortingPrefixes = settings.sortingPrefixes || ['the']
    this.chromecastEnabled = !!settings.chromecastEnabled
    this.dateFormat = settings.dateFormat || 'MM/dd/yyyy'
    this.timeFormat = settings.timeFormat || 'HH:mm'
    this.language = settings.language || 'en-us'
    this.allowedOrigins = settings.allowedOrigins || []
    this.logLevel = settings.logLevel || Logger.logLevel
    this.version = settings.version || null
    this.buildNumber = settings.buildNumber || 0 // Added v2.4.5

    this.authLoginCustomMessage = sanitize(settings.authLoginCustomMessage) || null // Added v2.8.0
    this.authActiveAuthMethods = settings.authActiveAuthMethods || ['local']

    this.authOpenIDIssuerURL = settings.authOpenIDIssuerURL || null
    this.authOpenIDAuthorizationURL = settings.authOpenIDAuthorizationURL || null
    this.authOpenIDTokenURL = settings.authOpenIDTokenURL || null
    this.authOpenIDUserInfoURL = settings.authOpenIDUserInfoURL || null
    this.authOpenIDJwksURL = settings.authOpenIDJwksURL || null
    this.authOpenIDLogoutURL = settings.authOpenIDLogoutURL || null
    this.authOpenIDClientID = settings.authOpenIDClientID || null
    this.authOpenIDClientSecret = settings.authOpenIDClientSecret || null
    this.authOpenIDTokenSigningAlgorithm = settings.authOpenIDTokenSigningAlgorithm || 'RS256'
    this.authOpenIDButtonText = settings.authOpenIDButtonText || 'Login with OpenId'
    this.authOpenIDAutoLaunch = !!settings.authOpenIDAutoLaunch
    this.authOpenIDAutoRegister = !!settings.authOpenIDAutoRegister
    this.authOpenIDMatchExistingBy = settings.authOpenIDMatchExistingBy || null
    this.authOpenIDMobileRedirectURIs = settings.authOpenIDMobileRedirectURIs || ['audiobookshelf://oauth']
    this.authOpenIDGroupClaim = settings.authOpenIDGroupClaim || ''
    this.authOpenIDAdvancedPermsClaim = settings.authOpenIDAdvancedPermsClaim || ''
    this.authOpenIDSubfolderForRedirectURLs = settings.authOpenIDSubfolderForRedirectURLs

    if (!Array.isArray(this.authActiveAuthMethods)) {
      this.authActiveAuthMethods = ['local']
    }

    // remove uninitialized methods
    // OpenID
    if (this.authActiveAuthMethods.includes('openid') && !this.isOpenIDAuthSettingsValid) {
      this.authActiveAuthMethods.splice(this.authActiveAuthMethods.indexOf('openid', 0), 1)
    }

    // fallback to local
    if (!Array.isArray(this.authActiveAuthMethods) || this.authActiveAuthMethods.length == 0) {
      this.authActiveAuthMethods = ['local']
    }

    // Migrations
    if (settings.storeCoverWithBook != undefined) {
      // storeCoverWithBook was renamed to storeCoverWithItem in 2.0.0
      this.storeCoverWithItem = !!settings.storeCoverWithBook
    }
    if (settings.storeMetadataWithBook != undefined) {
      // storeMetadataWithBook was renamed to storeMetadataWithItem in 2.0.0
      this.storeMetadataWithItem = !!settings.storeMetadataWithBook
    }
    if (settings.homeBookshelfView == undefined) {
      // homeBookshelfView was added in 2.1.3
      this.homeBookshelfView = settings.bookshelfView
    }
    if (settings.metadataFileFormat == undefined) {
      // metadataFileFormat was added in 2.2.21
      // All users using old settings will stay abs until changed
      this.metadataFileFormat = 'abs'
    }

    // As of v2.4.5 only json is supported
    if (this.metadataFileFormat !== 'json') {
      Logger.warn(`[ServerSettings] Invalid metadataFileFormat ${this.metadataFileFormat} (as of v2.4.5 only json is supported)`)
      this.metadataFileFormat = 'json'
    }

    if (this.logLevel !== Logger.logLevel) {
      Logger.setLogLevel(this.logLevel)
    }

    if (process.env.BACKUP_PATH && this.backupPath !== process.env.BACKUP_PATH) {
      Logger.info(`[ServerSettings] Using backup path from environment variable ${process.env.BACKUP_PATH}`)
      this.backupPath = process.env.BACKUP_PATH
    }

    // Environment overrides let a deployment ship working ad detection config
    // without anyone editing settings in the UI first. They win over the
    // stored settings, so the container is the source of truth when set.
    if (process.env.AD_DETECTION_LLM_API_KEY) {
      this.adDetectionLlmApiKey = process.env.AD_DETECTION_LLM_API_KEY
    }
    if (process.env.AD_DETECTION_TRANSCRIPTION_API_KEY) {
      this.adDetectionTranscriptionApiKey = process.env.AD_DETECTION_TRANSCRIPTION_API_KEY
    }
    if (process.env.AD_DETECTION_ENABLED === '1') {
      this.adDetectionEnabled = true
    }
    if (process.env.AD_DETECTION_TRANSCRIPTION_PROVIDER) {
      this.adDetectionTranscriptionProvider = process.env.AD_DETECTION_TRANSCRIPTION_PROVIDER
    }
    if (process.env.AD_DETECTION_TRANSCRIPTION_BASE_URL) {
      this.adDetectionTranscriptionBaseUrl = process.env.AD_DETECTION_TRANSCRIPTION_BASE_URL
    }
    if (process.env.AD_DETECTION_TRANSCRIPTION_MODEL) {
      this.adDetectionTranscriptionModel = process.env.AD_DETECTION_TRANSCRIPTION_MODEL
    }
    if (process.env.AD_DETECTION_LLM_BASE_URL) {
      this.adDetectionLlmBaseUrl = process.env.AD_DETECTION_LLM_BASE_URL
    }
    if (process.env.AD_DETECTION_LLM_MODEL) {
      this.adDetectionLlmModel = process.env.AD_DETECTION_LLM_MODEL
    }

    if (process.env.ALLOW_IFRAME === '1' && !this.allowIframe) {
      Logger.info(`[ServerSettings] Using allowIframe from environment variable`)
      this.allowIframe = true
    }
  }

  toJSON() {
    // Use toJSONForBrowser if sending to client
    return {
      id: this.id,
      tokenSecret: this.tokenSecret, // Do not return to client
      scannerFindCovers: this.scannerFindCovers,
      scannerCoverProvider: this.scannerCoverProvider,
      scannerParseSubtitle: this.scannerParseSubtitle,
      scannerPreferMatchedMetadata: this.scannerPreferMatchedMetadata,
      scannerDisableWatcher: this.scannerDisableWatcher,
      storeCoverWithItem: this.storeCoverWithItem,
      storeMetadataWithItem: this.storeMetadataWithItem,
      metadataFileFormat: this.metadataFileFormat,
      rateLimitLoginRequests: this.rateLimitLoginRequests,
      rateLimitLoginWindow: this.rateLimitLoginWindow,
      allowIframe: this.allowIframe,
      backupPath: this.backupPath,
      backupSchedule: this.backupSchedule,
      backupsToKeep: this.backupsToKeep,
      maxBackupSize: this.maxBackupSize,
      loggerDailyLogsToKeep: this.loggerDailyLogsToKeep,
      loggerScannerLogsToKeep: this.loggerScannerLogsToKeep,
      homeBookshelfView: this.homeBookshelfView,
      bookshelfView: this.bookshelfView,
      podcastEpisodeSchedule: this.podcastEpisodeSchedule,
      sortingIgnorePrefix: this.sortingIgnorePrefix,
      sortingPrefixes: [...this.sortingPrefixes],
      chromecastEnabled: this.chromecastEnabled,
      dateFormat: this.dateFormat,
      timeFormat: this.timeFormat,
      language: this.language,
      allowedOrigins: this.allowedOrigins,
      logLevel: this.logLevel,
      version: this.version,
      buildNumber: this.buildNumber,
      authLoginCustomMessage: this.authLoginCustomMessage,
      authActiveAuthMethods: this.authActiveAuthMethods,
      authOpenIDIssuerURL: this.authOpenIDIssuerURL,
      authOpenIDAuthorizationURL: this.authOpenIDAuthorizationURL,
      authOpenIDTokenURL: this.authOpenIDTokenURL,
      authOpenIDUserInfoURL: this.authOpenIDUserInfoURL,
      authOpenIDJwksURL: this.authOpenIDJwksURL,
      authOpenIDLogoutURL: this.authOpenIDLogoutURL,
      authOpenIDClientID: this.authOpenIDClientID, // Do not return to client
      authOpenIDClientSecret: this.authOpenIDClientSecret, // Do not return to client
      authOpenIDTokenSigningAlgorithm: this.authOpenIDTokenSigningAlgorithm,
      authOpenIDButtonText: this.authOpenIDButtonText,
      authOpenIDAutoLaunch: this.authOpenIDAutoLaunch,
      authOpenIDAutoRegister: this.authOpenIDAutoRegister,
      authOpenIDMatchExistingBy: this.authOpenIDMatchExistingBy,
      authOpenIDMobileRedirectURIs: this.authOpenIDMobileRedirectURIs, // Do not return to client
      authOpenIDGroupClaim: this.authOpenIDGroupClaim, // Do not return to client
      authOpenIDAdvancedPermsClaim: this.authOpenIDAdvancedPermsClaim, // Do not return to client
      authOpenIDSubfolderForRedirectURLs: this.authOpenIDSubfolderForRedirectURLs,
      adDetectionEnabled: this.adDetectionEnabled,
      adDetectionAutoRun: this.adDetectionAutoRun,
      adDetectionAutoSkip: this.adDetectionAutoSkip,
      adDetectionMinConfidence: this.adDetectionMinConfidence,
      adDetectionTranscriptionProvider: this.adDetectionTranscriptionProvider,
      adDetectionWhisperModel: this.adDetectionWhisperModel,
      adDetectionTranscriptionBaseUrl: this.adDetectionTranscriptionBaseUrl,
      adDetectionTranscriptionModel: this.adDetectionTranscriptionModel,
      adDetectionTranscriptionApiKey: this.adDetectionTranscriptionApiKey, // Do not return to client
      adDetectionLlmProvider: this.adDetectionLlmProvider,
      adDetectionLlmBaseUrl: this.adDetectionLlmBaseUrl,
      adDetectionLlmModel: this.adDetectionLlmModel,
      adDetectionLlmApiKey: this.adDetectionLlmApiKey // Do not return to client
    }
  }

  /**
   * Host timezone used by cron schedulers (not persisted in settings)
   * @returns {string} IANA timezone name, e.g. "America/New_York"
   */
  static getHostTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    } catch {
      return 'UTC'
    }
  }

  toJSONForBrowser() {
    const json = this.toJSON()
    delete json.tokenSecret
    delete json.authOpenIDClientID
    delete json.authOpenIDClientSecret
    delete json.authOpenIDMobileRedirectURIs
    delete json.authOpenIDGroupClaim
    delete json.authOpenIDAdvancedPermsClaim
    // Never ship provider credentials to the browser - only whether one is set
    json.adDetectionLlmApiKeySet = !!json.adDetectionLlmApiKey
    json.adDetectionTranscriptionApiKeySet = !!json.adDetectionTranscriptionApiKey
    delete json.adDetectionLlmApiKey
    delete json.adDetectionTranscriptionApiKey
    json.timeZone = ServerSettings.getHostTimeZone()
    return json
  }

  get supportedAuthMethods() {
    return ['local', 'openid']
  }

  /**
   * Auth settings required for openid to be valid
   */
  get isOpenIDAuthSettingsValid() {
    return this.authOpenIDIssuerURL && this.authOpenIDAuthorizationURL && this.authOpenIDTokenURL && this.authOpenIDUserInfoURL && this.authOpenIDJwksURL && this.authOpenIDClientID && this.authOpenIDClientSecret && this.authOpenIDTokenSigningAlgorithm
  }

  get authenticationSettings() {
    return {
      authLoginCustomMessage: this.authLoginCustomMessage,
      authActiveAuthMethods: this.authActiveAuthMethods,
      authOpenIDIssuerURL: this.authOpenIDIssuerURL,
      authOpenIDAuthorizationURL: this.authOpenIDAuthorizationURL,
      authOpenIDTokenURL: this.authOpenIDTokenURL,
      authOpenIDUserInfoURL: this.authOpenIDUserInfoURL,
      authOpenIDJwksURL: this.authOpenIDJwksURL,
      authOpenIDLogoutURL: this.authOpenIDLogoutURL,
      authOpenIDClientID: this.authOpenIDClientID, // Do not return to client
      authOpenIDClientSecret: this.authOpenIDClientSecret, // Do not return to client
      authOpenIDTokenSigningAlgorithm: this.authOpenIDTokenSigningAlgorithm,
      authOpenIDButtonText: this.authOpenIDButtonText,
      authOpenIDAutoLaunch: this.authOpenIDAutoLaunch,
      authOpenIDAutoRegister: this.authOpenIDAutoRegister,
      authOpenIDMatchExistingBy: this.authOpenIDMatchExistingBy,
      authOpenIDMobileRedirectURIs: this.authOpenIDMobileRedirectURIs, // Do not return to client
      authOpenIDGroupClaim: this.authOpenIDGroupClaim, // Do not return to client
      authOpenIDAdvancedPermsClaim: this.authOpenIDAdvancedPermsClaim, // Do not return to client
      authOpenIDSubfolderForRedirectURLs: this.authOpenIDSubfolderForRedirectURLs,

      authOpenIDSamplePermissions: User.getSampleAbsPermissions()
    }
  }

  get authFormData() {
    const clientFormData = {
      authLoginCustomMessage: sanitize(this.authLoginCustomMessage)
    }
    if (this.authActiveAuthMethods.includes('openid')) {
      clientFormData.authOpenIDButtonText = this.authOpenIDButtonText
      clientFormData.authOpenIDAutoLaunch = this.authOpenIDAutoLaunch
    }
    return clientFormData
  }

  /**
   * Update server settings
   *
   * @param {Object} payload
   * @returns {boolean} true if updates were made
   */
  update(payload) {
    let hasUpdates = false
    for (const key in payload) {
      if (!PATCHABLE_SETTINGS_KEYS.has(key)) continue

      if (this[key] !== payload[key]) {
        if (key === 'logLevel') {
          Logger.setLogLevel(payload[key])
        }
        this[key] = payload[key]
        hasUpdates = true
      }
    }
    return hasUpdates
  }
}
module.exports = ServerSettings
