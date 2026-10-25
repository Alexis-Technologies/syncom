'use strict';

// The @alexify/syncom/search subpath: the trigram index behind `$text` — the
// TextIndex contract (`put`, `remove`, `query`) the catalog feeds a record's
// searchable text to. Fuzzy by construction: a word and a typo of it share
// most of their trigrams. Ranking is TF-IDF over trigrams, normalized by the
// record's length. Postings live in memory only — the catalog persists the
// text and replays every row at open. No requires: platform-neutral, and off
// the main entry, so a node that never searches ships none of it.
//
// Normalization: NFD, combining marks stripped (`Crème` → `Creme`), lower
// case, anything that is not a letter or a digit a word break. Trigrams: per
// word, padded with a space on both sides, a window of three — `quick` →
// ` qu`, `qui`, `uic`, `ick`, `ck ` — so a word's start and end are trigrams
// too, and an exact word outranks a substring of a longer one.
//
// The score of a record for a query: the sum, over the trigrams they share,
// of qtf · tf · idf, divided by the square root of the record's trigram
// count, with idf = ln(1 + N/df) — never zero, so a store of one record
// finds it. A record matches when it holds at least `minOverlap` of the
// query's distinct trigrams (0.3 by default: a typo at the end of a
// five-letter word keeps two of its five; one in the middle, which touches
// three trigrams, keeps fewer — raise or lower it per corpus).

const MARKS = /\p{M}+/gu;
const WORD_BREAK = /[^\p{L}\p{N}]+/gu;

const normalize = (text) => {
  if (text === null || text === undefined) return '';
  return String(text).normalize('NFD').replace(MARKS, '').toLowerCase().replace(WORD_BREAK, ' ').trim();
};

const trigrams = (text) => {
  const grams = [];
  const words = normalize(text).split(' ');
  for (let w = 0; w < words.length; w++) {
    const word = words[w];
    if (word.length === 0) continue;
    const padded = ` ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) grams.push(padded.slice(i, i + 3));
  }
  return grams;
};

// Trigram → how many times, over one text.
const countOf = (grams) => {
  const counts = new Map();
  for (let i = 0; i < grams.length; i++) counts.set(grams[i], (counts.get(grams[i]) ?? 0) + 1);
  return counts;
};

// Best first; ties by id, so two nodes rank one corpus alike.
const compareHits = (a, b) => {
  if (a.score !== b.score) return b.score - a.score;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
};

class TrigramIndex {
  // gram → Map<id, tf>
  #postings = new Map();
  // id → { grams (distinct), length (all) }
  #docs = new Map();
  #minOverlap;

  constructor(minOverlap) {
    this.#minOverlap = minOverlap;
  }

  /** Records indexed. */
  get size() {
    return this.#docs.size;
  }

  put(id, text) {
    this.remove(id);
    const grams = trigrams(text);
    if (grams.length === 0) return;
    const counts = countOf(grams);
    for (const entry of counts) {
      let ids = this.#postings.get(entry[0]);
      if (!ids) this.#postings.set(entry[0], (ids = new Map()));
      ids.set(id, entry[1]);
    }
    this.#docs.set(id, { grams: [...counts.keys()], length: grams.length });
  }

  remove(id) {
    const doc = this.#docs.get(id);
    if (!doc) return;
    for (let i = 0; i < doc.grams.length; i++) {
      const ids = this.#postings.get(doc.grams[i]);
      ids.delete(id);
      if (ids.size === 0) this.#postings.delete(doc.grams[i]);
    }
    this.#docs.delete(id);
  }

  query(text) {
    const counts = countOf(trigrams(text));
    const hits = new Map();
    const total = this.#docs.size;
    for (const entry of counts) {
      const ids = this.#postings.get(entry[0]);
      if (!ids) continue;
      const idf = Math.log(1 + total / ids.size);
      for (const posting of ids) {
        let hit = hits.get(posting[0]);
        if (!hit) hits.set(posting[0], (hit = { score: 0, shared: 0 }));
        hit.score += entry[1] * posting[1] * idf;
        hit.shared++;
      }
    }
    const needed = counts.size * this.#minOverlap;
    const results = [];
    for (const hit of hits) {
      if (hit[1].shared < needed) continue;
      results.push({ id: hit[0], score: hit[1].score / Math.sqrt(this.#docs.get(hit[0]).length) });
    }
    results.sort(compareHits);
    return results;
  }
}

/** For `open({ search })`: a fresh trigram index per searchable entity. */
const createSearch = ({ minOverlap = 0.3 } = {}) => {
  if (typeof minOverlap !== 'number' || !(minOverlap >= 0 && minOverlap <= 1)) {
    throw new TypeError('createSearch({ minOverlap }): minOverlap must be a number between 0 and 1');
  }
  return () => new TrigramIndex(minOverlap);
};

module.exports = { createSearch, normalize, trigrams };
