// The Signing and identity page (docs/guide/signing.md) shows the regions of this file.
// tests/package/docs-examples.test.js runs it from an empty temporary directory. Port 8901 is this file's.
import assert from 'node:assert/strict';
// #region identity
import { createDatabase, memoryEngine } from '@alexify/syncom/all';

const laptop = await createDatabase({ engine: memoryEngine() }); // /all registers the signing plugin
console.log(laptop.nodeId); // 'BLIHJMz4SUxjMqmH-2muZLeDtYbI_a17XTXfWEONxDM': the node's Ed25519 public key
console.log(laptop.signatures); // 'verify': this node signs, and checks what arrives signed
// #endregion identity
assert.match(laptop.nodeId, /^[A-Za-z0-9_-]{43}$/);
assert.equal(laptop.signatures, 'verify');

// #region forged
const server = await createDatabase({ engine: memoryEngine() });
server.on('error', (error) => console.log(error.code)); // BAD_SIGNATURE

const id = await laptop.insert({ title: 'Pay 10' });
const [{ op }] = laptop.log.entriesOf(id); // the op as the laptop signed it
const tampered = { ...op, data: { title: 'Pay 1000' } }; // what a relay in the middle might send

console.log((await server.applyRemote([tampered])).forged); // 1: refused, not logged, not relayed
console.log(await server.get(id)); // null
console.log((await server.applyRemote([op])).applied); // 1: the real op lands
// #endregion forged
assert.equal(await server.get(id).then((record) => record.title), 'Pay 10');

// #region require
import * as lean from '@alexify/syncom';
import { sync } from '@alexify/syncom/sync';

const strict = await createDatabase({ engine: memoryEngine(), sync: { signatures: 'require' } });
strict.on('error', (error) => console.log(error.code)); // UNSIGNED

const unsigning = await lean.createDatabase({ engine: memoryEngine(), plugins: [sync] }); // no signing plugin
const other = await unsigning.insert({ title: 'Unsigned' });
const [unsigned] = unsigning.log.entriesOf(other);
console.log((await strict.applyRemote([unsigned.op])).unsigned); // 1: refused under 'require'
console.log((await server.applyRemote([unsigned.op])).applied); // 1: taken under 'verify'
// #endregion require
assert.equal(await strict.get(other), null);
assert.deepEqual(await server.get(other), { title: 'Unsigned' });
await strict.close();

// #region prove
import { Server, defineRouter, WrpcClient } from '@alexify/wrpc';
import { createWrpcLink } from '@alexify/syncom/wrpc';

const router = defineRouter({
  syncom: server.sync.unit({ access: 'public', prove: true }), // a peer proves its key at hello
});
const http = new Server({ router, host: '127.0.0.1', port: 8901, protocol: 'http' });
await http.listen();

const connect = async (node) => createWrpcLink(await WrpcClient.connect(node.url));
const phone = await createDatabase({ engine: memoryEngine(), sync: { connect } });
await phone.sync.addNode({ url: 'ws://127.0.0.1:8901/api' }); // signs the challenge, then syncs
await phone.sync.awaitInSync();

const keyless = await lean.createDatabase({ engine: memoryEngine(), plugins: [sync], sync: { connect } });
await keyless.sync.addNode({ url: 'ws://127.0.0.1:8901/api' }); // has no key to prove
// keyless.sync.peers()[0].lastError.code is 'UNPROVEN': it pushes nothing and receives nothing
// #endregion prove
const pending = await keyless.insert({ title: 'Never sent' });
await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(keyless.sync.peers()[0].lastError?.code, 'UNPROVEN');
assert.equal(await server.get(pending), null);
assert.deepEqual(await phone.get(id), { title: 'Pay 10' }, 'the proven phone received the server’s records');

// #region keys
import { generateSigningKeys, sign, verify } from '@alexify/syncom/signing';

const pair = await generateSigningKeys(); // { id, publicKey, privateKey }: id is what a node id would be
const signature = sign('release 1.0 approved', pair.privateKey);
console.log(verify('release 1.0 approved', signature, pair.id)); // true
console.log(verify('release 2.0 approved', signature, pair.id)); // false
// #endregion keys
assert.equal(verify('release 1.0 approved', signature, pair.id), true);
assert.equal(verify('release 2.0 approved', signature, pair.id), false);

await keyless.close();
await phone.close();
await unsigning.close();
await laptop.close();
await server.close();
await http.close();
