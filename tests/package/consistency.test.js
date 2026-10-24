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
      const match = source.match(/require\('([^']+)'\)/);
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
  const check = (entry, types) => {
    const runtime = Object.keys(require(path.join(ROOT, entry)));
    const source = readFileSync(path.join(ROOT, types), 'utf8');
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
  check('wrpc.js', 'wrpc.d.ts');
  check('contracts.js', 'contracts.d.ts');
  check('idb.js', 'idb.d.ts');
  check('search.js', 'search.d.ts');
  check('order.js', 'order.d.ts');
  check('undo.js', 'undo.d.ts');
  check('branch.js', 'branch.d.ts');
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
