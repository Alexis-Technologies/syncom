'use strict';

// An in-process SyncLink over a host's `unit()` — what the engine's tests, and an application's, run on instead of a
// socket. It mimics what wrpc does at the boundary: arguments and results cross as JSON (no shared references, the
// tracked symbol stripped), `changes` is driven as an async generator with `{ lastEventId, signal }`, a dropped
// connection aborts the generator, and a reconnect re-opens every subscription from the last event id it delivered —
// exactly wrpc's restore — before announcing `reconnect`. Its options are the hazards a transport has: `latency` (ms
// on every call and event), `drop(page)` (a page lost, and the link down with it: a socket never loses one message
// and carries on), `duplicate(page)` (a page delivered twice), `maxMessage` (a call or a chunk past it takes the link
// down, as a socket closed for a message too big); its hooks `disconnect()` and `reconnect()`. With `streams` it is
// a binary transport too — wrpc's streams in process (`pipe`): the host's client and the link each announce one
// (`createStream`) the other end reads (`getStream`, `stream`), so a snapshot page and a blob cross as bytes.

const { Emitter } = require('../utils.js');

const TRACKED = Symbol.for('wrpc.tracked');
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let nextClientId = 1;

// What a writable holds unread before `write` answers false, in chunks: small, so every write of a few chunks waits
// for a `drain` at least once.
const HIGH = 4;
// What wrpc's `writeAll` writes at a time.
const CHUNK = 64 * 1024;
const closedError = () => Object.assign(new Error('Connection closed'), { code: 503 });

// wrpc's pair of one binary stream, in process: what `write` takes — a copy — the readable's iteration hands on. A
// writable is an emitter (`drain`, `close`) with `closed`, `error`, `write`, `writeAll`, `end()` and `terminate()`;
// a readable is async-iterable with `terminate()`, which stops its writer as wrpc 2.1 does: `closed`, `close`
// announced, `error` with code 499, `write` false. `tooBig(length)` is the link's `maxMessage`: true once it took the
// link down.
const pipe = (id, tooBig) => {
  const queue = [];
  let wake = null;
  let ended = false;
  let cut = false;
  let full = false;
  const wakeUp = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  const drained = () => {
    full = false;
    void writable.emit('drain');
  };
  const writable = Object.assign(new Emitter(), {
    id,
    closed: false,
    error: null,
    write(chunk) {
      if (writable.closed || ended || tooBig(chunk.length)) return false;
      queue.push(new Uint8Array(chunk));
      wakeUp();
      full = queue.length >= HIGH;
      return !full;
    },
    // wrpc's: every byte in pieces, each when the writable takes it; false once it closed or was ended under it.
    async writeAll(bytes, size = CHUNK) {
      for (let at = 0; at < bytes.length; at += size) {
        if (writable.write(bytes.subarray(at, at + size))) continue;
        if (writable.closed || ended) return false;
        await new Promise((resolve) => writable.once('drain', resolve));
        if (writable.closed) return false;
      }
      return true;
    },
    end() {
      ended = true;
      wakeUp();
    },
    terminate() {
      ended = true;
      queue.length = 0;
      wakeUp();
    },
    // The connection went: nothing more is taken, and a writer waiting for `drain` is let go.
    close() {
      if (writable.closed) return;
      writable.closed = true;
      queue.length = 0;
      wakeUp();
      drained();
      void writable.emit('close');
    },
    // Its reader let go (wrpc's cancel): the writer stops as for a lost connection, `error` saying why — unless it
    // had sent everything already.
    cancel() {
      if (writable.closed || ended) return;
      writable.error = Object.assign(new Error(`Stream ${id} is no longer read`), { code: 499 });
      writable.close();
    },
  });
  const readable = {
    id,
    terminate() {
      cut = true;
      queue.length = 0;
      wakeUp();
      writable.cancel();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (cut) return;
        if (queue.length > 0) {
          const chunk = queue.shift();
          if (full && queue.length < HIGH) drained();
          yield chunk;
        } else if (ended || writable.closed) return;
        else await new Promise((resolve) => void (wake = resolve));
      }
    },
  };
  return { writable, readable };
};

class MemoryLink extends Emitter {
  #unit;
  #subscriptions = new Set();
  #down = false;
  #options;
  // The streams announced and not read yet, by id: the link's (read by the host) and the host's (read by the link).
  #up = new Map();
  #streams = new Map();
  #pipes = new Set();
  #nextStream = 1;
  /** The methods called, in order. */
  calls = [];
  /** The events sent, in order. */
  sent = [];

  constructor(unit, options = {}) {
    super();
    this.#unit = unit;
    this.#options = options;
    // What wrpc's `context.client` looks like from a handler's point of view: an emitter too, whose `close` the
    // host hears when the socket goes (a session let go of with its connection).
    this.client = Object.assign(new Emitter(), {
      id: `c${nextClientId++}`,
      data: {},
      binary: false,
      rooms: new Set(),
      join: (room) => void this.client.rooms.add(room),
    });
    // The host's server (mesh.js): rooms and `sendTo` over the links of one host, so a handler's relay reaches the
    // other links.
    this.context = { client: this.client, server: options.server ?? null };
    options.server?.links.add(this);
    if (options.streams !== true) return;
    // A binary transport: what wrpc's `client.createStream`/`getStream` are on either end.
    this.client.binary = true;
    this.client.createStream = () => this.#announce(this.#streams);
    this.client.getStream = (id) => this.#take(this.#up, id);
    this.stream = (id) => this.#take(this.#streams, id);
    this.createStream = () => this.#announce(this.#up);
  }

