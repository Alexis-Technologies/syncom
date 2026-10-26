---
name: js-conventions
description: Apply the Alexis JavaScript style (Metarhia-derived, linted by oxlint and formatted by oxfmt). Use when writing or editing .js, .mjs, .ts files (with certain corrections for typescript), formatting code, or when the user asks about code style or linting.
---

<!-- Adapted from metaskills v1.0.5 (skills/js-conventions) for the Alexis toolchain and for syncom:
     oxlint + oxfmt instead of ESLint + Prettier, pnpm instead of npm, 120 columns instead of 80,
     'use strict' in every src file (metaschema omits it), and comments that explain why.
     The syncom-specific rules (op model, browser halves, hooks, no runtime dependencies) live in
     CLAUDE.md, which wins if the two ever disagree. -->

# JavaScript Code Style

Use following conventions for JavaScript and TypeScript code.

## Preparations

- Linting is oxlint (`.oxlintrc.json`) and formatting is oxfmt (`.oxfmtrc.json`, `.editorconfig`);
  never add ESLint or Prettier
- The package manager is pnpm; the scripts are already in package.json:
  - `pnpm lint`: oxlint over `src`, `tests`, `scripts` and `bench`
  - `pnpm format`: oxfmt rewrites those files in place
  - `pnpm format:check`: oxfmt check only, as CI runs it
- Before and after code analysis with AI run `pnpm lint` and `pnpm test`
- Use `pnpm format` to fix formatting; fix lint errors in the code, and suppress a rule only for an
  intentional construct with a targeted `// oxlint-disable-next-line <rule>`

## Formatting

- Use single quotes and semicolons
- Keep max line length 120 (ignore URLs)
- Use trailing commas in multiline arrays, objects, and params
- Keep one empty line between semantic blocks
- Follow oxfmt and `.editorconfig` for spacing, braces, and indentation (2 spaces, LF)

## Modules

- Use CommonJS: `require` and `module.exports`, no `import`/`export` in `.js` sources; there is no
  build step, `src/` is what gets published
- Start every `src/` file with `'use strict'`
- Use the `node:` prefix for Node.js built-in modules (`require('node:fs')`)
- Always include the `.js` extension in relative requires (`require('./ops.js')`)
- No runtime dependencies: the only bare `require` allowed in `src/` is a `node:` built-in, and
  none at all in a file that reaches the browser bundle (put helpers in `src/utils.js`)
- A platform split is a `*.browser.js` file (dot, not dash); see CLAUDE.md for the three edits it needs

## Naming

- Use `camelCase` for variables and parameters
- Use `UpperCamelCase` for classes and types
- Use `UPPER_SNAKE_CASE` for constants
- Use `new` with capitalized constructor names
- Use `error` in catch blocks, not `err`
- Use short names (`e`, `i`) only in short one-line callbacks
- Use descriptive names in multiline callbacks (`event`, `index`, `item`)
- Use boolean prefixes: `is`, `has`, `can`, `should`
- Use singular names for entities and plural names for collections
- Use verb names for functions and handlers (`parse`, `create`, `handle`, `on`)
- Include units in numeric names (`timeoutMs`, `sizeBytes`) except options

## Best practices

- Prefer `const`, minimize `let`, never use `var`
- Prefer arrow functions (except prototype/class methods)
- Do not mutate input parameters; avoid `arguments`
- Keep functions small and single-purpose
- Decompose long expressions into intermediate variables
- Procedural loops in `src/`: no array method that takes a callback (`map`, `filter`, `find`,
  `findIndex`, `findLast`, `findLastIndex`, `some`, `every`, `flatMap`, `forEach`, `reduce`,
  `reduceRight`) and no `Array.from` — an indexed `for` over an array, `for..of` over a Map, a Set
  or an iterator, `[...iterable]` for a plain copy. `oxlint` enforces it for `src/**`
  (`no-restricted-properties`; `T.find`/`SL.find` are the rope's and the plist's own functions, and
  an editor's `RangeSet.map`/`DecorationSet.map` carries a disable comment). Tests, benchmarks and
  scripts may use them
- One walk does all the work it can: never `filter(...).map(...)`, a count pass then a build pass,
  or the same `Object.keys(o)` twice; a membership test inside a loop is a `Set` (or a `Map` for a
  transient dictionary), built once
- Never spread a data array into arguments — `out.push(...items)`, `Math.max(...values)`,
  `fn(...array)`: past ~130 000 elements it throws `RangeError` (a list run may hold 1 048 576)
- A new array is built packed: `[]` and `push`, never `new Array(n)` filled by index (V8 keeps
  it holey for good, and every read of it pays — a list's chunks built that way cost a text
  insert 8%); a bulk copy stays native (`slice`, `concat`) rather than an element loop
- Use `===` and `!==`; the one loose comparison is `value == null` for "null or undefined"
  (`eqeqeq` ignores `null`)
- Keep return types consistent
- Avoid nested ternaries and deep callback nesting
- Self-documented and self-descriptive code; a comment explains why (an invariant, a trap, a
  decision), never what the next line does
- Throw a `TypeError` for a bad argument, prefixed with the thing being configured
  (`${label}: hooks must be an object`); throw a typed error with a stable `code` when a caller
  has to branch on it (`HookError`, `code: 'HOOK_FAILED'`, with the original as `cause`); never
  swallow an error without saying why in a comment
- Events leave through `notify()` and never fail the operation they observe; a hook may fail it
- `await` `calculateHash`, `encrypt`, `decrypt`, `sign` and `verify` in shared code: they are synchronous in Node and
  promise-returning in the browser

## Optimizations

- Keep object shapes stable: same keys, types, and key order
- Change shape only in constructors and creational patterns; avoid mix-ins
- Use shape mutations only for metaprogramming
- Use `null` for empty reference types; use `undefined` for empty primitives
- Avoid array destructuring in assignments and loops; object destructuring is ok
- Keep hot functions monomorphic: stable arg count, types, and return types
- Avoid reading the same property from many unrelated object shapes
- Prefer string or number literals for status/codes; avoid mixing primitives with objects in one variable
- Keep objects that share a property to the same shape; avoid polymorphic hotspots
- Prefer fixed property access (`obj.x`) over dynamic keys (`obj[key]`)
- Keep arrays dense, avoid holes and mixed element kinds
- Initialize object fields in constructor/factory once and in one order
- Set field to `null` or `undefined`; avoid `delete`
- Move reusable callbacks outside loops
- Keep `try/catch`, spread/rest away from hot loops
- Use `Map` for dynamic key dictionaries, plain objects for fixed schemas
- Use `Set` for big and dynamic collections, prefer arrays for short and stable
- Use `Object.create(null)` for pure dictionaries
- Use typed arrays for numeric and binary workloads
- Reduce GC pressure: reuse arrays, objects, and buffers when safe
- In the hot path (applying and merging ops, `OpLog.append`, vector clocks, `packOps`): no closure
  or `RegExp` created per call, one object shape per kind of op and log entry, and `try/catch`
  only around user code (hooks, listeners) and I/O
- Check `pnpm bench` before and after touching the hot path; a number moved is a finding
