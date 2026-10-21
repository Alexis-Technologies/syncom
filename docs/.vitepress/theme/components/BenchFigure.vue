<script setup lang="ts">
import { computed } from 'vue';
import compare from '../../../../bench/results/compare.json';
import size from '../../../../bench/results/size.json';
import { coldStartModel, machineCaption, sizeModel } from '../../../../bench/report/model.mjs';
import BenchBars from './BenchBars.vue';

const props = defineProps<{ chart: 'coldstart' | 'size' }>();

const figure = computed(() =>
  props.chart === 'coldstart'
    ? { model: coldStartModel(compare), caption: machineCaption(compare.machine) }
    : { model: sizeModel(size), caption: `esbuild ${size.esbuild} · ${size.generatedAt.slice(0, 10)}` },
);
</script>

<template>
  <BenchBars :model="figure.model" :caption="figure.caption" />
</template>
