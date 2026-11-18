<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue'
import { locale, translate as t } from '../i18n.ts'
import { ANTIALIAS_OPTIONS, CAMERA_RANGES } from '../settings.ts'
import type { createGameSettings } from '../settings.ts'

const props = defineProps<{
  settings: ReturnType<typeof createGameSettings>
  isHudVisible: boolean
  isTouch: boolean
}>()
const state = props.settings.state
const settingsButton = useTemplateRef('settingsButton')
const settingsPanel = useTemplateRef('settingsPanel')
const languageSelect = useTemplateRef('languageSelect')
const ranges = [
  { id: 'volume', min: 0, max: 100, step: 1, unit: '%' },
  { id: 'sensitivity', ...CAMERA_RANGES.sensitivity, unit: '%' },
  { id: 'fov', ...CAMERA_RANGES.fov, unit: '°' },
] as const
const isSettingsOpen = computed(() => state.panel === 'settings')
const isHelpOpen = computed(() => state.panel === 'help')
const soundLabel = computed(() => t(state.isSoundOn ? 'mute' : 'unmute'))

interface WebKitFullscreenDocument extends Document {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- WebKit 固定的全屏属性名。
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element
  webkitExitFullscreen?: () => void
}

interface WebKitFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: (options?: FullscreenOptions) => void
}

const fullscreenDocument: WebKitFullscreenDocument = document
const fullscreenRoot: WebKitFullscreenElement = document.documentElement
const fullscreenElement = () =>
  document.fullscreenElement || fullscreenDocument.webkitFullscreenElement
const canFullscreen = Boolean(
  document.fullscreenEnabled || fullscreenDocument.webkitFullscreenEnabled,
)
const hasCoarsePointer = window.matchMedia('(pointer: coarse)').matches
const isFullscreen = ref(Boolean(fullscreenElement()))
const fullscreenLabel = computed(() => t(isFullscreen.value ? 'exitFullscreen' : 'fullscreen'))
const syncFullscreen = () => {
  isFullscreen.value = Boolean(fullscreenElement())
}
const toggleFullscreen = async () => {
  try {
    if (fullscreenElement()) {
      await (document.exitFullscreen || fullscreenDocument.webkitExitFullscreen)?.call(document)
    } else {
      await (fullscreenRoot.requestFullscreen || fullscreenRoot.webkitRequestFullscreen)?.call(
        fullscreenRoot,
        {
          navigationUI: 'hide',
        },
      )
    }
  } catch {
    // 浏览器拒绝请求时保留当前显示模式。
  }
}
const toggleSettings = async () => {
  state.panel = isSettingsOpen.value ? null : 'settings'
  if (isSettingsOpen.value) {
    await nextTick()
    languageSelect.value?.focus()
  }
}
const onPointerDown = (event: PointerEvent) => {
  const target = event.target
  if (
    isSettingsOpen.value &&
    target instanceof Node &&
    !settingsPanel.value?.contains(target) &&
    !settingsButton.value?.contains(target)
  ) {
    state.panel = null
  }
}
const onKeyDown = (event: KeyboardEvent) => {
  if (event.code === 'KeyM') {
    props.settings.toggleSound()
  }
  if (event.key === 'Escape' && isSettingsOpen.value) {
    state.panel = null
    settingsButton.value?.focus()
  }
}

watch(
  () => props.isHudVisible,
  (isVisible) => {
    if (!isVisible && isHelpOpen.value) {
      state.panel = null
    }
  },
)
onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown)
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('fullscreenchange', syncFullscreen)
  document.addEventListener('webkitfullscreenchange', syncFullscreen)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', onPointerDown)
  document.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('fullscreenchange', syncFullscreen)
  document.removeEventListener('webkitfullscreenchange', syncFullscreen)
})
</script>

