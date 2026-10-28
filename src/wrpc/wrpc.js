'use strict';

// The `@alexify/syncom/wrpc` subpath: adapts a wrpc client to the SyncLink
// contract the sync engine dials through. wrpc is INJECTED — the caller
// constructs the WrpcClient and hands it over; nothing here requires
// '@alexify/wrpc', and the shape is checked structurally at the boundary,
// the way wrpc itself takes uws, fastify or a Redis client.
//
//   const { WrpcClient } = require('@alexify/wrpc');
//   const { createWrpcLink } = require('@alexify/syncom/wrpc');
//   const storage = await open({
//     path: 'data',
//     sync: { connect: async (node) => createWrpcLink(await WrpcClient.connect(node.url)) },
//   });
//
// Everything the engine leaves to the transport — reconnecting with backoff,
// the heartbeat, re-opening the `changes` subscription from its last event id
// — is what a WrpcClient already does; the adapter only translates names. An
// event the engine sends (`send('syncom/presence', update)`) is the client's
// `sendEvent`; one it listens for (`on('syncom/presence', fn)`) is the unit's
// — `client.api.syncom.on('presence', fn)`, the emitter `use()` scaffolds.

const { isSyncLink } = require('../sync/link.js');

const UNIT = 'syncom';

// The introspection `client.use()` scaffolds `client.api.syncom` from, with
// no round trip: the engine calls procedures by name through `client.call`,
// and the one subscription needs a scaffolded handle to be resumable.
const SYNC_INTROSPECTION = Object.freeze({
  [UNIT]: Object.freeze({
    hello: Object.freeze({}),
    push: Object.freeze({}),
    snapshot: Object.freeze({}),
    changes: Object.freeze({ kind: 'subscription' }),
  }),
});

const isWrpcClient = (client) =>
  Boolean(client) &&
  typeof client.call === 'function' &&
  typeof client.use === 'function' &&
  typeof client.on === 'function' &&
  typeof client.off === 'function' &&
  typeof client.close === 'function';

/**
 * Wraps a WrpcClient (or anything shaped like one) into a SyncLink. `unit`
 * renames the router unit when the host mounted it under something other
 * than `syncom`.
 */
const createWrpcLink = (client, { unit = UNIT } = {}) => {
  if (!isWrpcClient(client)) {
    throw new TypeError('createWrpcLink: expected a WrpcClient (call/use/on/off/close)');
  }
  client.use({ [unit]: SYNC_INTROSPECTION[UNIT] });
  const target = (method) => {
    const slash = method.indexOf('/');
    const name = slash === -1 ? method : method.slice(slash + 1);
    return `${unit}/${name}`;
  };

  const link = {
    call: (method, args) => client.call(target(method), args),

    subscribe(method, args, { lastEventId, onData, onError, onEnd } = {}) {
      const name = target(method).slice(unit.length + 1);
      const procedure = client.api?.[unit]?.[name];
      if (!procedure || typeof procedure.subscribe !== 'function') {
        throw new TypeError(`createWrpcLink: ${unit}/${name} is not a subscription on this client`);
      }
      const handle = procedure.subscribe(args, {
        lastEventId,
        // wrpc updates the handle's lastEventId from the packet BEFORE it
        // delivers the value, so the id read here labels this very value.
        onData: (value) => onData?.(value, handle.lastEventId),
        onError,
        onEnd,
      });
      return handle;
    },

    // A WrpcReadable is async-iterable; the engine reads the NDJSON page from it.
    stream: (id) => client.getStream(id),

    // A fire-and-forget event to the host: presence.
    send: (event, data) => client.sendEvent(target(event), data),
    on: (event, listener) => {
      if (event.startsWith(`${unit}/`) && typeof client.api?.[unit]?.on === 'function') {
        client.api[unit].on(event.slice(unit.length + 1), listener);
      } else client.on(event, listener);
    },
    off: (event, listener) => {
      if (event.startsWith(`${unit}/`) && typeof client.api?.[unit]?.off === 'function') {
        client.api[unit].off(event.slice(unit.length + 1), listener);
      } else client.off(event, listener);
    },
    close: () => client.close(),
    // The wrapped client, for callers that need to reach past the contract.
    client,
  };
  return link;
};

module.exports = { createWrpcLink, isSyncLink, SYNC_INTROSPECTION };
