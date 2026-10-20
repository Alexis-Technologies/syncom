'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { fileExists } = require('./utils.js');

const read = (dir, filename) => fs.readFile(path.join(dir, filename), 'utf8');

// `options.mode` is a hint for a backend with file permissions — the
// private key asks for owner-only; adapters without permissions ignore it.
const write = async (dir, filename, content, options) => {
  await fs.mkdir(dir, { recursive: true });
  const mode = options?.mode;
  await fs.writeFile(path.join(dir, filename), content, mode === undefined ? undefined : { mode });
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
