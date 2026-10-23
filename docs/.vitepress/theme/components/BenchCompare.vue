<script setup lang="ts">
import { computed, ref } from 'vue';
import compare from '../../../../bench/results/compare.json';
import { compareCaption, compareKinds, compareModel } from '../../../../bench/report/model.mjs';
import BenchBars from './BenchBars.vue';
import Segmented from './Segmented.vue';

// `only`: the library ids to show (a page about one alternative); all of them when absent.
const props = withDefaults(defineProps<{ kind?: string; line?: string; only?: string[] }>(), {
  kind: 'insert',
  line: 'disk',
  only: undefined,
});

const kinds = compareKinds(compare);
const kind = ref(props.kind);
const line = ref(props.line);
const current = computed(() => kinds.find((item: any) => item.id === kind.value) ?? kinds[0]);
const lines = computed(() => current.value.lines.map((item: any) => ({ id: item.id, title: item.title })));
const scenario = computed(() => {
  const found = current.value.lines.find((item: any) => item.id === line.value) ?? current.value.lines[0];
  return found.scenario;
});

// Log by default: the results span several orders of magnitude, so on a
// linear axis the slow rows would be invisible. The toggle shows the other view.
const scale = ref('log');
const scales = [
  { id: 'log', title: 'Log' },
  { id: 'linear', title: 'Linear' },
];
const model = computed(() => compareModel(compare, scenario.value, scale.value, props.only ?? null));
const caption = compareCaption(compare);
</script>

<template>
  <BenchBars :model="model" :caption="caption">
    <template #controls>
      <div class="sc-controls">
        <Segmented v-model="kind" label="Scenario" :items="kinds" />
        <div class="sc-controls-row">
          <Segmented v-model="line" label="Storage" :items="lines" />
          <Segmented v-model="scale" label="Axis scale" :items="scales" />
        </div>
      </div>
    </template>
  </BenchBars>
</template>

<style scoped>
.sc-controls {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.sc-controls-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.5rem;
}
</style>
