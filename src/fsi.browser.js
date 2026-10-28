'use strict';

// Directory handles, once resolved, are kept: walking from the root on every
// call was the cost of every read and write. A storage never removes its own
// directories, so a cached handle stays valid; a handle that went stale all
// the same (`InvalidStateError`) is dropped and resolved again.
const handles = new Map();

const walk = async (dirPath) => {
  const root = await navigator.storage.getDirectory();
  const parts = dirPath.split('/');
  let dir = root;
  for (const part of parts) {
    if (part === '') continue;
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
};

const resolveDir = async (dirPath) => {
  let dir = handles.get(dirPath);
  if (dir === undefined) {
    dir = await walk(dirPath);
    handles.set(dirPath, dir);
  }
  return dir;
};

// Runs `fn` on the directory's handle, once more on a fresh one if the
// cached handle is no longer usable.
const withDir = async (dirPath, fn) => {
  try {
    return await fn(await resolveDir(dirPath));
  } catch (error) {
    if (error?.name !== 'InvalidStateError' || !handles.has(dirPath)) throw error;
    handles.delete(dirPath);
    return fn(await resolveDir(dirPath));
  }
};

const read = (dir, filename) =>
  withDir(dir, async (dirHandle) => {
    const fileHandle = await dirHandle.getFileHandle(filename);
    const file = await fileHandle.getFile();
    return file.text();
  });

const write = (dir, filename, content) =>
  withDir(dir, async (dirHandle) => {
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  });

// "Not there" is a `NotFoundError`, a name OPFS refuses (`TypeError`) or a
// directory under that name (`TypeMismatchError`), like the node half's
// `fileExists`; a storage that is denied or broken is not "not there".
const ABSENT = new Set(['NotFoundError', 'TypeError', 'TypeMismatchError']);

const exists = (dir, filename) =>
  withDir(dir, async (dirHandle) => {
    try {
      await dirHandle.getFileHandle(filename);
      return true;
    } catch (error) {
      if (ABSENT.has(error?.name)) return false;
      throw error;
    }
  });

const remove = (dir, filename) =>
  withDir(dir, async (dirHandle) => {
    try {
      await dirHandle.removeEntry(filename);
    } catch (error) {
      // A file already gone is what remove() was for; anything else is not.
      if (error?.name !== 'NotFoundError') throw error;
    }
  });

// OPFS twin of the node `list`: `resolveDir` creates the directory on the way
// down, so a directory that never existed lists as empty, like ENOENT above.
const list = (dir) =>
  withDir(dir, async (dirHandle) => {
    const names = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'file') names.push(name);
    }
    return names.sort();
  });

module.exports = { read, write, exists, remove, list };
