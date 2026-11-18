// DOM 层：字幕、提示、章节卡、黑场与闪白。

import type { LoadingState } from './loading.ts'
import { onLocaleChange, translate } from './i18n.ts'
import type { StoryMessageKey } from './i18n.ts'
import type { createTimeline } from './util/timeline.ts'
import { getElement as $, getChild } from './util/dom.ts'

interface SubtitleOptions {
  speaker?: StoryMessageKey
  hasGlyphEffect?: boolean
  hold?: number
}

/** 一行旁白或带说话人和字效的台词。 */
export type NarrationLine = StoryMessageKey | (SubtitleOptions & { text: StoryMessageKey })

type PromptHandler = () => Promise<void>

interface WebKitFullscreenDocument extends Document {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- WebKit 固定的全屏属性名。
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element
  webkitExitFullscreen?: () => void
}
interface WebKitFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: (options?: FullscreenOptions) => void
}

/**
 * 绑定标题画面的加载进度条。
 * @returns update 刷新进度和阶段说明；fail 显示加载错误和处理提示。
 */
export const createLoadingView = () => {
  const root = $('loading')
  const bar = getChild(root, '.loading-track i')
  const label = getChild(root, '.loading-label')
  const percent = getChild(root, '.loading-percent')
  const showFailure = () => {
    const message = translate('loadingFailed')
    label.textContent = message
    root.setAttribute('aria-valuetext', message)
  }
  return {
    update({ value, label: text }: LoadingState) {
      const rounded = Math.floor(value * 100)
      bar.style.transform = `scaleX(${value})`
      label.textContent = text
      percent.textContent = `${rounded}%`
      root.setAttribute('aria-valuenow', String(rounded))
      root.setAttribute('aria-valuetext', `${text} ${rounded}%`)
    },
    fail() {
      root.classList.add('failed')
      percent.textContent = ''
      $('intro').hidden = true
      $('loading-error').hidden = false
      showFailure()
      onLocaleChange(showFailure)
    },
  }
}

