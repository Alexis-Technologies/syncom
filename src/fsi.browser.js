'use strict';

const resolveDir = async (dirPath) => {
  const root = await navigator.storage.getDirectory();
  const parts = dirPath.split('/').filter(Boolean);
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
};

const read = async (dir, filename) => {
  const dirHandle = await resolveDir(dir);
  const fileHandle = await dirHandle.getFileHandle(filename);
  const file = await fileHandle.getFile();
  return file.text();
};

const write = async (dir, filename, content) => {
  const dirHandle = await resolveDir(dir);
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
};

const exists = async (dir, filename) => {
  const dirHandle = await resolveDir(dir);
  try {
    await dirHandle.getFileHandle(filename);
    return true;
  } catch {
    return false;
  }
};

const remove = async (dir, filename) => {
  const dirHandle = await resolveDir(dir);
  try {
    await dirHandle.removeEntry(filename);
  } catch {
    // File may not exist
  }
};

// OPFS twin of the node `list`: `resolveDir` creates the directory on the way
// down, so a directory that never existed lists as empty, like ENOENT above.
const list = async (dir) => {
  const dirHandle = await resolveDir(dir);
  const names = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'file') names.push(name);
  }
  return names.sort();
};

module.exports = { read, write, exists, remove, list };
