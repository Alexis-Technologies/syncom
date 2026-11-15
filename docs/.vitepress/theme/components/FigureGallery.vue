<script setup lang="ts">
// docs/figures.md: every figure (components/figures/Fig*.vue) and live demo (components/live/Live*.vue)
// on one page, in file-name order, for review — a new one shows up here without an edit.
const modules = import.meta.glob<{ default: object }>('./{figures,live}/{Fig,Live}*.vue', { eager: true });
const entries = Object.keys(modules)
  .sort()
  .map((file) => ({ name: file.slice(file.lastIndexOf('/') + 1, -4), component: modules[file].default }));
</script>

<template>
  <section v-for="entry in entries" :key="entry.name">
    <h2 :id="entry.name">{{ entry.name }}</h2>
    <component :is="entry.component" />
  </section>
</template>