/** 创建负责字幕、提示、章节卡、黑场与设置面板的界面控制器。 */
export const createUI = (timeline: ReturnType<typeof createTimeline>) => {
  const el = {
    title: $('title'),
    start: $('btn-start', HTMLButtonElement),
    free: $('btn-free', HTMLButtonElement),
    hud: $('hud'),
    tag: $('chapter-tag'),
    converge: $('converge'),
    prompt: $('prompt'),
    promptText: getChild($('prompt'), 'span'),
    sub: $('subtitle'),
    speaker: getChild($('subtitle'), '.speaker'),
    text: getChild($('subtitle'), '.text'),
    fade: $('fade'),
    flash: $('flash'),
    slash: $('slash'),
    card: $('card'),
    cardH: getChild($('card'), 'h2'),
    cardP: getChild($('card'), 'p'),
    pause: $('pause'),
    sound: $('btn-sound'),
    settings: $('btn-settings'),
    settingsBox: $('settings'),
    language: $('language', HTMLSelectElement),
    volume: $('volume', HTMLInputElement),
    volumeValue: $('volume-value'),
    sensitivity: $('sensitivity', HTMLInputElement),
    sensitivityValue: $('sensitivity-value'),
    fov: $('fov', HTMLInputElement),
    fovValue: $('fov-value'),
    fullscreen: $('btn-fullscreen'),
    antialias: $('antialias', HTMLSelectElement),
    help: $('btn-help'),
    helpBox: $('help'),
    joystick: $('joystick'),
    joyKnob: getChild($('joystick'), 'i'),
    act: $('btn-act'),
    sit: $('btn-sit'),
  }

  let sayToken = 0
  let shouldSkip = false
  let isSpeaking = false
  let refreshSubtitle: (() => void) | null = null
  const queue: Exclude<NarrationLine, string>[] = []
  let isQueueRunning = false

  /** 显示一行字幕并等待结束。hold 为停留秒数，hasGlyphEffect 启用抖动字效。 */
  const say = async (text: StoryMessageKey, o: SubtitleOptions = {}) => {
    const token = ++sayToken
    isSpeaking = true
    shouldSkip = false
    el.sub.hidden = false
    el.sub.classList.toggle('glyph', !!o.hasGlyphEffect)
    const syncSpeaker = () => {
      el.speaker.textContent = o.speaker ? `【${translate(o.speaker)}】` : ''
    }
    syncSpeaker()
    el.text.textContent = ''
    // 打字机
    let chars = [...translate(text)]
    let shown = 0
    let acc = 0
    const cps = 34
    const showCharacters = (count: number) => {
      shown = count
      el.text.textContent = chars.slice(0, shown).join('')
    }
    refreshSubtitle = () => {
      const wasComplete = shown === chars.length
      chars = [...translate(text)]
      syncSpeaker()
      showCharacters(wasComplete ? chars.length : Math.min(shown, chars.length))
    }
    await timeline.until((dt) => {
      if (token !== sayToken) {
        return true
      }
      acc += dt
      const want = shouldSkip ? chars.length : Math.min(chars.length, Math.floor(acc * cps))
      if (want !== shown) {
        showCharacters(want)
      }
      if (shown >= chars.length) {
        shouldSkip = false
        return true
      }
      return false
    })
    if (token !== sayToken) {
      return
    }
    // 停留
    const hold = o.hold ?? 1.5 + chars.length * 0.085
    let t = 0
    await timeline.until((dt) => {
      t += dt
      return token !== sayToken || t >= hold || shouldSkip
    })
    shouldSkip = false
    if (token !== sayToken) {
      return
    }
    isSpeaking = false
    refreshSubtitle = null
    el.sub.hidden = true
  }

  /** 不打断行动的旁白：排队依次显示 */
  const narrate = (lines: readonly NarrationLine[]) => {
    for (const l of lines) {
      queue.push(typeof l === 'string' ? { text: l } : l)
    }
    if (!isQueueRunning) {
      runQueue().catch((error) => console.error('旁白播放失败', error))
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
  const clearNarration = () => {
    queue.length = 0
    sayToken++
    isSpeaking = false
    refreshSubtitle = null
    el.sub.hidden = true
  }

  const fade = (to: number, seconds = 1.2) => {
    el.fade.style.transitionDuration = `${seconds}s`
    // 强制一次回流，保证过渡生效
    void el.fade.offsetWidth
    el.fade.style.opacity = String(to)
    return timeline.wait(seconds)
  }

  const retrigger = (node: HTMLElement) => {
    node.classList.remove('on')
    void node.offsetWidth
    node.classList.add('on')
  }

  let refreshCard: (() => void) | null = null
  const card = async (title: StoryMessageKey, sub: StoryMessageKey | null, seconds = 3.2) => {
    refreshCard = () => {
      el.cardH.textContent = translate(title)
      el.cardP.textContent = sub ? translate(sub) : ''
    }
    refreshCard()
    el.card.hidden = false
    void el.card.offsetWidth
    el.card.classList.add('on')
    await timeline.wait(seconds)
    el.card.classList.remove('on')
    await timeline.wait(1.1)
    el.card.hidden = true
  }

  let activePrompt: StoryMessageKey | null = null
  let promptHandler: PromptHandler | null = null
  const syncPrompt = () => {
    if (!activePrompt) {
      el.prompt.hidden = true
      el.act.hidden = true
      return
    }
    const text = translate(activePrompt)
    if (el.promptText.textContent !== text) {
      el.promptText.textContent = text
    }
    el.prompt.hidden = false
    if (isTouch) {
      el.act.textContent = text
      el.act.hidden = false
      el.prompt.hidden = true
    }
  }
  const setPrompt = (key: StoryMessageKey | null, handler: PromptHandler | null = null) => {
    activePrompt = key
    promptHandler = key ? handler : null
    syncPrompt()
  }

  // iPhone 上的 Safari 等不支持网页全屏，这时不显示全屏按钮。
  const fullscreenDocument: WebKitFullscreenDocument = document
  const canFullscreen = Boolean(
    document.fullscreenEnabled || fullscreenDocument.webkitFullscreenEnabled,
  )
  const fullscreenElement = () =>
    document.fullscreenElement || fullscreenDocument.webkitFullscreenElement
  const syncFullscreen = () => {
    const isFullscreen = Boolean(fullscreenElement())
    el.fullscreen.setAttribute('aria-pressed', String(isFullscreen))
    const label = translate(isFullscreen ? 'exitFullscreen' : 'fullscreen')
    el.fullscreen.title = label
    el.fullscreen.setAttribute('aria-label', label)
  }
  el.fullscreen.addEventListener('click', () => {
    const root: WebKitFullscreenElement = document.documentElement
    const request = fullscreenElement()
      ? (document.exitFullscreen || fullscreenDocument.webkitExitFullscreen)?.call(document)
      : (root.requestFullscreen || root.webkitRequestFullscreen)?.call(root, {
          navigationUI: 'hide',
        })
    Promise.resolve(request).catch(() => {
      // 浏览器拒绝请求时保留当前显示模式。
    })
  })
  document.addEventListener('fullscreenchange', syncFullscreen)
  document.addEventListener('webkitfullscreenchange', syncFullscreen)

  let isTouch = false
  const setTouchMode = () => {
    if (isTouch) {
      return
    }
    isTouch = true
    el.sit.hidden = false
    el.fullscreen.hidden = !canFullscreen
    syncPrompt()
  }
  // 手机端标题画面就要能全屏，不必等到第一次触摸。
  if (window.matchMedia('(pointer: coarse)').matches) {
    el.fullscreen.hidden = !canFullscreen
  }

  // 右上角一次只展开一个面板，避免设置遮住操作说明。
  const showPanel = (panel: 'settings' | 'help' | null) => {
    el.settingsBox.hidden = panel !== 'settings'
    el.helpBox.hidden = panel !== 'help'
    el.settings.setAttribute('aria-expanded', String(!el.settingsBox.hidden))
    el.help.setAttribute('aria-expanded', String(!el.helpBox.hidden))
  }
  el.help.addEventListener('click', () => showPanel(el.helpBox.hidden ? 'help' : null))
  el.settings.addEventListener('click', () => {
    showPanel(el.settingsBox.hidden ? 'settings' : null)
    if (!el.settingsBox.hidden) {
      el.language.focus()
    }
  })
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || el.settingsBox.hidden) {
      return
    }
    showPanel(null)
    el.settings.focus()
  })
  document.addEventListener('pointerdown', (e) => {
    const target = e.target
    if (
      !el.settingsBox.hidden &&
      target instanceof Node &&
      !el.settingsBox.contains(target) &&
      !el.settings.contains(target)
    ) {
      showPanel(null)
    }
  })

  let activeTag: StoryMessageKey | null = null
  let deaths = 0
  let isSoundOn: boolean | null = null
  let isSitting = false
  const ui = {
    el,
    get isSettingsOpen() {
      return !el.settingsBox.hidden
    },
    say,
    narrate,
    clearNarration,
    get isBusy() {
      return isSpeaking || queue.length > 0
    },
    /** 点击或按空格时，先补全正在打印的文字，再跳过等待进入下一句。 */
    advance() {
      if (isSpeaking) {
        shouldSkip = true
      }
    },
    fade,
    flash() {
      retrigger(el.flash)
    },
    slash() {
      retrigger(el.slash)
    },
    card,
    setPrompt,
    triggerPrompt() {
      if (promptHandler) {
        promptHandler().catch((error) => console.error('互动演出失败', error))
        return true
      }
      return false
    },
    setTag(key: StoryMessageKey) {
      activeTag = key
      el.tag.textContent = translate(key)
    },
    setConverge(n: number) {
      deaths = n
      el.converge.hidden = n <= 0
      el.converge.textContent = translate('convergeCount', n)
    },
    /** 显示或隐藏游戏 HUD；操作说明按钮随 HUD 一起显示，标题画面已列出按键所以不显示。 */
    showHud(isVisible: boolean) {
      el.hud.hidden = !isVisible
      el.help.hidden = !isVisible
      if (!isVisible && !el.helpBox.hidden) {
        showPanel(null)
      }
    },
    hideTitle() {
      el.title.classList.add('gone')
    },
    /** 收起加载进度条，显示并启用两个开始按钮。 */
    setReady() {
      $('loading').hidden = true
      el.start.disabled = false
      el.free.disabled = false
      getChild(el.title, '.actions').hidden = false
    },
    /**
     * 显示或收起暂停界面。
     */
    setPaused(isPaused: boolean) {
      el.pause.hidden = !isPaused
    },
    setSound(isOn: boolean) {
      isSoundOn = isOn
      el.sound.classList.toggle('off', !isOn)
      el.sound.setAttribute('aria-pressed', String(isOn))
      const label = translate(isOn ? 'mute' : 'unmute')
      el.sound.setAttribute('aria-label', label)
      el.sound.title = label
    },
    /**
     * 显示音量滑条和百分比。
     * @param value - 音量，取 0 至 1。
     */
    setVolume(value: number) {
      const percentage = Math.round(value * 100)
      el.volume.value = String(percentage)
      el.volume.setAttribute('aria-valuetext', `${percentage}%`)
      el.volumeValue.textContent = `${percentage}%`
    },
    /**
     * 显示视角灵敏度的百分比。
     * @param percentage - 100 为默认速度。
     */
    setSensitivityLabel(percentage: number) {
      el.sensitivity.setAttribute('aria-valuetext', `${percentage}%`)
      el.sensitivityValue.textContent = `${percentage}%`
    },
    /**
     * 显示视场角。
     * @param degrees - 横屏时的竖直视场角（度）。
     */
    setFovLabel(degrees: number) {
      el.fov.setAttribute('aria-valuetext', `${degrees}°`)
      el.fovValue.textContent = `${degrees}°`
    },
    setTouchMode,
    get isTouch() {
      return isTouch
    },
    setJoystick(isActive: boolean, x: number, y: number, dx: number, dy: number) {
      el.joystick.hidden = !isActive
      if (isActive) {
        el.joystick.style.left = `${x}px`
        el.joystick.style.top = `${y}px`
        el.joyKnob.style.transform = `translate(${dx}px, ${dy}px)`
      }
    },
    setSitLabel(shouldSit: boolean) {
      isSitting = shouldSit
      el.sit.textContent = translate(isSitting ? 'stand' : 'sit')
    },
  }
  ui.setSitLabel(false)
  onLocaleChange(() => {
    refreshSubtitle?.()
    refreshCard?.()
    syncPrompt()
    syncFullscreen()
    if (activeTag) {
      ui.setTag(activeTag)
    }
    ui.setConverge(deaths)
    if (isSoundOn !== null) {
      ui.setSound(isSoundOn)
    }
    ui.setSitLabel(isSitting)
  })
  return ui
}
