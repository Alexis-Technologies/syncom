// The Audit chain page (docs/guide/chain.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
// #region validate
import { createDatabase } from '@alexify/syncom/all';

const books = await createDatabase({ path: 'books', defer: 0 }); // /all registers the chain plugin
const id = await books.insert({ title: 'Invoice 7', total: 10 });
await books.update(id, { total: 12 });

console.log(await books.validate({ last: 10 })); // true: the 10 newest blocks hash to what links them
console.log(await books.validate()); // true: the whole chain, back to its first block
console.log(books.stats().chain); // { tail: '<hash of the newest block>' }
// #endregion validate
assert.equal(await books.validate(), true);
assert.match(books.stats().chain.tail, /^[0-9a-f]{64}$/);
await books.close();

// Someone edits the record file behind syncom's back (the files engine keeps one file per record).
const file = `books/data/${id}.json`;
const stored = JSON.parse(readFileSync(file, 'utf8'));
stored.data.total = 1;
writeFileSync(file, JSON.stringify(stored));

// #region tampered
const reopened = await createDatabase({ path: 'books', defer: 0 });
try {
  await reopened.get(id);
} catch (error) {
  console.log(error.code); // ALX_ERR_INTEGRITY: the file no longer hashes to what its block recorded
}
// #endregion tampered
await assert.rejects(reopened.get(id), { code: 'ALX_ERR_INTEGRITY' });
assert.deepEqual(await reopened.repair(id), { ops: 2, alive: true });
assert.deepEqual(await reopened.get(id), { title: 'Invoice 7', total: 12 });
await reopened.close();

// #region off
const hub = await createDatabase({ path: 'hub', chain: false }); // a node that only relays
try {
  await hub.validate();
} catch (error) {
  console.log(error.code); // ALX_ERR_NO_CHAIN
}
// #endregion off
await assert.rejects(hub.validate(), { code: 'ALX_ERR_NO_CHAIN' });
await hub.close();

// #region blockchain
import { Blockchain } from '@alexify/syncom/chain';

const audit = await new Blockchain('audit'); // a chain of its own, in its own directory
const hash = await audit.addBlock({ event: 'release approved', by: 'ada' });
console.log(await audit.readBlock(hash));
// { prev: '<hash of the block before>', timestamp: 1794…, data: { event: 'release approved', by: 'ada' } }
console.log(await audit.validate()); // true
// #endregion blockchain
assert.deepEqual((await audit.readBlock(hash)).data, { event: 'release approved', by: 'ada' });
assert.equal(audit.tailHash, hash);
await assert.rejects(audit.readBlock('0'.repeat(64)), { code: 'ALX_ERR_BLOCK_NOT_FOUND' });
