'use strict';

const runSyncManagerCoreTests = async (t, assert, getSync) => {
  await t.test('addNode listNodes and removeNode', async (t2) => {
    const sync = await getSync(t2);

    await sync.addNode({ url: 'wss://peer.example.com/api', token: 't1' });

    const nodes = sync.listNodes();
    assert.strictEqual(nodes.length, 1);
    assert.strictEqual(nodes[0].url, 'wss://peer.example.com/api');
    assert.strictEqual(nodes[0].token, 't1');
    assert.deepStrictEqual(nodes[0].scopes, ['*']);
    assert.strictEqual(nodes[0].enabled, true);
    assert.strictEqual(nodes[0].lastSync, null);

    await sync.removeNode('wss://peer.example.com/api');
    assert.strictEqual(sync.listNodes().length, 0);
  });

  await t.test('addNode rejects bad input', async (t2) => {
    const sync = await getSync(t2);

    await assert.rejects(() => sync.addNode({ token: 'x' }), /URL is required/);
    await assert.rejects(() => sync.addNode({ url: 'ws://a.com:1', scopes: 'nope' }), /scopes/);

    await sync.addNode({ url: 'ws://dup.example.com:80' });
    await assert.rejects(() => sync.addNode({ url: 'ws://dup.example.com:80' }), /already exists/);
  });

  await t.test('two peers on one host, or a url without a port, do not collide', async (t2) => {
    const sync = await getSync(t2);
    await sync.addNode({ url: 'ws://host.example.com:9000' });
    await sync.addNode({ url: 'ws://host.example.com:9001' });
    await sync.addNode({ url: 'wss://host.example.com/api' });
    assert.strictEqual(sync.listNodes().length, 3);
  });

  await t.test('removeNode throws when unknown', async (t2) => {
    const sync = await getSync(t2);
    await assert.rejects(() => sync.removeNode('http://nope.example.com:1'), /not found/);
  });

  await t.test('the registry survives a reopen', async (t2) => {
    const sync = await getSync(t2);
    await sync.addNode({ url: 'wss://persist.example.com/api', token: 'k', scopes: ['docs'] });
    const reopened = await getSync(t2, sync);
    const [node] = reopened.listNodes();
    assert.strictEqual(node.url, 'wss://persist.example.com/api');
    assert.strictEqual(node.token, 'k');
    assert.deepStrictEqual(node.scopes, ['docs']);
  });
};

module.exports = { runSyncManagerCoreTests };
