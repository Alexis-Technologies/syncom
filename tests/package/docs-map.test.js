'use strict';

// The guide holds together: every page is in the sidebar and every sidebar entry is a page, each with the
// `title` and `description` its card and llms.txt read; every page of RxDB's sidebar (docs/rxdb-map.json) is
// answered by a page that carries its <FromRxdb> (and its <NotInSyncom> when the verdict is `absent`), every
// row such a block names is a row of docs/comparison-rxdb.json; docs/public/llms.txt is what scripts/llms.js
// writes; and every src/ path a figure or a live demo says it depicts exists.

const path = require('node:path');
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert');
const { render, frontmatter, pageFile, TARGET } = require('../../scripts/llms.js');

const ROOT = path.join(__dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs');
const GUIDE = path.join(DOCS, 'guide');

const sidebar = () => {
  const dir = path.join(DOCS, '.vitepress', 'sidebar');
  const links = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    for (const item of JSON.parse(readFileSync(path.join(dir, name), 'utf8')).items) links.push(item.link);
  }
  return links;
};

test('every guide page is in the sidebar, and every sidebar entry is a page', () => {
  const linked = new Set();
  const missing = [];
  for (const link of sidebar()) {
    const file = pageFile(link);
    linked.add(path.relative(GUIDE, file));
    if (!existsSync(file)) missing.push(`sidebar entry ${link} has no page`);
  }
  for (const name of readdirSync(GUIDE)) {
    if (name.endsWith('.md') && !linked.has(name)) missing.push(`docs/guide/${name} is in no sidebar file`);
  }
  assert.deepStrictEqual(missing, []);
});

test('every guide and reference page has a title and a description', () => {
  const missing = [];
  for (const dir of ['guide', 'reference']) {
    for (const name of readdirSync(path.join(DOCS, dir))) {
      if (!name.endsWith('.md')) continue;
      const { title, description } = frontmatter(path.join(DOCS, dir, name));
      if (!title || !description) missing.push(`docs/${dir}/${name}`);
    }
  }
  assert.deepStrictEqual(missing, []);
});

test('every page of RxDB’s sidebar is answered by a page that carries its block', () => {
  const map = JSON.parse(readFileSync(path.join(DOCS, 'rxdb-map.json'), 'utf8'));
  const problems = [];
  for (const [id, entry] of Object.entries(map.pages)) {
    const file = pageFile(entry.page);
    if (!existsSync(file)) {
      problems.push(`${id}: ${entry.page} does not exist`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const anchored = entry.page.includes('#');
    if (!anchored && !text.includes(`<FromRxdb page="${id}"`)) problems.push(`${id}: ${entry.page} has no <FromRxdb>`);
    if (!anchored && entry.verdict === 'absent' && !text.includes(`<NotInSyncom page="${id}"`)) {
      problems.push(`${id}: ${entry.page} has no <NotInSyncom>`);
    }
    if (anchored) {
      const anchor = entry.page.split('#')[1];
      const heading = /^#{2,3} .+$/gm;
      const slugs = (text.match(heading) ?? []).map((line) =>
        line
          .replace(/^#+ /, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, ''),
      );
      if (!slugs.includes(anchor)) problems.push(`${id}: ${entry.page} has no heading #${anchor}`);
    }
  }
  assert.deepStrictEqual(problems, []);
});

test('every row a <FromRxdb> names is a row of docs/comparison-rxdb.json', () => {
  const matrix = JSON.parse(readFileSync(path.join(DOCS, 'comparison-rxdb.json'), 'utf8'));
  const rows = new Set();
  for (const group of matrix.groups) for (const row of group.rows) rows.add(row.id);
  const missing = [];
  for (const name of readdirSync(GUIDE)) {
    if (!name.endsWith('.md')) continue;
    const text = readFileSync(path.join(GUIDE, name), 'utf8');
    for (const match of text.matchAll(/<FromRxdb [^>]*:rows="\[([^\]]*)\]"/g)) {
      for (const id of match[1].matchAll(/'([^']+)'/g)) if (!rows.has(id[1])) missing.push(`${name}: ${id[1]}`);
    }
  }
  assert.deepStrictEqual(missing, []);
});

test('docs/public/llms.txt is what scripts/llms.js writes', () => {
  assert.strictEqual(readFileSync(TARGET, 'utf8'), render(), 'docs/public/llms.txt is stale: run pnpm docs:llms');
});

test('every src/ path a figure or a live demo depicts exists', () => {
  const missing = [];
  for (const dir of ['figures', 'live']) {
    const full = path.join(DOCS, '.vitepress', 'theme', 'components', dir);
    for (const name of readdirSync(full)) {
      if (!name.endsWith('.vue')) continue;
      const text = readFileSync(path.join(full, name), 'utf8');
      for (const match of text.matchAll(/src\/[A-Za-z0-9_./-]+\.(?:js|ts)/g)) {
        if (!existsSync(path.join(ROOT, match[0]))) missing.push(`${dir}/${name}: ${match[0]}`);
      }
    }
  }
  assert.deepStrictEqual(missing, []);
});
