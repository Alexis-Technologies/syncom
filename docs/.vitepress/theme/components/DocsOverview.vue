<script setup lang="ts">
// The guide's front page: every group of the sidebar (docs/.vitepress/sidebar/*.json) as a heading
// and a grid of cards, each card the page's own title and description from its frontmatter.
import { withBase } from 'vitepress';
import { data as pages } from '../pages.data.mts';

interface Item {
  text: string;
  link: string;
}
interface Group {
  text: string;
  items: Item[];
}

const files = import.meta.glob<Group>('../../sidebar/*.json', { eager: true, import: 'default' });
const groups = Object.keys(files)
  .sort()
  .map((name) => files[name])
  .filter((group) => group.text !== 'Getting Started' || group.items.length > 1);

const byUrl = new Map(pages.map((page) => [page.url, page]));
const describe = (item: Item) => byUrl.get(item.link.split('#')[0])?.description ?? '';
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
</script>

<template>
  <div class="sc-overview">
    <section v-for="group in groups" :key="group.text">
      <h2 :id="slug(group.text)">{{ group.text }}</h2>
      <div class="sc-overview-grid">
        <a
          v-for="item in group.items.filter((entry) => entry.link !== '/guide/')"
          :key="item.link"
          class="sc-overview-card"
          :href="withBase(item.link)"
        >
          <strong>{{ item.text }}</strong>
          <span v-if="describe(item)">{{ describe(item) }}</span>
        </a>
      </div>
    </section>
  </div>
</template>
