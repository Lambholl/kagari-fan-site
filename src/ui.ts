// DOM 层：字幕、提示、章节卡、黑场与闪白。

import type { LoadingState } from './loading.ts'
import type { createTimeline } from './util/timeline.ts'
import { getElement as $, getChild } from './util/dom.ts'

interface SubtitleOptions {
  speaker?: string
  hasGlyphEffect?: boolean
  hold?: number
}

/** 一行旁白或带说话人和字效的台词。 */
export type NarrationLine = string | (SubtitleOptions & { text: string })

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
 * @returns update 刷新进度和阶段说明；fail 把进度条标成失败并显示 message。
 */
export const createLoadingView = () => {
  const root = $('loading')
  const bar = getChild(root, '.loading-track i')
  const label = getChild(root, '.loading-label')
  const percent = getChild(root, '.loading-percent')
  return {
    update({ value, label: text }: LoadingState) {
      const rounded = Math.floor(value * 100)
      bar.style.transform = `scaleX(${value})`
      label.textContent = text
      percent.textContent = `${rounded}%`
      root.setAttribute('aria-valuenow', String(rounded))
      root.setAttribute('aria-valuetext', `${text} ${rounded}%`)
    },
    fail(message: string) {
      root.classList.add('failed')
      label.textContent = message
      percent.textContent = ''
      root.setAttribute('aria-valuetext', message)
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
  const queue: Exclude<NarrationLine, string>[] = []
  let isQueueRunning = false

  /** 显示一行字幕并等它读完；hold 为停留秒数，glyph 启用抖动字效。 */
  const say = async (text: string, o: SubtitleOptions = {}) => {
    const token = ++sayToken
    isSpeaking = true
    shouldSkip = false
    el.sub.hidden = false
    el.sub.classList.toggle('glyph', !!o.hasGlyphEffect)
    el.speaker.textContent = o.speaker ? `【${o.speaker}】` : ''
    el.text.textContent = ''
    // 打字机
    const chars = [...text]
    let shown = 0
    let acc = 0
    const cps = 34
    await timeline.until((dt) => {
      if (token !== sayToken) {
        return true
      }
      acc += dt
      const want = shouldSkip ? chars.length : Math.min(chars.length, Math.floor(acc * cps))
      if (want !== shown) {
        shown = want
        el.text.textContent = chars.slice(0, shown).join('')
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

  const card = async (title: string, sub = '', seconds = 3.2) => {
    el.cardH.textContent = title
    el.cardP.textContent = sub
    el.card.hidden = false
    void el.card.offsetWidth
    el.card.classList.add('on')
    await timeline.wait(seconds)
    el.card.classList.remove('on')
    await timeline.wait(1.1)
    el.card.hidden = true
  }

  let promptHandler: PromptHandler | null = null
  const setPrompt = (text: string | null, handler: PromptHandler | null = null) => {
    promptHandler = text ? handler : null
    if (!text) {
      el.prompt.hidden = true
      el.act.hidden = true
      return
    }
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
    const label = isFullscreen ? '退出全屏' : '全屏'
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
      el.volume.focus()
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

  return {
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
    setTag(text: string) {
      el.tag.textContent = text
    },
    setConverge(n: number) {
      el.converge.hidden = n <= 0
      el.converge.textContent = `再收束 × ${n}`
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
      el.sound.classList.toggle('off', !isOn)
      el.sound.setAttribute('aria-pressed', String(isOn))
      el.sound.setAttribute('aria-label', isOn ? '关闭声音' : '开启声音')
      el.sound.title = isOn ? '关闭声音' : '开启声音'
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
    setSitLabel(isSitting: boolean) {
      el.sit.textContent = isSitting ? '起身' : '坐下'
    },
  }
}
