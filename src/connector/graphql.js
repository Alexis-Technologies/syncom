'use strict';

// The GraphQL adapter (@alexify/syncom/connector/graphql): the handlers
// `replicate()` takes, over a GraphQL endpoint reached through an injected
// `fetch` — or a `request(query, variables)` of the application's own client.
// A GraphQL schema is the application's: the adapter posts the queries it is
// given and reads their answers through the functions it is given — `pull`
// `{ query, variables(checkpoint, batchSize), read(data) → { documents, checkpoint } }`,
// `push` `{ query, variables(rows), read(data) → conflicts }` — so one adapter
// fits every schema. An answer with `errors` is a failure (the connector
// tries again). The stream is the application's too: `stream(emit)` as
// `replicate()` takes it, over its subscription client. No requires.

const checkSide = (side, value) => {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object') throw new TypeError(`graphql(): ${side} must be an object`);
  if (typeof value.query !== 'string' || value.query.length === 0) {
    throw new TypeError(`graphql(): ${side}.query is required`);
  }
  if (typeof value.variables !== 'function') throw new TypeError(`graphql(): ${side}.variables must be a function`);
  if (typeof value.read !== 'function') throw new TypeError(`graphql(): ${side}.read must be a function`);
  return value;
};

/**
 * `{ pull, push }` for `replicate()`. `url` and `fetch` (the platform's
 * unless given) post `{ query, variables }` as JSON with `headers`; or
 * `request(query, variables)` is the application's client, answering the
 * `data`. `pull.read(data)` answers `{ documents: [{ id, data, deleted }],
 * checkpoint }`, `push.read(data)` the conflicts `[{ id, data, deleted }]`.
 */
const graphql = ({ url, fetch = globalThis.fetch, headers = {}, request = null, pull, push, stream = null } = {}) => {
  if (request === null) {
    if (typeof url !== 'string' || url.length === 0) throw new TypeError('graphql(): url or request is required');
    if (typeof fetch !== 'function') throw new TypeError('graphql(): fetch must be a function');
  } else if (typeof request !== 'function') throw new TypeError('graphql(): request must be a function');
  const pulling = checkSide('pull', pull);
  const pushing = checkSide('push', push);
  if (pulling === null && pushing === null) throw new TypeError('graphql(): a pull, a push, or both');
  if (stream !== null && typeof stream !== 'function') throw new TypeError('graphql(): stream must be a function');

  const post = async (query, variables) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`GraphQL answered ${response.status}`);
    const body = await response.json();
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      const messages = [];
      for (let i = 0; i < body.errors.length; i++) messages.push(body.errors[i]?.message ?? String(body.errors[i]));
      const error = new Error(`GraphQL errors: ${messages.join('; ')}`);
      error.errors = body.errors;
      throw error;
    }
    return body.data;
  };
  const run = request === null ? post : request;

  const handlers = {};
  if (pulling !== null) {
    handlers.pull = {
      handler: async (checkpoint, batchSize) =>
        pulling.read(await run(pulling.query, pulling.variables(checkpoint, batchSize))),
    };
    if (stream !== null) handlers.pull.stream = stream;
  }
  if (pushing !== null) {
    handlers.push = {
      handler: async (rows) => (await pushing.read(await run(pushing.query, pushing.variables(rows)))) ?? [],
    };
  }
  return handlers;
};

module.exports = { graphql };
