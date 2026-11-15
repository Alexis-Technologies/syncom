// The Backup page (docs/guide/backup.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

const schema = { entities: { Task: {} } };
const board = await createDatabase({ path: 'board', schema });
const task = await board.Task.insert({ title: 'Back me up', done: false });

// #region write
import { writeFile, rename } from 'node:fs/promises';
import { exportJSON } from '@alexify/syncom/dump';

const backup = async (db, file) => {
  await writeFile(`${file}.tmp`, JSON.stringify(await exportJSON(db)));
  await rename(`${file}.tmp`, file); // a crash mid-write never leaves half a backup under the real name
};
await backup(board, 'board.backup.json');
// #endregion write

// #region restore
import { readFile } from 'node:fs/promises';
import { importJSON } from '@alexify/syncom/dump';

const restored = await createDatabase({ path: 'restored', schema });
const dump = JSON.parse(await readFile('board.backup.json', 'utf8'));
console.log(await importJSON(restored, dump)); // { mode: 'merge', records: 1 }
console.log(await restored.Task.get(task.id)); // { title: 'Back me up', done: false, $type: 'Task' }
console.log(restored.nodeId === board.nodeId); // false: the records came back, as a new node
// #endregion restore
assert.deepEqual(await restored.Task.get(task.id), { title: 'Back me up', done: false, $type: 'Task' });
assert.notEqual(restored.nodeId, board.nodeId);
await restored.close();

// #region schedule
let changed = false;
board.on('transaction', () => {
  changed = true; // every turn that changed something: a local write, a peer's page
});
const backupIfChanged = async () => {
  if (!changed) return;
  changed = false;
  await backup(board, 'board.backup.json');
};
const timer = setInterval(backupIfChanged, 10 * 60 * 1000); // every ten minutes, when something changed
// #endregion schedule
await board.Task.insert({ title: 'Written after the first backup', done: false });
await backupIfChanged();
clearInterval(timer);
assert.equal(JSON.parse(await readFile('board.backup.json', 'utf8')).records.length, 2);
await board.close();

// #region cold
import { filesEngine, read, write, exists, remove, list } from '@alexify/syncom';
import { copyEngine } from '@alexify/syncom/engines';

const files = filesEngine({ read, write, exists, remove, list }); // the files under the working directory
await copyEngine(files, files, { path: 'board', targetPath: 'backups/board-2026-11-15' }); // board is closed
// #endregion cold
const copy = await createDatabase({ path: 'backups/board-2026-11-15', schema });
assert.equal(copy.nodeId, board.nodeId);
assert.equal(await copy.Task.select({}).count(), 2);
await copy.close();
