'use strict';

const { it } = require('node:test');

const runSyncManagerCoreTests = (assert, getSync) => {
  it('should add, list and remove a node with addNode, listNodes and removeNode', async (t2) => {
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

  it('should reject bad input to addNode', async (t2) => {
    const sync = await getSync(t2);

    await assert.rejects(() => sync.addNode({ token: 'x' }), /URL is required/);
    await assert.rejects(() => sync.addNode({ url: 'ws://a.com:1', scopes: 'nope' }), /scopes/);

    await sync.addNode({ url: 'ws://dup.example.com:80' });
    await assert.rejects(() => sync.addNode({ url: 'ws://dup.example.com:80' }), {
      code: 'ALX_ERR_NODE_EXISTS',
      url: 'ws://dup.example.com:80',
      message: /already exists/,
    });
  });

  it('should not collide two peers on one host, or a url without a port', async (t2) => {
    const sync = await getSync(t2);
    await sync.addNode({ url: 'ws://host.example.com:9000' });
    await sync.addNode({ url: 'ws://host.example.com:9001' });
    await sync.addNode({ url: 'wss://host.example.com/api' });
    assert.strictEqual(sync.listNodes().length, 3);
  });

  it('should throw from removeNode when the node is unknown', async (t2) => {
    const sync = await getSync(t2);
    await assert.rejects(() => sync.removeNode('http://nope.example.com:1'), {
      code: 'ALX_ERR_NODE_NOT_FOUND',
      message: /not found/,
    });
  });

  it('should keep the registry across a reopen', async (t2) => {
    const sync = await getSync(t2);
    await sync.addNode({ url: 'wss://persist.example.com/api', token: 'k', scopes: ['docs'] });
    await sync.storage.close();
    const reopened = await getSync(t2, sync);
    const [node] = reopened.listNodes();
    assert.strictEqual(node.url, 'wss://persist.example.com/api');
    assert.strictEqual(node.token, 'k');
    assert.deepStrictEqual(node.scopes, ['docs']);
  });
};

module.exports = { runSyncManagerCoreTests };
