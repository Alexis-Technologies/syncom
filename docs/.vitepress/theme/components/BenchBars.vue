<script setup lang="ts">
import { computed, ref } from 'vue';
// The chart models are shared with the README images (bench/report/svg.mjs),
// so the docs and the README cannot show different numbers.
import { allValues, barsOf, createScale, formatValue } from '../../../../bench/report/model.mjs';

const props = defineProps<{ model: any; caption?: string | null }>();

const scale = computed(() =>
  createScale(allValues(props.model), props.model.scale, props.model.unit),
);
const pct = (at: number) => `${(Math.max(0, Math.min(1, at)) * 100).toFixed(3)}%`;
const reference = computed(() =>
  props.model.reference === undefined ? null : pct(scale.value.at(props.model.reference)),
);

const body = ref<HTMLElement | null>(null);
const active = ref<{ row: any; top: number; left: number } | null>(null);

const show = (row: any, event: Event) => {
  const target = event.currentTarget as HTMLElement;
  const host = body.value;
  if (!host) return;
  const rowBox = target.getBoundingClientRect();
  const hostBox = host.getBoundingClientRect();
  const bars = target.querySelectorAll('.sc-bar');
  const last = bars[bars.length - 1] as HTMLElement | undefined;
  const barEnd = last
    ? last.getBoundingClientRect().right - hostBox.left
    : rowBox.left - hostBox.left;
  const width = Math.min(300, hostBox.width);
  active.value = {
    row,
    top: rowBox.bottom - hostBox.top + 4,
    left: Math.max(0, Math.min(barEnd - width / 2, hostBox.width - width)),
  };
};

const hide = () => {
  active.value = null;
};

const ariaLabel = (row: any) => {
  const name = row.sublabel ? `${row.label} (${row.sublabel})` : row.label;
  return `${name}: ${row.details?.[0] ?? formatValue(row.value, props.model.unit)}`;
};

const offset = (index: number, count: number) =>
  count === 1 ? '50%' : `calc(50% + ${(index - (count - 1) / 2) * 11}px)`;
</script>

<template>
  <figure class="sc-chart">
    <slot name="controls" />
    <div class="sc-head">
      <div class="sc-title">{{ model.title }}</div>
      <div class="sc-subtitle">{{ model.subtitle }}</div>
      <div v-if="model.legend" class="sc-legend">
        <span v-for="item in model.legend" :key="item.label" class="sc-legend-item">
          <span class="sc-swatch" :class="item.tone && `is-${item.tone}`" />{{ item.label }}
        </span>
      </div>
    </div>

    <div ref="body" class="sc-body" @pointerleave="hide">
      <template v-for="group in model.groups" :key="group.id">
        <div v-if="group.label" class="sc-group">{{ group.label }}</div>
        <div
          v-for="row in group.rows"
          :key="row.id"
          class="sc-row"
          :class="[row.tone && `is-${row.tone}`, { 'is-active': active?.row === row }]"
          tabindex="0"
          :aria-label="ariaLabel(row)"
          @pointerenter="show(row, $event)"
          @focus="show(row, $event)"
          @blur="hide"
        >
          <div class="sc-label">
            <span class="sc-name">{{ row.label }}</span>
            <span v-if="row.sublabel" class="sc-sub">{{ row.sublabel }}</span>
          </div>
          <div class="sc-plot">
            <span
              v-for="tick in scale.ticks"
              :key="tick.value"
              class="sc-gridline"
              :style="{ left: pct(tick.at) }"
            />
            <span v-if="reference" class="sc-reference" :style="{ left: reference }" />
            <template v-for="(bar, index) in barsOf(row)" :key="index">
              <span
                class="sc-bar"
                :class="[bar.tone && `is-${bar.tone}`, { 'is-thin': barsOf(row).length > 1 }]"
                :style="{ width: pct(scale.at(bar.value)), top: offset(index, barsOf(row).length) }"
              />
              <span
                class="sc-value"
                :class="{ 'is-thin': barsOf(row).length > 1 }"
                :style="{ left: pct(scale.at(bar.value)), top: offset(index, barsOf(row).length) }"
                >{{ formatValue(bar.value, model.unit) }}</span
              >
            </template>
          </div>
        </div>
      </template>

      <div class="sc-row sc-axis" aria-hidden="true">
        <div class="sc-label" />
        <div class="sc-plot">
          <span
            v-for="tick in scale.ticks"
            :key="tick.value"
            class="sc-tick"
            :style="{ left: pct(tick.at) }"
            >{{ tick.label }}</span
          >
        </div>
      </div>

      <div
        v-if="active"
        class="sc-tooltip"
        :style="{ top: `${active.top}px`, left: `${active.left}px` }"
        role="status"
      >
        <div class="sc-tooltip-value">
          {{ active.row.details?.[0] ?? formatValue(active.row.value, model.unit) }}
        </div>
        <div class="sc-tooltip-name">
          {{ active.row.label
          }}<template v-if="active.row.sublabel"> · {{ active.row.sublabel }}</template>
        </div>
        <div v-for="line in active.row.details?.slice(1) ?? []" :key="line" class="sc-tooltip-line">
          {{ line }}
        </div>
      </div>
    </div>

    <figcaption v-if="caption" class="sc-caption">{{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
.sc-chart {
  --sc-primary: #245a9e;
  --sc-secondary: #5e9be6;
  --sc-bar: #c4c6cc;
  --sc-label-w: 14.5rem;
  --sc-value-w: 3.75rem;
  --sc-row-h: 2.6rem;
  margin: 1.25rem 0 1.5rem;
  padding: 1.1rem 1.25rem 1rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg);
}
.dark .sc-chart {
  --sc-primary: #8dbcf2;
  --sc-secondary: #3d7bd0;
  --sc-bar: #46474e;
}

.sc-head {
  margin-bottom: 0.9rem;
}
.sc-title {
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.4;
  color: var(--vp-c-text-1);
}
.sc-subtitle {
  font-size: 0.8rem;
  line-height: 1.45;
  color: var(--vp-c-text-2);
}
.sc-legend {
  display: flex;
  gap: 1rem;
  margin-top: 0.4rem;
  font-size: 0.75rem;
  color: var(--vp-c-text-2);
}
.sc-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}
.sc-swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: var(--sc-bar);
}
.sc-swatch.is-primary {
  background: var(--sc-primary);
}
.sc-swatch.is-secondary {
  background: var(--sc-secondary);
}

