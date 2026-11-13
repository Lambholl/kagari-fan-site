const BGM_URL = `${import.meta.env.BASE_URL}audio/bgm.m4a`;
const BGM_SAMPLE_RATE = 48000;
const BGM_LOOP_START_SECONDS = 1631598 / BGM_SAMPLE_RATE;
const BGM_LOOP_END_SECONDS = 7679898 / BGM_SAMPLE_RATE;
const BGM_FADE_START_SECONDS = 0;
const BGM_FADE_IN_SECONDS = 1.5;
const MASTER_MAX_GAIN = 0.9;
const SOUND_FADE_IN_SECONDS = 0.9;
const SOUND_FADE_OUT_SECONDS = 0.6;
const VOLUME_RAMP_SECONDS = 0.12;

/**
 * 场景音乐与互动音效的控制接口。
 * @typedef {object} SceneAudio
 * @property {boolean} enabled
 * @property {number} volume - 音量，取 0 至 1。
 * @property {() => void} init
 * @property {() => void} resume
 * @property {() => boolean} toggle
 * @property {(value: number) => number} setVolume
 * @property {(v: number) => void} setTension
 * @property {(isOnPaper: boolean, isRunning: boolean) => void} step
 * @property {() => void} ribbonRise
 * @property {() => void} bristle
 * @property {() => void} slash
 * @property {() => void} flick
 * @property {() => void} glyph
 * @property {() => void} pour
 * @property {() => void} chime
 * @property {() => void} open
 */

/**
 * 创建背景音乐和场景音效控制器，并读取已保存的声音开关与音量，默认音量为 50%。
 *
 * @returns {SceneAudio} 通过 init 创建音频资源，音乐与音效共用声音开关。
 */
