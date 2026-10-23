<script setup lang="ts">
import { computed, ref } from 'vue';
import engine from '../../../../bench/results/engine.json';
import { engineCaption, engineModel, engineSubjects } from '../../../../bench/report/model.mjs';
import BenchBars from './BenchBars.vue';
import Segmented from './Segmented.vue';

const props = withDefaults(defineProps<{ subject?: string }>(), { subject: 'storage' });

const subjects = engineSubjects(engine);
const subject = ref(props.subject);
const model = computed(() => engineModel(engine, subject.value));
const caption = engineCaption(engine);
</script>

<template>
  <BenchBars :model="model" :caption="caption">
    <template #controls>
      <div class="sc-controls">
        <Segmented v-model="subject" label="Subject" :items="subjects" />
      </div>
    </template>
  </BenchBars>
</template>

<style scoped>
.sc-controls {
  margin-bottom: 1rem;
}
</style>
