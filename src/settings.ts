/** 视角灵敏度使用百分比，视场角使用度。 */
export const CAMERA_RANGES = {
  sensitivity: { min: 20, max: 300, step: 5, initial: 100 },
  fov: { min: 50, max: 90, step: 1, initial: 62 },
} as const

/** 抗锯齿的可选值和对应的界面文案键。 */
export const ANTIALIAS_OPTIONS = {
  off: 'aaOff',
  fxaa: 'aaFxaa',
  smaa: 'aaSmaa',
  taa: 'aaTaa',
} as const

/** 读取保存的偏好。浏览器限制存储时返回 null。 */
export const readSetting = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** 保存偏好。浏览器限制存储时保留本次访问中的选择。 */
export const saveSetting = (key: string, value: number | string): void => {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // 存储不可用时，当前页面仍能正常使用设置。
  }
}

/** 读取滑条保存值，缺失或超出范围时使用初始值。 */
export const readRangeSetting = (
  key: string,
  { min, max, step, initial }: { min: number; max: number; step: number; initial: number },
): number => {
  const saved = Number(readSetting(key) ?? NaN)
  return Number.isFinite(saved) && saved >= min && saved <= max
    ? min + Math.round((saved - min) / step) * step
    : initial
}
import { reactive, watch } from 'vue'
import type { createAudio } from './audio.ts'

/** 恢复设置并保存更改，音量和声音开关由音频接口处理。 */
export const createGameSettings = (audio: ReturnType<typeof createAudio>) => {
  const savedAntialias = readSetting('kagari.antialias')
  const antialias =
    savedAntialias && Object.hasOwn(ANTIALIAS_OPTIONS, savedAntialias)
      ? (savedAntialias as keyof typeof ANTIALIAS_OPTIONS)
      : 'fxaa'
  const state = reactive({
    panel: null as 'settings' | 'help' | null,
    isSoundOn: audio.isEnabled,
    volume: Math.round(audio.volume * 100),
    sensitivity: readRangeSetting('kagari.sensitivity', CAMERA_RANGES.sensitivity),
    fov: readRangeSetting('kagari.fov', CAMERA_RANGES.fov),
    antialias,
  })
  watch(
    () => state.volume,
    (volume) => audio.setVolume(volume / 100),
  )
  watch(
    () => state.sensitivity,
    (value) => saveSetting('kagari.sensitivity', value),
  )
  watch(
    () => state.fov,
    (value) => saveSetting('kagari.fov', value),
  )
  watch(
    () => state.antialias,
    (value) => saveSetting('kagari.antialias', value),
  )
  return {
    state,
    /** 切换声音并同步按钮状态。 */
    toggleSound() {
      state.isSoundOn = audio.toggle()
    },
  }
}
