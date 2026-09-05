import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

const ogTitle = 'syncom — distributed data sync engine for Node.js and the browser';
const ogDescription =
  'Fast, zero-dependency distributed data sync engine: local-first storage with a hash-linked ' +
  'integrity log, CRDT deltas, JavaScript smart contracts, and one API across Node.js and the Web.';
const repo = 'https://github.com/Alexis-Technologies/syncom';
const base = '/';
const hostname = 'https://syncomjs.vercel.app/';
const ogImage = `${hostname}logo-mark.svg`;

// Mirrors package.json "keywords" — kept as a one-term-per-line list so the
// two stay easy to diff. tests/package/consistency.test.js fails if they drift.
const keywords = [
  'syncom',
  'distributed',
  'data',
  'sync',
  'engine',
  'real-time',
  'collaboration',
  'p2p',
  'peer-to-peer',
  'replication',
  'wrpc',
  'websocket',
  'conflict-resolution',
  'CRDT',
  'event-sourcing',
  'blockchain',
  'smart-contracts',
  'local-first',
  'offline-first',
  'storage',
  'database',
  'zero-dependency',
  'javascript',
  'nodejs',
  'browser',
  'opentelemetry',
  'observability',
].join(', ');

// schema.org structured data — helps search and AI engines understand the
// package as a software entity, not just text on a page.
const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: '@alexify/syncom',
  alternateName: 'syncom',
  description: ogDescription,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Node.js >= 22, modern browsers',
  url: hostname,
  image: ogImage,
  downloadUrl: 'https://www.npmjs.com/package/@alexify/syncom',
  codeRepository: repo,
  license: 'https://opensource.org/licenses/MIT',
  keywords,
  author: { '@type': 'Organization', name: 'Alexis Technologies' },
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
};

// https://vitepress.dev/reference/site-config
export default withMermaid({
  ...defineConfig({
    title: '@alexify/syncom',
    titleTemplate: ':title — syncom',
    description: ogDescription,
    lang: 'en-US',
    base,
    cleanUrls: true,
    lastUpdated: true,
    sitemap: { hostname },

    head: [
      ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}logo-mark.svg` }],
      ['meta', { name: 'theme-color', content: '#3f7fd0' }],
      ['meta', { name: 'author', content: 'Alexis Technologies' }],
      ['meta', { name: 'keywords', content: keywords }],
      ['meta', { name: 'robots', content: 'index, follow' }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:site_name', content: '@alexify/syncom' }],
      ['meta', { property: 'og:title', content: ogTitle }],
      ['meta', { property: 'og:description', content: ogDescription }],
      ['meta', { property: 'og:image', content: ogImage }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      ['meta', { name: 'twitter:title', content: ogTitle }],
      ['meta', { name: 'twitter:description', content: ogDescription }],
      ['meta', { name: 'twitter:image', content: ogImage }],
      ['script', { type: 'application/ld+json' }, JSON.stringify(jsonLd)],
    ],

    // Mermaid pulls in a few CJS-only transitive deps (dayjs among them). Vite's
    // dev server hands them to the browser unbundled, where `import dayjs from` has
    // no default export and the whole app fails to boot. Pre-bundling them fixes dev;
    // noExternal keeps mermaid inlined for the SSR build.
    vite: {
      optimizeDeps: { include: ['mermaid', 'dayjs'] },
      ssr: { noExternal: ['mermaid'] },
    },

    // Per-page canonical + og:url for clean SEO indexing.
    transformPageData(pageData) {
      const path = pageData.relativePath.replace(/index\.md$/, '').replace(/\.md$/, '');
      const canonical = `${hostname}${path}`;
      pageData.frontmatter.head ??= [];
      pageData.frontmatter.head.push(
        ['link', { rel: 'canonical', href: canonical }],
        ['meta', { property: 'og:url', content: canonical }],
      );
    },

    themeConfig: {
      logo: '/logo-mark.svg',

      // ─── Top navigation ──────────────────────────────────────────────
      nav: [
        { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
        { text: 'Reference', link: '/reference/api', activeMatch: '/reference/' },
        {
          // Hand-synced with package.json "version" — part of the release
          // checklist, and asserted by tests/package/consistency.test.js.
          text: 'v0.0.1',
          items: [
            { text: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md` },
            { text: 'npm', link: 'https://www.npmjs.com/package/@alexify/syncom' },
            { text: 'Releases', link: `${repo}/releases` },
          ],
        },
      ],

      // ─── Sidebar ─────────────────────────────────────────────────────
      sidebar: {
        '/guide/': [
          {
            text: 'Introduction',
            items: [{ text: 'Getting Started', link: '/guide/getting-started' }],
          },
          {
            text: 'Core',
            items: [
              { text: 'Storage', link: '/guide/storage' },
              { text: 'CRDT deltas', link: '/guide/crdt' },
              { text: 'Blockchain log', link: '/guide/chain' },
              { text: 'Smart contracts', link: '/guide/contracts' },
            ],
          },
          {
            text: 'Replication',
            items: [
              { text: 'Sync', link: '/guide/sync' },
              { text: 'wrpc transport', link: '/guide/wrpc' },
            ],
          },
          {
            text: 'Platforms',
            items: [{ text: 'Browser', link: '/guide/browser' }],
          },
          {
            text: 'Operations',
            items: [{ text: 'OpenTelemetry', link: '/guide/telemetry' }],
          },
        ],
        '/reference/': [
          {
            text: 'Reference',
            items: [{ text: 'API', link: '/reference/api' }],
          },
        ],
      },

      // ─── Local, zero-config full-text search ─────────────────────────
      search: { provider: 'local' },

      socialLinks: [{ icon: 'github', link: repo }],

      editLink: {
        pattern: `${repo}/edit/main/docs/:path`,
        text: 'Edit this page on GitHub',
      },

      footer: {
        message: 'Released under the MIT License.',
        copyright: 'Copyright © 2026 Alexis Technologies',
      },

      docFooter: {
        prev: 'Previous page',
        next: 'Next page',
      },
    },
  }),

  // ─── Mermaid ───────────────────────────────────────────────────────────
  // Deliberately no `theme` here: vitepress-plugin-mermaid picks 'default' or
  // 'dark' from VitePress' own isDark and re-renders on toggle, and anything we
  // set would win over that and freeze the diagrams in one theme.
  mermaid: {
    fontFamily: 'var(--vp-font-family-base)',
    flowchart: { useMaxWidth: true, htmlLabels: true, padding: 12 },
    sequence: { useMaxWidth: true, actorMargin: 40, wrap: true },
  },

  mermaidPlugin: {
    // `vp-raw` keeps VitePress' own markdown styling off the rendered SVG.
    class: 'mermaid vp-raw',
  },
});
