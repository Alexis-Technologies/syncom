'use strict';

const defaultFsi = require('./fsi.js');
const { calculateHash } = require('./crypto.js');
const { checkFsi } = require('./backend.js');

const BLOCKCHAIN = '.blockchain.json';

class Blockchain {
  #fsi;

  constructor(basePath, { fsi = defaultFsi } = {}) {
    this.path = basePath;
    this.tailHash = null;
    this.#fsi = checkFsi(fsi, 'Blockchain');
    return this.#init();
  }

  async #init() {
    const exists = await this.#fsi.exists(this.path, BLOCKCHAIN);
    if (!exists) {
      const block = { prev: '0', timestamp: Date.now(), data: {} };
      this.tailHash = await this.writeBlock(block);
      await this.writeChain();
    } else {
      const raw = await this.#fsi.read(this.path, BLOCKCHAIN);
      let chain;
      try {
        chain = JSON.parse(raw);
      } catch (error) {
        const corrupt = new Error(`${BLOCKCHAIN} is unreadable (${error.message}); restore it or remove the directory`);
        throw Object.assign(corrupt, { code: 'CORRUPT', cause: error });
      }
      this.tailHash = chain.tailHash;
    }
    return this;
  }

  async writeChain() {
    const chain = { tailHash: this.tailHash };
    await this.#fsi.write(this.path, BLOCKCHAIN, JSON.stringify(chain));
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
    const hash = await calculateHash(block);
    await this.#fsi.write(this.path, `${hash}.json`, JSON.stringify(block));
    return hash;
  }

  async readBlock(hash) {
    const exists = await this.#fsi.exists(this.path, `${hash}.json`);
    if (!exists) throw new Error(`Block not found: ${hash}`);
    const raw = await this.#fsi.read(this.path, `${hash}.json`);
    return JSON.parse(raw);
  }

  async validate({ last, from } = {}) {
    let currentHash = from || this.tailHash;
    if (!currentHash) return false;
    let count = 0;
    while (currentHash) {
      // An unknown `from` (or a dangling `prev`) is an invalid chain, not an
      // exception: validate() answers a boolean for every input.
      const known = await this.#fsi.exists(this.path, `${currentHash}.json`);
      if (!known) return false;
      const block = await this.readBlock(currentHash);
      const expectedHash = await calculateHash(block);
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

module.exports = { Blockchain };
