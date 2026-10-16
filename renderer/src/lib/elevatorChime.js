/**
 * Arrival chime —— that "ding" when the elevator reaches a floor.
 *
 * Why synthesize on the fly with WebAudio instead of <audio> + an audio file:
 *   1. zero assets, zero dependencies (the project has no audio assets, and we don't want to add an mp3 for one bell);
 *   2. controllable alignment —— an audio file must be decoded, so the first trip often can't ring in time, or rings after the door has finished opening;
 *      on-the-fly synthesis rings "the moment the door opens", on the same frame as `phase: opening`.
 *
 * How the timbre is made (the first version stacked just two sines and sounded like an electronic beep, not an elevator):
 *   A real elevator's "ding" = **a metal bell being struck**, three things are all required:
 *     ① inharmonic partials: a bell's partials aren't integer multiples (1 / 2.0 / 2.76 / 4.07 / 5.43),
 *        stacking integer multiples sounds like an organ / electronic tone, only inharmonic reads as "metal";
 *     ② strike noise: 20ms of high-frequency breath at the start, that touch of "metal being hit";
 *     ③ each partial decays differently: highs die quickly, lows drag a long tail (the 1.0 one rings for over a second),
 *        so it sounds like "ding——" rather than "beep".
 *   Also, each ring adds a tiny random detune (±0.2%), so repeated hits aren't identical —— neither is a real bell.
 *
 * Three timbre modes (`localStorage['wg.elevatorChime']`, takes effect immediately after changing, no refresh needed):
 *   `off`   → muted
 *   `bell`  → single bell "ding" (**default**, closest to a real elevator arriving)
 *   `chime` → two-tone doorbell "ding-dong" (E6→C6 descending, the doorbell of an old passenger elevator)
 *   any other value / not set → fall back to `bell`.
 *
 * Two more rules:
 *   1. **Lazily create the AudioContext**: browsers / Electron only allow sound "after a user gesture".
 *      Calling the elevator is itself a click, so creating it the first time it needs to ring is the safest; resume it in passing when suspended.
 *   2. Repeated triggers within 250ms ring only once (hammering floor buttons doesn't turn into a string of bells).
 */

/** Bell body fundamental C6 (≈1046.5Hz): close to a real elevator's bell, bright but not sharp */
const BASE_HZ = 1046.5;
/** Peak gain: the only volume knob in the whole chain, change this one number if it's too loud */
const PEAK_GAIN = 0.12;
/** Minimum gap (ms) so it rings only once at a time */
const MIN_GAP_MS = 250;

/** Single bell: ratio / relative volume / decay seconds. The inharmonic ratios are where the "metallic feel" comes from, the low ones decay slowest (the tail) */
const BELL_PARTIALS = [
  [1, 1, 1.05],
  [2.0, 0.5, 0.75],
  [2.76, 0.33, 0.55],
  [4.07, 0.19, 0.34],
  [5.43, 0.11, 0.2],
];

/** Two-tone doorbell: frequency + delay relative to the first note (seconds), a descending third (E6 → C6), like an old passenger elevator's doorbell */
const CHIME_NOTES = [
  [1318.5, 0],
  [1046.5, 0.17],
];
/** The doorbell has one fewer partial than the bell: two notes stack up, too many partials would smear */
const CHIME_PARTIALS = [
  [1, 1, 0.85],
  [2.0, 0.35, 0.5],
  [3.01, 0.12, 0.3],
];

let ctx = null;
let lastAt = 0;

/** Read the timbre mode: off / bell / chime (falls back to bell when unreadable) */
function mode() {
  let v = '';
  try {
    v = localStorage.getItem('wg.elevatorChime') || '';
  } catch {
    return 'bell'; // private mode / storage disabled: use the default
  }
  if (v === 'off') return 'off';
  if (v === 'chime' || v === 'twotone') return 'chime';
  return 'bell';
}

/** Get a usable AudioContext; returns null when the environment doesn't support it (or there is no window), the caller silently skips */
function ensureCtx() {
  const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  if (!ctx) {
    try {
      ctx = new AC();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/**
 * Strike the bell: lay out a string of sines per the partial table, giving each an "attack → exponential decay" envelope.
 * @param {AudioContext} ac
 * @param {GainNode} master the bus
 * @param {number} t0 start time (AudioContext timeline, seconds)
 * @param {number} f0 fundamental frequency
 * @param {number[][]} partials [ratio, relative volume, decay seconds]
 * @param {number} detune overall detune ratio (slightly different each ring)
 */
function voice(ac, master, t0, f0, partials, detune) {
  const base = f0 * (1 + detune);
  for (const [ratio, amp, decay] of partials) {
    const hz = base * ratio;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    // The pitch is slightly high at the strike and quickly falls back: the physical feel of a bell "tightening then relaxing" when hit, a few cents is enough
    osc.frequency.setValueAtTime(hz * 1.006, t0);
    osc.frequency.exponentialRampToValueAtTime(hz, t0 + 0.05);
    // Exponential envelope: 2ms attack (the strike feel), the tail decays naturally (an exponential can't be 0, so use 0.0001 as a fallback)
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(amp, t0 + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    osc.connect(gain).connect(master);
    osc.start(t0);
    osc.stop(t0 + decay + 0.05);
  }
}

/**
 * Strike noise: 20ms of decaying white noise + a 2.5kHz high-pass, for that "metal being hit" moment.
 * Without it, no amount of partials sounds like anything but an electronic tone (this is what the first version lacked most).
 */
function strikeNoise(ac, master, t0, gainValue) {
  const len = Math.max(1, Math.floor(ac.sampleRate * 0.02));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len); // linear decay
  const src = ac.createBufferSource();
  src.buffer = buf;
  const hp = ac.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2500;
  const gain = ac.createGain();
  gain.gain.value = gainValue;
  src.connect(hp).connect(gain).connect(master);
  src.start(t0);
}

/**
 * Ring once. Called on arrival (`phase` entering `opening`, the door starting to open).
 * Returns silently in environments that can't make sound —— a failed chime must never affect the animation.
 */
export function playArrivalChime() {
  const m = mode();
  if (m === 'off') return;
  const now = Date.now();
  if (now - lastAt < MIN_GAP_MS) return;
  lastAt = now;

  const ac = ensureCtx();
  if (!ac) return;
  try {
    const t0 = ac.currentTime + 0.01;
    const master = ac.createGain();
    master.gain.value = PEAK_GAIN;
    master.connect(ac.destination);
    const detune = (Math.random() - 0.5) * 0.004;
    if (m === 'chime') {
      for (const [hz, delay] of CHIME_NOTES) {
        strikeNoise(ac, master, t0 + delay, 0.035);
        voice(ac, master, t0 + delay, hz, CHIME_PARTIALS, detune);
      }
    } else {
      strikeNoise(ac, master, t0, 0.05);
      voice(ac, master, t0, BASE_HZ, BELL_PARTIALS, detune);
    }
  } catch {
    /* treat synthesis failure as if nothing happened */
  }
}
