# AI-Powered Podcast Ad Detection & Skipping - Implementation Plan

Target repo: `rtyner/audiobookshelf` (fork of `advplyr/audiobookshelf`), base `master` @ v2.36.1.
Audience: an implementing agent. Every phase below is independently shippable and testable.

---

## 1. Goal

For podcast episodes, automatically:
1. Transcribe the downloaded audio to timestamped text.
2. Detect in-episode advertisement segments (host-read and dynamically inserted).
3. Skip those segments during playback, with the user able to see, correct, and disable them.

Non-goals (explicitly out of scope for v1):
- Re-encoding/cutting the audio file. Segments stay metadata-only so they are reversible and do not break existing progress timestamps, RSS feeds, or downloads.
- Books. Podcasts only.
- Offline mobile-app skipping. v1 exposes segments over the API; the mobile apps are separate repos.

---

## 2. What already exists in the codebase (read these first)

| Concern | File | Why it matters |
|---|---|---|
| Podcast episode model + JSON columns | `server/models/PodcastEpisode.js` | `chapters` and `extraData` are already `DataTypes.JSON`; the ad-segment table will FK to `podcastEpisodes.id` |
| Download -> probe -> add episode pipeline | `server/managers/PodcastManager.js` (`startPodcastEpisodeDownload` ~L73, `scanAddPodcastEpisodeAudioFile` ~L192, `episode_added` emit ~L256) | This is the single hook point where a newly downloaded episode becomes available. Ad detection is queued here. |
| Background jobs + progress UI | `server/managers/TaskManager.js`, `server/objects/Task.js` | `createAndAddTask` / `taskFinished` emit `task_started` / `task_finished` over socket; the client already renders these |
| External binary download/management | `server/managers/BinaryManager.js` (`ZippedAssetDownloader`) | Existing precedent for fetching ffmpeg/ffprobe from GitHub releases. Reuse for `whisper.cpp` |
| ffmpeg invocation helpers | `server/utils/ffmpegHelpers.js` | Use for extracting 16 kHz mono PCM/WAV for the transcriber |
| Pluggable provider pattern | `server/models/CustomMetadataProvider.js`, `server/controllers/CustomMetadataProviderController.js` | Copy this shape for user-configurable transcription/LLM providers (URL + API key + name, stored in DB) |
| Server settings | `server/objects/settings/ServerSettings.js` | Add global defaults here |
| Route registration | `server/routers/ApiRouter.js` (podcast routes ~L248-260) | Add new routes alongside |
| Migration template | `server/migrations/v2.33.0-add-discover-query-indexes.js` | Exact `up`/`down` + `migrationVersion` shape to copy |
| Client playback loop | `client/players/PlayerHandler.js` (`playerTimeupdate` ~L132), `client/players/LocalAudioPlayer.js` | Where the skip decision is made |
| Player UI | `client/components/player/PlayerTrackBar.vue`, `PlayerUi.vue` | Where ad markers render |
| Tests | `test/server/**` (mocha, run via `npm test`) | Mirror existing dir structure |

Note: the server is built (`npm run build:server`, tsc) before tests run. Client is Nuxt 2 in `client/`.

---

## 3. Architecture

```
episode downloaded (PodcastManager)
        |
        v
  AdDetectionManager.queueEpisode(episodeId)      <- serial queue, 1 job at a time
        |
        +-- 1. audio prep    ffmpeg -> 16kHz mono wav in /metadata/cache/addetect/<id>.wav
        +-- 2. transcribe    TranscriptionProvider -> [{start,end,text}]
        +-- 3. persist       transcript JSON -> /metadata/transcripts/<episodeId>.json
        +-- 4. detect        AdDetectionProvider(transcript) -> [{start,end,confidence,label}]
        +-- 5. persist       rows in `mediaItemAdSegments`
        +-- 6. emit          socket `ad_segments_updated` + task_finished
        |
        v
client PlayerHandler loads segments with the play session
        |
        v
  on timeupdate: if inside an enabled segment -> seek(end + epsilon), toast w/ undo
```

