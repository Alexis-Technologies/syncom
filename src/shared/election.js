'use strict';

// Who leads among the instances of one database in one browser profile, or
// one process: Web Locks where the platform has them — `locks.request(name,
// { mode: 'exclusive' }, held)` resolves when the lock is granted, and a
// grant outlives nothing but its holder (a tab that dies lets go) — else a
// heartbeat over a BroadcastChannel-shaped `channel` (`postMessage`,
// `addEventListener('message')` or `onmessage`, `close`): a candidate claims
// with its token and waits one beat; a leader says `lead` every `heartbeat`
// ms; a candidate that hears no leader for `misses` beats and no smaller
// claim in its round leads; a leader that hears a lead from a smaller token
// yields (`onLost`). Two leaders at once never write at once: the
// database's own lock is the last word, and a claimant it refuses tries
// again. No requires.

const DEFAULT_HEARTBEAT = 1000;
const DEFAULT_MISSES = 3;

const randomToken = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

const listen = (channel, listener) => {
  if (typeof channel.addEventListener === 'function') {
    channel.addEventListener('message', listener);
    return () => channel.removeEventListener?.('message', listener);
  }
  channel.onmessage = listener;
  return () => {
    if (channel.onmessage === listener) channel.onmessage = null;
  };
};

/**
 * `{ lead, leader, token, mode, onLost, release }`: `lead` resolves when this
 * instance leads (never, if `release()` comes first), `leader` is whether it
 * does now, `mode` is `'locks'`, `'heartbeat'` or `'alone'` (neither given:
 * this instance leads at once — one process, one instance).
 */
const elect = ({
  name,
  locks = null,
  channel = null,
  heartbeat = DEFAULT_HEARTBEAT,
  misses = DEFAULT_MISSES,
  token = randomToken(),
} = {}) => {
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('elect(): name is required');
  if (!Number.isFinite(heartbeat) || heartbeat <= 0) {
    throw new TypeError('elect(): heartbeat must be a positive number');
  }
  if (!Number.isInteger(misses) || misses < 1) throw new TypeError('elect(): misses must be a positive integer');
  let leader = false;
  let released = false;
  let grant;
  const lead = new Promise((resolve) => {
    grant = resolve;
  });
  const lost = new Set();
  const result = {
    token,
    mode: 'alone',
    lead,
    get leader() {
      return leader;
    },
    onLost(listener) {
      lost.add(listener);
      return () => lost.delete(listener);
    },
    release() {
      released = true;
      leader = false;
    },
  };

  if (locks !== null && typeof locks?.request === 'function') {
    result.mode = 'locks';
    let free;
    const held = new Promise((resolve) => {
      free = resolve;
    });
    locks
      .request(name, { mode: 'exclusive' }, () => {
        // Released before it was granted: let go at once.
        if (released) return undefined;
        leader = true;
        grant();
        return held;
      })
      .catch(() => {
        // The request was aborted: this instance never leads.
      });
    result.release = () => {
      released = true;
      leader = false;
      free();
    };
    return result;
  }

  if (channel !== null && typeof channel?.postMessage === 'function') {
    result.mode = 'heartbeat';
    let lastLead = 0;
    let rival = false;
    const say = (t) => {
      try {
        channel.postMessage({ syncom: name, t, token });
      } catch {
        // A closed channel: the next beat tells.
      }
    };
    const hear = (event) => {
      const message = event !== null && typeof event === 'object' && 'data' in event ? event.data : event;
      if (message === null || typeof message !== 'object' || message.syncom !== name || message.token === token) return;
      if (message.t === 'lead') {
        lastLead = Date.now();
        if (leader && message.token < token) {
          // Two leaders — the smaller token stays; this one yields.
          leader = false;
          for (const listener of lost) listener();
        }
      } else if (message.t === 'claim') {
        if (leader) say('lead');
        else if (message.token < token) rival = true;
      } else if (message.t === 'bye') lastLead = 0;
    };
    const unlisten = listen(channel, hear);
    const tick = () => {
      if (released) return;
      if (leader) return void say('lead');
      if (Date.now() - lastLead >= misses * heartbeat && !rival) {
        leader = true;
        say('lead');
        grant();
      }
      rival = false;
    };
    say('claim');
    lastLead = Date.now() - (misses - 1) * heartbeat;
    const timer = setInterval(tick, heartbeat);
    result.release = () => {
      released = true;
      clearInterval(timer);
      if (leader) say('bye');
      leader = false;
      unlisten();
    };
    return result;
  }

  // Nothing to elect with: one instance, the leader.
  leader = true;
  grant();
  return result;
};

module.exports = { elect, DEFAULT_HEARTBEAT, DEFAULT_MISSES };
