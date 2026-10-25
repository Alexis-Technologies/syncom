'use strict';

// Everything in one import (@alexify/syncom/all): the core with every plugin
// the package ships registered — the lists, the texts and the trees — the
// way the package worked before it was taken apart into blocks. `open()`
// here is `open()` of the core with those plugins ahead of the caller's
// (a plugin given twice is given once); `applyOp` and `mergeEntry` fold
// under the same registry. The exports are spelled out — the core spread
// whole, the rest by name — the shape cjs-module-lexer reads for an ESM
// importer.

const core = require('../index.js');
const { createPlugins } = require('../plugin.js');
const { text } = require('../text/text.js');
const { tree } = require('../tree/tree.js');
const { signing } = require('../signing/signing.js');
const { chain } = require('../chain/chain.js');
const { encryption } = require('../encryption/encryption.js');
const { memory } = require('../memory/memory.js');
const { layered } = require('../layered/layered.js');
const { sync } = require('../sync/sync.js');
const { schema } = require('../schema/schema.js');
const { telemetry, createTelemetry } = require('../telemetry/telemetry.js');
const { query } = require('../query/query.js');

/** The plugins the package ships, in registration order. */
const PLUGINS = Object.freeze([text, tree, signing, chain, encryption, sync, schema, telemetry, query]);
const registry = createPlugins(PLUGINS);

const withAll = (given = []) => {
  if (!Array.isArray(given)) return given;
  const plugins = [...PLUGINS];
  for (const plugin of given) if (!plugins.includes(plugin)) plugins.push(plugin);
  return plugins;
};

class Storage extends core.Storage {
  constructor(options = {}) {
    super(
      options === null || typeof options !== 'object' ? options : { ...options, plugins: withAll(options.plugins) },
    );
  }
}

const open = (options) => new Storage(options);
const applyOp = (entry, op, limits = null) =>
  core.applyOp(entry, op, { ...limits, plugins: limits?.plugins ?? registry });
const mergeEntry = (a, b, limits = null) => core.mergeEntry(a, b, { ...limits, plugins: limits?.plugins ?? registry });

module.exports = {
  ...require('../index.js'),
  ...require('../signing/signing.js'),
  ...require('../chain/chain.js'),
  ...require('../encryption/encryption.js'),
  ...require('../sync/sync.js'),
  memory,
  layered,
  Storage,
  open,
  applyOp,
  mergeEntry,
  text,
  tree,
  signing,
  chain,
  encryption,
  sync,
  schema,
  telemetry,
  createTelemetry,
  query,
  PLUGINS,
};
