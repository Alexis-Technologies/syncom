'use strict';

// The diff behind updateText: what it promises is that applying its hunks,
// last first, turns the first string into the second — minimal where it is
// cheap to be, exact always.

const test = require('node:test');
const assert = require('node:assert');
const { diff, patch } = require('../src/myers.js');

test('myers diff', async (t) => {
  await t.test('hunks are splices in the before string, last first', () => {
    assert.deepStrictEqual(diff('hello', 'hallo'), [[1, 1, 'a']]);
    assert.deepStrictEqual(diff('', 'abc'), [[0, 0, 'abc']]);
    assert.deepStrictEqual(diff('abc', ''), [[0, 3, '']]);
    assert.deepStrictEqual(diff('abc', 'abc'), []);
    assert.deepStrictEqual(diff('abc', 'abcd'), [[3, 0, 'd']]);
    assert.deepStrictEqual(diff('abc', 'xabc'), [[0, 0, 'x']]);
    const hunks = diff('the quick brown fox', 'the slow brown dog');
    assert.deepStrictEqual(hunks, [
      [18, 1, 'g'],
      [16, 1, 'd'],
      [4, 5, 'slow'],
    ]);
    for (let i = 1; i < hunks.length; i++) assert.ok(hunks[i][0] <= hunks[i - 1][0], 'last first');
    // Myers' own example.
    assert.strictEqual(patch('abcabba', diff('abcabba', 'cbabac')), 'cbabac');
    assert.strictEqual(
      diff('abcabba', 'cbabac').reduce((n, [, c, t]) => n + c + t.length, 0),
      5,
      'five edits',
    );
  });

  await t.test('applying the hunks gives the second string, over seeded random pairs', () => {
    let seed = 20260924;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const word = () =>
      Array.from({ length: Math.floor(random() * 14) }, () => 'ab \u{1F600}'[Math.floor(random() * 4)]).join('');
    for (let i = 0; i < 2000; i++) {
      const a = word();
      const b = word();
      const hunks = diff(a, b);
      assert.strictEqual(patch(a, hunks), b, `${JSON.stringify(a)} -> ${JSON.stringify(b)}: ${JSON.stringify(hunks)}`);
    }
  });

  await t.test('indices are UTF-16 code units; past max edits one hunk replaces the middle', () => {
    assert.deepStrictEqual(diff('a😀b', 'ab'), [[1, 2, '']], 'the emoji is two units');
    const a = `keep ${'x'.repeat(3000)} keep`;
    const b = `keep ${'y'.repeat(3000)} keep`;
    const hunks = diff(a, b);
    assert.deepStrictEqual(hunks, [[5, 3000, 'y'.repeat(3000)]]);
    assert.strictEqual(patch(a, hunks), b);
    assert.deepStrictEqual(diff('abc', 'xyz', { max: 1 }), [[0, 3, 'xyz']]);
    assert.throws(() => diff('a', 1), TypeError);
  });
});
