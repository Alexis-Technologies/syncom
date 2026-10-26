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

// Exclusive: the file must not exist, or the write fails with EEXIST. What
// the directory lock uses to make two openers racing for a free lock lose
// deterministically — the optional sixth function of the contract.
const create = async (dir, filename, content) => {
  if (!known.has(dir)) {
    await fs.mkdir(dir, { recursive: true });
    known.add(dir);
  }
  await fs.writeFile(path.join(dir, filename), content, { flag: 'wx' });
};

// Descriptors held open for appends. A log appends to one file for a while,
// and an open, a write and a close per append cost about ten times a write
// on a held descriptor (a new file and its unlink 170 µs, a held write 11 µs
// on an SSD). One is held per directory — a log appends to its newest
// journal alone, so a new file there releases the one before — and at most
// MAX_HELD in all, the least recently used closed first (eight once, shared
// by every storage of the process: nine logs appending took turns reopening
// their files); a remove closes its own first; each has a lane, so a close
// waits for the write before it. A descriptor opened in append mode writes
// at the end of whatever the file holds, so a `write` that rewrites the file
// in place leaves it right.
const MAX_HELD = 64;
const held = new Map();
const heldIn = new Map();

const release = (target) => {
  const entry = held.get(target);
  if (entry === undefined) return Promise.resolve();
  held.delete(target);
  if (heldIn.get(entry.dir) === target) heldIn.delete(entry.dir);
  return entry.lane
    .then(() => entry.handle)
    .then((handle) => handle.close())
    .catch(() => {});
};

const heldFor = (target) => {
  let entry = held.get(target);
  if (entry !== undefined) {
    held.delete(target);
    held.set(target, entry);
    return entry;
  }
  const dir = path.dirname(target);
  const before = heldIn.get(dir);
  if (before !== undefined) void release(before);
  entry = { handle: fs.open(target, 'a'), lane: Promise.resolve(), dir };
  entry.handle.catch(() => {});
  held.set(target, entry);
  heldIn.set(dir, target);
  if (held.size > MAX_HELD) void release(held.keys().next().value);
  return entry;
};

// Appends `content` to the file, made when absent; resolves once it is
// written (as durable as `write`: `sync` makes it more).
const append = async (dir, filename, content) => {
  if (!known.has(dir)) {
    await fs.mkdir(dir, { recursive: true });
    known.add(dir);
  }
  const target = path.join(dir, filename);
  const attempt = () => {
    const entry = heldFor(target);
    const run = entry.lane.then(async () => (await entry.handle).appendFile(content));
    entry.lane = run.catch(() => {});
    return run.catch((error) => {
      // A descriptor that failed is not kept: the next append opens again.
      if (held.get(target) === entry) void release(target);
      throw error;
    });
  };
  try {
    await attempt();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await fs.mkdir(dir, { recursive: true });
    await attempt();
  }
};

const exists = (dir, filename) => fileExists(path.join(dir, filename));

const remove = async (dir, filename) => {
  const filePath = path.join(dir, filename);
  await release(filePath);
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

module.exports = { read, write, exists, remove, list, sync, create, append };
