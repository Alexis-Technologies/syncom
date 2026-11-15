import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import './custom.css';
import FromRxdb from './components/FromRxdb.vue';
import NotInSyncom from './components/NotInSyncom.vue';
import DocsOverview from './components/DocsOverview.vue';
import FigureGallery from './components/FigureGallery.vue';
import './components/figures/figures.css';

// Every figure (components/figures/Fig*.vue) and live demo (components/live/Live*.vue) is
// registered under its file name, so a page writes <FigReplication /> without an import.
const figures = import.meta.glob<{ default: object }>('./components/{figures,live}/{Fig,Live}*.vue', { eager: true });

// Extends the default VitePress theme with the syncom brand styling (see custom.css).
// This is exactly the pattern Pinia / Vite / Vue use to brand their docs — the
// layout and components stay the default theme, the look comes from CSS variables.
export default {
  extends: DefaultTheme,
  enhanceApp({ app, router }) {
    // The components every guide page may use without importing them (docs/CLAUDE.md lists them).
    app.component('FromRxdb', FromRxdb);
    app.component('NotInSyncom', NotInSyncom);
    app.component('DocsOverview', DocsOverview);
    app.component('FigureGallery', FigureGallery);
    for (const [file, module] of Object.entries(figures)) {
      app.component(file.slice(file.lastIndexOf('/') + 1, -4), module.default);
    }
    // Vercel Web Analytics + Speed Insights. The framework-agnostic `inject`
    // entrypoints are used rather than the `/vue` components: those require
    // `vue-router`, which VitePress does not use (it ships its own router).
    // Both are browser-only, so they are imported dynamically to stay out of
    // the SSR build that `pnpm docs:build` runs.
    if (import.meta.env.SSR) return;
    void import('@vercel/analytics').then(({ inject }) => {
      // `mode: 'auto'` logs to the console on localhost and only sends data
      // from the deployed site; the injected script picks up VitePress'
      // pushState navigations on its own, so no per-route call is needed.
      inject({ mode: 'auto', framework: 'vitepress' });
    });
    void import('@vercel/speed-insights').then(({ injectSpeedInsights }) => {
      const insights = injectSpeedInsights({ framework: 'vitepress' });
      if (!insights) return;
      // Speed Insights does need the route pushed to it by hand. Chain onto any
      // existing handler instead of replacing it.
      const previous = router.onAfterRouteChange;
      router.onAfterRouteChange = (to) => {
        insights.setRoute(to);
        return previous?.call(router, to);
      };
    });
  },
} satisfies Theme;