  // A stream announced on one end: its writable handed back, its readable kept for the other end by id.
  #announce(readers) {
    if (this.#down) throw closedError();
    const { writable, readable } = pipe(`s${this.#nextStream++}`, (length) => this.#tooBig(length));
    this.#pipes.add(writable);
    readers.set(writable.id, readable);
    return writable;
  }

  #take(readers, id) {
    const readable = readers.get(id);
    if (readable === undefined) throw new Error(`Stream ${id} is not initialized`);
    readers.delete(id);
    return readable;
  }

  // `maxMessage`: what a socket does with a message past its limit — it closes.
  #tooBig(length) {
    const { maxMessage } = this.#options;
    if (maxMessage === undefined || length <= maxMessage) return false;
    this.disconnect();
    return true;
  }

  // The streams go with the socket: every writer told (`close`), every reader's iteration ended.
  #cut() {
    for (const writable of this.#pipes) writable.close();
    this.#pipes.clear();
    this.#up.clear();
    this.#streams.clear();
  }

  /** Whether the socket is down. */
  get down() {
    return this.#down;
  }

  /** A fire-and-forget event to the host: the unit's `on` handler, as wrpc would call it. */
  send(event, data) {
    if (this.#down) throw closedError();
    const name = event.split('/')[1];
    const handler = this.#unit.on?.[name]?.handler;
    if (!handler) throw Object.assign(new Error(`Unknown event ${event}`), { code: 404 });
    this.sent.push(event);
    const delay = this.#options.latency ? sleep(this.#options.latency) : null;
    Promise.resolve(delay)
      .then(() => handler(this.context, clone(data)))
      .catch(() => {});
  }

  /** The host's event to this client — what wrpc's `client.api.syncom.on` hears. */
  deliver(event, data) {
    if (this.#down) return;
    void this.emit(event, clone(data));
  }

  async call(method, args) {
    if (this.#down) throw closedError();
    const name = method.split('/')[1];
    const procedure = this.#unit[name];
    if (!procedure) throw Object.assign(new Error(`Unknown method ${method}`), { code: 404 });
    this.calls.push(method);
    const { maxMessage } = this.#options;
    if (maxMessage !== undefined && this.#tooBig(JSON.stringify(args ?? null).length)) throw closedError();
    if (this.#options.latency) await sleep(this.#options.latency);
    let answer = undefined;
    try {
      answer = clone(await procedure.handler(this.context, clone(args)));
    } catch (error) {
      // The socket went while the host worked: its refusal has nowhere to go, as its answer has not.
      throw this.#down ? closedError() : error;
    }
    if (this.#down) throw closedError();
    return answer;
  }

  subscribe(method, args, handlers) {
    const record = { method, args: clone(args), handlers, lastEventId: handlers.lastEventId, controller: null };
    this.#subscriptions.add(record);
    this.#open(record);
    return {
      get lastEventId() {
        return record.lastEventId;
      },
      unsubscribe: () => {
        this.#subscriptions.delete(record);
        record.controller?.abort();
      },
    };
  }

  #open(record) {
    const controller = new AbortController();
    record.controller = controller;
    const name = record.method.split('/')[1];
    const procedure = this.#unit[name];
    const { onData, onError, onEnd } = record.handlers;
    const run = async () => {
      const iterator = procedure.handler(this.context, clone(record.args), {
        lastEventId: record.lastEventId,
        signal: controller.signal,
      });
      for await (const value of iterator) {
        if (controller.signal.aborted) break;
        const isTracked = value && typeof value === 'object' && value[TRACKED] === true;
        const eventId = isTracked ? value.id : undefined;
        const data = clone(isTracked ? value.data : value);
        // A page lost: the socket died with it — nothing after it arrives until `reconnect()`, which resumes from the
        // last page delivered, as wrpc's restore does.
        if (this.#options.drop?.(data)) return void this.disconnect();
        await onData?.(data, eventId);
        if (eventId !== undefined) record.lastEventId = eventId;
        // A page delivered twice, as a flaky transport might: the engine must take the second as the duplicate it is.
        if (this.#options.duplicate?.(data)) await onData?.(clone(data), eventId);
      }
      if (!controller.signal.aborted) {
        this.#subscriptions.delete(record);
        onEnd?.();
      }
    };
    run().catch((error) => {
      if (controller.signal.aborted) return;
      this.#subscriptions.delete(record);
      onError?.(error);
    });
  }

  // --- the hazards -------------------------------------------------------

  /** The socket died: live feeds stop, calls fail, `close` is announced — the host's client hears it too. */
  disconnect() {
    this.#down = true;
    this.#cut();
    for (const record of this.#subscriptions) record.controller?.abort();
    void this.client.emit('close');
    void this.emit('close');
  }

  /**
   * wrpc's reconnect: a NEW server-side client (its `data` bag is empty, so the host has to be greeted again), every
   * subscription re-opened from the last event id it delivered, then `reconnect` announced.
   */
  async reconnect({ freshClient = true } = {}) {
    this.#down = false;
    if (freshClient) this.client.data = {};
    const records = [];
    for (const record of this.#subscriptions) records.push(record);
    for (let i = 0; i < records.length; i++) this.#open(records[i]);
    await this.emit('open');
    await this.emit('reconnect');
  }

  close() {
    this.#down = true;
    this.#cut();
    for (const record of this.#subscriptions) record.controller?.abort();
    this.#subscriptions.clear();
    void this.client.emit('close');
  }
}

module.exports = { MemoryLink };
