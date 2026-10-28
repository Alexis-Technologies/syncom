'use strict';

// The nodes a storage dials, on disk: one `remote/<url>.json` per node (its
// url, token, scopes, whether enabled, the cursor of its feed, what its
// hello said), over the storage's own backend. A file is rewritten on every
// page received; one torn by a crash is reported and skipped at the load,
// never fatal to the open. Writes are coalesced AND serialized per node: a
// save that comes while one is pending shares it, one that comes while a
// write is in flight runs after it — two writes to one file interleaving is
// how a reopen read half a JSON document. No requires.

const REMOTE = 'remote';

const fileName = (url) => `${encodeURIComponent(url)}.json`;

class NodeRegistry {
  #fsi;
  #path;
  #logger;
  #saving = new Map();

  constructor(fsi, storagePath, logger) {
    this.#fsi = fsi;
    this.#path = `${storagePath}/${REMOTE}`;
    this.#logger = logger;
  }

  /** Every node the directory names, by url. */
  async load() {
    const nodes = new Map();
    for (const file of await this.#fsi.list(this.#path)) {
      if (!file.endsWith('.json')) continue;
      let node = null;
      try {
        node = JSON.parse(await this.#fsi.read(this.#path, file));
      } catch (error) {
        this.#logger.warn({ event: 'sync.node.unreadable', file, err: error });
        continue;
      }
      if (node && typeof node.url === 'string') nodes.set(node.url, node);
    }
    return nodes;
  }

  /** Writes a node's file at once (a new node). */
  write(node) {
    return this.#fsi.write(this.#path, fileName(node.url), JSON.stringify(node), { atomic: true });
  }

  /** Removes a node's file. */
  remove(url) {
    return this.#fsi.remove(this.#path, fileName(url));
  }

  /**
   * Saves a node's file, coalesced and serialized per node; `held(url)`
   * says whether the node is still registered when the write runs.
   */
  save(node, held) {
    const { url } = node;
    let state = this.#saving.get(url);
    if (!state) {
      state = { last: Promise.resolve(), next: null };
      this.#saving.set(url, state);
    }
    if (state.next) return state.next;
    const write = state.last.then(async () => {
      state.next = null;
      if (!held(url)) return;
      await this.write(node);
    });
    state.next = write;
    state.last = write
      .catch(() => {})
      .then(() => {
        if (state.next === null) this.#saving.delete(url);
      });
    return write;
  }

  /** Resolves once every save in flight is done. */
  async drain() {
    const writes = [];
    for (const state of this.#saving.values()) writes.push(state.last);
    await Promise.all(writes);
  }
}

module.exports = { NodeRegistry, REMOTE };
