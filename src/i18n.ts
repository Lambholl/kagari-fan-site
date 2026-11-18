import { storyMessages } from './i18n/story-messages.ts'
import { uiMessages } from './i18n/ui-messages.ts'
import { bindSelectSetting } from './settings.ts'
import { getElement } from './util/dom.ts'

const messages = { ...uiMessages, ...storyMessages }

/** 界面和剧情文案的键。 */
export type MessageKey = keyof typeof messages

/** 剧情文案的键，包括旁白、说话人和互动提示。 */
export type StoryMessageKey = keyof typeof storyMessages

type Locale = 'zh-CN' | 'ja'
let locale: Locale = 'zh-CN'
const listeners = new Set<() => void>()

/** 读取当前语言的文案，并按顺序替换参数占位符。 */
export const translate = (key: MessageKey, ...values: (number | string)[]): string => {
  const text = messages[key][locale === 'ja' ? 1 : 0]
  return values.length > 0
    ? text.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
        String(values[Number(index)] ?? placeholder),
      )
    : text
}

/** 语言切换后调用 refresh，返回取消订阅的方法。 */
export const onLocaleChange = (refresh: () => void): (() => void) => {
  listeners.add(refresh)
  return () => listeners.delete(refresh)
}

/** 恢复保存的语言，绑定设置中的语言选项并翻译页面上的固定文案。 */
export const bindPageLanguage = (): void => {
  const select = getElement('language', HTMLSelectElement)
  select.value = /^ja(?:-|$)/i.test(navigator.language) ? 'ja' : 'zh-CN'
  const attributes = [
    ['data-i18n', null],
    ['data-i18n-label', 'aria-label'],
    ['data-i18n-title', 'title'],
    ['data-i18n-content', 'content'],
  ] as const
  const bindings = attributes.flatMap(([marker, attribute]) =>
    Array.from(document.querySelectorAll('[' + marker + ']'), (node) => {
      const key = node.getAttribute(marker)!
      if (!Object.hasOwn(messages, key)) {
        throw new Error('未知文案键 ' + key)
      }
      return { node, key: key as MessageKey, attribute }
    }),
  )

  bindSelectSetting(select, 'kagari.language', (value) => {
    const previous = locale
    locale = value === 'ja' ? 'ja' : 'zh-CN'
    document.documentElement.lang = locale
    for (const { node, key, attribute } of bindings) {
      const text = translate(key)
      if (attribute) {
        node.setAttribute(attribute, text)
      } else {
        node.textContent = text
      }
    }
    if (locale !== previous) {
      for (const refresh of listeners) {
        refresh()
      }
    }
  })
}
