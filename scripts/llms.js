/**
 * docs/public/llms.txt — the map of the documentation for language models (https://llmstxt.org), generated
 * so it cannot drift: the facts come from package.json, the pages from the guide's sidebar
 * (docs/.vitepress/sidebar/*.json, in file-name order) and each page's own `title` and `description`
 * frontmatter, the reference pages from docs/reference/. tests/package/docs-map.test.js fails when the
 * file is not what this script writes.
 *
 * Run: pnpm docs:llms   (`--check` exits 1 instead of writing when the file is stale)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const SITE = 'https://syncomjs.vercel.app';
const TARGET = path.join(DOCS, 'public', 'llms.txt');

// `title` and `description` of a page's frontmatter (one line each, as every page writes them).
const frontmatter = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  const fields = {};
  if (match) {
    for (const line of match[1].split('\n')) {
      const pair = line.match(/^(\w+):\s*(.*)$/);
      if (pair) fields[pair[1]] = pair[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  if (!fields.title) {
    const heading = text.match(/^# (.+)$/m);
    if (heading) fields.title = heading[1];
  }
  return fields;
};

const pageFile = (link) => {
  const clean = link.split('#')[0].replace(/^\//, '');
  return path.join(DOCS, clean.endsWith('/') ? `${clean}index.md` : `${clean}.md`);
};

const render = () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lines = [
    `# ${pkg.name}`,
    '',
    `> ${pkg.description}`,
    '',
    'syncom is a local-first data engine: records live on the device, every write is an op in a log that other',
    'nodes (servers, browsers, peers) replicate over an injected transport, and every node converges on the same',
    'records without a coordinator. Fields merge by kind (registers, counters, sets, lists, text, trees), so there',
    'is no conflict handler. One API in Node.js and the browser.',
    '',
    '## Key facts',
    '',
    `- Package: \`${pkg.name}\` ${pkg.version}, ${pkg.license}, source at ${pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')}`,
    '- Not published to npm yet: depend on the repository until the first release',
    `- Runtimes: Node.js ${pkg.engines.node}, and browsers with OPFS or IndexedDB and Web Crypto`,
    '- Zero runtime dependencies; CommonJS with named ESM imports; no build step',
    `- Entry points: ${Object.keys(pkg.exports)
      .filter((key) => key !== './package.json')
      .map((key) => `\`${key === '.' ? pkg.name : `${pkg.name}/${key.slice(2)}`}\``)
      .join(', ')}`,
    '- `createDatabase(options)` resolves once the database is open; `@alexify/syncom/all` registers every plugin',
    '- Every operational error is a `SyncomError` with a `code`',
    '',
  ];
  const dir = path.join(DOCS, '.vitepress', 'sidebar');
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const group = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    lines.push(`## ${group.text}`, '');
    for (const item of group.items) {
      const file = pageFile(item.link);
      const { description } = fs.existsSync(file) ? frontmatter(file) : {};
      lines.push(`- [${item.text}](${SITE}${item.link})${description ? `: ${description}` : ''}`);
    }
    lines.push('');
  }
  lines.push('## Reference', '');
  for (const name of fs.readdirSync(path.join(DOCS, 'reference')).sort()) {
    if (!name.endsWith('.md')) continue;
    const { title, description } = frontmatter(path.join(DOCS, 'reference', name));
    lines.push(`- [${title}](${SITE}/reference/${name.slice(0, -3)})${description ? `: ${description}` : ''}`);
  }
  lines.push('');
  return lines.join('\n');
};

if (require.main === module) {
  const text = render();
  if (process.argv.includes('--check')) {
    const stale = !fs.existsSync(TARGET) || fs.readFileSync(TARGET, 'utf8') !== text;
    if (stale) console.error('docs/public/llms.txt is stale: run pnpm docs:llms');
    process.exit(stale ? 1 : 0);
  }
  fs.writeFileSync(TARGET, text);
  console.log(`wrote ${path.relative(ROOT, TARGET)}`);
}

module.exports = { render, frontmatter, pageFile, TARGET };
