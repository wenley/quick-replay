# quick-replay

Instant lookback for your microphone. quick-replay keeps a rolling buffer of
the last few minutes of mic audio in your browser tab and lets you replay any
recent stretch of it — 5 seconds up to 5 minutes — with a single keypress.
No "oops, rewind the recording" fumbling: the audio is already there, so
time-to-replay is close to zero.

## Requirements

- Node 24+ (earlier versions can't run the `.ts` sources directly, which the
  tests rely on)
- **Chrome.** It has the most reliable `AudioWorklet` support and remembers
  mic permission per-origin, so you're only prompted once. Safari's behavior
  here is flakier — stick with Chrome.

## Run it

```
npm install
npm start
```

`npm start` compiles `src/` and then starts the server; `npm run build && node
server.ts` is the same thing spelled out. Then open the printed URL, click
**Arm**, and grant microphone access when prompted.

While editing, leave `npm run dev` running in a second terminal — that's
`tsc --watch`, so a browser reload picks up whatever you just saved.

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
| `x` | Cycle playback speed: 1.0x → 0.75x → 0.5x → 0.25x → 1.0x |
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

## Slowed playback

Press `x` to cycle playback speed — 1.0x → 0.75x → 0.5x → 0.25x → back to
1.0x — or use the **Playback speed** slider for anything in between, down to
0.25x (quarter speed). This is
for studying a sung phrase: slowing it down does **not** transpose it down in
pitch. A plain `playbackRate` on a raw audio buffer would do that (slower
playback = lower pitch, the vinyl-record effect), which is exactly what this
avoids.

The trick is who does the time-stretching. At 1.0x, quick-replay plays the
clip through Web Audio the normal way — instant, zero added latency. Below
1.0x, it instead hands the clip to a hidden `<audio>` element with
`preservesPitch` enabled and routes its output back through the same Web
Audio gain node. That's the browser's own native pitch-preserving
time-stretcher — there's no hand-rolled phase vocoder or WSOLA here, just
what Chrome already ships for exactly this purpose. The tradeoff is a small
one-time delay to encode the clip before that first slowed play begins,
which the 1.0x path never pays.

Sustained vowels hold up well even at 0.5x — that's the material this is
built for. Consonants and other transients smear somewhat at the slower
speeds; that's inherent to time-domain stretching, not a bug. Expect that
smearing to become clearly audible by 0.25x, where the stretcher is
repeating each grain four times over: useful for picking apart a fast
melisma note by note, less so for judging tone. Changing speed
while a clip is playing restarts it at the new speed rather than trying to
switch speeds mid-stream. The setting persists across reloads, same as gain.

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

While a replay is running, the stretch of buffer it is drawn from is lit up on
the timeline and the duration key that launched it is highlighted, so the key,
the clip length, and the region being heard all read as one thing. Position
*within* the clip is shown by the playback progress bar, not on the timeline.

One thing the axis does **not** mean: because idle time is never stored, the
timeline measures *recorded* audio, not wall-clock time. `-2:00` is two minutes
of material back, which may be far longer ago in real time. Each take carries
its wall-clock start time in a tooltip if you need the real answer.

## Modes

- **Standby** — not recording, mic released (indicator goes dark).
- **Record** — actively capturing into the ring buffer.
- **Playback** — replaying a fixed lookback window on loop, until you leave
  it with `Space` (back to whichever mode it was launched from) or `Esc`
  (to Standby). The playback status line reads "looping last …" while it
  runs.

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

## Source layout

```
src/          TypeScript sources for the browser
public/js/    build output — generated, gitignored
public/       index.html
server.ts     static file server (Node runs it directly, no build)
test/         unit tests
```

Two tsconfigs, because the two halves of the project should not be able to see
each other's globals: `tsconfig.json` builds `src/` against the DOM with no
Node types, and `tsconfig.node.json` type-checks the server and tests against
Node with no DOM. `npm run typecheck` runs both.

Imports name the `.ts` file directly (`./ring-buffer.ts`) rather than the
conventional `.js`. That single specifier form resolves for Node — which runs
the tests straight off the TypeScript, no build involved — as well as for tsc
and the editor, and `rewriteRelativeImportExtensions` turns it into `.js` on
emit so the browser gets a specifier pointing at a file that exists. Because
the tests bypass the compiler this way, `erasableSyntaxOnly` is on: it rejects
the TypeScript features Node's type stripper can't handle (enums, namespaces,
constructor parameter properties) at check time rather than at run time.

## Testing

```
node --test
```

The pure logic — ring buffer, mode transitions, CLI arg parsing — is unit
tested with Node's built-in test runner, which reads the `.ts` files directly.
Audio I/O and UI behavior are verified by running the app in a browser.
