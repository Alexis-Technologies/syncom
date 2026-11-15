<script setup lang="ts">
// The frame of every figure of the guide: an SVG scene told in steps. The figure inside gets the
// current step through the slot (`v-slot="{ step }"`) and draws each state; CSS transitions on its
// elements turn one state into the next. The frame plays when it scrolls into view, pauses when it
// leaves, and stops autoplay for a reader who asked for reduced motion (the steps stay reachable by
// the buttons). The step captions are the figure's text: shown under the scene, and the scene's
// accessible description. The server render shows `keyStep`, the state that tells the most alone.
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';

const props = withDefaults(
  defineProps<{
    caption: string;
    steps: string[];
    /** ms each step holds while playing; the last one holds `hold` ms before the loop starts again. */
    interval?: number;
    hold?: number;
    keyStep?: number;
    viewBox?: string;
  }>(),
  { interval: 2400, hold: 4000, keyStep: 0, viewBox: '0 0 720 300' },
);

const step = ref(props.keyStep);
const playing = ref(false);
const root = ref<HTMLElement | null>(null);
const uid = useId();
let timer: ReturnType<typeof setTimeout> | null = null;
let observer: IntersectionObserver | null = null;
let visible = false;
let reduced = false;

const last = computed(() => props.steps.length - 1);

const clear = () => {
  if (timer !== null) clearTimeout(timer);
  timer = null;
};
const schedule = () => {
  clear();
  if (!playing.value || !visible) return;
  timer = setTimeout(
    () => {
      step.value = step.value >= last.value ? 0 : step.value + 1;
      schedule();
    },
    step.value >= last.value ? props.hold : props.interval,
  );
};
const play = () => {
  playing.value = true;
  if (step.value >= last.value) step.value = 0;
  schedule();
};
const pause = () => {
  playing.value = false;
  clear();
};
const go = (to: number) => {
  pause();
  step.value = Math.max(0, Math.min(last.value, to));
};

onMounted(() => {
  reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  step.value = reduced ? props.keyStep : 0;
  observer = new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !reduced && !playing.value && timer === null && step.value === 0) play();
      else if (visible) schedule();
      else clear();
    },
    { threshold: 0.35 },
  );
  if (root.value) observer.observe(root.value);
});
onBeforeUnmount(() => {
  clear();
  observer?.disconnect();
});
</script>

<template>
  <figure ref="root" class="sc-fig">
    <svg
      class="sc-fig-scene"
      :viewBox="viewBox"
      role="img"
      :aria-labelledby="`${uid}-title`"
      :aria-describedby="`${uid}-steps`"
    >
      <title :id="`${uid}-title`">{{ caption }}</title>
      <defs>
        <linearGradient :id="`${uid}-grad`" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#3f7fd0" />
          <stop offset="1" stop-color="#6ad0c8" />
        </linearGradient>
      </defs>
      <slot :step="step" :grad="`url(#${uid}-grad)`" />
    </svg>
    <figcaption>
      <div class="sc-fig-controls">
        <button
          type="button"
          class="sc-fig-button"
          :aria-label="playing ? 'Pause' : 'Play'"
          @click="playing ? pause() : play()"
        >
          <svg v-if="playing" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h3v10H4zM9 3h3v10H9z" /></svg>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" /></svg>
        </button>
        <button type="button" class="sc-fig-button" aria-label="Previous step" :disabled="step === 0" @click="go(step - 1)">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 3 5 8l5.5 5" /></svg>
        </button>
        <button
          type="button"
          class="sc-fig-button"
          aria-label="Next step"
          :disabled="step === last"
          @click="go(step + 1)"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3 11 8l-5.5 5" /></svg>
        </button>
        <span class="sc-fig-dots" aria-hidden="true">
          <button
            v-for="(_, i) in steps"
            :key="i"
            type="button"
            tabindex="-1"
            :class="['sc-fig-dot', { 'sc-fig-dot-on': i === step }]"
            @click="go(i)"
          />
        </span>
        <span class="sc-fig-count">{{ step + 1 }} / {{ steps.length }}</span>
      </div>
      <p class="sc-fig-step" aria-live="polite">{{ steps[step] }}</p>
      <ol :id="`${uid}-steps`" class="sc-fig-alt">
        <li v-for="(text, i) in steps" :key="i">{{ text }}</li>
      </ol>
      <p class="sc-fig-caption">{{ caption }}</p>
    </figcaption>
  </figure>
</template>
