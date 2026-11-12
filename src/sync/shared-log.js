'use strict';

// The contract of a log shared by several hub processes (`createDatabase({
// sync: { sharedLog } })`, src/sync/shared.js): every hub appends the ops it
// accepts to one stream and serves `changes` from it, so a peer can resume on
// any hub. It is structurally wrpc's `BrokerLog` (`append`, `read`, `parseId`),
// so a broker's `.log` — memory, Redis, NATS, Kafka — fits with no adapter. A
// read yields `{ id, value, headers }` in order; a log may yield a HOLE — an id
// whose entry never came, `value: null` with `headers.hole` — which a consumer
// tells and passes, never a gap it skips in silence (`mongoSharedLog` does). A
// log may have `trimBefore(topic, id)`: a writer trims the inbox past what it
// landed. No requires.

const METHODS = ['append', 'read', 'parseId'];

/** Whether `value` has the three functions of the shared-log contract. */
const isSharedLog = (value) => {
  if (typeof value !== 'object' || value === null) return false;
  for (let i = 0; i < METHODS.length; i++) {
    if (typeof value[METHODS[i]] !== 'function') return false;
  }
  return true;
};

module.exports = { isSharedLog };