Two provider interfaces, both pluggable, both with a local-first default:

**TranscriptionProvider** (`server/providers/transcription/`)
- `WhisperCppProvider` (default): binary managed by a new `WhisperBinaryManager` extending the `BinaryManager` pattern; model file (`ggml-base.en.bin`, ~148 MB) downloaded on first use into `/metadata/models/`. Runs `whisper-cli -oj` and parses the JSON output for segment timestamps.
- `OpenAICompatibleProvider`: POST multipart to `{baseUrl}/v1/audio/transcriptions` with `response_format=verbose_json` (works with OpenAI, Groq, local faster-whisper servers).
- Interface: `async transcribe(wavPath, { language }) -> { segments: [{start, end, text}], language, durationMs }`

**AdDetectionProvider** (`server/providers/addetection/`)
- `LlmAdDetectionProvider` (default): chunks the transcript into overlapping windows (~4 min of text, 30 s overlap), sends each window with timestamps to a chat-completions endpoint (OpenAI-compatible; covers OpenAI, Anthropic via gateway, Ollama, vLLM), asks for strict JSON ad spans, then merges/dedupes overlapping spans across windows.
- `HeuristicAdDetectionProvider` (fallback / no-LLM mode): keyword + phrase scoring ("this episode is brought to you by", "promo code", "slash podcast", URL reads) with a boundary snap to the nearest silence. Useful as a test double and for users who refuse to run an LLM.
- Interface: `async detect(transcript, { episodeMeta }) -> [{start, end, confidence, label, source}]`

Post-processing shared by all providers (`server/utils/adSegmentUtils.js`):
- merge segments closer than 3 s
- drop segments shorter than 5 s or longer than 25% of the episode
- snap boundaries to nearest silence using `ffmpeg -af silencedetect` within a +/-4 s window
- clamp to [0, duration]

---

## 4. Data model

New table `mediaItemAdSegments` (a table, not a JSON blob on the episode, so segments are queryable, per-user-correctable, and independently versioned):

| column | type | notes |
|---|---|---|
| `id` | UUID PK | |
| `mediaItemId` | UUID | `podcastEpisodes.id` (generic column name leaves room for books later) |
| `mediaItemType` | STRING | `'podcastEpisode'` |
| `startTime` | FLOAT | seconds |
| `endTime` | FLOAT | seconds |
| `confidence` | FLOAT | 0-1 |
| `label` | STRING | e.g. `preroll`, `midroll`, `postroll`, `selfpromo` |
| `source` | STRING | `'ai'` \| `'user'` \| `'imported'` |
| `enabled` | BOOLEAN | user can disable one segment without deleting it |
| `createdAt`/`updatedAt` | DATE | |

Indexes: `(mediaItemId, mediaItemType)`, `(mediaItemId, startTime)`.
FK to `podcastEpisodes` is not enforceable across polymorphic types - delete segments explicitly in the episode-delete path (`PodcastController.removeEpisode`).

Also add to `podcastEpisodes.extraData` (no migration needed, it is JSON):
- `adDetectionStatus`: `null | 'queued' | 'transcribing' | 'detecting' | 'complete' | 'failed' | 'skipped'`
- `adDetectionError`: string | null
- `adDetectionVersion`: int (bump to force reprocess on algorithm change)
- `transcriptPath`: relative path under metadata

Transcripts live on disk, not in SQLite: `/metadata/transcripts/<podcastEpisodeId>.json`. They are 50-300 KB each and would bloat the DB and every episode query.

Migration: `server/migrations/v2.37.0-add-ad-segments.js`, copying the exact shape of `v2.33.0-add-discover-query-indexes.js` (`up`, `down`, `migrationVersion`, `loggerPrefix`). `down` drops the table.

---

## 5. Settings

