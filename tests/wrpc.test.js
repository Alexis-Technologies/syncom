'use strict';

// The adapter against a wrpc-SHAPED client, so `src/wrpc.js` is covered with
// or without @alexify/wrpc installed; the real thing runs in
// tests/wrpc.integration.test.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createWrpcLink, isSyncLink, SYNC_INTROSPECTION } = require('../src/wrpc/wrpc.js');
const { Emitter } = require('../src/utils.js');

class FakeWrpcClient extends Emitter {
  calls = [];
  used = null;
  api = {};
  closed = false;
  streams = new Map();

  async call(method, args) {
    this.calls.push([method, args]);
    return { echoed: method };
  }

  use(introspection) {
    this.used = introspection;
    for (const unit in introspection) {
      this.api[unit] = {};
      for (const name in introspection[unit]) {
        const info = introspection[unit][name];
        if (info.kind !== 'subscription') continue;
        this.api[unit][name] = {
          kind: 'subscription',
          subscribe: (args, options) => {
            const record = { args, lastEventId: options.lastEventId, options, closed: false };
            this.last = record;
            return {
              get lastEventId() {
                return record.lastEventId;
              },
              unsubscribe: () => {
                record.closed = true;
              },
            };
          },
        };
      }
    }
    return this;
  }

  // Emulates a `data` packet: the id moves BEFORE the value is delivered.
  deliver(eventId, value) {
    if (eventId !== undefined) this.last.lastEventId = eventId;
    this.last.options.onData(value);
  }

  getStream(id) {
    return this.streams.get(id);
  }

  close() {
    this.closed = true;
  }
}

describe('createWrpcLink', () => {
  it('should refuse anything not shaped like a WrpcClient', () => {
    assert.throws(() => createWrpcLink({}), /expected a WrpcClient/);
    assert.throws(() => createWrpcLink(null), TypeError);
    assert.strictEqual(isSyncLink(createWrpcLink(new FakeWrpcClient())), true);
    assert.strictEqual(isSyncLink({ call() {} }), false);
  });

  it('should scaffold the unit with use() and route calls by method name', async () => {
    const client = new FakeWrpcClient();
    const link = createWrpcLink(client);
    assert.deepStrictEqual(client.used, { syncom: SYNC_INTROSPECTION.syncom });
    assert.deepStrictEqual(await link.call('syncom/hello', { node: 'a' }), { echoed: 'syncom/hello' });
    assert.deepStrictEqual(client.calls, [['syncom/hello', { node: 'a' }]]);
    assert.strictEqual(link.client, client);
  });

  it('should honour a renamed unit on calls and subscriptions', async () => {
    const client = new FakeWrpcClient();
    const link = createWrpcLink(client, { unit: 'replication' });
    await link.call('syncom/push', { ops: [] });
    assert.deepStrictEqual(client.calls[0][0], 'replication/push');
    assert.ok(client.api.replication.changes);
    link.subscribe('syncom/changes', { scopes: ['*'] }, {});
    assert.deepStrictEqual(client.last.args, { scopes: ['*'] });
  });

  it('should pass lastEventId in on subscribe and label every value with the current one', () => {
    const client = new FakeWrpcClient();
    const link = createWrpcLink(client);
    const received = [];
    const ended = [];
    const handle = link.subscribe(
      'syncom/changes',
      { scopes: ['*'] },
      {
        lastEventId: 'ep.5',
        onData: (value, eventId) => received.push([value, eventId]),
        onEnd: () => ended.push('end'),
      },
    );
    assert.strictEqual(client.last.lastEventId, 'ep.5');
    client.deliver('ep.6', { ops: [] });
    client.deliver(undefined, { bootstrap: true });
    assert.deepStrictEqual(received, [
      [{ ops: [] }, 'ep.6'],
      [{ bootstrap: true }, 'ep.6'],
    ]);
    assert.strictEqual(handle.lastEventId, 'ep.6');
    client.last.options.onEnd();
    assert.deepStrictEqual(ended, ['end']);
    handle.unsubscribe();
    assert.strictEqual(client.last.closed, true);
    assert.throws(() => link.subscribe('syncom/push', {}, {}), /not a subscription/);
  });

  it('should let streams, events and close reach the client', async () => {
    const client = new FakeWrpcClient();
    client.streams.set(
      's1',
      (async function* () {
        yield new Uint8Array([1]);
      })(),
    );
    const link = createWrpcLink(client);
    const chunks = [];
    for await (const chunk of link.stream('s1')) chunks.push(chunk);
    assert.strictEqual(chunks.length, 1);

    const seen = [];
    const listener = () => seen.push('reconnect');
    link.on('reconnect', listener);
    await client.emit('reconnect');
    link.off('reconnect', listener);
    await client.emit('reconnect');
    assert.deepStrictEqual(seen, ['reconnect']);
    link.close();
    assert.strictEqual(client.closed, true);
  });
});
