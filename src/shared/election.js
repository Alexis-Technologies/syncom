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
// yields (`onLost`). The election is re-armable: `onLead` fires at EVERY
// grant, `yield()` lets the lock (or the lead) go and `request()` asks for
// it again — an instance that could not open as the leader steps aside and
// comes back. Two leaders at once never write at once: the database's own
// lock is the last word, and a claimant it refuses tries again. A
// `follower` never leads (a tab beside a SharedWorker that does). No requires.

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
 * `{ leader, token, mode, onLead, onLost, yield, request, release }`: `onLead(listener)` is called at every
 * grant (answers the off), `leader` is whether this instance leads now, `mode` is `'locks'`, `'heartbeat'`,
 * `'follower'` (never leads) or `'alone'` (neither given: this instance leads at once — one process, one
 * instance); `yield()` steps aside, `request()` asks again, `release()` leaves for good.
 */
const elect = ({
  name,
  locks = null,
  channel = null,
  follower = false,
  heartbeat = DEFAULT_HEARTBEAT,
  misses = DEFAULT_MISSES,
  token = randomToken(),
} = {}) => {
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('elect(): name is required');
  if (!Number.isFinite(heartbeat) || heartbeat <= 0) {
    throw new TypeError('elect(): heartbeat must be a positive number');
  }
  if (!Number.isInteger(misses) || misses < 1) throw new TypeError('elect(): misses must be a positive integer');
  if (typeof follower !== 'boolean') throw new TypeError('elect(): follower must be a boolean');
  let leader = false;
  let released = false;
  const leads = new Set();
  const lost = new Set();
  const granted = () => {
    leader = true;
    for (const listener of leads) listener();
  };
  const taken = () => {
    leader = false;
    for (const listener of lost) listener();
  };
  const result = {
    token,
    mode: 'alone',
    get leader() {
      return leader;
    },
    onLead(listener) {
      leads.add(listener);
      return () => leads.delete(listener);
    },
    onLost(listener) {
      lost.add(listener);
      return () => lost.delete(listener);
    },
    yield() {
      leader = false;
    },
    request() {
      if (!released && !leader) granted();
    },
    release() {
      released = true;
      leader = false;
    },
  };

  if (follower) {
    result.mode = 'follower';
    result.request = () => {};
    return result;
  }

  if (locks !== null && typeof locks?.request === 'function') {
    result.mode = 'locks';
    // `wanted`: whether a grant is to be kept when it comes; `pending`: a request in flight; `free` lets the held
    // grant go. A yield before the grant lets the lock go the moment it is granted.
    let wanted = false;
    let pending = false;
    let free = null;
    const request = () => {
      wanted = true;
      if (released || pending || leader) return;
      pending = true;
      const held = new Promise((resolve) => {
        free = resolve;
      });
      locks
        .request(name, { mode: 'exclusive' }, () => {
          pending = false;
          if (released || !wanted) return undefined;
          granted();
          return held;
        })
        .catch(() => {
          // The request was aborted — the lock stolen from under a holder: a loss, said; before a grant, nothing.
          pending = false;
          if (leader) taken();
        });
    };
    result.yield = () => {
      wanted = false;
      if (leader) {
        leader = false;
        free?.();
      }
    };
    result.request = request;
    result.release = () => {
      released = true;
      wanted = false;
      leader = false;
      free?.();
    };
    request();
    return result;
  }

  if (channel !== null && typeof channel?.postMessage === 'function') {
    result.mode = 'heartbeat';
    let lastLead = 0;
    let rival = false;
    let suspended = false;
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
        // Two leaders — the smaller token stays; this one yields, and claims again once the other goes quiet.
        if (leader && message.token < token) taken();
      } else if (message.t === 'claim') {
        if (leader) say('lead');
        else if (message.token < token) rival = true;
      } else if (message.t === 'bye') {
        // The leader left: a claim round — every candidate says so, and the smallest token leads at the next beat.
        lastLead = 0;
        if (!leader && !suspended) say('claim');
      }
    };
    const unlisten = listen(channel, hear);
    const tick = () => {
      if (released) return;
      if (leader) return void say('lead');
      if (!suspended && Date.now() - lastLead >= misses * heartbeat && !rival) {
        say('lead');
        granted();
      }
      rival = false;
    };
    say('claim');
    lastLead = Date.now() - (misses - 1) * heartbeat;
    const timer = setInterval(tick, heartbeat);
    result.yield = () => {
      suspended = true;
      if (leader) {
        leader = false;
        say('bye');
      }
    };
    result.request = () => {
      if (released || leader) return;
      suspended = false;
      lastLead = Date.now();
      say('claim');
    };
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
  return result;
};

module.exports = { elect, DEFAULT_HEARTBEAT, DEFAULT_MISSES };