`ServerSettings.js` additions (+ `toJSON`/`construct` handling, matching the existing style):
- `adDetectionEnabled` (bool, default `false` - opt-in)
- `adDetectionAutoRun` (bool, default `true`) - run on newly downloaded episodes
- `adDetectionAutoSkip` (bool, default `true`) - client auto-seeks vs just showing markers
- `adDetectionMinConfidence` (float, default `0.7`)
- `adDetectionTranscriptionProvider` (`'whisper-local' | 'openai-compatible'`)
- `adDetectionModel` (string, default `'base.en'`)
- `adDetectionLlmProvider` (`'none' | 'openai-compatible'`)
- `adDetectionConcurrency` (int, default `1`)

API keys/base URLs for remote providers go in a DB-backed provider row (mirroring `CustomMetadataProvider`), never in `ServerSettings` JSON that is served broadly - check `ServerSettings.toJSONForBrowser` and keep secrets out.

Per-podcast override on `podcasts.extraData`: `adDetectionEnabled: true|false|null` (null = inherit server).
Per-user override on user settings: `autoSkipAds` bool, so one user can disable skipping without changing detection.

---

## 6. API surface

All under the existing auth middleware in `ApiRouter.js`:

```
GET    /api/podcasts/:id/episode/:episodeId/ad-segments      -> { segments, status, transcriptAvailable }
POST   /api/podcasts/:id/episode/:episodeId/ad-segments      -> queue detection (force=true to re-run)
PATCH  /api/podcasts/:id/episode/:episodeId/ad-segments/:segId -> edit start/end/enabled  (admin/update perm)
DELETE /api/podcasts/:id/episode/:episodeId/ad-segments/:segId
GET    /api/podcasts/:id/episode/:episodeId/transcript       -> the transcript JSON
POST   /api/libraries/:id/ad-detection/backfill              -> queue all undetected episodes (admin only)
```

Also include `adSegments` in the play-session payload so the client does not need a second round trip: extend `PlaybackSessionManager.startSession` output (see `server/managers/PlaybackSessionManager.js`) with the enabled segments for the episode. This is the key integration point for the mobile apps too.

New controller: `server/controllers/AdSegmentController.js`, following `PodcastController`'s `middleware.bind(this)` pattern for library-item lookup + permission checks.

Socket events (via `SocketAuthority.emitter`): `ad_detection_started`, `ad_detection_finished`, `ad_segments_updated` (payload `{ episodeId, segments, status }`).

---

## 7. Client behaviour

**Skipping** (`client/players/PlayerHandler.js`):
- Load `this.adSegments` when the session starts (from the session payload).
- In `playerTimeupdate` (~L132), after `getCurrentTime()`, find an enabled segment where `start - 0.25 <= t < end`. If found and auto-skip is on and this segment was not just un-skipped by the user, call `this.seek(segment.end + 0.1)` and emit a UI event.
- Guard against loops: keep a `recentlySkipped` Set of segment ids for 10 s; never skip the same segment twice in a row; never skip if the user seeked backwards into it within the last 5 s (that is an explicit "I want to hear this").
- Handle the multi-track offset correctly - `PlayerHandler` times are already whole-item times; `LocalAudioPlayer.seek` (~L273) does the track-offset math. Podcast episodes are single-track, so this is simple, but do not assume it.

**UI**
- `PlayerTrackBar.vue`: render enabled ad segments as translucent amber bands on the bar (same coordinate math as chapter ticks).
- `PlayerUi.vue`: transient toast "Skipped 82s ad - Undo", where Undo seeks back to `segment.start` and marks the segment as un-skipped for this session.
- Episode detail modal: an "Ad segments" section listing segments with start/end/confidence, enable toggles, delete, and an "Add segment" using the current playhead. Editing sets `source: 'user'` so a re-run never overwrites user edits (re-runs must preserve `source === 'user'` rows).
- Library settings: per-podcast "Detect ads" tri-state.
- Server settings page (`client/components/app/SettingsContent.vue` / `client/pages/config/`): the global toggles and provider config.
- i18n: add all new strings to `client/strings/en-us.json` (every other locale falls back).

---

## 8. Phases

Each phase ends green (`npm run lint`, `npm test`) and is one commit or PR.

