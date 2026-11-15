<script setup lang="ts">
// The body of a page's "Coming from RxDB" section: the verdict, RxDB's own page, and the rows of the
// matrix (docs/comparison-rxdb.json) that this page is about, so the page and /guide/vs-rxdb never
// disagree. The heading stays in the page's markdown, where the outline sees it.
//
//   ## Coming from RxDB
//   <FromRxdb page="rx-database" :rows="['multiInstance', 'openCost']" />
import { computed } from 'vue';
import { withBase } from 'vitepress';
import { data } from '../rxdb.data.mts';

const props = defineProps<{ page: string; rows?: string[] }>();

const entry = computed(() => {
  const page = data.pages[props.page];
  if (!page) throw new Error(`<FromRxdb>: "${props.page}" is not a page of docs/rxdb-map.json`);
  return page;
});
const rows = computed(() =>
  (props.rows ?? []).map((id) => {
    const row = data.rows[id];
    if (!row) throw new Error(`<FromRxdb>: "${id}" is not a row of docs/comparison-rxdb.json`);
    return { id, ...row };
  }),
);
</script>

<template>
  <div class="sc-rxdb">
    <p class="sc-rxdb-head">
      <span :class="['sc-verdict', `sc-verdict-${entry.verdict}`]">{{ data.verdicts[entry.verdict] }}</span>
      <span>
        RxDB's page: <a :href="entry.url" target="_blank" rel="noreferrer">{{ entry.label }}</a>
        · every difference: <a :href="withBase('/guide/vs-rxdb')">Compared with RxDB</a>
      </span>
    </p>
    <table v-if="rows.length" class="sc-rxdb-rows">
      <thead>
        <tr>
          <th></th>
          <th>syncom</th>
          <th>RxDB {{ data.version }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id">
          <td>{{ row.title }}</td>
          <td><span class="sc-mark">{{ row.syncom.mark }}</span> <span v-html="row.syncom.html" /></td>
          <td><span class="sc-mark">{{ row.rxdb.mark }}</span> <span v-html="row.rxdb.html" /></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
