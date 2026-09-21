import LocalAudioPlayer from './LocalAudioPlayer'
import CastPlayer from './CastPlayer'
import AudioTrack from './AudioTrack'

export default class PlayerHandler {
  constructor(ctx) {
    this.ctx = ctx
    this.libraryItem = null
    this.episodeId = null
    this.displayTitle = null
    this.displayAuthor = null
    this.playWhenReady = false
    this.initialPlaybackRate = 1
    this.player = null
    this.playerState = 'IDLE'
    this.isHlsTranscode = false
    this.currentSessionId = null
    this.startTimeOverride = undefined // Used for starting playback at a specific time (i.e. clicking bookmark from library item page)
    this.startTime = 0

    this.failedProgressSyncs = 0
    this.lastSyncTime = 0
    this.listeningTimeSinceSync = 0

    this.playInterval = null

    // Segments the listener deliberately returned to. Skipping them again
    // would trap them in a loop they cannot get out of.
    this.unskippedSegmentIds = new Set()
    this.lastSkippedSegmentId = null
    this.lastSeekTime = 0
  }

  get isCasting() {
    return this.ctx.$store.state.globals.isCasting
  }
  get libraryItemId() {
    return this.libraryItem ? this.libraryItem.id : null
  }
  get isPlayingCastedItem() {
    return this.libraryItem && this.player instanceof CastPlayer
  }
  get isPlayingLocalItem() {
    return this.libraryItem && this.player instanceof LocalAudioPlayer
  }
  get playerPlaying() {
    return this.playerState === 'PLAYING'
  }
  get episode() {
    if (!this.episodeId) return null
    return this.libraryItem.media.episodes.find((ep) => ep.id === this.episodeId)
  }
  get jumpForwardAmount() {
    return this.ctx.$store.getters['user/getUserSetting']('jumpForwardAmount')
  }
  get jumpBackwardAmount() {
    return this.ctx.$store.getters['user/getUserSetting']('jumpBackwardAmount')
  }
  /**
   * The store is the single source of truth so that segments edited while
   * playing (socket "ad_segments_updated") take effect immediately.
   * @type {{id: string, startTime: number, endTime: number, label: string}[]}
   */
  get adSegments() {
    return this.ctx.$store.state.adSegments || []
  }
  get autoSkipAdsEnabled() {
    // Read settings directly - the getUserSetting getter coerces false to null
    if (this.ctx.$store.state.user.settings?.autoSkipAds === false) return false
    return this.ctx.$store.getters['getServerSetting']('adDetectionAutoSkip') !== false
  }

  setSessionId(sessionId) {
    this.currentSessionId = sessionId
    this.ctx.$store.commit('setPlaybackSessionId', sessionId)
  }

  load(libraryItem, episodeId, playWhenReady, playbackRate, startTimeOverride = undefined) {
    this.libraryItem = libraryItem

    this.episodeId = episodeId
    this.playWhenReady = playWhenReady
    this.initialPlaybackRate = playbackRate

    this.startTimeOverride = startTimeOverride == null || isNaN(startTimeOverride) ? undefined : Number(startTimeOverride)

    if (!this.player) this.switchPlayer(playWhenReady)
    else this.prepare()
  }

  switchPlayer(playWhenReady) {
    if (this.isCasting && !(this.player instanceof CastPlayer)) {
      console.log('[PlayerHandler] Switching to cast player')

      this.stopPlayInterval()
      this.playerStateChange('LOADING')

      this.startTime = this.player ? this.player.getCurrentTime() : this.startTime
      if (this.player) {
        this.player.destroy()
      }
      this.player = new CastPlayer(this.ctx)
      this.setPlayerListeners()

      if (this.libraryItem) {
        // libraryItem was already loaded - prepare for cast
        this.playWhenReady = playWhenReady
        this.prepare()
      }
    } else if (!this.isCasting && !(this.player instanceof LocalAudioPlayer)) {
      console.log('[PlayerHandler] Switching to local player')

      this.stopPlayInterval()
      this.playerStateChange('LOADING')

      if (this.player) {
        this.player.destroy()
      }

      this.player = new LocalAudioPlayer(this.ctx)

      this.setPlayerListeners()

      if (this.libraryItem) {
        // libraryItem was already loaded - prepare for local play
        this.playWhenReady = playWhenReady
        this.prepare()
      }
    }
  }