**Phase 1 - Data + API skeleton (half a day)**
1. `server/models/MediaItemAdSegment.js` + register in `server/Database.js`.
2. Migration `v2.37.0-add-ad-segments.js`.
3. `AdSegmentController.js` + routes; CRUD only, no AI.
4. Include enabled segments in the play-session payload.
5. Tests: `test/server/models/MediaItemAdSegment.test.js`, `test/server/controllers/AdSegmentController.test.js`.
Done when: you can POST a segment by hand with curl and GET it back.

**Phase 2 - Client skip + markers (half a day)**
6. `PlayerHandler` skip logic with the anti-loop guards.
7. Track-bar bands, skip toast with undo.
8. Per-user `autoSkipAds` setting.
Done when: a hand-inserted segment from Phase 1 is visibly skipped in the web player. **This is the real E2E checkpoint - do it before any AI work**, so the AI layer is dropped into a proven pipeline.

**Phase 3 - Transcription (1-2 days)**
9. `server/utils/audioPrep.js`: ffmpeg extract to 16 kHz mono WAV in the cache dir; delete after use.
10. `WhisperBinaryManager` (extend the `BinaryManager` pattern) + model download with progress via `TaskManager`.
11. `WhisperCppProvider` + `OpenAICompatibleProvider` behind the `TranscriptionProvider` interface.
12. Transcript persistence + `GET .../transcript`.
13. Tests with a 30 s fixture and a stubbed provider; do not run whisper in CI.
Done when: `POST .../ad-segments?transcribeOnly=1` on a real episode writes a transcript with sane timestamps.

**Phase 4 - Ad detection (1-2 days)**
14. `HeuristicAdDetectionProvider` first (deterministic, fully testable).
15. `LlmAdDetectionProvider`: windowing, strict-JSON prompt, response validation, cross-window merge, retry-once-on-malformed-JSON.
16. `adSegmentUtils.js`: merge/filter/silence-snap/clamp.
17. `AdDetectionManager`: serial queue, status transitions on `extraData`, task + socket events, failure handling.
18. Hook into `PodcastManager` after `scanAddPodcastEpisodeAudioFile` when auto-run is enabled.
19. Tests: golden transcripts in `test/server/fixtures/` with known ad spans; assert precision/recall against them.
Done when: downloading a new episode of a known ad-heavy podcast produces correct segments end to end.

**Phase 5 - Management UI + backfill (1 day)**
20. Segment editor in the episode modal, per-podcast toggle, server settings page, backfill endpoint + a rate-limited library-wide job.
21. Docs: `docs/ad-detection.md` covering CPU/RAM cost, model sizes, and the remote-provider option.

Total: roughly 5-7 focused days.

---

## 9. Risks and the decisions taken

- **Compute cost.** whisper.cpp `base.en` runs ~5-10x realtime on a modern x86 core; a 60 min episode is ~6-12 min of CPU. Mitigation: serial queue, off by default, `small.en` opt-in, remote-provider escape hatch. Document this prominently - it is the main reason this cannot be on by default upstream.
- **LLM false positives cutting content.** Mitigation: confidence threshold, max-segment-length cap, undo toast, markers-only mode (`adDetectionAutoSkip=false`) as the recommended first run.
- **Timestamp drift** between whisper segments and real audio. Mitigation: silence-snap post-process; never trust the LLM's own numbers, only the transcript segment boundaries it references.
- **User edits lost on re-run.** Mitigation: `source: 'user'` rows are never deleted by a re-run; AI rows overlapping a user row are dropped.
- **Upstream mergeability.** Keep every new file additive and every hook a single call site. Do not refactor `PodcastManager` or `PlayerHandler` beyond the insertion points. If upstream ever wants this, it should be a clean opt-in diff.
- **Secrets.** Provider API keys must not leak through `ServerSettings.toJSONForBrowser` or the socket `init` payload. Verify explicitly.

---

## 10. First concrete step for the implementing agent

Create a worktree off `origin/master`, then write `server/models/MediaItemAdSegment.js` and the migration, and get `npm test` green. Do not touch any AI code until Phase 2's hand-inserted segment visibly skips in the web player.
