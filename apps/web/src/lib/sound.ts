/**
 * The app's sound layer. Cues are channel-aware:
 *  - outbound WhatsApp → the real WhatsApp "sent" sound (an embedded MP3),
 *  - outbound email → a synthesised "swoosh",
 *  - outbound note / other → a soft synth blip,
 *  - incoming message → a gentle two-note "ding".
 * Everything except the WhatsApp clip is synthesised with the Web Audio API.
 * Every cue plays at full volume: the computer's own volume is the control.
 *
 * Sound is on by default, muteable, and the choice persists in localStorage.
 * Browsers block audio until the first user gesture — `unlock()` (wired to the
 * first click/keydown) resumes the context so the very next cue can play.
 */
import { WHATSAPP_SENT_SOUND } from "./sound-assets";

const STORE_KEY = "nc_sound";

let ctx: AudioContext | null = null;
let enabled = readEnabled();
const listeners = new Set<(on: boolean) => void>();

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORE_KEY) !== "off";
  } catch {
    return true;
  }
}

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

/**
 * Resume the audio context (autoplay policy).
 *
 * Called on user gestures and when the tab comes back to the foreground, and
 * safe to call at any time — resuming a running context is a no-op. It must not
 * be a one-shot: a context is suspended before the first gesture, and browsers
 * suspend it again after a tab has been in the background, so "unlocked once"
 * is not the same as "unlocked".
 */
export function unlock(): void {
  const ac = audio();
  if (ac && ac.state === "suspended") void ac.resume();
}

export function isSoundOn(): boolean {
  return enabled;
}

export function setSoundOn(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(STORE_KEY, on ? "on" : "off");
  } catch {
    /* ignore quota/private-mode errors */
  }
  if (on) unlock();
  listeners.forEach((l) => l(on));
}

export function toggleSound(): boolean {
  setSoundOn(!enabled);
  return enabled;
}

/** Subscribe to on/off changes (for toggle buttons). Returns an unsubscribe. */
export function subscribeSound(cb: (on: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** One short shaped tone. */
function tone(freq: number, start: number, dur: number, peak: number, type: OscillatorType = "sine"): void {
  const ac = audio();
  if (!ac) return;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

/** The embedded WhatsApp "sent" clip, primed once and reused. */
let waEl: HTMLAudioElement | null = null;
function playWhatsAppSent(): void {
  if (typeof Audio === "undefined") return;
  try {
    if (!waEl) {
      waEl = new Audio(WHATSAPP_SENT_SOUND);
      waEl.preload = "auto";
      waEl.volume = 1;
    }
    waEl.currentTime = 0;
    void waEl.play().catch(() => {});
  } catch {
    /* ignore playback errors (autoplay policy, decode) */
  }
}

/** Outgoing email: a short filtered-noise "swoosh" (bright → dark sweep). */
function playSwoosh(): void {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime;
  const dur = 0.34;
  const frames = Math.floor(ac.sampleRate * dur);
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  // A bandpass sweeping downward is what reads as a "whoosh".
  const bp = ac.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(2600, t);
  bp.frequency.exponentialRampToValueAtTime(500, t + dur);
  bp.Q.value = 0.9;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(1, t + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp).connect(gain).connect(ac.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}

/** Outgoing: a channel-specific "sent" cue (WhatsApp clip, email swoosh, else blip). */
export function playSent(channel?: string): void {
  if (!enabled) return;
  if (channel === "whatsapp" || channel === "whatsapp_group") {
    playWhatsAppSent();
    return;
  }
  if (channel === "email") {
    playSwoosh();
    return;
  }
  // Notes / unknown: the original soft synth blip.
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime;
  tone(520, t, 0.09, 1);
  tone(780, t + 0.05, 0.1, 1);
}

/** The chime itself, once the context is known to be running. */
function chime(ac: AudioContext): void {
  const t = ac.currentTime;
  tone(660, t, 0.16, 1);
  tone(990, t + 0.11, 0.18, 1);
  tone(1320, t + 0.24, 0.26, 1);
}

/**
 * Two arrivals in the same breath are one event to a person, and ten are not
 * ten chimes' worth of information. Short enough that consecutive messages in a
 * conversation each still sound.
 */
const COALESCE_MS = 900;
let lastReceivedAt = 0;

/** Incoming: a rising three-note chime — a touch longer and more attention-
 *  grabbing than a single ding, so a new chat is noticeable without being harsh.
 *
 *  Resumes the context first if it has been suspended. A suspended context does
 *  not throw and does not play: `start()` schedules against a clock that isn't
 *  running, so the cue is silently dropped. That is most of what "sometimes
 *  there's no sound" turns out to be — the tab was in the background, or nobody
 *  had clicked anything yet. */
export function playReceived(): void {
  if (!enabled) return;
  const ac = audio();
  if (!ac) return;

  const now = Date.now();
  if (now - lastReceivedAt < COALESCE_MS) return;
  lastReceivedAt = now;

  if (ac.state === "suspended") {
    // Resuming needs a gesture in some browsers and will reject without one;
    // there is nothing to do about that here, and the next gesture unlocks it.
    void ac.resume().then(() => chime(ac)).catch(() => {});
    return;
  }
  chime(ac);
}
