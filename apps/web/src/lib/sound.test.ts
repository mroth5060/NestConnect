import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Why a chime that was asked for sometimes doesn't happen.
 *
 * Both rules here were live bugs, and both are silent by construction — a
 * suspended AudioContext accepts every call in `playReceived` without throwing
 * and simply never makes a sound, so nothing appears in a console anywhere.
 * The report was "sometimes it dings and sometimes it doesn't", which is the
 * worst possible symptom: people stop trusting the sound and go back to
 * watching the screen.
 */

/** A fake Web Audio context that records what was started, and whose `state`
 *  the test drives. */
function fakeAudio() {
  const started: number[] = [];
  const levels: number[] = [];
  let state: "running" | "suspended" = "running";
  const param = () => ({ setValueAtTime: () => {}, exponentialRampToValueAtTime: (v: number) => levels.push(v), value: 0 });
  const node = () => ({ connect: (n: unknown) => n, type: "", frequency: param(), Q: param(), gain: param() });
  const ctx = {
    get state() {
      return state;
    },
    currentTime: 0,
    sampleRate: 48000,
    destination: {},
    resume: vi.fn(async () => {
      state = "running";
    }),
    createOscillator: () => ({
      ...node(),
      start: (t: number) => started.push(t),
      stop: () => {},
    }),
    createGain: node,
    createBiquadFilter: node,
  };
  return {
    ctx,
    started,
    levels,
    suspend: () => {
      state = "suspended";
    },
  };
}

let audio: ReturnType<typeof fakeAudio>;
let sound: typeof import("./sound");

beforeEach(async () => {
  audio = fakeAudio();
  vi.stubGlobal("window", { AudioContext: function () { return audio.ctx; } });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  vi.resetModules();
  sound = await import("./sound");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("an arriving message", () => {
  it("chimes", () => {
    sound.playReceived();
    expect(audio.started.length).toBeGreaterThan(0);
  });

  it("chimes even when the context has gone to sleep", async () => {
    // A browser suspends the context while the tab is in the background. The
    // old code scheduled against a stopped clock: no error, no sound, and no
    // way for anyone to tell why. This is most of "sometimes".
    audio.suspend();
    sound.playReceived();
    await Promise.resolve();
    await Promise.resolve();
    expect(audio.ctx.resume).toHaveBeenCalled();
    expect(audio.started.length).toBeGreaterThan(0);
  });

  it("chimes at full volume", () => {
    // It played at 6% and people didn't hear it. How loud it is belongs to
    // the computer's volume, not to a number in here.
    sound.playReceived();
    expect(Math.max(...audio.levels)).toBe(1);
  });

  it("stays silent when the person has turned sound off", () => {
    sound.setSoundOn(false);
    sound.playReceived();
    expect(audio.started).toHaveLength(0);
  });
});

describe("several arriving at once", () => {
  it("is one chime, not a pile of them", () => {
    // Ten messages landing together are one event to a person. This is the only
    // suppression left on the sound, and it is about the noise it makes rather
    // than about whether the message mattered.
    for (let i = 0; i < 10; i++) sound.playReceived();
    const firstChime = audio.started.length;
    expect(firstChime).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) sound.playReceived();
    expect(audio.started.length).toBe(firstChime);
  });

  it("and the next one a moment later still sounds", () => {
    vi.useFakeTimers();
    sound.playReceived();
    const first = audio.started.length;
    vi.advanceTimersByTime(1000);
    vi.setSystemTime(Date.now() + 1000);
    sound.playReceived();
    expect(audio.started.length).toBeGreaterThan(first);
  });
});