export function createAudio() {
  let ctx = null;
  let master = null;
  let wet = null;
  let tension = null;
  let bgmSource = null;
  let bgmLoading = null;
  let enabled = true;
  let volume = 0.5;
  let noiseBuf = null;
  try {
    enabled = localStorage.getItem('kagari.sound') !== 'off';
    const storedVolume = localStorage.getItem('kagari.volume');
    if (storedVolume !== null) {
      const parsedVolume = Number(storedVolume);
      if (Number.isFinite(parsedVolume) && parsedVolume >= 0 && parsedVolume <= 1) volume = parsedVolume;
    }
  } catch {
    /* 隐私模式下可能读不到，默认开 */
  }

  function rampVolume(seconds) {
    if (!ctx) return;
    const now = ctx.currentTime;
    if (typeof master.gain.cancelAndHoldAtTime === 'function') {
      master.gain.cancelAndHoldAtTime(now);
    } else {
      const currentGain = master.gain.value;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(currentGain, now);
    }
    master.gain.linearRampToValueAtTime(enabled ? volume * MASTER_MAX_GAIN : 0, now + seconds);
  }

  async function startBgm() {
    if (bgmSource || bgmLoading) return;
    bgmLoading = (async () => {
      const response = await fetch(BGM_URL);
      if (!response.ok) throw new Error(`背景音乐请求失败：HTTP ${response.status}`);
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
      if (buffer.duration <= BGM_LOOP_END_SECONDS) throw new Error('背景音乐长度不足以覆盖循环终点');
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.loopStart = BGM_LOOP_START_SECONDS;
      source.loopEnd = BGM_LOOP_END_SECONDS;
      const gain = ctx.createGain();
      const startTime = ctx.currentTime;
      const fadeStartTime = startTime + BGM_FADE_START_SECONDS;
      gain.gain.value = 0;
      gain.gain.setValueAtTime(0, fadeStartTime);
      gain.gain.linearRampToValueAtTime(0.8, fadeStartTime + BGM_FADE_IN_SECONDS);
      // 成品已经包含混响，直接接入 master 可保留混音时的空间感。
      source.connect(gain).connect(master);
      source.start(startTime);
      bgmSource = source;
    })();
    try {
      await bgmLoading;
    } catch (error) {
      console.error('背景音乐加载失败，将在下次恢复声音时重试。', error);
    } finally {
      bgmLoading = null;
    }
  }

  /**
   * 创建音乐和音效资源；重复调用复用已创建的资源。
   * @returns {void}
   */
  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = enabled ? volume * MASTER_MAX_GAIN : 0;
    master.connect(ctx.destination);
    void startBgm();

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

  /**
   * 恢复浏览器暂停的音频，并重试尚未加载成功的音乐。
   * @returns {void}
   */
  function resume() {
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch((error) => console.error('恢复场景声音失败。', error));
    }
    void startBgm();
  }

  return {
    init,
    resume,
    /**
     * 返回音乐和音效的开关状态。
     * @returns {boolean}
     */
    get enabled() {
      return enabled;
    },
    /**
     * 返回当前音量。
     * @returns {number} 音量，取 0 至 1。
     */
    get volume() {
      return volume;
    },
    /**
     * 平滑调整音乐和音效的音量，并保存设置。
     * @param {number} value - 音量，超出 0 至 1 的值取最近的边界。
     * @returns {number} 调整后的音量；静音时保留该音量供恢复声音时使用。
     * @throws {TypeError} value 不是有限数值时抛出。
     */
    setVolume(value) {
      if (!Number.isFinite(value)) throw new TypeError('音量必须是有限数值');
      volume = Math.max(0, Math.min(1, value));
      try {
        localStorage.setItem('kagari.volume', String(volume));
      } catch {
        /* 存储受限时仍保留本次访问的音量。 */
      }
      rampVolume(VOLUME_RAMP_SECONDS);
      return volume;
    },
    /**
     * 淡入或淡出音乐和音效，并保存开关状态。
     * @returns {boolean} 切换后的状态。
     */
    toggle() {
      enabled = !enabled;
      try {
        localStorage.setItem('kagari.sound', enabled ? 'on' : 'off');
      } catch {
        /* 存储受限时仍保留本次访问的开关状态。 */
      }
      rampVolume(enabled ? SOUND_FADE_IN_SECONDS : SOUND_FADE_OUT_SECONDS);
      if (enabled) resume();
      return enabled;
    },
    /**
     * 调整紧张音效的强度。
     * @param {number} v - 强度，取 0 至 1。
     * @returns {void}
     */
    setTension(v) {
      if (!ctx) return;
      tension.gain.setTargetAtTime(v * 0.12, ctx.currentTime, 0.6);
    },
    /**
     * 播放脚步音效。
     * @param {boolean} isOnPaper - 是否踩在纸上。
     * @param {boolean} isRunning - 是否正在奔跑。
     * @returns {void}
     */
    step(isOnPaper, isRunning) {
      if (isOnPaper) noise({ dur: 0.09, type: 'highpass', f0: 2600, f1: 1800, gain: 0.035, q: 0.7 });
      else noise({ dur: 0.13, type: 'lowpass', f0: isRunning ? 900 : 620, f1: 240, gain: 0.05, q: 0.5 });
    },
    /**
     * 播放缎带扬起时的渐强音效。
     * @returns {void}
     */
    ribbonRise() {
      noise({ dur: 1.6, type: 'bandpass', f0: 500, f1: 2400, q: 2.5, gain: 0.07, attack: 0.5 });
    },
    /**
     * 播放缎带绷紧时的短促音效。
     * @returns {void}
     */
    bristle() {
      noise({ dur: 0.35, type: 'highpass', f0: 3200, f1: 5200, q: 1, gain: 0.08, attack: 0.02 });
    },
    /**
     * 播放缎带挥斩和撞击的音效。
     * @returns {void}
     */
    slash() {
      noise({ dur: 0.28, type: 'highpass', f0: 1500, f1: 7000, q: 0.8, gain: 0.4, attack: 0.004 });
      noise({ when: 0.06, dur: 0.6, type: 'lowpass', f0: 420, f1: 60, q: 1, gain: 0.5, attack: 0.01 });
    },
    /**
     * 播放被缎带弹开时的音效。
     * @returns {void}
     */
    flick() {
      noise({ dur: 0.07, type: 'bandpass', f0: 2200, f1: 900, q: 1.5, gain: 0.35, attack: 0.002 });
    },
    /**
     * 播放少女语言的噪声与振荡音效。
     * @returns {void}
     */
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
    /**
     * 播放倒水音效。
     * @returns {void}
     */
    pour() {
      noise({ dur: 1.1, type: 'bandpass', f0: 900, f1: 1900, q: 6, gain: 0.07, attack: 0.15 });
    },
    /**
     * 播放逐渐升高的铃声音效。
     * @returns {void}
     */
    chime() {
      if (!ctx) return;
      const t = ctx.currentTime + 0.05;
      [587.33, 880.0, 1174.66, 1479.98, 1760.0].forEach((f, i) => bell(f, t + i * 0.16, 0.07, 4.5));
    },
    /**
     * 播放踏入纸面时的和弦与渐强音效。
     * @returns {void}
     */
    open() {
      if (!ctx) return;
      const t = ctx.currentTime + 0.02;
      [293.66, 440.0, 587.33].forEach((f, i) => bell(f, t + i * 0.05, 0.08, 5));
      noise({ dur: 2.2, type: 'bandpass', f0: 300, f1: 3000, q: 3, gain: 0.05, attack: 0.8 });
    },
  };
}