  setPlayerListeners() {
    this.player.on('stateChange', this.playerStateChange.bind(this))
    this.player.on('timeupdate', this.playerTimeupdate.bind(this))
    this.player.on('buffertimeUpdate', this.playerBufferTimeUpdate.bind(this))
    this.player.on('error', this.playerError.bind(this))
    this.player.on('finished', this.playerFinished.bind(this))
  }

  playerError() {
    // Switch to HLS stream on error
    if (!this.isCasting && this.player instanceof LocalAudioPlayer) {
      console.log(`[PlayerHandler] Audio player error switching to HLS stream`)
      this.prepare(true)
    }
  }

  playerFinished() {
    this.stopPlayInterval()

    var currentTime = this.player.getCurrentTime()
    this.ctx.setCurrentTime(currentTime)

    // TODO: Add listening time between last sync and now?
    this.sendProgressSync(currentTime)

    this.ctx.mediaFinished(this.libraryItemId, this.episodeId)
  }

  playerStateChange(state) {
    console.log('[PlayerHandler] Player state change', state)
    this.playerState = state

    if (this.playerState === 'PLAYING') {
      this.setPlaybackRate(this.initialPlaybackRate)
      this.startPlayInterval()
    } else {
      this.stopPlayInterval()
    }

    if (this.player) {
      if (this.playerState === 'LOADED' || this.playerState === 'PLAYING') {
        this.ctx.setDuration(this.getDuration())
      }
      if (this.playerState !== 'LOADING') {
        this.ctx.setCurrentTime(this.player.getCurrentTime())
      }
    }

    this.ctx.setPlaying(this.playerState === 'PLAYING')
    this.ctx.playerLoading = this.playerState === 'LOADING'
  }

  playerTimeupdate(time) {
    this.ctx.setCurrentTime(time)
    this.checkSkipAdSegment(time)
  }

  /**
   * Replace the ad segments for the item being played.
   *
   * @param {Object[]} segments
   */
  setAdSegments(segments) {
    this.unskippedSegmentIds = new Set()
    this.lastSkippedSegmentId = null
    this.ctx.$store.commit('setAdSegments', Array.isArray(segments) ? segments.filter((segment) => segment.enabled !== false) : [])
  }

  /**
   * The segment containing this time, if any.
   *
   * @param {number} time
   * @returns {Object|null}
   */
  getAdSegmentAtTime(time) {
    // A small lead-in catches the seam before the first word of the ad
    return this.adSegments.find((segment) => time >= segment.startTime - 0.25 && time < segment.endTime - 0.25) || null
  }

  /**
   * Seek past an ad segment when playback enters one.
   *
   * Deliberately conservative: a segment is skipped at most once per session,
   * never when the listener just seeked backwards into it, and never when the
   * remaining audio after it is too short to be worth a jump.
   *
   * @param {number} time
   */
  checkSkipAdSegment(time) {
    if (!this.adSegments.length || !this.autoSkipAdsEnabled) return
    if (!this.playerPlaying) return

    const segment = this.getAdSegmentAtTime(time)
    if (!segment) {
      if (this.lastSkippedSegmentId && !this.getAdSegmentAtTime(time)) {
        this.lastSkippedSegmentId = null
      }
      return
    }

    if (this.unskippedSegmentIds.has(segment.id)) return
    if (this.lastSkippedSegmentId === segment.id) return

    // Seeking backwards into an ad is an explicit "I want to hear this"
    if (Date.now() - this.lastSeekTime < 5000) {
      this.unskippedSegmentIds.add(segment.id)
      return
    }

    const duration = this.getDuration()
    const target = segment.endTime + 0.1
    if (duration && target >= duration - 0.5) {
      // Nothing meaningful left after the ad - let it play out rather than
      // ending the episode early.
      return
    }

    this.lastSkippedSegmentId = segment.id
    console.log(`[PlayerHandler] Skipping ad segment ${segment.id} (${segment.startTime} -> ${segment.endTime})`)
    this.seek(target, true, true)
    this.ctx.onAdSegmentSkipped?.(segment)
  }

