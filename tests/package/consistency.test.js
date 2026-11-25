'use strict';

// The machine-checked version of the release checklist. `files` is an explicit
// allowlist, so a new root shim or .d.ts that was not added to it silently
// disappears from the tarball; an exports entry whose file does not exist
// fails only at a consumer's first import. This suite makes every one of
// those a red test instead.

const path = require('node:path');
const { existsSync, readFileSync, readdirSync } = require('node:fs');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

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

// The allowlist ships whole directories (src/) and named root files; an entry that begins with `!` takes files
// back out of them (the notes: `!**/CLAUDE.md` — tests/package/pack.test.js holds the tarball to it).
const included = pkg.files.filter((entry) => !entry.startsWith('!'));

const shipped = (relative) => {
  const clean = relative.replace(/^\.\//, '');
  return included.some((entry) => (entry.endsWith('/') ? clean.startsWith(entry) : clean === entry));
};

describe('package consistency', () => {
  it('should find every exports target on disk and in the files allowlist', () => {
    for (const [key, value] of Object.entries(pkg.exports)) {
      for (const target of exportTargets(value)) {
        assert.ok(existsSync(path.join(ROOT, target)), `${key} -> ${target} does not exist`);
        assert.ok(shipped(target), `${key} -> ${target} is not in the files allowlist`);
      }
    }
  });

  it('should give every subpath a types condition wherever it has a runtime one', () => {
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

  it('should have every root shim require a file that exists', () => {
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

  it('should have a tsd file for every published entry point', () => {
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

  it('should map the browser field to files that ship', () => {
    for (const [from, to] of Object.entries(pkg.browser)) {
      for (const target of [from, to]) {
        assert.ok(existsSync(path.join(ROOT, target)), `browser field references missing ${target}`);
        assert.ok(shipped(target), `browser field references unshipped ${target}`);
      }
    }
  });

  it('should find every files entry on disk, and take the notes back out', () => {
    for (const entry of included) {
      assert.ok(existsSync(path.join(ROOT, entry)), `files entry ${entry} does not exist`);
    }
    assert.ok(pkg.files.includes('!**/CLAUDE.md'), 'files must exclude every CLAUDE.md: the notes never ship');
  });

  it('should mirror package.json in the docs keywords list', () => {
    const config = readFileSync(path.join(ROOT, 'docs', '.vitepress', 'config.mts'), 'utf8');
    const block = config.match(/const keywords = \[([\s\S]*?)\]\.join/);
    assert.ok(block, 'docs config has no `const keywords = [...]` block');
    const listed = [...block[1].matchAll(/'([^']+)'/g)].map(([, term]) => term);
    assert.deepStrictEqual(listed, pkg.keywords, 'docs keywords have drifted from package.json#keywords');
  });

  it('should match package.json in the docs nav version label', () => {
    const config = readFileSync(path.join(ROOT, 'docs', '.vitepress', 'config.mts'), 'utf8');
    assert.ok(config.includes(`'v${pkg.version}'`), `docs nav does not carry v${pkg.version}`);
  });

  it('should have a row in scripts/size.js for every exports entry point', () => {
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

  it('should declare every runtime export in the types', () => {
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
    check('src/sqlite/sqlite.js', 'src/sqlite/sqlite.d.ts');
    check('src/mongodb/mongodb.js', 'src/mongodb/mongodb.d.ts');
    check('src/engines/engines.js', 'src/engines/engines.d.ts');
    check('src/search/search.js', 'src/search/search.d.ts');
    check('src/order/order.js', 'src/order/order.d.ts');
    check('src/undo/undo.js', 'src/undo/undo.d.ts');
    check('src/branch/branch.js', 'src/branch/branch.d.ts');
    check('src/presence/presence.js', 'src/presence/presence.d.ts');
    check('src/inspect/inspect.js', 'src/inspect/inspect.d.ts');
    check('src/editor/editor.js', 'src/editor/editor.d.ts');
    check('src/store/store.js', 'src/store/store.d.ts');
    check('src/prosemirror/prosemirror.js', 'src/prosemirror/prosemirror.d.ts');
    check('src/codemirror/codemirror.js', 'src/codemirror/codemirror.d.ts');
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
    check('src/local/local.js', 'src/local/local.d.ts');
    check('src/state/state.js', 'src/state/state.d.ts');
    check('src/dump/dump.js', 'src/dump/dump.d.ts');
    check('src/pipeline/pipeline.js', 'src/pipeline/pipeline.d.ts');
    check('src/cleanup/cleanup.js', 'src/cleanup/cleanup.d.ts');
    check('src/shared/shared.js', 'src/shared/shared.d.ts');
    check('src/attachments/attachments.js', 'src/attachments/attachments.d.ts');
    check('src/testing/testing.js', 'src/testing/testing.d.ts');
    check('src/mcp/mcp.js', 'src/mcp/mcp.d.ts');
    check('src/query/query.js', 'src/query/query.d.ts');
    check('src/versions/versions.js', 'src/versions/versions.d.ts');
    check('src/local/local.js', 'src/local/local.d.ts');
    check('src/state/state.js', 'src/state/state.d.ts');
    check('src/dump/dump.js', 'src/dump/dump.d.ts');
    check('src/pipeline/pipeline.js', 'src/pipeline/pipeline.d.ts');
    check('src/cleanup/cleanup.js', 'src/cleanup/cleanup.d.ts');
    check('src/connector/connector.js', 'src/connector/connector.d.ts');
    check('src/connector/couchdb.js', 'src/connector/couchdb.d.ts');
    check('src/connector/graphql.js', 'src/connector/graphql.d.ts');
    check('src/connector/mongodb.js', 'src/connector/mongodb.d.ts');
    check('src/connector/supabase.js', 'src/connector/supabase.d.ts');
    check('src/connector/firestore.js', 'src/connector/firestore.d.ts');
    check('src/connector/appwrite.js', 'src/connector/appwrite.d.ts');
    check('src/connector/gdrive.js', 'src/connector/gdrive.d.ts');
    check('src/connector/onedrive.js', 'src/connector/onedrive.d.ts');
    check('src/shared/shared.js', 'src/shared/shared.d.ts');
    check('src/attachments/attachments.js', 'src/attachments/attachments.d.ts');
    // browser.js is only loadable under OPFS/WebCrypto globals, so compare its
    // barrel's names against the node one instead of requiring it here.
    check('index.js', 'browser.d.ts');
  });

  // The other way: a value a .d.ts declares at its top level (a const, a function, a class) is one the module
  // exports — a type that only reads as a value would compile an import that is undefined at run time.
  it('should export from its module every value a .d.ts declares', () => {
    const pairs = [['index.js', 'index.d.ts']];
    for (const name of readdirSync(path.join(ROOT, 'src'))) {
      const types = path.join('src', name, `${name}.d.ts`);
      if (existsSync(path.join(ROOT, types)) && existsSync(path.join(ROOT, 'src', name, `${name}.js`))) {
        pairs.push([path.join('src', name, `${name}.js`), types]);
      }
    }
    const missing = [];
    for (const [entry, types] of pairs) {
      const runtime = require(path.join(ROOT, entry));
      const source = readFileSync(path.join(ROOT, types), 'utf8');
      for (const match of source.matchAll(/^export (?:declare )?(?:const|function|class) (\w+)/gm)) {
        if (!Object.hasOwn(runtime, match[1])) {
          missing.push(`${types} declares ${match[1]}, ${entry} does not export it`);
        }
      }
    }
    assert.deepStrictEqual(missing, []);
  });

  it('should export from browser.d.ts every type index.d.ts exports', () => {
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
    assert.deepStrictEqual(
      missing,
      [],
      'a TypeScript user under the browser condition imports these from browser.d.ts',
    );
  });

  // Every code src/ raises is in its union and in the API reference's table, and nothing is there that src/ does not
  // raise: a SyncomError's in `SyncomErrorCode`, a typed TypeError's in `TypedErrorCode` — each code read off the
  // first argument of `new SyncomError(…)`, a `super(…)` of a class extending it, or `typed(…)`, a conditional's
  // codes included, a call over several lines too.
  it('should list every error code src/ raises in its union and in the reference table, and nothing else', () => {
    const fs = require('node:fs');
    const nodePath = require('node:path');
    const root = nodePath.join(__dirname, '..', '..');
    const files = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const full = nodePath.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.js')) files.push(full);
      }
    };
    walk(nodePath.join(root, 'src'));
    // The text of a call's first argument: up to the first comma at depth 0.
    const firstArgument = (text, from) => {
      let depth = 0;
      for (let i = from; i < text.length; i++) {
        const c = text[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
          if (depth === 0) return text.slice(from, i);
          depth--;
        } else if (c === ',' && depth === 0) return text.slice(from, i);
      }
      return '';
    };
    const codesIn = (text, pattern) => {
      const out = new Set();
      for (const match of text.matchAll(pattern)) {
        for (const code of firstArgument(text, match.index + match[0].length).matchAll(/'([A-Z][A-Z_]+)'/g)) {
          out.add(code[1]);
        }
      }
      return out;
    };
    const raised = new Set();
    const dataCodes = new Set();
    const bare = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const code of codesIn(text, /new SyncomError\(/g)) raised.add(code);
      if (/extends (SyncomError|HookError)/.test(text)) {
        for (const code of codesIn(text, /\bsuper\(/g)) raised.add(code);
      }
      for (const code of codesIn(text, /new DataError\(/g)) dataCodes.add(code);
      // A wrong argument is syncom's own class: no bare TypeError or RangeError outside the module that defines them
      // and the one that makes again an error thrown on the other side of a channel (a native one too).
      const own = file.endsWith(`${nodePath.sep}wire-error.js`);
      if (!own && /new (TypeError|RangeError)\(/.test(text)) bare.push(file);
    }
    assert.deepStrictEqual(
      bare,
      [],
      'src/ throws ArgumentError, ArgumentRangeError or DataError, never a bare TypeError',
    );
    const errors = fs.readFileSync(nodePath.join(root, 'src', 'argument-errors.js'), 'utf8');
    const argumentCode = /const INVALID_ARGUMENT = '([A-Z_]+)';/.exec(errors)[1];
    for (const code of [...raised, ...dataCodes, argumentCode]) assert.match(code, /^ALX_ERR_[A-Z_]+$/, code);
    const types = fs.readFileSync(nodePath.join(root, 'index.d.ts'), 'utf8');
    const unionOf = (name) => {
      const at = types.indexOf(`export type ${name} =`);
      assert.ok(at >= 0, name);
      return new Set([...types.slice(at, types.indexOf(';', at)).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));
    };
    const sorted = (set) => [...set].sort();
    assert.deepStrictEqual(sorted(unionOf('SyncomErrorCode')), sorted(raised), 'SyncomErrorCode is what src/ raises');
    assert.deepStrictEqual(
      sorted(unionOf('DataErrorCode')),
      sorted(dataCodes),
      'DataErrorCode is what DataError raises',
    );
    assert.deepStrictEqual(sorted(unionOf('ErrorCode')), [argumentCode], 'ErrorCode adds the code of ArgumentError');
    const api = fs.readFileSync(nodePath.join(root, 'docs', 'reference', 'api.md'), 'utf8');
    const section = api.slice(api.indexOf('### `SyncomError`'), api.indexOf('### `HookError`'));
    const documented = new Set();
    for (const line of section.split('\n')) {
      if (!line.startsWith('| `')) continue;
      for (const code of line.split('|')[1].matchAll(/`([A-Z][A-Z_]+)`/g)) documented.add(code[1]);
    }
    assert.deepStrictEqual(
      sorted(documented),
      sorted(new Set([...raised, ...dataCodes, argumentCode])),
      'the table names every code once',
    );
  });
});
