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
| `r` | Switch to Record |
| `s` | Switch to Standby |
| `Space` | Back to previous mode |
| `Esc` | Back to Standby |

The browser tab must be focused for keys to register.

## Modes

- **Standby** — not recording, mic released (indicator goes dark).
- **Record** — actively capturing into the ring buffer.
- **Playback** — replaying a fixed lookback window, then automatically
  returning to whichever mode (Record or Standby) it was launched from.

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
