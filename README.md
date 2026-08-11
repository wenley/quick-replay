# quick-replay

Instant lookback for your microphone. quick-replay keeps a rolling buffer of
the last few minutes of mic audio in your browser tab and lets you replay any
recent stretch of it — 5 seconds up to 5 minutes — with a single keypress.
No "oops, rewind the recording" fumbling: the audio is already there, so
time-to-replay is close to zero.

## Requirements

- Node 18+
- **Chrome.** It has the most reliable `AudioWorklet` support and remembers
  mic permission per-origin, so you're only prompted once. Safari's behavior
  here is flakier — stick with Chrome.

## Run it

```
node server.js
```

Then open the printed URL, click **Arm**, and grant microphone access when
prompted.

Flags:

| Flag | Default | Meaning |
|------|---------|---------|
| `--max <seconds>` | `300` | Size of the rolling buffer, in seconds (max `1800`) |
| `--port <n>` | `8080` | Port to listen on |

The server binds to `127.0.0.1` only — it's not reachable from other devices
on your network.

## Key map

| Key | Action |
|-----|--------|
| `1` | Replay last 5s |
| `2` | Replay last 10s |
| `3` | Replay last 30s |
| `4` | Replay last 1m |
| `5` | Replay last 2m |
| `6` | Replay last 5m |
| `q` | Replay the current take from its start |
| `r` | Switch to Record |
| `s` | Switch to Standby |
| `l` | Toggle looping on/off |
| `Space` | Toggle Record/Standby — or, during playback, back to the previous mode |
| `Esc` | Back to Standby |
| `↑` / `↓` | Playback volume ±1 dB |
| `0` | Reset volume to 0 dB |

The browser tab must be focused for keys to register.

## Playback volume

A slider sets playback gain from **−30 dB (muted) to +18 dB (~8×)**, defaulting
to 0 dB (unchanged). It's calibrated in dB rather than as a plain multiplier
because loudness is perceived logarithmically — a linear multiplier would spend
most of the slider's travel on boost and leave almost none for attenuation.

Adjustments apply mid-replay, not just to the next one, and the setting persists
across reloads. Boosting past the material's headroom will clip; a warning
appears when the current gain would push the most recent replay over 0 dBFS.

Note this affects **playback only** — capture stays raw and unmodified, so
turning it up never degrades what's stored in the buffer.

## Takes and the timeline

A **take** is one contiguous stretch of capture. Leaving Record — for Standby
*or* for Playback — ends the current take, and returning starts a new one. The
timeline marks those seams, so you can see at a glance whether a 30s replay will
reach back past a boundary into the previous take.

`q` replays the current take from its start, or from as far back as the buffer
still holds if the take has grown longer than the buffer.

Take markers are stored as absolute positions in the audio stream rather than as
offsets into the ring buffer. Once the buffer fills and old audio starts being
overwritten, the markers don't move — the retained window slides forward past
them, takes scroll off the left edge, and a take whose start has been
overwritten stops showing a start marker, because that boundary is genuinely
gone rather than sitting at the buffer edge.

One thing the axis does **not** mean: because idle time is never stored, the
timeline measures *recorded* audio, not wall-clock time. `-2:00` is two minutes
of material back, which may be far longer ago in real time. Each take carries
its wall-clock start time in a tooltip if you need the real answer.

## Modes

- **Standby** — not recording, mic released (indicator goes dark).
- **Record** — actively capturing into the ring buffer.
- **Playback** — replaying a fixed lookback window, then automatically
  returning to whichever mode (Record or Standby) it was launched from
  (unless looping is on — see below).

## Looping

Press `l` (or click the **Looping** toggle) to arm looping mode. It's a
global on/off switch, not tied to any one replay, and its setting persists
across reloads.

- **Off (default):** playback runs once, then returns to whichever mode
  (Record or Standby) it was launched from.
- **On:** when a clip finishes, it immediately replays the same clip again —
  same audio, same duration — for as long as looping stays on. Playback mode
  is held indefinitely instead of returning.

Because looping is global, toggling it takes effect at the next natural
boundary rather than mid-clip: flipping it on while a replay is already
running makes that replay loop once it reaches the end; flipping it off
during a loop lets the current pass finish before returning as normal — it
never cuts audio short. The playback status line reads "looping last …"
while a loop is running.

## Things worth knowing

- The audio buffer lives in the browser page's memory. **Reloading the page
  wipes it.** Nothing is ever written to disk, and the server never receives
  audio — it's a plain static file server.
- The macOS orange mic indicator **stays lit during playback by design**.
  The mic stream is held open (but not recording) so returning to Record is
  instantaneous and gapless. It genuinely goes dark in Standby, where the
  stream is released.
- Recording appends across Standby pauses: idle time is never stored, so a
  30s replay may stitch together audio from several separate recording
  sessions.
- Capture is raw — echo cancellation, auto gain control, and noise
  suppression are all disabled for fidelity.

## Testing

```
node --test
```

The pure logic — ring buffer, mode transitions, CLI arg parsing — is unit
tested with Node's built-in test runner. Audio I/O and UI behavior are
verified by running the app in a browser.
