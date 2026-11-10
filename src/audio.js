// 全部用 WebAudio 现场合成：一层缓慢起伏的和声垫底，偶尔落下几粒八音盒般的音。
// 不含任何录音或原作乐曲。

const PENTA = [587.33, 698.46, 783.99, 880.0, 1046.5, 1174.66, 1396.91]; // D 小调五声
const PAD = [146.83, 220.0, 293.66, 329.63, 440.0];

export function createAudio() {
  let ctx = null;
  let master = null;
  let wet = null;
  let padGain = null;
  let tension = null;
  let enabled = true;
  let nextBell = 0;
  let noiseBuf = null;
  try {
    enabled = localStorage.getItem('kagari.sound') !== 'off';
  } catch {
    /* 隐私模式下可能读不到，默认开 */
  }

  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = enabled ? 0.9 : 0;
    master.connect(ctx.destination);

    // 简易混响：两条互相反馈的延迟线
    wet = ctx.createGain();
    wet.gain.value = 0.5;
    const d1 = ctx.createDelay(2);
    const d2 = ctx.createDelay(2);
    d1.delayTime.value = 0.37;
    d2.delayTime.value = 0.53;
    const fb1 = ctx.createGain();
    const fb2 = ctx.createGain();
    fb1.gain.value = 0.46;
    fb2.gain.value = 0.42;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    wet.connect(d1);
    wet.connect(d2);
    d1.connect(fb1).connect(d2);
    d2.connect(fb2).connect(lp).connect(d1);
    d1.connect(master);
    d2.connect(master);

    // 和声垫
    padGain = ctx.createGain();
    padGain.gain.value = 0;
    const padLp = ctx.createBiquadFilter();
    padLp.type = 'lowpass';
    padLp.frequency.value = 780;
    padGain.connect(padLp).connect(master);
    padLp.connect(wet);
    PAD.forEach((f, i) => {
      for (const det of [-4, 5]) {
        const o = ctx.createOscillator();
        o.type = i < 2 ? 'sine' : 'triangle';
        o.frequency.value = f;
        o.detune.value = det + i;
        const g = ctx.createGain();
        g.gain.value = 0.0;
        // 每个声部各自缓慢呼吸
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.04 + i * 0.013 + (det > 0 ? 0.007 : 0);
        const lg = ctx.createGain();
        lg.gain.value = 0.018;
        lfo.connect(lg).connect(g.gain);
        g.gain.setValueAtTime(0.022, ctx.currentTime);
        o.connect(g).connect(padGain);
        o.start();
        lfo.start();
      }
    });
    padGain.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 6);

    // 紧张时浮上来的低频
    tension = ctx.createGain();
    tension.gain.value = 0;
    const to = ctx.createOscillator();
    to.type = 'sawtooth';
    to.frequency.value = 55;
    const to2 = ctx.createOscillator();
    to2.type = 'sawtooth';
    to2.frequency.value = 58.3;
    const tl = ctx.createBiquadFilter();
    tl.type = 'lowpass';
    tl.frequency.value = 220;
    to.connect(tl);
    to2.connect(tl);
    tl.connect(tension).connect(master);
    to.start();
    to2.start();

    // 噪声素材
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    nextBell = ctx.currentTime + 3;
  }

  function bell(freq, when, gain = 0.07, dur = 3.2) {
    if (!ctx) return;
    const o = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o.type = 'sine';
    o2.type = 'sine';
    o.frequency.value = freq;
    o2.frequency.value = freq * 2.76;
    const g = ctx.createGain();
    const g2 = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    g2.gain.setValueAtTime(0, when);
    g2.gain.linearRampToValueAtTime(gain * 0.25, when + 0.004);
    g2.gain.exponentialRampToValueAtTime(0.0001, when + dur * 0.25);
    o.connect(g);
    o2.connect(g2);
    g.connect(master);
    g.connect(wet);
    g2.connect(master);
    g2.connect(wet);
    o.start(when);
    o2.start(when);
    o.stop(when + dur + 0.1);
    o2.stop(when + dur + 0.1);
  }

  function noise({ when = 0, dur = 0.3, type = 'bandpass', f0 = 1000, f1 = f0, q = 1, gain = 0.2, attack = 0.01 }) {
    if (!ctx) return;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g);
    g.connect(master);
    g.connect(wet);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  return {
    init,
    get enabled() {
      return enabled;
    },
    toggle() {
      enabled = !enabled;
      try {
        localStorage.setItem('kagari.sound', enabled ? 'on' : 'off');
      } catch {
        /* ignore */
      }
      if (ctx) master.gain.linearRampToValueAtTime(enabled ? 0.9 : 0, ctx.currentTime + 0.3);
      return enabled;
    },
    resume() {
      if (ctx && ctx.state === 'suspended') ctx.resume();
    },
    update() {
      if (!ctx) return;
      const now = ctx.currentTime;
      if (now >= nextBell) {
        // 零星落下的音
        const n = 1 + (Math.random() < 0.35 ? 1 : 0) + (Math.random() < 0.12 ? 1 : 0);
        let t = now + 0.05;
        let idx = (Math.random() * PENTA.length) | 0;
        for (let i = 0; i < n; i++) {
          bell(PENTA[idx] * (Math.random() < 0.3 ? 0.5 : 1), t, 0.05 + Math.random() * 0.03);
          idx = Math.max(0, Math.min(PENTA.length - 1, idx + ((Math.random() * 5) | 0) - 2));
          t += 0.28 + Math.random() * 0.4;
        }
        nextBell = now + 2.6 + Math.random() * 4.5;
      }
    },
    setTension(v) {
      if (!ctx) return;
      tension.gain.setTargetAtTime(v * 0.12, ctx.currentTime, 0.6);
    },
    step(onPaper, running) {
      if (onPaper) noise({ dur: 0.09, type: 'highpass', f0: 2600, f1: 1800, gain: 0.035, q: 0.7 });
      else noise({ dur: 0.13, type: 'lowpass', f0: running ? 900 : 620, f1: 240, gain: 0.05, q: 0.5 });
    },
    /** 缎带无风自起 */
    ribbonRise() {
      noise({ dur: 1.6, type: 'bandpass', f0: 500, f1: 2400, q: 2.5, gain: 0.07, attack: 0.5 });
    },
    bristle() {
      noise({ dur: 0.35, type: 'highpass', f0: 3200, f1: 5200, q: 1, gain: 0.08, attack: 0.02 });
    },
    slash() {
      noise({ dur: 0.28, type: 'highpass', f0: 1500, f1: 7000, q: 0.8, gain: 0.4, attack: 0.004 });
      noise({ when: 0.06, dur: 0.6, type: 'lowpass', f0: 420, f1: 60, q: 1, gain: 0.5, attack: 0.01 });
    },
    /** 被缎带“啪”地弹开 */
    flick() {
      noise({ dur: 0.07, type: 'bandpass', f0: 2200, f1: 900, q: 1.5, gain: 0.35, attack: 0.002 });
    },
    /** “有力量的语言”：被压缩的信息，听起来只是一块噪声 */
    glyph() {
      if (!ctx) return;
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      o.type = 'square';
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.09, t + 0.01);
      g.gain.setValueAtTime(0.09, t + 0.42);
      g.gain.linearRampToValueAtTime(0, t + 0.5);
      for (let i = 0; i < 24; i++) o.frequency.setValueAtTime(180 + Math.random() * 2400, t + i * 0.021);
      const ring = ctx.createOscillator();
      ring.frequency.value = 37;
      const rg = ctx.createGain();
      rg.gain.value = 0;
      ring.connect(rg.gain);
      o.connect(rg).connect(g);
      g.connect(master);
      g.connect(wet);
      o.start(t);
      ring.start(t);
      o.stop(t + 0.55);
      ring.stop(t + 0.55);
      noise({ dur: 0.5, type: 'bandpass', f0: 4000, f1: 300, q: 4, gain: 0.12 });
    },
    pour() {
      noise({ dur: 1.1, type: 'bandpass', f0: 900, f1: 1900, q: 6, gain: 0.07, attack: 0.15 });
    },
    /** 她笑了 */
    chime() {
      if (!ctx) return;
      const t = ctx.currentTime + 0.05;
      [587.33, 880.0, 1174.66, 1479.98, 1760.0].forEach((f, i) => bell(f, t + i * 0.16, 0.07, 4.5));
    },
    /** 被请进纸上的那一刻 */
    open() {
      if (!ctx) return;
      const t = ctx.currentTime + 0.02;
      [293.66, 440.0, 587.33].forEach((f, i) => bell(f, t + i * 0.05, 0.08, 5));
      noise({ dur: 2.2, type: 'bandpass', f0: 300, f1: 3000, q: 3, gain: 0.05, attack: 0.8 });
    },
  };
}
