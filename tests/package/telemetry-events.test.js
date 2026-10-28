'use strict';

// The names are a surface: every `event:` a logger receives, every span,
// every metric and gauge, and every attribute a span or a metric carries
// has a row in docs/guide/telemetry.md, and a log event is emitted at the
// level its row names. This keeps the code and the page in step — a new
// name needs its row, a level changed needs its row changed.

const test = require('node:test');
const assert = require('node:assert');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

// Every module under src/, the subpaths' folders included: a name is a
// surface wherever it is emitted.
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(path.join(dir, entry.name))
      : entry.name.endsWith('.js')
        ? [path.join(dir, entry.name)]
        : [],
  );
const sources = () => files(SRC).map((file) => readFileSync(file, 'utf8'));
const page = () => readFileSync(path.join(ROOT, 'docs', 'guide', 'telemetry.md'), 'utf8');

const names = (pattern) => {
  const found = new Set();
  for (const source of sources()) for (const match of source.matchAll(pattern)) found.add(match[1]);
  return [...found].sort();
};

test('every log event, span and metric name in src/ has a row in docs/guide/telemetry.md', () => {
  const text = page();
  const documented = (name) => text.includes(`\`${name}\``);
  const events = names(/\bevent: '([a-z][a-z0-9._]*)'/g);
  const spans = names(/(?:withSpan|traced)\(\s*(?:[a-zA-Z.#]+,\s*)?'(syncom\.[a-z0-9.]+)'/g);
  const metrics = names(/create(?:Counter|Histogram|ObservableGauge)\('(syncom\.[a-z0-9.]+)'/g);
  // The observable gauges are made from a table of names, not a literal each.
  for (const gauge of names(/\['(syncom\.[a-z0-9.]+)', '[a-z]+', '/g)) metrics.push(gauge);
  assert.ok(events.length >= 30, `${events.length} events found`);
  assert.ok(spans.length >= 8, `${spans.length} spans found`);
  assert.ok(metrics.length >= 10, `${metrics.length} metrics found`);
  for (const name of [...events, ...spans, ...metrics]) assert.ok(documented(name), `no row for ${name}`);
});

test('every attribute a span or a metric carries has a row in docs/guide/telemetry.md', () => {
  const text = page();
  // An attribute is a `syncom.*` key of an object literal: a span's or a
  // metric's labels, wherever they are built.
  const attributes = names(/'(syncom\.[a-z0-9_.]+)':/g);
  assert.ok(attributes.length >= 20, `${attributes.length} attributes found`);
  for (const name of attributes) assert.ok(text.includes(`\`${name}\``), `no row names the attribute ${name}`);
});

test('a log event is emitted at the level its row in docs/guide/telemetry.md names', () => {
  // The rows of the log events table: `| level | `name`, `name` (note) | when |`.
  const levels = new Map();
  for (const row of page().matchAll(/^\| (error|warn|info|debug) \| ([^|]+) \|/gm)) {
    for (const name of row[2].matchAll(/`([a-z][a-z0-9._]*)`/g)) {
      if (!levels.has(name[1])) levels.set(name[1], new Set());
      levels.get(name[1]).add(row[1]);
    }
  }
  assert.ok(levels.size >= 40, `${levels.size} events in the table`);
  const wrong = [];
  let checked = 0;
  for (const source of sources()) {
    // A call with its level written out; a level chosen at run time
    // (`log.epoch.new`) or an event passed in (`failureReporter`) is the
    // table's word alone.
    for (const call of source.matchAll(/\b(error|warn|info|debug)\??\.?\(\{\s*event: '([a-z][a-z0-9._]*)'/g)) {
      checked++;
      const listed = levels.get(call[2]);
      if (listed === undefined || !listed.has(call[1])) {
        wrong.push(`${call[2]} at ${call[1]}, the table says ${listed ? [...listed].join('/') : 'nothing'}`);
      }
    }
  }
  assert.ok(checked >= 40, `${checked} calls checked`);
  assert.deepStrictEqual(wrong, []);
});
