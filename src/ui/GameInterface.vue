<script setup lang="ts">
import { computed } from 'vue'
import { translate as t } from '../i18n.ts'
import type { createGameSettings } from '../settings.ts'
import type { createUI, GameUiActions } from '../ui.ts'
import CornerControls from './CornerControls.vue'
import TitleScreen from './TitleScreen.vue'

const props = defineProps<{
  ui: ReturnType<typeof createUI>
  settings: ReturnType<typeof createGameSettings>
  actions: GameUiActions
}>()
const { state, subtitleText } = props.ui
const promptText = computed(() => (state.prompt ? t(state.prompt) : ''))
const activate = () => {
  if (!props.ui.triggerPrompt()) {
    props.ui.advance()
  }
}
</script>

<template>
  <div id="hud" :hidden="!state.isHudVisible">
    <div id="chapter-tag">{{ state.tag ? t(state.tag) : '' }}</div>
    <div v-if="state.deaths > 0" id="converge">{{ t('convergeCount', state.deaths) }}</div>
    <div v-if="state.prompt && !state.isTouch" id="prompt">
      <kbd>E</kbd><span>{{ promptText }}</span>
    </div>
    <div
      id="subtitle"
      :hidden="!state.subtitle"
      :class="{ glyph: state.subtitle?.hasGlyphEffect }"
      @click="ui.advance"
    >
      <div v-if="state.subtitle?.speaker" class="speaker">【{{ t(state.subtitle.speaker) }}】</div>
      <p class="text">{{ subtitleText }}</p>
    </div>
    <div
      v-if="state.joystick"
      id="joystick"
      :style="{ left: `${state.joystick.x}px`, top: `${state.joystick.y}px` }"
    >
      <i :style="{ transform: `translate(${state.joystick.dx}px, ${state.joystick.dy}px)` }"></i>
    </div>
    <button v-if="state.prompt && state.isTouch" id="btn-act" type="button" @click="activate">
      {{ promptText }}
    </button>
    <button v-if="state.isTouch" id="btn-sit" type="button" @click="actions.toggleSitting?.()">
      {{ t(state.isSitting ? 'stand' : 'sit') }}
    </button>
    <div v-if="state.isPaused" id="pause" @click="actions.resume?.()">
      <span>{{ t('resume') }}</span>
    </div>
  </div>

  <Transition name="card">
    <div v-if="state.card" id="card">
      <h2>{{ t(state.card.title) }}</h2>
      <p>{{ state.card.sub ? t(state.card.sub) : '' }}</p>
    </div>
  </Transition>

  <TitleScreen
    :is-hidden="state.isTitleHidden"
    :has-loading-error="state.hasLoadingError"
    :loading="state.loading"
    @start="actions.start?.($event)"
  />
  <CornerControls
    :settings="settings"
    :is-hud-visible="state.isHudVisible"
    :is-touch="state.isTouch"
  />
</template>