.sc-body {
  position: relative;
}
.sc-group {
  padding: 0.6rem 0 0.25rem;
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
}
.sc-row {
  display: grid;
  grid-template-columns: var(--sc-label-w) 1fr;
  column-gap: 0.75rem;
  align-items: stretch;
  min-height: var(--sc-row-h);
  border-radius: 6px;
  outline: none;
}
.sc-row:not(.sc-axis):hover,
.sc-row.is-active,
.sc-row:focus-visible {
  background: var(--vp-c-default-soft);
}
.sc-row:focus-visible {
  box-shadow: 0 0 0 2px var(--vp-c-brand-1);
}

.sc-label {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  padding: 0.2rem 0 0.2rem 0.4rem;
}
.sc-name {
  font-size: 0.85rem;
  font-weight: 600;
  line-height: 1.3;
  color: var(--vp-c-text-1);
}
.is-primary .sc-name,
.is-secondary .sc-name {
  font-weight: 700;
}
.sc-sub {
  overflow: hidden;
  font-size: 0.72rem;
  line-height: 1.3;
  color: var(--vp-c-text-2);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.sc-plot {
  position: relative;
  margin-right: var(--sc-value-w);
}
.sc-gridline,
.sc-reference {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--vp-c-divider);
}
.sc-gridline:first-child {
  background: var(--vp-c-border);
}
/* Dashed, as in the README images: the line marks JSON (or ×1), not a tick. */
.sc-reference {
  background: none;
  border-left: 1px dashed var(--vp-c-text-3);
}
.sc-bar {
  position: absolute;
  left: 0;
  min-width: 2px;
  height: 14px;
  transform: translateY(-50%);
  border-radius: 0 4px 4px 0;
  background: var(--sc-bar);
  transition: width 0.25s ease;
}
.sc-bar.is-thin {
  height: 9px;
}
.sc-bar.is-primary {
  background: var(--sc-primary);
}
.sc-bar.is-secondary {
  background: var(--sc-secondary);
}
.sc-value {
  position: absolute;
  padding-left: 6px;
  transform: translateY(-50%);
  font-size: 0.78rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--vp-c-text-2);
  white-space: nowrap;
  transition: left 0.25s ease;
}
.sc-value.is-thin {
  font-size: 0.66rem;
}

.sc-axis {
  min-height: 1.6rem;
}
.sc-tick {
  position: absolute;
  top: 0.3rem;
  transform: translateX(-50%);
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
  color: var(--vp-c-text-3);
  white-space: nowrap;
}

.sc-tooltip {
  position: absolute;
  z-index: 10;
  width: max-content;
  max-width: 300px;
  padding: 0.5rem 0.7rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-elv);
  box-shadow: var(--vp-shadow-3);
  pointer-events: none;
}
.sc-tooltip-value {
  font-size: 0.85rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--vp-c-text-1);
}
.sc-tooltip-name {
  margin-bottom: 0.15rem;
  font-size: 0.75rem;
  color: var(--vp-c-text-2);
}
.sc-tooltip-line {
  font-size: 0.72rem;
  line-height: 1.45;
  color: var(--vp-c-text-2);
}

.sc-caption {
  margin-top: 0.6rem;
  font-size: 0.72rem;
  line-height: 1.45;
  color: var(--vp-c-text-3);
}

@media (max-width: 640px) {
  .sc-chart {
    --sc-value-w: 3.25rem;
    padding: 0.9rem 0.75rem 0.8rem;
  }
  .sc-row {
    grid-template-columns: 1fr;
    min-height: 0;
  }
  .sc-label {
    padding-top: 0.35rem;
  }
  .sc-plot {
    height: 1.6rem;
  }
  .sc-axis .sc-label {
    display: none;
  }
}
</style>
