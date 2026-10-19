// OK：ピッ ／ NG：ブブー（既存の現場チェック画面と同じ音）
export async function playBeep(type: "OK" | "NG") {
  try {
    if (typeof window === "undefined") return;
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    if (ctx.state === "suspended") await ctx.resume();
    const tone = (start: number, freq: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.2, start);
      gain.gain.exponentialRampToValueAtTime(0.01, start + dur);
      osc.start(start);
      osc.stop(start + dur);
    };
    const now = ctx.currentTime;
    if (type === "OK") tone(now, 1200, 0.15);
    else {
      tone(now, 500, 0.15);
      tone(now + 0.25, 500, 0.15);
    }
  } catch {
    // 音が出せない環境では無視する
  }
}
