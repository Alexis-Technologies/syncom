// Every guide page's url, title and description, for <DocsOverview>: the cards read what each page's
// frontmatter says about itself, so a card and its page cannot drift.
import { createContentLoader } from 'vitepress';

export interface GuidePage {
  url: string;
  title: string;
  description: string;
}

declare const data: GuidePage[];
export { data };

export default createContentLoader('guide/*.md', {
  transform: (pages) =>
    pages.map((page) => ({
      url: page.url.replace(/\.html$/, ''),
      title: page.frontmatter.title ?? '',
      description: page.frontmatter.description ?? '',
    })),
});
