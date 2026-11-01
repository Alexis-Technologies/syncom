'use strict';

// The hash-linked chain as a plugin (@alexify/syncom/chain): every applied
// batch — a local write, a peer's page, a replay — appends a block naming
// the hash of each record's data after it, and a record file is checked
// against its block on a cold read (`integrity: 'verify'`); `validate()`
// walks the chain. Blocks are SHA-256 of their JSON (../digest.js:
// node:crypto, Web Crypto in the browser); each node's chain is its own audit, not
// shared. `createDatabase({ chain: false })` keeps the plugin registered and the
// chain off — a hub that only replicates has nothing to audit and saves two
// file writes per batch.

const defaultFsi = require('../fsi.js');
const { sha256 } = require('../crypto/digest.js');
const { checkFsi } = require('../backend.js');
const { kvNamespace, fsiNamespace } = require('../engine.js');
const { SyncomError } = require('../errors.js');

const BLOCKCHAIN = '.blockchain.json';
const NAMESPACE = 'blockchain';

class Blockchain {
  // The blocks' store: the `blockchain` namespace of a database's kv, or a
  // directory of an fsi for a chain of its own (the smart contracts').
  #store;

  constructor(basePath, { fsi = defaultFsi, kv = null } = {}) {
    this.path = basePath;
    this.tailHash = null;
    this.#store = kv === null ? fsiNamespace(checkFsi(fsi, 'Blockchain'), basePath) : kvNamespace(kv, NAMESPACE);
    return this.#init();
  }

  async #init() {
    const raw = await this.#store.get(BLOCKCHAIN);
    if (raw === null) {
      const block = { prev: '0', timestamp: Date.now(), data: {} };
      this.tailHash = await this.writeBlock(block);
      await this.writeChain();
    } else {
      let chain;
      try {
        chain = JSON.parse(raw);
      } catch (error) {
        const message = `${BLOCKCHAIN} is unreadable (${error.message}); restore it or remove the directory`;
        throw new SyncomError('CORRUPT', message, { cause: error });
      }
      this.tailHash = chain.tailHash;
    }
    return this;
  }

  async writeChain() {
    const chain = { tailHash: this.tailHash };
    await this.#store.put(BLOCKCHAIN, JSON.stringify(chain), { atomic: true });
  }

  async addBlock(data) {
    const prev = this.tailHash;
    const timestamp = Date.now();
    const block = { prev, timestamp, data };
    const hash = await this.writeBlock(block);
    this.tailHash = hash;
    await this.writeChain();
    return hash;
  }

  async writeBlock(block) {
    const hash = await sha256(block);
    await this.#store.put(`${hash}.json`, JSON.stringify(block));
    return hash;
  }

  async readBlock(hash) {
    const raw = await this.#store.get(`${hash}.json`);
    if (raw === null) throw new SyncomError('BLOCK_NOT_FOUND', `Block not found: ${hash}`, { hash });
    return JSON.parse(raw);
  }

  async validate({ last, from } = {}) {
    let currentHash = from || this.tailHash;
    if (!currentHash) return false;
    let count = 0;
    while (currentHash) {
      // An unknown `from` (or a dangling `prev`) is an invalid chain, not an
      // exception: validate() answers a boolean for every input.
      const known = await this.#store.has(`${currentHash}.json`);
      if (!known) return false;
      const block = await this.readBlock(currentHash);
      const expectedHash = await sha256(block);
      const valid = currentHash === expectedHash;
      if (!valid) return false;
      count++;
      if (last && count >= last) break;
      if (block.prev === '0') break;
      currentHash = block.prev;
    }
    return true;
  }
}

/** The chain plugin: `createDatabase({ plugins: [chain] })`; `chain: false` keeps it off. */
const chain = Object.freeze({
  name: 'chain',
  async setup({ db, path, settings }) {
    if (settings.chained === false) return {};
    return { chain: await new Blockchain(`${path}/${NAMESPACE}`, { kv: db.kv }) };
  },
});

module.exports = { chain, Blockchain };
