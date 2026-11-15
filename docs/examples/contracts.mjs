// The Smart contracts page (docs/guide/contracts.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory.
import assert from 'node:assert/strict';
import { createDatabase } from '@alexify/syncom/all';

const db = await createDatabase({ path: 'blog', schema: { entities: { Post: {} } } });
const post = await db.Post.insert({ title: 'Release 1.0', status: 'draft' });

// #region save
import { Blockchain } from '@alexify/syncom/chain';
import { SmartContract } from '@alexify/syncom/contracts';

const chain = await new Blockchain('contracts'); // a chain of its own for the contracts
const hash = await SmartContract.save('publish', chain, async (reader, args) => {
  const found = await reader.get(args.id);
  if (found === null) throw new Error(`no post ${args.id}`);
  return { ...found, status: 'published', publishedBy: args.by };
});
// #endregion save
assert.match(hash, /^[0-9a-f]{64}$/);

// #region execute
const publish = await SmartContract.load(hash, { storage: db, chain });
await publish.execute({ id: post.id, by: 'ada' }); // the result is written under args.id
console.log(await db.Post.get(post.id));
// { title: 'Release 1.0', status: 'published', '$type': 'Post', publishedBy: 'ada' }
// #endregion execute
assert.deepEqual(await db.Post.get(post.id), {
  title: 'Release 1.0',
  status: 'published',
  $type: 'Post',
  publishedBy: 'ada',
});

// #region failure
try {
  await publish.execute({ id: 'no-such-post', by: 'ada' });
} catch (error) {
  console.log(error.message); // 'no post no-such-post', rethrown...
}
console.log((await chain.readBlock(chain.tailHash)).data);
// ...and recorded: { contract: 'publish', args: { id: 'no-such-post', by: 'ada' }, error: 'no post no-such-post', timestamp: … }
// #endregion failure
const failure = (await chain.readBlock(chain.tailHash)).data;
assert.equal(failure.contract, 'publish');
assert.equal(failure.error, 'no post no-such-post');
await assert.rejects(SmartContract.load(chain.tailHash, { storage: db, chain }), { code: 'NOT_CONTRACT' });
await db.close();