  /**
   * Return to the start of a segment and stop skipping it this session.
   *
   * @param {Object} segment
   */
  undoAdSkip(segment) {
    if (!segment) return
    this.unskippedSegmentIds.add(segment.id)
    this.lastSkippedSegmentId = null
    this.seek(Math.max(0, segment.startTime))
  }

  playerBufferTimeUpdate(buffertime) {
    this.ctx.setBufferTime(buffertime)
  }

  getDeviceId() {
    let deviceId = localStorage.getItem('absDeviceId')
    if (!deviceId) {
      deviceId = this.ctx.$randomId()
      localStorage.setItem('absDeviceId', deviceId)
    }
    return deviceId
  }

  async prepare(forceTranscode = false) {
    this.setSessionId(null) // Reset session

    const payload = {
      deviceInfo: {
        clientName: 'Abs Web',
        deviceId: this.getDeviceId()
      },
      supportedMimeTypes: this.player.playableMimeTypes,
      mediaPlayer: this.isCasting ? 'chromecast' : 'html5',
      forceTranscode,
      forceDirectPlay: this.isCasting // TODO: add transcode support for chromecast
    }

    const path = this.episodeId ? `/api/items/${this.libraryItem.id}/play/${this.episodeId}` : `/api/items/${this.libraryItem.id}/play`
    const session = await this.ctx.$axios.$post(path, payload).catch((error) => {
      console.error('Failed to start stream', error)
    })
    this.prepareSession(session)
  }

  prepareOpenSession(session, playbackRate) {
    // Session opened on init socket
    if (!this.player) this.switchPlayer() // Must set player first for open sessions

    this.libraryItem = session.libraryItem
    this.playWhenReady = false
    this.initialPlaybackRate = playbackRate
    this.startTimeOverride = undefined
    this.lastSyncTime = 0
    this.listeningTimeSinceSync = 0

    this.prepareSession(session)
  }

  prepareSession(session) {
    this.failedProgressSyncs = 0
    this.startTime = this.startTimeOverride !== undefined ? this.startTimeOverride : session.currentTime
    this.setSessionId(session.id)
    this.displayTitle = session.displayTitle
    this.displayAuthor = session.displayAuthor

    console.log('[PlayerHandler] Preparing Session', session)

    this.setAdSegments(session.adSegments || [])

    var audioTracks = session.audioTracks.map((at) => new AudioTrack(at, session.id, this.ctx.$config.routerBasePath))

    this.ctx.playerLoading = true
    this.isHlsTranscode = true
    if (session.playMethod === this.ctx.$constants.PlayMethod.DIRECTPLAY) {
      this.isHlsTranscode = false
    }

    this.player.set(this.libraryItem, audioTracks, this.isHlsTranscode, this.startTime, this.playWhenReady)

    // browser media session api
    this.ctx.setMediaSession()
  }

  closePlayer() {
    console.log('[PlayerHandler] Close Player')
    this.sendCloseSession()
    this.resetPlayer()
  }

  resetPlayer() {
    if (this.player) {
      this.player.destroy()
    }
    this.player = null
    this.playerState = 'IDLE'
    this.libraryItem = null
    this.setSessionId(null)
    this.startTime = 0
    this.stopPlayInterval()
  }

  resetStream(startTime, streamId) {
    if (this.isHlsTranscode && this.currentSessionId === streamId) {
      this.player.resetStream(startTime)
    } else {
      console.warn('resetStream mismatch streamId', this.currentSessionId, streamId)
    }
  }

