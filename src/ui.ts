import { computed, reactive, shallowReactive } from 'vue'
import { translate } from './i18n.ts'
import type { StoryMessageKey } from './i18n.ts'
import type { LoadingState } from './loading.ts'
import type { createTimeline } from './util/timeline.ts'
import { getElement } from './util/dom.ts'

interface SubtitleOptions {
  speaker?: StoryMessageKey
  hasGlyphEffect?: boolean
  hold?: number
}

/** 一行旁白或带说话人和字效的台词。 */
export type NarrationLine = StoryMessageKey | (SubtitleOptions & { text: StoryMessageKey })

type PromptHandler = () => Promise<void>

/** 由游戏提供的标题页和触屏按钮行为。 */
export interface GameUiActions {
  start?: (isFree: boolean) => void
  resume?: () => void
  toggleSitting?: () => void
}

interface Subtitle extends SubtitleOptions {
  text: StoryMessageKey
  shown: number
  isComplete: boolean
}

/** 提供 Vue 界面所需的游戏状态和由场景时间轴驱动的演出方法。 */
export const createUI = (timeline: ReturnType<typeof createTimeline>) => {
  const state = shallowReactive({
    isTitleHidden: false,
    isHudVisible: false,
    isPaused: false,
    isTouch: false,
    isSitting: false,
    loading: { value: 0, label: 'loadingDownload', isDone: false } as LoadingState,
    hasLoadingError: false,
    tag: null as StoryMessageKey | null,
    deaths: 0,
    prompt: null as StoryMessageKey | null,
    subtitle: null as Subtitle | null,
    card: null as { title: StoryMessageKey; sub: StoryMessageKey | null } | null,
    joystick: null as { x: number; y: number; dx: number; dy: number } | null,
  })
  const subtitleChars = computed(() => (state.subtitle ? [...translate(state.subtitle.text)] : []))
  const subtitleText = computed(() => {
    const chars = subtitleChars.value
    const line = state.subtitle
    return (line?.isComplete ? chars : chars.slice(0, line?.shown ?? 0)).join('')
  })
  const fade = getElement('fade')
  const flash = getElement('flash')
  const slash = getElement('slash')
  let shouldSkip = false
  const queue: Exclude<NarrationLine, string>[] = []
  let isQueueRunning = false

  /** 显示一行字幕并等待结束。hold 为停留秒数，hasGlyphEffect 启用抖动字效。 */
  const say = async (text: StoryMessageKey, options: SubtitleOptions = {}) => {
    const line = reactive({ ...options, text, shown: 0, isComplete: false })
    state.subtitle = line
    shouldSkip = false
    let elapsed = 0
    await timeline.until((dt) => {
      if (state.subtitle !== line) {
        return true
      }
      elapsed += dt
      const length = subtitleChars.value.length
      line.shown = shouldSkip ? length : Math.min(length, Math.floor(elapsed * 34))
      return line.shown >= length
    })
    if (state.subtitle !== line) {
      return
    }
    line.isComplete = true
    shouldSkip = false
    const hold = options.hold ?? 1.5 + subtitleChars.value.length * 0.085
    elapsed = 0
    await timeline.until((dt) => {
      elapsed += dt
      return state.subtitle !== line || elapsed >= hold || shouldSkip
    })
    if (state.subtitle === line) {
      state.subtitle = null
    }
  }

  const runQueue = async () => {
    isQueueRunning = true
    try {
      let line
      while ((line = queue.shift())) {
        await say(line.text, line)
        await timeline.wait(0.25)
      }
    } finally {
      isQueueRunning = false
    }
  }
  const setFade = (to: number, seconds = 1.2) => {
    fade.style.transitionDuration = `${seconds}s`
    // 先应用过渡时长，再修改透明度，确保这次淡入淡出使用新的时长。
    void fade.offsetWidth
    fade.style.opacity = String(to)
    return timeline.wait(seconds)
  }
  const retrigger = (node: HTMLElement) => {
    // 连续触发同一个特效时，先移除类名并让浏览器应用，才能从头开始动画。
    node.classList.remove('on')
    void node.offsetWidth
    node.classList.add('on')
  }
  const card = async (title: StoryMessageKey, sub: StoryMessageKey | null, seconds = 3.2) => {
    const entry = { title, sub }
    state.card = entry
    await timeline.wait(seconds)
    if (state.card === entry) {
      state.card = null
    }
    await timeline.wait(1.1)
  }

  let promptHandler: PromptHandler | null = null
  return {
    state,
    subtitleText,
    say,
    /** 将旁白排队播放，玩家仍可行动。 */
    narrate(lines: readonly NarrationLine[]) {
      for (const line of lines) {
        queue.push(typeof line === 'string' ? { text: line } : line)
      }
      if (!isQueueRunning) {
        runQueue().catch((error) => console.error('旁白播放失败', error))
      }
    },
    clearNarration() {
      queue.length = 0
      state.subtitle = null
    },
    get isBusy() {
      return state.subtitle !== null || queue.length > 0
    },
    /** 点击或按空格时，先补全正在打印的文字，再跳过等待进入下一句。 */
    advance() {
      if (state.subtitle) {
        shouldSkip = true
      }
    },
    fade: setFade,
    flash() {
      retrigger(flash)
    },
    slash() {
      retrigger(slash)
    },
    card,
    setPrompt(key: StoryMessageKey | null, handler: PromptHandler | null = null) {
      state.prompt = key
      promptHandler = key ? handler : null
    },
    triggerPrompt() {
      if (promptHandler) {
        promptHandler().catch((error) => console.error('互动演出失败', error))
        return true
      }
      return false
    },
    setTag(key: StoryMessageKey) {
      state.tag = key
    },
    setConverge(n: number) {
      state.deaths = n
    },
    showHud(isVisible: boolean) {
      state.isHudVisible = isVisible
    },
    hideTitle() {
      state.isTitleHidden = true
    },
    setPaused(isPaused: boolean) {
      state.isPaused = isPaused
    },
    setTouchMode() {
      state.isTouch = true
    },
    setJoystick(isActive: boolean, x: number, y: number, dx: number, dy: number) {
      state.joystick = isActive ? { x, y, dx, dy } : null
    },
    setSitLabel(isSitting: boolean) {
      state.isSitting = isSitting
    },
  }
}
