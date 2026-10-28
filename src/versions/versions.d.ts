// Versions as a plugin (@alexify/syncom/versions): `open({ plugins: [versions] })`
// gives the storage its past — `get(id, { at })`, `history()`, `diff()`
// between versions, `restore()` — and the tags (`tag`, `untag`, `tags`,
// `at`). The present and its patches (`applyPatches`, `compact`) are the
// core's. The version types are the core's (index.d.ts) and are re-exported
// here; without the plugin those methods throw `PLUGIN_MISSING`,
// `stats().tags` is null, and a directory that holds tags is refused.

import type {
  Plugin,
  Version,
  HistoryVersion,
  HistoryResult,
  Patch,
  Tag,
  TagView,
  TagCollection,
  CommitEvent,
} from '../../index.js';

export type { Plugin, Version, HistoryVersion, HistoryResult, Patch, Tag, TagView, TagCollection, CommitEvent };

/** The plugin: the past read out of the log, the tags kept on this node. */
export declare const versions: Plugin;
