// The timeline: buffer/take visualization, plus its hover-preview and
// running-playback overlays. Renders a snapshot handed in by the caller
// (see TimelineModel) — it owns no audio/take state of its own, only the
// DOM it draws into.

import type { Duration } from './config.ts';
import type { Take } from './takes.ts';
import { el } from './dom.ts';
import { formatMinSec } from './format.ts';

// Snapshot the renderer draws from. All positions are absolute frames; the
// view window is [nowAbs - capacity, nowAbs], so "now" sits at the right edge
// and everything scrolls leftward as recording continues.
export interface TimelineModel {
  sampleRate: number;
  maxSeconds: number;
  capacity: number;
  nowAbs: number;
  windowStartAbs: number;
  oldestAbs: number;
  takes: readonly Take[];
  activeTake: Take | null;
  durations: Duration[];
}

/** The stretch of buffer a running replay is drawn from, in absolute frames. */
export interface PlaybackSpan {
  startAbs: number;
  endAbs: number;
}

export interface Timeline {
  render(model: TimelineModel | null): void;
  /** Pass null for `span` when nothing is playing. */
  renderPlaybackSpan(model: TimelineModel | null, span: PlaybackSpan | null): void;
  highlightDurationSpan(model: TimelineModel | null, seconds: number): void;
  hideHighlight(): void;
}

const AXIS_INTERVALS_SECONDS = [5, 10, 15, 30, 60, 120, 300];

function pickAxisInterval(maxSeconds: number): number {
  for (const candidate of AXIS_INTERVALS_SECONDS) {
    if (maxSeconds / candidate <= 6) return candidate;
  }
  return AXIS_INTERVALS_SECONDS[AXIS_INTERVALS_SECONDS.length - 1];
}

