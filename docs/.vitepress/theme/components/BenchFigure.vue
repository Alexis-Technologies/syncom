<script setup lang="ts">
import { computed } from 'vue';
import compare from '../../../../bench/results/compare.json';
import size from '../../../../bench/results/size.json';
import { coldStartModel, coreSizeModel, machineCaption, sizeModel } from '../../../../bench/report/model.mjs';
import BenchBars from './BenchBars.vue';

// `only`: the library ids to show (a page about one alternative); all of them when absent.
// `cores`: the CRDT libraries' whole packages (/guide/vs-crdt).
const props = defineProps<{ chart: 'coldstart' | 'size' | 'cores'; only?: string[] }>();

const sizeCaption = `esbuild ${size.esbuild} · ${size.generatedAt.slice(0, 10)}`;
const figure = computed(() => {
  if (props.chart === 'coldstart') {
    return { model: coldStartModel(compare, props.only ?? null), caption: machineCaption(compare.machine) };
  }
  const model = props.chart === 'cores' ? coreSizeModel(size, props.only ?? null) : sizeModel(size, props.only ?? null);
  return { model, caption: sizeCaption };
});
</script>

<template>
  <BenchBars :model="figure.model" :caption="figure.caption" />
</template>