  /**
   * First sync happens after 20 seconds
   * subsequent syncs happen every 10 seconds
   */
  startPlayInterval() {
    clearInterval(this.playInterval)
    let lastTick = Date.now()
    this.playInterval = setInterval(() => {
      // Update UI
      if (!this.player) return
      const currentTime = this.player.getCurrentTime()
      this.ctx.setCurrentTime(currentTime)

      const exactTimeElapsed = (Date.now() - lastTick) / 1000
      lastTick = Date.now()
      this.listeningTimeSinceSync += exactTimeElapsed
      const TimeToWaitBeforeSync = this.lastSyncTime > 0 ? 10 : 20
      if (this.listeningTimeSinceSync >= TimeToWaitBeforeSync) {
        this.sendProgressSync(currentTime)
      }
    }, 1000)
  }

  sendCloseSession() {
    let syncData = null
    if (this.player) {
      const listeningTimeToAdd = Math.max(0, Math.floor(this.listeningTimeSinceSync))
      // When opening player and quickly closing dont save progress
      if (listeningTimeToAdd > 20) {
        syncData = {
          timeListened: listeningTimeToAdd,
          currentTime: this.getCurrentTime()
        }
      }
    }
    this.listeningTimeSinceSync = 0
    this.lastSyncTime = 0
    return this.ctx.$axios.$post(`/api/session/${this.currentSessionId}/close`, syncData, { timeout: 6000, progress: false }).catch((error) => {
      console.error('Failed to close session', error)
    })
  }

  sendProgressSync(currentTime) {
    const diffSinceLastSync = Math.abs(this.lastSyncTime - currentTime)
    if (diffSinceLastSync < 1) return

    this.lastSyncTime = currentTime
    const listeningTimeToAdd = Math.max(0, Math.floor(this.listeningTimeSinceSync))
    const syncData = {
      timeListened: listeningTimeToAdd,
      currentTime
    }

    this.listeningTimeSinceSync = 0
    this.ctx.$axios
      .$post(`/api/session/${this.currentSessionId}/sync`, syncData, { timeout: 9000, progress: false })
      .then(() => {
        this.failedProgressSyncs = 0
      })
      .catch((error) => {
        console.error('Failed to update session progress', error)
        // After 4 failed sync attempts show an alert toast
        this.failedProgressSyncs++
        if (this.failedProgressSyncs >= 4) {
          this.ctx.showFailedProgressSyncs()
          this.failedProgressSyncs = 0
        }
      })
  }

  stopPlayInterval() {
    clearInterval(this.playInterval)
    this.playInterval = null
  }

  playPause() {
    if (this.player) this.player.playPause()
  }

  play() {
    if (this.player) this.player.play()
  }

  pause() {
    if (this.player) this.player.pause()
  }

  getCurrentTime() {
    return this.player ? this.player.getCurrentTime() : 0
  }

  getDuration() {
    return this.player ? this.player.getDuration() : 0
  }

  jumpBackward() {
    if (!this.player) return
    var currentTime = this.getCurrentTime()
    const jumpAmount = this.jumpBackwardAmount
    this.seek(Math.max(0, currentTime - jumpAmount))
  }

  jumpForward() {
    if (!this.player) return
    var currentTime = this.getCurrentTime()
    const jumpAmount = this.jumpForwardAmount
    this.seek(Math.min(currentTime + jumpAmount, this.getDuration()))
  }

  setVolume(volume) {
    if (!this.player) return
    this.player.setVolume(volume)
  }

  setPlaybackRate(playbackRate) {
    this.initialPlaybackRate = playbackRate // Might be loaded from settings before player is started
    if (!this.player) return
    this.player.setPlaybackRate(playbackRate)
  }

  seek(time, shouldSync = true, isAdSkip = false) {
    if (!this.player) return
    // Only a listener seeking backwards suppresses ad skipping - the skip
    // itself must not suppress the next one.
    if (!isAdSkip && time < this.getCurrentTime()) {
      this.lastSeekTime = Date.now()
    }
    this.player.seek(time, this.playerPlaying)
    this.ctx.setCurrentTime(time)

    // Update progress if paused
    if (!this.playerPlaying && shouldSync) {
      this.sendProgressSync(time)
    }
  }
}
