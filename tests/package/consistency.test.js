'use strict';

// The machine-checked version of the release checklist. `files` is an explicit
// allowlist, so a new root shim or .d.ts that was not added to it silently
// disappears from the tarball; an exports entry whose file does not exist
// fails only at a consumer's first import. This suite makes every one of
// those a red test instead.

const path = require('node:path');
const { existsSync, readFileSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert');

const ROOT = path.join(__dirname, '..', '..');
const pkg = require('../../package.json');

// Every file an exports condition can resolve to, flattened.
const exportTargets = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) exportTargets(nested, out);
  }
  return out;
};

const shipped = (relative) => {
  // The allowlist ships whole directories (src/) and named root files.
  const clean = relative.replace(/^\.\//, '');
  return pkg.files.some((entry) => (entry.endsWith('/') ? clean.startsWith(entry) : clean === entry));
};

test('every exports target exists and is in the files allowlist', () => {
  for (const [key, value] of Object.entries(pkg.exports)) {
    for (const target of exportTargets(value)) {
      assert.ok(existsSync(path.join(ROOT, target)), `${key} -> ${target} does not exist`);
      assert.ok(shipped(target), `${key} -> ${target} is not in the files allowlist`);
    }
  }
});

test('every subpath has a types condition wherever it has a runtime one', () => {
  for (const [key, value] of Object.entries(pkg.exports)) {
    if (key === './package.json') continue;
    const check = (conditions, label) => {
      assert.ok(typeof conditions === 'object', `${label} must be a conditions object`);
      assert.ok(conditions.types, `${label} has no types condition`);
      assert.ok(conditions.default, `${label} has no default condition`);
      // exports conditions match top-down: a `types` AFTER `default` is dead.
      const keys = Object.keys(conditions);
      assert.ok(keys.indexOf('types') < keys.indexOf('default'), `${label}: types must come before default`);
      if (conditions.browser && typeof conditions.browser === 'object') check(conditions.browser, `${label}.browser`);
    };
    check(value, key);
  }
});

test('every root shim requires a file that exists', () => {
  for (const [key, value] of Object.entries(pkg.exports)) {
    for (const target of exportTargets(value)) {
      if (!target.endsWith('.js')) continue;
      const source = readFileSync(path.join(ROOT, target), 'utf8');
      // A shim is one line: `module.exports = require('…')`; an entry that is
      // a module of its own (a subpath under src/) is not one.
      const match = source.match(/^module\.exports = require\('([^']+)'\);?$/m);
      if (!match) continue; // not a shim
      const required = path.join(ROOT, path.dirname(target), match[1]);
      assert.ok(existsSync(required), `${key} shim ${target} requires missing ${match[1]}`);
    }
  }
});

test('every published entry point has a tsd file', () => {
  for (const [key, value] of Object.entries(pkg.exports)) {
    if (key === './package.json') continue;
    for (const target of exportTargets(value)) {
      if (!target.endsWith('.d.ts')) continue;
      const name = path.basename(target, '.d.ts');
      const testFile = path.join(ROOT, 'tests', `${name}.test-d.ts`);
      assert.ok(existsSync(testFile), `${target} has no tests/${name}.test-d.ts`);
    }
  }
});

test('the browser field maps to files that ship', () => {
  for (const [from, to] of Object.entries(pkg.browser)) {
    for (const target of [from, to]) {
      assert.ok(existsSync(path.join(ROOT, target)), `browser field references missing ${target}`);
      assert.ok(shipped(target), `browser field references unshipped ${target}`);
    }
  }
});

test('every files entry exists', () => {
  for (const entry of pkg.files) {
    assert.ok(existsSync(path.join(ROOT, entry)), `files entry ${entry} does not exist`);
  }
});

test('the docs keywords list mirrors package.json', () => {
  const config = readFileSync(path.join(ROOT, 'docs', '.vitepress', 'config.mts'), 'utf8');
  const block = config.match(/const keywords = \[([\s\S]*?)\]\.join/);
  assert.ok(block, 'docs config has no `const keywords = [...]` block');
  const listed = [...block[1].matchAll(/'([^']+)'/g)].map(([, term]) => term);
  assert.deepStrictEqual(listed, pkg.keywords, 'docs keywords have drifted from package.json#keywords');
});

test('the docs nav version label matches package.json', () => {
  const config = readFileSync(path.join(ROOT, 'docs', '.vitepress', 'config.mts'), 'utf8');
  assert.ok(config.includes(`'v${pkg.version}'`), `docs nav does not carry v${pkg.version}`);
});

test('every exports entry point has a row in scripts/size.js', () => {
  const source = readFileSync(path.join(ROOT, 'scripts', 'size.js'), 'utf8');
  const measured = new Set([...source.matchAll(/entry: '([^']+)'/g)].map(([, entry]) => entry));
  for (const [key, value] of Object.entries(pkg.exports)) {
    if (key === './package.json') continue;
    for (const target of exportTargets(value)) {
      if (!target.endsWith('.js')) continue;
      const clean = target.replace(/^\.\//, '');
      assert.ok(measured.has(clean), `${clean} has no ENTRIES row in scripts/size.js`);
    }
  }
});

test('every runtime export is declared in the types', () => {
  // A .d.ts that re-exports another whole (`export * from`) declares what
  // that one declares.
  const sourceOf = (types, seen = new Set()) => {
    const file = path.join(ROOT, types);
    if (seen.has(file)) return '';
    seen.add(file);
    let source = readFileSync(file, 'utf8');
    for (const [, from] of source.matchAll(/^export \* from '([^']+)';/gm)) {
      const target = path.relative(ROOT, path.resolve(path.dirname(file), from.replace(/\.js$/, '.d.ts')));
      source += sourceOf(target, seen);
    }
    return source;
  };
  const check = (entry, types) => {
    const runtime = Object.keys(require(path.join(ROOT, entry)));
    const source = sourceOf(types);
    for (const name of runtime) {
      const declared =
        new RegExp(`export (?:declare )?(?:function|const|class) ${name}\\b`).test(source) ||
        new RegExp(`^\\s*${name},?$`, 'm').test(source) ||
        new RegExp(`export \\{[^}]*\\b${name}\\b[^}]*\\} from`).test(source);
      assert.ok(declared, `${entry} exports ${name}, but ${types} does not declare it`);
    }
  };
  check('index.js', 'index.d.ts');
  // The subpaths: their runtime surface is small and loads without a browser.
  check('src/wrpc/wrpc.js', 'src/wrpc/wrpc.d.ts');
  check('src/contracts/contracts.js', 'src/contracts/contracts.d.ts');
  check('src/idb/idb.js', 'src/idb/idb.d.ts');
  check('src/search/search.js', 'src/search/search.d.ts');
  check('src/order/order.js', 'src/order/order.d.ts');
  check('src/undo/undo.js', 'src/undo/undo.d.ts');
  check('src/branch/branch.js', 'src/branch/branch.d.ts');
  check('src/presence/presence.js', 'src/presence/presence.d.ts');
  check('src/inspect/inspect.js', 'src/inspect/inspect.d.ts');
  check('src/editor/editor.js', 'src/editor/editor.d.ts');
  check('src/store/store.js', 'src/store/store.d.ts');
  check('src/all/all.js', 'src/all/all.d.ts');
  check('src/text/text.js', 'src/text/text.d.ts');
  check('src/tree/tree.js', 'src/tree/tree.d.ts');
  check('src/signing/signing.js', 'src/signing/signing.d.ts');
  check('src/chain/chain.js', 'src/chain/chain.d.ts');
  check('src/encryption/encryption.js', 'src/encryption/encryption.d.ts');
  check('src/memory/memory.js', 'src/memory/memory.d.ts');
  check('src/layered/layered.js', 'src/layered/layered.d.ts');
  check('src/sync/sync.js', 'src/sync/sync.d.ts');
  check('src/schema/schema.js', 'src/schema/schema.d.ts');
  check('src/telemetry/telemetry.js', 'src/telemetry/telemetry.d.ts');
  check('src/query/query.js', 'src/query/query.d.ts');
  check('src/versions/versions.js', 'src/versions/versions.d.ts');
  // browser.js is only loadable under OPFS/WebCrypto globals, so compare its
  // barrel's names against the node one instead of requiring it here.
  check('index.js', 'browser.d.ts');
});

test('every type index.d.ts exports, browser.d.ts exports too', () => {
  const declared = (source) =>
    new Set([
      ...[...source.matchAll(/^export (?:declare )?(?:type|interface|class|const|function|enum) (\w+)/gm)].map(
        (m) => m[1],
      ),
      ...[...source.matchAll(/export (?:type )?\{([^}]*)\}/g)].flatMap((m) => m[1].match(/\w+/g) ?? []),
    ]);
  const node = declared(readFileSync(path.join(ROOT, 'index.d.ts'), 'utf8'));
  const browser = declared(readFileSync(path.join(ROOT, 'browser.d.ts'), 'utf8'));
  const missing = [...node].filter((name) => !browser.has(name));
  assert.deepStrictEqual(missing, [], 'a TypeScript user under the browser condition imports these from browser.d.ts');
});
