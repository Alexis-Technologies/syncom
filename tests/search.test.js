'use strict';

// The trigram index on its own: normalization, the trigrams, what ranks
// above what, and the factory.

const test = require('node:test');
const assert = require('node:assert');
const { createSearch, normalize, trigrams } = require('../search.js');

const ids = (hits) => hits.map((hit) => hit.id);

test('search: normalize and trigrams', async (t) => {
  await t.test('normalize: marks off, lower case, letters and digits only, one space between words', () => {
    assert.strictEqual(normalize('  Crème Brûlée — über-QUICK, fox!  '), 'creme brulee uber quick fox');
    assert.strictEqual(normalize('北京 东京'), '北京 东京');
    assert.strictEqual(normalize('a\tb\n\nc'), 'a b c');
    assert.strictEqual(normalize(42), '42');
    assert.strictEqual(normalize(''), '');
    assert.strictEqual(normalize(null), '');
    assert.strictEqual(normalize(undefined), '');
    assert.strictEqual(normalize('---'), '');
  });

  await t.test('trigrams: per word, padded, three wide', () => {
    assert.deepStrictEqual(trigrams('quick fox'), [' qu', 'qui', 'uic', 'ick', 'ck ', ' fo', 'fox', 'ox ']);
    assert.deepStrictEqual(trigrams('qiuck'), [' qi', 'qiu', 'iuc', 'uck', 'ck ']);
    assert.deepStrictEqual(trigrams('a'), [' a ']);
    assert.deepStrictEqual(trigrams('ab'), [' ab', 'ab ']);
    assert.deepStrictEqual(trigrams(''), []);
    assert.deepStrictEqual(trigrams(' . '), []);
    assert.deepStrictEqual(trigrams('Crème'), trigrams('creme'));
  });
});

test('search: the index', async (t) => {
  await t.test('put, replace, remove, size; a fresh array every query', () => {
    const index = createSearch()('Post');
    assert.strictEqual(index.size, 0);
    index.put('a', 'quick fox');
    index.put('b', 'lazy dog');
    assert.strictEqual(index.size, 2);
    assert.deepStrictEqual(ids(index.query('quick')), ['a']);
    index.put('a', 'slow turtle');
    assert.deepStrictEqual(ids(index.query('quick')), [], 'a put replaces: the old trigrams are gone');
    assert.deepStrictEqual(ids(index.query('turtle')), ['a']);
    index.remove('nope');
    index.remove('a');
    assert.strictEqual(index.size, 1);
    assert.deepStrictEqual(ids(index.query('turtle')), []);
    index.put('c', '   ');
    assert.strictEqual(index.size, 1, 'nothing to index is not indexed');
    const first = index.query('dog');
    first.length = 0;
    assert.strictEqual(index.query('dog').length, 1);
    assert.deepStrictEqual(index.query(''), []);
    assert.deepStrictEqual(index.query('...'), []);
    assert.deepStrictEqual(index.query('zzz'), []);
  });

  await t.test('ranking: exact over substring, rare over common, short over long, typos tolerated', () => {
    const index = createSearch()('Post');
    index.put('exact', 'fox');
    index.put('longer', 'foxglove');
    assert.deepStrictEqual(ids(index.query('fox')), ['exact', 'longer']);
    const rare = createSearch()('Post');
    for (let i = 0; i < 5; i++) rare.put(`common${i}`, 'alpha beta');
    rare.put('rare', 'alpha zeta');
    assert.strictEqual(ids(rare.query('zeta'))[0], 'rare');
    assert.strictEqual(ids(rare.query('alpha beta zeta'))[0], 'rare', 'the rare word weighs more');
    const length = createSearch()('Post');
    length.put('short', 'quick fox');
    length.put('long', 'quick fox jumps over the lazy dog again and again');
    assert.deepStrictEqual(ids(length.query('quick fox')), ['short', 'long']);
    const typo = createSearch()('Post');
    typo.put('a', 'quick fox');
    assert.deepStrictEqual(ids(typo.query('quikc')), ['a'], 'a typo at the end keeps 2 of 5 trigrams');
    assert.deepStrictEqual(ids(typo.query('quack')), ['a'], 'a substitution keeps 2 of 5');
    assert.deepStrictEqual(ids(typo.query('qiuck')), [], 'a transposition in the middle keeps 1 of 5: below 0.3');
    const strict = createSearch({ minOverlap: 1 })('Post');
    strict.put('a', 'quick fox');
    assert.deepStrictEqual(ids(strict.query('quikc')), []);
    assert.deepStrictEqual(ids(strict.query('quick')), ['a']);
    const loose = createSearch({ minOverlap: 0 })('Post');
    loose.put('a', 'quick fox');
    assert.deepStrictEqual(ids(loose.query('brick')), ['a'], 'one shared trigram is enough at 0');
    // Ties break by id; a one-record store finds its record (idf never zero).
    const ties = createSearch()('Post');
    ties.put('b', 'same words');
    ties.put('a', 'same words');
    assert.deepStrictEqual(ids(ties.query('same')), ['a', 'b']);
    const one = createSearch()('Post');
    one.put('only', 'hello world');
    assert.deepStrictEqual(ids(one.query('hello')), ['only']);
    assert.ok(one.query('hello')[0].score > 0);
  });

  await t.test('createSearch: a fresh index per call, the option checked', () => {
    const factory = createSearch();
    const posts = factory('Post');
    const tags = factory('Tag');
    posts.put('p', 'alpha');
    assert.deepStrictEqual(tags.query('alpha'), [], 'independent indexes');
    assert.throws(() => createSearch({ minOverlap: 'high' }), {
      name: 'TypeError',
      message: 'createSearch({ minOverlap }): minOverlap must be a number between 0 and 1',
    });
    assert.throws(() => createSearch({ minOverlap: 2 }), TypeError);
    assert.throws(() => createSearch({ minOverlap: -0.1 }), TypeError);
    assert.throws(() => createSearch({ minOverlap: NaN }), TypeError);
  });
});