export function createTimeline(): Timeline {
  // --- timeline highlight (hover preview) -----------------------------------

  function showTimelineHighlight(pct: number): void {
    if (!el.timelineHighlight) return;
    const clamped = Math.min(100, Math.max(0, pct));
    el.timelineHighlight.style.left = `${clamped}%`;
    el.timelineHighlight.style.width = `${100 - clamped}%`;
    el.timelineHighlight.classList.remove('hidden');
  }

  function hideTimelineHighlight(): void {
    if (!el.timelineHighlight) return;
    el.timelineHighlight.classList.add('hidden');
  }

  // Hovering a duration button previews the span of the track it would replay.
  function highlightDurationSpan(model: TimelineModel | null, seconds: number): void {
    if (!model || model.capacity <= 0) return;
    const targetAbs = model.nowAbs - seconds * model.sampleRate;
    const pct = Math.min(1, Math.max(0, (targetAbs - model.windowStartAbs) / model.capacity)) * 100;
    showTimelineHighlight(pct);
  }

  // The stretch of buffer the current replay is drawn from. Lives outside
  // #timeline-track because renderTimeline() replaces that element's children
  // wholesale on every pass.
  function renderPlaybackSpan(model: TimelineModel | null, span: PlaybackSpan | null): void {
    if (!el.timelinePlaying) return;

    if (!model || !span || span.endAbs <= span.startAbs) {
      el.timelinePlaying.classList.add('hidden');
      return;
    }

    const fraction = (abs: number) =>
      Math.min(1, Math.max(0, (abs - model.windowStartAbs) / model.capacity));
    const startPct = fraction(span.startAbs) * 100;
    const endPct = fraction(span.endAbs) * 100;

    el.timelinePlaying.style.left = `${startPct}%`;
    el.timelinePlaying.style.width = `${Math.max(0, endPct - startPct)}%`;
    el.timelinePlaying.classList.remove('hidden');
  }

  // --- timeline (buffer/take visualization) ---------------------------------

  // Hover is delegated to the container rather than bound per tick: the ticks
  // are rebuilt several times a second while recording, and a node replaced
  // mid-hover never fires its own mouseleave, which would strand the highlight.
  if (el.timelineTicks) {
    el.timelineTicks.addEventListener('mouseover', (event: MouseEvent) => {
      const target = event.target;
      const pct = target instanceof HTMLElement ? target.dataset.pct : undefined;
      if (pct !== undefined && pct !== '') showTimelineHighlight(Number(pct));
    });
    el.timelineTicks.addEventListener('mouseleave', hideTimelineHighlight);
  }

  function renderTimeline(model: TimelineModel | null): void {
    if (!el.timelineTicks || !el.timelineTrack || !el.timelineAxis) return;
    const ticksEl = el.timelineTicks;
    const trackEl = el.timelineTrack;
    const axisEl = el.timelineAxis;

    if (!model || model.capacity <= 0) {
      ticksEl.replaceChildren();
      trackEl.replaceChildren();
      axisEl.replaceChildren();
      hideTimelineHighlight();
      return;
    }

    const fraction = (abs: number) => {
      const f = (abs - model.windowStartAbs) / model.capacity;
      return Math.min(1, Math.max(0, f));
    };

    // --- reach ticks: "how far back does duration N reach?" ---
    const ticksFrag = document.createDocumentFragment();
    let lastLabelPct: number | null = null;
    for (const d of model.durations) {
      const targetAbs = model.nowAbs - d.seconds * model.sampleRate;
      const rawFraction = (targetAbs - model.windowStartAbs) / model.capacity;
      const clipped = rawFraction < 0;
      const pct = Math.min(1, Math.max(0, rawFraction)) * 100;

      const tick = document.createElement('div');
      tick.className = clipped ? 'timeline-tick clipped' : 'timeline-tick';
      tick.style.left = `${pct}%`;
      tick.dataset.pct = String(pct);
      ticksFrag.appendChild(tick);

      if (lastLabelPct === null || Math.abs(pct - lastLabelPct) >= 4) {
        const label = document.createElement('div');
        label.className = clipped ? 'timeline-tick-label clipped' : 'timeline-tick-label';
        label.style.left = `${pct}%`;
        label.textContent = d.key;
        label.dataset.pct = String(pct);
        ticksFrag.appendChild(label);
        lastLabelPct = pct;
      }
    }
    ticksEl.replaceChildren(ticksFrag);

    // --- track: unfilled headroom + one span per take + boundary markers ---
    const trackFrag = document.createDocumentFragment();
    for (const take of model.takes) {
      const clampedStartAbs = Math.max(take.startAbs, model.oldestAbs);
      const startPct = fraction(clampedStartAbs) * 100;
      const endPct = fraction(take.endAbs) * 100;
      const width = Math.max(0, endPct - startPct);
      const isActive = model.activeTake === take;

      const span = document.createElement('div');
      span.className = isActive ? 'timeline-take active' : 'timeline-take';
      span.style.left = `${startPct}%`;
      span.style.width = `${width}%`;
      const takeSeconds = (take.endAbs - take.startAbs) / model.sampleRate;
      const clockStart = new Date(take.wallClockStart).toLocaleTimeString();
      span.title = `Take ${take.id} — ${formatMinSec(takeSeconds)}, started ${clockStart}`;
      trackFrag.appendChild(span);

      // Start marker: only when the true start is still retained (not
      // partially overwritten — that edge is the buffer limit, not a seam).
      if (take.startAbs >= model.oldestAbs) {
        const startMarker = document.createElement('div');
        startMarker.className = 'timeline-boundary';
        startMarker.style.left = `${startPct}%`;
        trackFrag.appendChild(startMarker);
      }
      // End marker: skip on the active take — its end is "now", not a seam.
      if (take !== model.activeTake) {
        const endMarker = document.createElement('div');
        endMarker.className = 'timeline-boundary';
        endMarker.style.left = `${endPct}%`;
        trackFrag.appendChild(endMarker);
      }
    }
    trackEl.replaceChildren(trackFrag);

    // --- time axis: adaptive interval, "now" right-aligned ---
    const axisFrag = document.createDocumentFragment();
    const interval = pickAxisInterval(model.maxSeconds);
    for (let s = 0; s <= model.maxSeconds; s += interval) {
      const pct = model.maxSeconds > 0 ? (1 - s / model.maxSeconds) * 100 : 100;
      const label = document.createElement('div');
      label.className = 'timeline-axis-label';
      label.style.left = `${pct}%`;
      label.textContent = s === 0 ? 'now' : `-${formatMinSec(s)}`;
      if (pct >= 99.99) {
        label.style.transform = 'translateX(-100%)';
      } else if (pct <= 0.01) {
        label.style.transform = 'translateX(0)';
      } else {
        label.style.transform = 'translateX(-50%)';
      }
      axisFrag.appendChild(label);
    }
    axisEl.replaceChildren(axisFrag);
  }

  return {
    render: renderTimeline,
    renderPlaybackSpan,
    highlightDurationSpan,
    hideHighlight: hideTimelineHighlight,
  };
}
