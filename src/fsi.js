'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { fileExists } = require('./utils.js');

const read = (dir, filename) => fs.readFile(path.join(dir, filename), 'utf8');

// Directories this process has written into: `mkdir -p` on every write is a
// syscall the hot path need not pay twice. A directory removed behind our
// back fails the write with ENOENT, which makes it again, once.
const known = new Set();

// `options.mode` is a hint for a backend with file permissions — the
// private key asks for owner-only; adapters without permissions ignore it.
const write = async (dir, filename, content, options) => {
  const mode = options?.mode;
  const target = path.join(dir, filename);
  const fileOptions = mode === undefined ? undefined : { mode };
  if (!known.has(dir)) {
    await fs.mkdir(dir, { recursive: true });
    known.add(dir);
  }
  try {
    await fs.writeFile(target, content, fileOptions);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(target, content, fileOptions);
  }
};

const exists = (dir, filename) => fileExists(path.join(dir, filename));

const remove = async (dir, filename) => {
  const filePath = path.join(dir, filename);
  if (await fileExists(filePath)) await fs.unlink(filePath);
};

// The file names in a directory (no subdirectories); a missing directory is
// an empty listing, not an error — a storage that has never written a record
// simply has no data/ yet.
const list = async (dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const names = [];
  for (const entry of entries) if (entry.isFile()) names.push(entry.name);
  return names.sort();
};

// fsync: what `open({ durable: true })` calls after every write. The OPFS
// half has none — a closed writable is durable there.
const sync = async (dir, filename) => {
  const handle = await fs.open(path.join(dir, filename), 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

module.exports = { read, write, exists, remove, list, sync };
