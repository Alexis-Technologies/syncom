'use strict';

// The names are a surface: every `event:` a logger receives, every span and
// every metric syncom emits has a row in docs/guide/telemetry.md. This keeps
// the code and the page in step — a new name needs its row.

const test = require('node:test');
const assert = require('node:assert');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

const sources = () =>
  readdirSync(SRC)
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(path.join(SRC, name), 'utf8'));

const names = (pattern) => {
  const found = new Set();
  for (const source of sources()) for (const match of source.matchAll(pattern)) found.add(match[1]);
  return [...found].sort();
};

test('every log event, span and metric name in src/ has a row in docs/guide/telemetry.md', () => {
  const page = readFileSync(path.join(ROOT, 'docs', 'guide', 'telemetry.md'), 'utf8');
  const documented = (name) => page.includes(`\`${name}\``);
  const events = names(/\bevent: '([a-z][a-z0-9._]*)'/g);
  const spans = names(/(?:withSpan|traced)\(\s*(?:[a-zA-Z.#]+,\s*)?'(syncom\.[a-z0-9.]+)'/g);
  const metrics = names(/create(?:Counter|Histogram|ObservableGauge)\('(syncom\.[a-z0-9.]+)'/g);
  assert.ok(events.length >= 30, `${events.length} events found`);
  assert.ok(spans.length >= 8, `${spans.length} spans found`);
  assert.ok(metrics.length >= 10, `${metrics.length} metrics found`);
  for (const name of [...events, ...spans, ...metrics]) assert.ok(documented(name), `no row for ${name}`);
});
