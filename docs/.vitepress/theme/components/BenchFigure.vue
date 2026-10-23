<script setup lang="ts">
import { computed } from 'vue';
import compare from '../../../../bench/results/compare.json';
import size from '../../../../bench/results/size.json';
import { coldStartModel, machineCaption, sizeModel } from '../../../../bench/report/model.mjs';
import BenchBars from './BenchBars.vue';

// `only`: the library ids to show (a page about one alternative); all of them when absent.
const props = defineProps<{ chart: 'coldstart' | 'size'; only?: string[] }>();

const figure = computed(() =>
  props.chart === 'coldstart'
    ? { model: coldStartModel(compare, props.only ?? null), caption: machineCaption(compare.machine) }
    : { model: sizeModel(size, props.only ?? null), caption: `esbuild ${size.esbuild} · ${size.generatedAt.slice(0, 10)}` },
);
</script>

<template>
  <BenchBars :model="figure.model" :caption="figure.caption" />
</template>
