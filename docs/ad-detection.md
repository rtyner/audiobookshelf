# AI Podcast Ad Detection

Transcribes podcast episodes, detects advertisement segments, and skips them
during playback. Off by default.

Ads are stored as **metadata only** - the audio file is never modified. That
means detection can be re-run, individual segments can be disabled, a listener
can undo a skip mid-episode, and nothing about existing progress, RSS feeds or
downloads changes.

---

## Turning it on

1. Settings -> Ad Detection -> **Enable AI ad detection**
2. Pick a transcription provider (below)
3. Pick an ad detection provider and enter its API key
4. Save

New episodes are processed as they download. Existing episodes are processed
via **Detect ads** in the episode modal, or a library-wide backfill:

```
POST /api/libraries/:id/ad-detection/backfill
```

The first run per server downloads a speech model, which takes a few minutes.

---

## Choosing providers

Two independent stages. Transcription turns audio into timestamped text;
detection reads that text and returns ad spans.

### Transcription

| Provider | When to use it | Cost |
| --- | --- | --- |
| `whisper.cpp (local)` | The host CPU supports **AVX2** | CPU only |
| `OpenAI-compatible API` | Everything else: a faster-whisper sidecar, OpenAI, Groq | CPU on the sidecar, or per-minute |

**Check for AVX2 before choosing local whisper.cpp:**

```bash
grep -o avx2 /proc/cpuinfo | head -1
```

If that prints nothing, the published whisper.cpp binaries will die with
`SIGILL` (illegal instruction) on this host. Use the OpenAI-compatible option
pointed at a faster-whisper sidecar instead - CTranslate2 runs on plain AVX.
The bundled compose stack in `docker/ad-detection/` does exactly this.

whisper.cpp is not auto-installed. Set `WHISPER_PATH` to the binary, or put
`whisper-cli` on `PATH`. The GGML model file *is* downloaded automatically into
`/metadata/models/`.

**Budget for local transcription.** On an AVX-only Xeon at 3 cores,
faster-whisper `small.en` runs at roughly **3x realtime** - a one hour episode
takes about 20 minutes of wall clock. Jobs run one at a time on purpose, so
transcription never starves playback transcoding.

The model file is downloaded on first use. If it cannot be reached the job
fails within a minute with the reason, rather than hanging - a stalled
download is aborted and the partial file removed.

### Ad detection

| Provider | Notes |
| --- | --- |
| `OpenAI-compatible API` | Default. Works with DeepSeek, OpenAI, Groq, OpenRouter, Ollama, vLLM |
| `Keyword heuristic (no AI)` | No network, no transcript leaves the server. Conservative - it misses ads rather than cutting content |

DeepSeek is the default: base URL `https://api.deepseek.com/v1`, model
`deepseek-chat`. To use something else, change the base URL and model - the
request shape is identical.

DeepSeek has no audio transcription endpoint, so a DeepSeek setup pairs it with
local or sidecar whisper for the transcription stage.

The transcript is sent to the detection provider in overlapping ~4 minute
windows. A single episode is a few dozen small requests.

---

## Configuration

Set in Settings -> Ad Detection, or via `PATCH /api/settings`:

| Setting | Default | Meaning |
| --- | --- | --- |
| `adDetectionEnabled` | `false` | Master switch |
| `adDetectionAutoRun` | `true` | Process newly downloaded episodes |
| `adDetectionAutoSkip` | `true` | Seek past ads, vs only showing markers |
| `adDetectionMinConfidence` | `0.7` | Segments below this are discarded |
| `adDetectionTranscriptionProvider` | `whisper-local` | `whisper-local` or `openai-compatible` |
| `adDetectionWhisperModel` | `base.en` | GGML model name |
| `adDetectionLlmProvider` | `llm` | `llm` or `none` (heuristic) |
| `adDetectionLlmBaseUrl` | DeepSeek | Any OpenAI-compatible base URL |
| `adDetectionLlmModel` | `deepseek-chat` | Model name |

API keys are write-only: they are never returned to the browser. They can also
be supplied through the environment, which keeps them out of the settings row
entirely:

- `AD_DETECTION_LLM_API_KEY`
- `AD_DETECTION_TRANSCRIPTION_API_KEY`

Per-podcast override: `podcast.extraData.adDetectionEnabled` (`true`, `false`,
or absent to inherit the server default).

Per-user override: the `autoSkipAds` user setting disables skipping for one
listener without changing detection.

---

## What a listener sees

- Ad segments appear as amber bands on the player track bar
- When playback reaches one, it seeks past it and shows
  **"Skipped 1:22 of ads - Undo"**
- Undo returns to the start of the segment and will not skip it again this
  session

Anti-loop rules: each segment is skipped at most once per session, a segment is
never skipped if the listener seeked backwards within the last 5 seconds, and a
segment running to the end of the episode is left alone rather than ending
playback early.

