// Short, recognisable two-tone alert (~2.4 s) synthesised with WebAudio — no audio files needed.
let ctx: AudioContext | null = null;
let lastPlay = 0;

function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

/** Browsers only allow audio after a user gesture: call this from the first tap. */
export function unlockAudio() {
  const c = getCtx();
  if (c && c.state === 'suspended') void c.resume();
}

export function playSiren(kind: 'alert' | 'report' | 'allclear' = 'alert') {
  const c = getCtx();
  if (!c) return;
  const t0 = c.currentTime + 0.02;
  if (Date.now() - lastPlay < 4000) return;
  lastPlay = Date.now();
  if (c.state === 'suspended') void c.resume();

  const master = c.createGain();
  master.gain.value = 0.0001;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 3200;
  master.connect(filter).connect(c.destination);

  if (kind === 'allclear') {
    // Two soft rising chimes.
    [660, 880].forEach((f, i) => tone(c, master, f, f, t0 + i * 0.22, 0.35, 'sine'));
    envelope(master, t0, 0.8, 0.5);
    return;
  }
  if (kind === 'report') {
    [880, 880].forEach((f, i) => tone(c, master, f, f, t0 + i * 0.18, 0.12, 'triangle'));
    envelope(master, t0, 0.5, 0.35);
    return;
  }
  // Alert: three rising sweeps (wail) layered with a square for presence.
  const dur = 0.72;
  for (let i = 0; i < 3; i++) {
    const s = t0 + i * (dur + 0.08);
    tone(c, master, 620, 1180, s, dur, 'sawtooth');
    tone(c, master, 310, 590, s, dur, 'square', 0.25);
  }
  envelope(master, t0, 3 * (dur + 0.08), 0.55);
  if ('vibrate' in navigator) navigator.vibrate?.([300, 120, 300, 120, 600]);
}

function tone(c: AudioContext, out: AudioNode, f0: number, f1: number, start: number, dur: number, type: OscillatorType, gain = 1) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, start);
  o.frequency.exponentialRampToValueAtTime(f1, start + dur * 0.85);
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.03);
  g.gain.setValueAtTime(gain, start + dur - 0.06);
  g.gain.linearRampToValueAtTime(0, start + dur);
  o.connect(g).connect(out);
  o.start(start);
  o.stop(start + dur + 0.02);
}

function envelope(g: GainNode, start: number, total: number, peak: number) {
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(peak, start + 0.05);
  g.gain.setValueAtTime(peak, start + total - 0.1);
  g.gain.exponentialRampToValueAtTime(0.0001, start + total + 0.05);
}
