'use strict';

// What the tarball holds, asked of npm itself: `npm pack --dry-run --json` lists what `npm publish` and
// `pnpm publish` would send, writes nothing and fetches nothing. The package ships code and types alone — every
// file under src/ a .js or a .d.ts — and the agents' notes never ship: no CLAUDE.md, the root's or a folder's,
// nothing of .claude/. `files` in package.json keeps them out (`!**/CLAUDE.md`); this suite holds what is packed
// to it, so a note added to a new folder, or the exclusion dropped, is a red test before it is a publish.

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..', '..');
const NOTES = 'CLAUDE.md';

// The packed paths, or null where there is no npm to ask (a runtime without it): the tests then skip.
const packed = () => {
  let out;
  try {
    out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
      env: { ...process.env, npm_config_update_notifier: 'false' },
    });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return JSON.parse(out)[0].files.map((file) => file.path);
};

// Every CLAUDE.md under `dir`, relative to the root.
const notesUnder = (dir, out = []) => {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) notesUnder(relative, out);
    else if (entry.name === NOTES) out.push(relative);
  }
  return out;
};

const files = packed();
const skip = files === null ? 'npm is not on the PATH' : false;

describe('the packed tarball', () => {
  it('should pack no CLAUDE.md: not the root’s, not a folder’s, and nothing of .claude/', { skip }, () => {
    // The notes are there to be left out: without them this would hold of anything.
    assert.ok(notesUnder('src').length > 0, 'src/ holds no CLAUDE.md: this suite checks nothing');
    const notes = files.filter((file) => path.posix.basename(file).toLowerCase() === NOTES.toLowerCase());
    assert.deepStrictEqual(notes, [], 'package.json#files must keep every CLAUDE.md out ("!**/CLAUDE.md")');
    const agent = files.filter((file) => file.split('/').includes('.claude'));
    assert.deepStrictEqual(agent, [], '.claude/ is never packed');
  });

  it('should ship code and types alone from src/: every packed file of it is a .js or a .d.ts', { skip }, () => {
    const source = files.filter((file) => file.startsWith('src/'));
    assert.ok(source.includes('src/index.js') && source.includes('src/sync/sync.d.ts'), 'src/ is packed');
    const other = source.filter((file) => !file.endsWith('.js') && !file.endsWith('.d.ts'));
    assert.deepStrictEqual(other, [], 'a file of src/ that is neither code nor types would ship');
  });
});
