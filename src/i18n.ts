import { ref, watch } from 'vue'
import { storyMessages } from './i18n/story-messages.ts'
import { uiMessages } from './i18n/ui-messages.ts'
import { readSetting, saveSetting } from './settings.ts'
import { getElement } from './util/dom.ts'

const messages = { ...uiMessages, ...storyMessages }

/** 界面和剧情文案的键。 */
export type MessageKey = keyof typeof messages

/** 剧情文案的键，包括旁白、说话人和互动提示。 */
export type StoryMessageKey = keyof typeof storyMessages

type Locale = 'zh-CN' | 'ja'

/** 当前界面和剧情语言。 */
export const locale = ref<Locale>('zh-CN')

/** 读取当前语言的文案，并按顺序替换参数占位符。 */
export const translate = (key: MessageKey, ...values: (number | string)[]): string => {
  const text = messages[key][locale.value === 'ja' ? 1 : 0]
  return values.length > 0
    ? text.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
        String(values[Number(index)] ?? placeholder),
      )
    : text
}

/** 恢复保存的语言，并同步页面元信息和三维场景的可访问名称。 */
export const bindPageLanguage = (): void => {
  const saved = readSetting('kagari.language')
  const browserLocale = /^ja(?:-|$)/i.test(navigator.language) ? 'ja' : 'zh-CN'
  locale.value = saved === 'ja' || saved === 'zh-CN' ? saved : browserLocale
  const scene = getElement('app')
  const description = document.querySelector('meta[name="description"]')
  const applyLanguage = () => {
    document.documentElement.lang = locale.value
    document.title = translate('pageTitle')
    description?.setAttribute('content', translate('pageDescription'))
    scene.setAttribute('aria-label', translate('scene'))
  }

  applyLanguage()
  watch(locale, (value) => {
    saveSetting('kagari.language', value)
    applyLanguage()
  })
}
