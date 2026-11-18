<script setup lang="ts">
import { computed } from 'vue'
import { translate as t } from '../i18n.ts'
import type { LoadingState } from '../loading.ts'

const props = defineProps<{
  isHidden: boolean
  hasLoadingError: boolean
  loading: LoadingState
}>()
const emit = defineEmits<{ start: [isFree: boolean] }>()
const percentage = computed(() => Math.floor(props.loading.value * 100))
const loadingLabel = computed(() =>
  props.hasLoadingError
    ? t('loadingFailed')
    : t(props.loading.label, ...(props.loading.labelValues ?? [])),
)
</script>

<template>
  <section id="title" :class="{ gone: isHidden }">
    <div class="title-inner">
      <p class="eyebrow">Rewrite ── Moon</p>
      <h1>
        <span>月</span><span>王</span><span>篝</span><span>{{ t('titleLastCharacter') }}</span>
      </h1>
      <p class="lead">
        <small>{{ t('creators') }}</small>
      </p>
      <p v-if="hasLoadingError" class="desc" id="loading-error">{{ t('loadingFailureHint') }}</p>
      <p v-else class="desc" id="intro">
        {{ t('introNight') }}<br />
        {{ t('introPaper') }}
      </p>
      <div
        v-if="hasLoadingError || !loading.isDone"
        id="loading"
        :class="{ failed: hasLoadingError }"
        role="progressbar"
        :aria-label="t('loadingProgress')"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="percentage"
        :aria-valuetext="hasLoadingError ? loadingLabel : `${loadingLabel} ${percentage}%`"
      >
        <div class="loading-track"><i :style="{ transform: `scaleX(${loading.value})` }"></i></div>
        <p class="loading-text">
          <span class="loading-label">{{ loadingLabel }}</span>
          <span v-if="!hasLoadingError" class="loading-percent">{{ percentage }}%</span>
        </p>
      </div>
      <div v-else class="actions">
        <button id="btn-start" type="button" @click="emit('start', false)">{{ t('start') }}</button>
        <button id="btn-free" type="button" class="ghost" @click="emit('start', true)">
          <span>{{ t('freeRoam') }}</span><small>{{ t('skipStory') }}</small>
        </button>
      </div>
      <ul class="keys">
        <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> {{ t('move') }}</li>
        <li>
          <kbd>{{ t('mouse') }}</kbd> {{ t('look') }}
        </li>
        <li><kbd>E</kbd> {{ t('interact') }}</li>
        <li><kbd>C</kbd> {{ t('sit') }}</li>
        <li><kbd>X</kbd> {{ t('zoom') }}</li>
        <li class="touch-only">{{ t('touchControls') }}</li>
      </ul>
      <p class="legal">
        {{ t('modelCredit') }}
        <a
          href="https://github.com/qpyiu123/Patchouli-model-warehouse"
          target="_blank"
          rel="noopener"
          >Kagari-v9-rigged · qpyiu123</a
        >
        （<a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener"
          >CC BY-SA 4.0</a
        >）<br />
        {{ t('treeCredit') }}
        <a
          href="https://sketchfab.com/3d-models/200-year-old-oak-tree-337641cb274845b39f7944aa880ff686"
          target="_blank"
          rel="noopener"
          >200 Year Old Oak Tree · kungphil</a
        >
        （<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener"
          >CC BY 4.0</a
        >）<br />
        {{ t('bgmCredit')
        }}<a
          href="https://www.youtube.com/watch?v=0RwhROC7yfU"
          target="_blank"
          rel="noopener noreferrer"
          >YouTube</a
        ><br />
        {{ t('harpCredit')
        }}<a
          href="https://freepats.zenvoid.org/OrchestralStrings/harp.html"
          target="_blank"
          rel="noopener noreferrer"
          >Concert Harp · Versilian Studios / FreePats</a
        >
        （<a
          href="https://creativecommons.org/publicdomain/zero/1.0/"
          target="_blank"
          rel="noopener noreferrer"
          >CC0 1.0</a
        >）<br />
        {{ t('copyright') }}
      </p>
    </div>
  </section>
</template>
