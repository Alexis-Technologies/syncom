<script setup lang="ts">
// The banner at the top of a page that answers an RxDB feature syncom does not have (verdict
// `absent` in docs/rxdb-map.json): what the reader came looking for, in one line, before the page
// says why and what to use instead.
//
//   <NotInSyncom page="key-compression" />
import { computed } from 'vue';
import { data } from '../rxdb.data.mts';

const props = defineProps<{ page: string }>();

const entry = computed(() => {
  const page = data.pages[props.page];
  if (!page) throw new Error(`<NotInSyncom>: "${props.page}" is not a page of docs/rxdb-map.json`);
  return page;
});
</script>

<template>
  <div class="sc-absent" role="note">
    <span class="sc-verdict sc-verdict-absent">{{ data.verdicts.absent }}</span>
    <span>
      RxDB has <a :href="entry.url" target="_blank" rel="noreferrer">{{ entry.label }}</a>. syncom does not.
      This page explains why, and what to use instead.
    </span>
  </div>
</template>