**Skipping is client-side.** The web player and Chromecast honour segments
today. Third-party and mobile apps need to read `adSegments` from the play
session response to participate. If ads must be gone regardless of the player,
the audio has to be re-cut, which this feature deliberately does not do.

---

## Correcting a detection

Episode modal -> **Ad segments**:

- the eye toggle disables a segment without deleting it
- delete removes it
- **Detect ads** re-runs the pipeline

A segment you create or edit is marked `source: user`. Re-running detection
never deletes a user segment, and any AI segment overlapping one is dropped.
Your boundaries always win.

---

## How it works

```
episode downloaded
  -> ffmpeg: decode to 16 kHz mono WAV
  -> transcription provider: WAV -> timestamped segments
  -> transcript saved to /metadata/transcripts/<episodeId>.json
  -> detection provider: transcript windows -> candidate ad spans
  -> post-processing: merge, clamp, snap to silence, confidence filter
  -> rows in mediaItemAdSegments
  -> socket ad_segments_updated
```

Post-processing is shared by every provider, so all providers behave
identically. Boundaries are snapped onto nearby silence because transcript
timestamps land mid-word often enough that skipping on them alone clips speech.

---

## API

```
GET    /api/podcasts/:id/episode/:episodeId/ad-segments
POST   /api/podcasts/:id/episode/:episodeId/ad-segments          run detection
POST   /api/podcasts/:id/episode/:episodeId/ad-segments          body {startTime,endTime} creates one
PATCH  /api/podcasts/:id/episode/:episodeId/ad-segments/:segId
DELETE /api/podcasts/:id/episode/:episodeId/ad-segments/:segId
GET    /api/podcasts/:id/episode/:episodeId/transcript
POST   /api/libraries/:id/ad-detection/backfill                  admin only
GET    /api/ad-detection/status                                  admin only
```

Segments also arrive with the play session:

```jsonc
// POST /api/items/:id/play/:episodeId
{
  "id": "...",
  "audioTracks": [...],
  "adSegments": [
    { "id": "...", "startTime": 62.5, "endTime": 145.0, "confidence": 0.91, "label": "preroll", "source": "ai", "enabled": true }
  ]
}
```

---

## Running it

`docker/ad-detection/` holds a compose stack with Audiobookshelf plus a
faster-whisper sidecar:

```bash
cd docker/ad-detection
cp .env.example .env    # add DEEPSEEK_API_KEY
docker compose up -d --build
```

The stack pre-configures itself through the environment: ad detection is
enabled, transcription points at the whisper sidecar, and detection points at
DeepSeek. The only thing you supply is the API key - either in `.env` before
starting, or in Settings -> Ad Detection afterwards.

Environment values override stored settings, so the container stays the source
of truth. The overrides are `AD_DETECTION_ENABLED`,
`AD_DETECTION_TRANSCRIPTION_PROVIDER`, `AD_DETECTION_TRANSCRIPTION_BASE_URL`,
`AD_DETECTION_TRANSCRIPTION_MODEL`, `AD_DETECTION_LLM_BASE_URL`,
`AD_DETECTION_LLM_MODEL`, `AD_DETECTION_LLM_API_KEY` and
`AD_DETECTION_TRANSCRIPTION_API_KEY`.

`deploy-dev01.sh` does the same on a remote host over SSH (defaults to
`rusty@10.1.1.50`, invoking docker through sudo).

---

## Verifying it works

The pipeline was validated end to end against real speech: a host-read sponsor
block sitting at 32.3s-44.5s in a 76s episode, with two-second gaps either
side, was transcribed by whisper.cpp, detected, and stored as **30.2s-46.5s** -
landing on the silence seams either side of the read.

Two things that verification caught are worth knowing about, because they look
like configuration problems if you hit them:

- **whisper.cpp must not be run with `-nt`.** That flag collapses the
  transcript into one segment per 30-second window, so every ad boundary can be
  up to 30 seconds out. Audiobookshelf does not pass it.
- **Boundaries come from silence, not from the transcript.** A transcript line
  routinely ends a few seconds before the real seam, so every boundary is
  snapped onto nearby silence, and never moved further than 6 seconds.

To re-run the checks yourself:

```bash
npm test              # server suite, including the detection pipeline
npm run test:client   # the player's ad-skip decisions
```

---

## Troubleshooting

**`whisper.cpp not found`** - install it and set `WHISPER_PATH`, or switch to
the OpenAI-compatible provider.

**Exit 132 / SIGILL from whisper** - the host has no AVX2. Use faster-whisper.

**`provider did not return parseable JSON`** - the model ignored the JSON
instruction. One retry already happened. Try a stronger model; very small local
models often cannot hold the format.

**Detection finished with zero segments** - check `adDetectionMinConfidence`,
and read the transcript endpoint to confirm the audio actually transcribed. A
segment longer than a quarter of the episode is also discarded as implausible,
which is usually a sign the detector over-reached rather than a real ad.

**Ads are detected but not skipped** - check `adDetectionAutoSkip` and the
per-user `autoSkipAds` setting, and confirm the player is the web player.
