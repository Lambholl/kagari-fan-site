import { fetchWithProgress, trackLoad } from './loading.ts'

const BGM_URL = `${import.meta.env.BASE_URL}audio/bgm.m4a`
const SOUND_SAMPLES = ['tree-hit.mp3', 'land.mp3', 'ribbon-slash.mp3', 'coffee-pour.m4a'] as const
const BGM_SAMPLE_RATE = 48000
const BGM_LOOP_START_SECONDS = 1613328 / BGM_SAMPLE_RATE
const BGM_LOOP_END_SECONDS = 7661016 / BGM_SAMPLE_RATE
const BGM_FADE_START_SECONDS = 0
const BGM_FADE_IN_SECONDS = 1.5
const MASTER_MAX_GAIN = 0.9
const SOUND_FADE_IN_SECONDS = 0.9
const SOUND_FADE_OUT_SECONDS = 0.6
const VOLUME_RAMP_SECONDS = 0.12

let bgmData: Promise<ArrayBuffer> | null = null
type SoundSample = (typeof SOUND_SAMPLES)[number]
const sampleData: Partial<Record<SoundSample, Promise<ArrayBuffer>>> = {}

const fetchSample = (sound: SoundSample): Promise<ArrayBuffer> => {
  const url = `${import.meta.env.BASE_URL}audio/${sound}`
  sampleData[sound] ??= trackLoad((onProgress) => fetchWithProgress(url, onProgress)).catch(
    (error: unknown) => {
      delete sampleData[sound]
      throw new Error(`下载音效失败：${url}`, { cause: error })
    },
  )
  return sampleData[sound]
}

/**
 * 预先下载录制的场景音效，并计入首屏进度。
 * @throws 任一音效下载失败时拒绝。
 */
export const preloadSoundSamples = async (): Promise<void> => {
  await Promise.all(SOUND_SAMPLES.map(fetchSample))
}

/**
 * 预先下载背景音乐并计入首屏进度；重复调用复用同一次下载，失败后下次调用会重试。
 * @throws 下载失败时拒绝。
 */
export const preloadBgm = (): Promise<ArrayBuffer> => {
  bgmData ??= trackLoad((onProgress) => fetchWithProgress(BGM_URL, onProgress)).catch(
    (error: unknown) => {
      bgmData = null
      throw error instanceof Error ? error : new Error('背景音乐下载失败', { cause: error })
    },
  )
  return bgmData
}

/**
 * 创建背景音乐和场景音效控制器，并读取已保存的声音开关与音量，默认音量为 50%。
 *
 * @returns 音乐与音效共用声音开关。
 */
