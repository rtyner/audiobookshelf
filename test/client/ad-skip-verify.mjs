// Verifies PlayerHandler's ad-skip decisions by driving it with a fake player
// and store.
//
// This lives outside the mocha suite because PlayerHandler is a browser ES
// module while the server suite runs the compiled CommonJS build. Run it with:
//
//   npm run test:client
//
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const root = process.env.ABS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const src = fs.readFileSync(path.join(root, 'client/players/PlayerHandler.js'), 'utf8')
  .replace(/^import .*$/gm, '')
const shim = path.join(os.tmpdir(), 'abs-player-handler-shim.mjs')
fs.writeFileSync(shim, src.replace('export default class PlayerHandler', 'export default class PlayerHandler'))
const { default: PlayerHandler } = await import(shim)

const segments = [
  { id: 'a', startTime: 100, endTime: 160, enabled: true, label: 'midroll' },
  { id: 'b', startTime: 400, endTime: 460, enabled: true, label: 'midroll' }
]

function makeCtx({ autoSkipServer = true, autoSkipUser = true } = {}) {
  const state = { adSegments: [...segments], user: { settings: { autoSkipAds: autoSkipUser } } }
  return {
    skipped: [],
    $store: {
      state,
      commit: (name, value) => {
        if (name === 'setAdSegments') state.adSegments = value
      },
      getters: {
        getServerSetting: (key) => (key === 'adDetectionAutoSkip' ? autoSkipServer : null),
        'user/getUserSetting': () => null
      }
    },
    setCurrentTime() {},
    onAdSegmentSkipped(segment) {
      this.skipped.push(segment.id)
    }
  }
}

function makeHandler(opts) {
  const ctx = makeCtx(opts)
  const handler = new PlayerHandler(ctx)
  handler.playerState = 'PLAYING'
  handler.seeks = []
  handler.player = { seek: () => {}, getCurrentTime: () => handler.currentTime }
  handler.currentTime = 0
  handler.getDuration = () => 3600
  handler.getCurrentTime = () => handler.currentTime
  handler.seek = (time, sync = true, isAdSkip = false) => {
    if (!isAdSkip && time < handler.currentTime) handler.lastSeekTime = Date.now()
    handler.seeks.push(time)
    handler.currentTime = time
  }
  return { handler, ctx }
}

let failures = 0
const check = (name, cond) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`)
  if (!cond) failures++
}

// 1. skips on entering a segment
{
  const { handler, ctx } = makeHandler()
  handler.currentTime = 99
  handler.checkSkipAdSegment(100.5)
  check('seeks past the ad', handler.seeks.length === 1 && Math.abs(handler.seeks[0] - 160.1) < 0.001)
  check('notifies the UI once', ctx.skipped.length === 1)
}

// 2. does not skip outside a segment
{
  const { handler } = makeHandler()
  handler.checkSkipAdSegment(300)
  check('leaves normal content alone', handler.seeks.length === 0)
}

// 3. never loops on the same segment
{
  const { handler } = makeHandler()
  handler.checkSkipAdSegment(100.5)
  handler.checkSkipAdSegment(100.5)
  handler.checkSkipAdSegment(120)
  check('skips a segment at most once in a row', handler.seeks.length === 1)
}

// 4. undo suppresses that segment for the session
{
  const { handler } = makeHandler()
  handler.checkSkipAdSegment(100.5)
  handler.undoAdSkip(segments[0])
  handler.currentTime = 100
  handler.checkSkipAdSegment(101)
  check('undo returns to the ad start', handler.seeks[1] === 100)
  check('does not re-skip an undone segment', handler.seeks.length === 2)
}

// 5. a recent backwards seek suppresses skipping
{
  const { handler } = makeHandler()
  handler.currentTime = 200
  handler.seek(110)
  handler.checkSkipAdSegment(110)
  check('respects a deliberate seek back into an ad', handler.seeks.length === 1)
}

// 6. honours the settings
{
  const { handler } = makeHandler({ autoSkipServer: false })
  handler.checkSkipAdSegment(100.5)
  check('server auto-skip off disables skipping', handler.seeks.length === 0)

  const { handler: h2 } = makeHandler({ autoSkipUser: false })
  h2.checkSkipAdSegment(100.5)
  check('user opt-out disables skipping', h2.seeks.length === 0)
}

// 7. paused playback does not skip
{
  const { handler } = makeHandler()
  handler.playerState = 'PAUSED'
  handler.checkSkipAdSegment(100.5)
  check('does not skip while paused', handler.seeks.length === 0)
}

// 8. an ad running to the end of the episode is left alone
{
  const { handler, ctx } = makeHandler()
  ctx.$store.state.adSegments = [{ id: 'c', startTime: 3500, endTime: 3599.9, enabled: true }]
  handler.checkSkipAdSegment(3501)
  check('does not end the episode early', handler.seeks.length === 0)
}

// 9. disabled segments are ignored
{
  const { handler } = makeHandler()
  handler.setAdSegments([{ id: 'd', startTime: 100, endTime: 160, enabled: false }])
  handler.checkSkipAdSegment(100.5)
  check('ignores disabled segments', handler.seeks.length === 0)
}

console.log(failures ? `\n${failures} FAILURES` : '\nAll ad-skip behaviours verified')
process.exit(failures ? 1 : 0)
