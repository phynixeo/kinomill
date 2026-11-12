// A short, soft two-note chime played when a download or conversion finishes.
let ctx: AudioContext | undefined;

export function playChime(): void {
  try {
    ctx ??= new AudioContext();
    const now = ctx.currentTime;
    for (const [i, freq] of [880, 1318.5].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = now + i * 0.12;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.65);
    }
  } catch {
    /* audio not available */
  }
}