<template>
  <div id="corner">
    <div id="top-buttons">
      <a
        id="link-github"
        href="https://github.com/Lambholl/kagari-fan-site"
        target="_blank"
        rel="noopener noreferrer"
        :title="t('viewGithub')"
        :aria-label="t('github')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 .297C5.37.297 0 5.67 0 12.297c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.043-1.61-4.043-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.838 1.237 1.838 1.237 1.07 1.835 2.809 1.305 3.495.998.108-.776.418-1.305.762-1.605-2.665-.3-5.467-1.334-5.467-5.931 0-1.31.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23a11.52 11.52 0 0 1 3.003-.404c1.018.005 2.042.138 3.003.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.652.242 2.873.119 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.628-5.479 5.924.43.372.823 1.102.823 2.222 0 1.606-.015 2.898-.015 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
          />
        </svg>
      </a>
      <button
        id="btn-fullscreen"
        type="button"
        :title="fullscreenLabel"
        :aria-label="fullscreenLabel"
        :aria-pressed="isFullscreen"
        :hidden="!canFullscreen || (!hasCoarsePointer && !isTouch)"
        @click="toggleFullscreen"
      >
        <svg class="icon-enter" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
        </svg>
        <svg class="icon-exit" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 2v4H2M14 6h-4V2M10 14v-4h4M2 10h4v4" />
        </svg>
      </button>
      <button
        id="btn-sound"
        type="button"
        :class="{ off: !state.isSoundOn }"
        :title="soundLabel"
        :aria-label="soundLabel"
        :aria-pressed="state.isSoundOn"
        @click="settings.toggleSound"
      >
        ♪
      </button>
      <button
        id="btn-settings"
        ref="settingsButton"
        type="button"
        :title="t('settings')"
        :aria-label="t('settings')"
        aria-controls="settings"
        :aria-expanded="isSettingsOpen"
        @click="toggleSettings"
      >
        &#x2699;&#xFE0E;
      </button>
      <button
        id="btn-help"
        type="button"
        :title="t('help')"
        :aria-label="t('help')"
        aria-controls="help"
        :aria-expanded="isHelpOpen"
        :hidden="!isHudVisible"
        @click="state.panel = isHelpOpen ? null : 'help'"
      >
        ?
      </button>
    </div>
    <section
      id="settings"
      ref="settingsPanel"
      aria-labelledby="settings-title"
      :hidden="!isSettingsOpen"
    >
      <h2 id="settings-title">{{ t('settings') }}</h2>
      <label for="language">{{ t('language') }}</label>
      <select id="language" ref="languageSelect" v-model="locale">
        <option value="zh-CN" lang="zh-CN">简体中文</option>
        <option value="ja" lang="ja">日本語</option>
      </select>
      <template v-for="control in ranges" :key="control.id">
        <label :for="control.id">{{ t(control.id) }}</label>
        <div class="range-control">
          <input
            :id="control.id"
            v-model.number="state[control.id]"
            type="range"
            :min="control.min"
            :max="control.max"
            :step="control.step"
            :aria-valuetext="`${state[control.id]}${control.unit}`"
          />
          <output :id="`${control.id}-value`" :for="control.id">
            {{ state[control.id] }}{{ control.unit }}
          </output>
        </div>
      </template>
      <label for="antialias">{{ t('antialias') }}</label>
      <select id="antialias" v-model="state.antialias" aria-describedby="antialias-hint">
        <option v-for="(label, mode) in ANTIALIAS_OPTIONS" :key="mode" :value="mode">
          {{ t(label) }}
        </option>
      </select>
      <p id="antialias-hint">{{ t('aaHint') }}</p>
    </section>
    <div id="help" :hidden="!isHelpOpen">
      <p>
        <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> {{ t('move') }}&#x3000;<kbd>Shift</kbd>
        {{ t('run') }}
      </p>
      <p>
        <kbd>{{ t('mouse') }}</kbd> {{ t('look') }}&#x3000;<kbd>C</kbd> {{ t('sitOrStand') }}
      </p>
      <p>
        <kbd>E</kbd> {{ t('act') }}&#x3000;<kbd>{{ t('space') }}</kbd> {{ t('advance') }}
      </p>
      <p><kbd>X</kbd> {{ t('zoomHelp') }}</p>
      <p><kbd>Esc</kbd> {{ t('releaseMouse') }}</p>
    </div>
  </div>
</template>