export const createAudio = () => {
  let ctx: AudioContext | null = null
  let master: GainNode
  let wet: GainNode
  let tension: GainNode
  let bgmSource: AudioBufferSourceNode | null = null
  let bgmLoading: Promise<void> | null = null
  const sampleBuffers: Partial<Record<SoundSample, Promise<AudioBuffer>>> = {}
  let isEnabled = true
  let volume = 0.5
  let noiseBuf: AudioBuffer
  try {
    isEnabled = localStorage.getItem('kagari.sound') !== 'off'
    const storedVolume = localStorage.getItem('kagari.volume')
    if (storedVolume !== null) {
      const parsedVolume = Number(storedVolume)
      if (Number.isFinite(parsedVolume) && parsedVolume >= 0 && parsedVolume <= 1) {
        volume = parsedVolume
      }
    }
  } catch {
    /* 隐私模式下可能读不到，默认开 */
  }

  const rampVolume = (seconds: number) => {
    if (!ctx) {
      return
    }
    const now = ctx.currentTime
    if (typeof master.gain.cancelAndHoldAtTime === 'function') {
      master.gain.cancelAndHoldAtTime(now)
    } else {
      const currentGain = master.gain.value
      master.gain.cancelScheduledValues(now)
      master.gain.setValueAtTime(currentGain, now)
    }
    master.gain.linearRampToValueAtTime(isEnabled ? volume * MASTER_MAX_GAIN : 0, now + seconds)
  }

  const startBgm = (context: AudioContext) => {
    if (bgmSource || bgmLoading) {
      return
    }
    bgmLoading = (async () => {
      // 解码会转移 ArrayBuffer 的所有权，传副本以便解码失败后还能重试。
      const buffer = await context.decodeAudioData((await preloadBgm()).slice(0))
      if (buffer.duration <= BGM_LOOP_END_SECONDS) {
        throw new Error('背景音乐长度不足以覆盖循环终点')
      }
      const source = context.createBufferSource()
      source.buffer = buffer
      source.loop = true
      source.loopStart = BGM_LOOP_START_SECONDS
      source.loopEnd = BGM_LOOP_END_SECONDS
      const gain = context.createGain()
      const startTime = context.currentTime
      const fadeStartTime = startTime + BGM_FADE_START_SECONDS
      gain.gain.value = 0
      gain.gain.setValueAtTime(0, fadeStartTime)
      gain.gain.linearRampToValueAtTime(0.8, fadeStartTime + BGM_FADE_IN_SECONDS)
      // 成品已经包含混响，直接接入 master 可保留混音时的空间感。
      source.connect(gain).connect(master)
      source.start(startTime)
      bgmSource = source
    })()
      .catch((error) => console.error('背景音乐加载失败，将在下次恢复声音时重试。', error))
      .finally(() => {
        bgmLoading = null
      })
  }

  const decodeSample = (context: AudioContext, sound: SoundSample): Promise<AudioBuffer> => {
    sampleBuffers[sound] ??= fetchSample(sound)
      .then((bytes) => context.decodeAudioData(bytes.slice(0)))
      .catch((error: unknown) => {
        delete sampleBuffers[sound]
        throw new Error(`准备音效失败：${sound}`, { cause: error })
      })
    return sampleBuffers[sound]
  }

  const playSample = (sound: SoundSample, gain: number, delay = 0) => {
    const context = ctx
    if (!context) {
      return
    }
    const when = context.currentTime + delay
    decodeSample(context, sound)
      .then((buffer) => {
        const source = context.createBufferSource()
        source.buffer = buffer
        const level = context.createGain()
        level.gain.value = gain
        source.connect(level).connect(master)
        source.start(when)
      })
      .catch((error: unknown) => console.warn('播放音效失败', error))
  }

  /**
   * 创建音乐和音效资源；重复调用复用已创建的资源。
   */
  const init = () => {
    if (ctx) {
      return
    }
    const { webkitAudioContext } = window as Window & { webkitAudioContext?: typeof AudioContext }
    const AC = window.AudioContext || webkitAudioContext
    if (!AC) {
      return
    }
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = isEnabled ? volume * MASTER_MAX_GAIN : 0
    master.connect(ctx.destination)
    startBgm(ctx)
    for (const sound of SOUND_SAMPLES) {
      decodeSample(ctx, sound).catch((error: unknown) => console.warn(error))
    }

    // 简易混响：两条互相反馈的延迟线
    wet = ctx.createGain()
    wet.gain.value = 0.5
    const d1 = ctx.createDelay(2)
    const d2 = ctx.createDelay(2)
    d1.delayTime.value = 0.37
    d2.delayTime.value = 0.53
    const fb1 = ctx.createGain()
    const fb2 = ctx.createGain()
    fb1.gain.value = 0.46
    fb2.gain.value = 0.42
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 2600
    wet.connect(d1)
    wet.connect(d2)
    d1.connect(fb1).connect(d2)
    d2.connect(fb2).connect(lp).connect(d1)
    d1.connect(master)
    d2.connect(master)

    // 紧张时浮上来的低频
    tension = ctx.createGain()
    tension.gain.value = 0
    const to = ctx.createOscillator()
    to.type = 'sawtooth'
    to.frequency.value = 55
    const to2 = ctx.createOscillator()
    to2.type = 'sawtooth'
    to2.frequency.value = 58.3
    const tl = ctx.createBiquadFilter()
    tl.type = 'lowpass'
    tl.frequency.value = 220
    to.connect(tl)
    to2.connect(tl)
    tl.connect(tension).connect(master)
    to.start()
    to2.start()

    // 噪声素材
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const data = noiseBuf.getChannelData(0)
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1
    }
  }

  const bell = (freq: number, when: number, gain = 0.07, dur = 3.2) => {
    if (!ctx) {
      return
    }
    const o = ctx.createOscillator()
    const o2 = ctx.createOscillator()
    o.type = 'sine'
    o2.type = 'sine'
    o.frequency.value = freq
    o2.frequency.value = freq * 2.76
    const g = ctx.createGain()
    const g2 = ctx.createGain()
    g.gain.setValueAtTime(0, when)
    g.gain.linearRampToValueAtTime(gain, when + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur)
    g2.gain.setValueAtTime(0, when)
    g2.gain.linearRampToValueAtTime(gain * 0.25, when + 0.004)
    g2.gain.exponentialRampToValueAtTime(0.0001, when + dur * 0.25)
    o.connect(g)
    o2.connect(g2)
    g.connect(master)
    g.connect(wet)
    g2.connect(master)
    g2.connect(wet)
    o.start(when)
    o2.start(when)
    o.stop(when + dur + 0.1)
    o2.stop(when + dur + 0.1)
  }

  const noise = ({
    dur = 0.3,
    type = 'bandpass',
    f0 = 1000,
    f1 = f0,
    q = 1,
    gain = 0.2,
    attack = 0.01,
  }: {
    dur?: number
    type?: BiquadFilterType
    f0?: number
    f1?: number
    q?: number
    gain?: number
    attack?: number
  }) => {
    if (!ctx) {
      return
    }
    const t = ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = noiseBuf
    src.loop = true
    const f = ctx.createBiquadFilter()
    f.type = type
    f.Q.value = q
    f.frequency.setValueAtTime(f0, t)
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(gain, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(f).connect(g)
    g.connect(master)
    g.connect(wet)
    src.start(t, Math.random())
    src.stop(t + dur + 0.05)
  }

  /**
   * 恢复浏览器暂停的音频，并重试尚未加载成功的音乐。
   */
  const resume = () => {
    if (!ctx) {
      return
    }
    if (ctx.state === 'suspended') {
      ctx.resume().catch((error) => console.error('恢复场景声音失败。', error))
    }
    startBgm(ctx)
  }

  return {
    init,
    resume,
    /**
     * 返回音乐和音效的开关状态。
     */
    get isEnabled() {
      return isEnabled
    },
    /**
     * 返回当前音量。
     * @returns 音量，取 0 至 1。
     */
    get volume() {
      return volume
    },
    /**
     * 平滑调整音乐和音效的音量，并保存设置。
     * @param value - 音量，超出 0 至 1 的值取最近的边界。
     * @returns 调整后的音量；静音时保留该音量供恢复声音时使用。
     * @throws {TypeError} value 不是有限数值时抛出。
     */
    setVolume(value: number) {
      if (!Number.isFinite(value)) {
        throw new TypeError('音量必须是有限数值')
      }
      volume = Math.max(0, Math.min(1, value))
      try {
        localStorage.setItem('kagari.volume', String(volume))
      } catch {
        /* 存储受限时仍保留本次访问的音量。 */
      }
      rampVolume(VOLUME_RAMP_SECONDS)
      return volume
    },
    /**
     * 淡入或淡出音乐和音效，并保存开关状态。
     * @returns 切换后的状态。
     */
    toggle() {
      isEnabled = !isEnabled
      try {
        localStorage.setItem('kagari.sound', isEnabled ? 'on' : 'off')
      } catch {
        /* 存储受限时仍保留本次访问的开关状态。 */
      }
      rampVolume(isEnabled ? SOUND_FADE_IN_SECONDS : SOUND_FADE_OUT_SECONDS)
      if (isEnabled) {
        resume()
      }
      return isEnabled
    },
    /**
     * 调整紧张音效的强度。
     * @param strength - 强度，取 0 至 1。
     * @param timeConstant - 音量变化的时间常数，单位为秒。
     */
    setTension(strength: number, timeConstant = 0.6) {
      if (!ctx) {
        return
      }
      tension.gain.setTargetAtTime(strength * 0.12, ctx.currentTime, timeConstant)
    },
    /**
     * 播放脚步音效。
     */
    step(isOnPaper: boolean, isRunning: boolean) {
      if (isOnPaper) {
        noise({ dur: 0.09, type: 'highpass', f0: 2600, f1: 1800, gain: 0.035, q: 0.7 })
      } else {
        noise({
          dur: 0.13,
          type: 'lowpass',
          f0: isRunning ? 900 : 620,
          f1: 240,
          gain: 0.05,
          q: 0.5,
        })
      }
    },
    /**
     * 按落地力度播放闷响。
     * @param strength - 按落地速度换算，0 及以下静音，1 及以上使用最大音量。
     */
    land(strength: number) {
      if (strength <= 0) {
        return
      }
      playSample('land.mp3', Math.min(1, strength) * 0.7)
    },
    /**
     * 播放全速撞上树干的音效：木头的闷响加上身体倒地的冲击。
     */
    treeHit() {
      playSample('tree-hit.mp3', 0.65)
      playSample('land.mp3', 0.35, 0.45)
    },
    /**
     * 播放缎带扬起时的渐强音效。
     */
    ribbonRise() {
      noise({ dur: 1.6, type: 'bandpass', f0: 500, f1: 2400, q: 2.5, gain: 0.07, attack: 0.5 })
    },
    /**
     * 播放缎带绷紧时的短促音效。
     */
    bristle() {
      noise({ dur: 0.35, type: 'highpass', f0: 3200, f1: 5200, q: 1, gain: 0.08, attack: 0.02 })
    },
    /**
     * 播放缎带划过空气的音效。
     */
    slash() {
      playSample('ribbon-slash.mp3', 0.58)
    },
    /**
     * 播放被缎带弹开时的音效。
     */
    flick() {
      noise({ dur: 0.07, type: 'bandpass', f0: 2200, f1: 900, q: 1.5, gain: 0.35, attack: 0.002 })
    },
    /**
     * 播放少女语言的噪声与振荡音效。
     */
    glyph() {
      if (!ctx) {
        return
      }
      const t = ctx.currentTime
      const o = ctx.createOscillator()
      o.type = 'square'
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(0.09, t + 0.01)
      g.gain.setValueAtTime(0.09, t + 0.42)
      g.gain.linearRampToValueAtTime(0, t + 0.5)
      for (let i = 0; i < 24; i++) {
        o.frequency.setValueAtTime(180 + Math.random() * 2400, t + i * 0.021)
      }
      const ring = ctx.createOscillator()
      ring.frequency.value = 37
      const rg = ctx.createGain()
      rg.gain.value = 0
      ring.connect(rg.gain)
      o.connect(rg).connect(g)
      g.connect(master)
      g.connect(wet)
      o.start(t)
      ring.start(t)
      o.stop(t + 0.55)
      ring.stop(t + 0.55)
      noise({ dur: 0.5, type: 'bandpass', f0: 4000, f1: 300, q: 4, gain: 0.12 })
    },
    /**
     * 播放倒咖啡入杯的音效。
     */
    pour() {
      playSample('coffee-pour.m4a', 0.8)
    },
    /**
     * 播放逐渐升高的铃声音效。
     */
    chime() {
      if (!ctx) {
        return
      }
      const t = ctx.currentTime + 0.05
      ;[587.33, 880.0, 1174.66, 1479.98, 1760.0].forEach((f, i) => bell(f, t + i * 0.16, 0.07, 4.5))
    },
    /**
     * 播放踏入纸面时的和弦与渐强音效。
     */
    open() {
      if (!ctx) {
        return
      }
      const t = ctx.currentTime + 0.02
      ;[293.66, 440.0, 587.33].forEach((f, i) => bell(f, t + i * 0.05, 0.08, 5))
      noise({ dur: 2.2, type: 'bandpass', f0: 300, f1: 3000, q: 3, gain: 0.05, attack: 0.8 })
    },
  }
}
