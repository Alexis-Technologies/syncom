'use strict';

// Reserved: the contract of a log shared by several hub processes — what a
// broker-backed hub mode takes after v1, where every hub appends the ops it
// accepts to one stream and serves `changes` from it, so a peer can resume
// on any hub. It is structurally wrpc's `BrokerLog` (`append`, `read`,
// `parseId`), so a broker's `.log` — memory, Redis, NATS, Kafka — fits with
// no adapter. Nothing consumes it yet: `open({ sync: { sharedLog } })` is
// refused, and this check is what the option will run. No requires.

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
