<script setup lang="ts">
// A row of toggle buttons for the chart controls (scenario, mode, scale).
defineProps<{ label: string; items: { id: string; title: string }[]; modelValue: string }>();
defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <div class="sc-segmented" role="group" :aria-label="label">
    <button
      v-for="item in items"
      :key="item.id"
      type="button"
      :aria-pressed="modelValue === item.id"
      :class="{ 'is-on': modelValue === item.id }"
      @click="$emit('update:modelValue', item.id)"
    >
      {{ item.title }}
    </button>
  </div>
</template>

<style scoped>
.sc-segmented {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: var(--vp-c-default-soft);
}
.sc-segmented button {
  padding: 0.3rem 0.7rem;
  border-radius: 6px;
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--vp-c-text-2);
  transition:
    color 0.2s,
    background-color 0.2s;
}
.sc-segmented button:hover {
  color: var(--vp-c-text-1);
}
.sc-segmented button.is-on {
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.sc-segmented button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 1px;
}
</style>
