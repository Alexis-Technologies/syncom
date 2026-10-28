'use strict';

// The editor binding (src/editor/editor.js) against whichever half the
// caller builds: an editor loaded from the field and kept the same as it
// through local edits and a peer's, two editors on one storage racing
// through STALE and the rebase, two editors on two nodes, a reset that
// reloads, and the pure helpers — the diff between two readings, spans
// and blocks, transforms, selections as tokens, a presence room's cursors.

const { createMesh, settle, waitUntil, prng } = require('../utils/mesh.js');
const { createPresence } = require('../../src/presence/presence.js');
const E = require('../../src/editor/editor.js');

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

// A fake editor: a Quill-shaped document that reports its own edits.
const createEditor = () => {
  let ops = [];
  const listeners = new Set();
  const editor = {
    setContents: (next) => void (ops = E.compose([], next)),
    updateContents: (delta) => void (ops = E.compose(ops, delta)),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getContents: () => ops,
    text: () => ops.map((op) => (typeof op.insert === 'string' ? op.insert : E.EMBED)).join(''),
    edit: (delta) => {
      ops = E.compose(ops, delta);
      for (const listener of listeners) listener(delta);
    },
    type: (index, text, attributes) =>
      editor.edit([
        ...(index > 0 ? [{ retain: index }] : []),
        attributes ? { insert: text, attributes } : { insert: text },
      ]),
    erase: (index, count) => editor.edit([...(index > 0 ? [{ retain: index }] : []), { delete: count }]),
    format: (index, length, attributes) =>
      editor.edit([...(index > 0 ? [{ retain: index }] : []), { retain: length, attributes }]),
  };
  return editor;
};

// Two documents as one canonical delta each, for a comparison.
const canon = (ops) => E.compose([], ops);
const reading = async (storage, id) => canon(E.spansToDelta((await storage.spans(id, 'body')) ?? []));

// Random edits of an editor: inserts, cuts, marks.
const randomEdit = (editor, random, tag) => {
  const length = editor.text().length;
  const roll = random();
  if (length > 0 && roll < 0.3) {
    const index = Math.floor(random() * length);
    editor.erase(index, Math.min(length - index, 1 + Math.floor(random() * 3)));
  } else if (length > 0 && roll < 0.45) {
    const index = Math.floor(random() * length);
    editor.format(index, Math.min(length - index, 1 + Math.floor(random() * 4)), {
      bold: random() < 0.5 ? true : null,
    });
  } else {
    const index = Math.floor(random() * (length + 1));
    editor.type(index, `${tag}${Math.floor(random() * 10)}`);
  }
};

const runEditorTests = async (t, assert, createStorage) => {
  await t.test(
    'a bound editor loads the field, sends its edits and takes the storage’s, embeds and marks included',
    async (t2) => {
      const storage = await createStorage(t2, 'A');
      const id = await storage.insert({ title: 'x' });
      await storage.updateText(id, 'body', 'hello world');
      await storage.mark(id, 'body', 0, 5, 'bold', true);
      await storage.insertEmbed(id, 'body', 6, { type: 'image', attrs: { src: 'a.png' } });
      const editor = createEditor();
      const binding = E.createTextBinding(storage, id, 'body', editor);
      t2.after(() => binding.stop());
      await binding.ready;
      assert.deepStrictEqual(canon(editor.getContents()), await reading(storage, id));
      assert.strictEqual(binding.shadow, `hello ${E.EMBED}world`);
      // Local edits, one transaction each, land as the editor holds them.
      editor.type(5, ',');
      editor.erase(0, 1);
      editor.format(0, 4, { italic: true });
      assert.strictEqual(binding.pending, true);
      await binding.flush();
      assert.strictEqual(binding.pending, false);
      assert.strictEqual((await storage.get(id)).body, `ello, ${E.EMBED}world`);
      assert.deepStrictEqual(canon(editor.getContents()), await reading(storage, id));
      assert.strictEqual(binding.shadow, editor.text());
      // The storage's own edits — a peer's, as far as the binding knows — reach the editor.
      await storage.splice(id, 'body', 0, 0, 'H');
      await storage.unmark(id, 'body', 0, 5, 'italic');
      await storage.updateBlock(id, 'body', 7, { type: 'image', attrs: { src: 'b.png' }, isEmbed: true });
      await waitUntil(async () => editor.text() === `Hello, ${E.EMBED}world` && binding.shadow === editor.text());
      await tick();
      assert.deepStrictEqual(canon(editor.getContents()), await reading(storage, id));
      assert.deepStrictEqual(
        E.deltaToSpans(editor.getContents()).find((span) => span.type === 'embed'),
        {
          type: 'embed',
          value: { type: 'image', parents: [], attrs: { src: 'b.png' }, isEmbed: true },
          marks: {},
        },
      );
      // Stopped: nothing more crosses either way.
      binding.stop();
      editor.type(0, 'zzz');
      await storage.splice(id, 'body', 0, 1);
      await tick();
      assert.strictEqual((await storage.get(id)).body, `ello, ${E.EMBED}world`);
      assert.strictEqual(editor.text(), `zzzHello, ${E.EMBED}world`);
      // Arguments.
      assert.throws(() => E.createTextBinding(storage, id, 'body', {}), TypeError);
      assert.throws(() => E.createTextBinding({}, id, 'body', editor), TypeError);
      assert.throws(() => E.createTextBinding(storage, 5, 'body', editor), TypeError);
    },
  );

  await t.test(
    'a send goes with the revision the last one handed back, sparing the text compare; a peer’s edit sends the next without',
    async (t2) => {
      const storage = await createStorage(t2, 'A');
      const id = await storage.insert({});
      await storage.updateText(id, 'body', 'base');
      // Every send's options, in order; a peer types between two of them once asked to.
      const sent = [];
      let peer = null;
      const spying = new Proxy(storage, {
        get: (target, name) => {
          if (name === 'applyDelta') {
            return async (...args) => {
              sent.push(args[3]);
              if (peer !== null) {
                const text = peer;
                peer = null;
                await target.splice(id, 'body', 0, 0, text);
              }
              return target.applyDelta(...args);
            };
          }
          const value = target[name];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const editor = createEditor();
      const binding = E.createTextBinding(spying, id, 'body', editor);
      t2.after(() => binding.stop());
      await binding.ready;
      for (const letter of 'abc') {
        editor.type(editor.text().length, letter);
        await binding.flush();
      }
      assert.strictEqual(sent.length, 3);
      for (let i = 0; i < 3; i++) assert.ok(Number.isSafeInteger(sent[i].revision), `send ${i} with a revision`);
      assert.notStrictEqual(sent[1].revision, sent[2].revision, 'each the revision its predecessor left');
      // A peer's edit lands before the next send's turn: the revision it carries is stale, the text
      // is compared (STALE), the delta rebased and sent again without one, then with one again.
      peer = '>';
      editor.type(editor.text().length, 'd');
      await binding.flush();
      await waitUntil(() => editor.text() === '>baseabcd');
      editor.type(editor.text().length, 'e');
      await binding.flush();
      assert.strictEqual((await storage.get(id)).body, '>baseabcde');
      const after = sent.slice(3);
      assert.ok(
        after.some((options) => options.revision === undefined),
        'a send after the peer’s edit compares the text',
      );
      assert.ok(Number.isSafeInteger(after[after.length - 1].revision), 'and the one after it has a revision again');
      assert.strictEqual(binding.shadow, '>baseabcde');
    },
  );

  await t.test(
    'two editors on one storage converge: an edit landing while another is in flight leaves the first STALE, rebased and sent again, nothing lost',
    async (t2) => {
      const storage = await createStorage(t2, 'A');
      const id = await storage.insert({});
      const a = createEditor();
      const b = createEditor();
      const resets = [];
      const ba = E.createTextBinding(storage, id, 'body', a, { onReset: () => resets.push('a') });
      const bb = E.createTextBinding(storage, id, 'body', b, { onReset: () => resets.push('b') });
      t2.after(() => ba.stop());
      t2.after(() => bb.stop());
      await Promise.all([ba.ready, bb.ready]);
      // Both type at once: a's lands first, b's is refused as STALE, rebased over a's and lands after it.
      a.type(0, 'abc');
      b.type(0, 'xyz');
      await Promise.all([ba.flush(), bb.flush()]);
      await waitUntil(() => a.text() === 'abcxyz' && b.text() === 'abcxyz');
      assert.strictEqual((await storage.get(id)).body, 'abcxyz');
      assert.deepStrictEqual([ba.shadow, bb.shadow], ['abcxyz', 'abcxyz']);
      // A storm from both, interleaved without a wait, converges on the field.
      for (const seed of [1, 2, 3]) {
        const random = prng(seed);
        for (let i = 0; i < 40; i++) {
          randomEdit(random() < 0.5 ? a : b, random, random() < 0.5 ? 'A' : 'B');
          if (random() < 0.2) await tick();
        }
        await Promise.all([ba.flush(), bb.flush()]);
        await waitUntil(async () => {
          const text = (await storage.get(id)).body;
          return a.text() === text && b.text() === text && ba.shadow === text && bb.shadow === text;
        });
        const expected = await reading(storage, id);
        assert.deepStrictEqual(canon(a.getContents()), expected, `seed ${seed}: a`);
        assert.deepStrictEqual(canon(b.getContents()), expected, `seed ${seed}: b`);
      }
      assert.deepStrictEqual(resets, []);
    },
  );

  await t.test('two editors on two nodes converge once the nodes have', async (t2) => {
    const mesh = await createMesh(t2, ['A', 'B'], [['A', 'B']], createStorage);
    const [sa, sb] = ['A', 'B'].map((name) => mesh.get(name));
    const id = await sa.insert({ title: 'doc' });
    await settle([sa, sb]);
    const a = createEditor();
    const b = createEditor();
    const ba = E.createTextBinding(sa, id, 'body', a);
    const bb = E.createTextBinding(sb, id, 'body', b);
    t2.after(() => ba.stop());
    t2.after(() => bb.stop());
    await Promise.all([ba.ready, bb.ready]);
    const random = prng(7);
    for (let i = 0; i < 60; i++) {
      randomEdit(random() < 0.5 ? a : b, random, random() < 0.5 ? 'A' : 'B');
      if (random() < 0.3) await tick();
    }
    await Promise.all([ba.flush(), bb.flush()]);
    await settle([sa, sb]);
    await waitUntil(async () => {
      const text = (await sa.get(id)).body;
      return text === (await sb.get(id)).body && a.text() === text && b.text() === text;
    });
    const expected = await reading(sa, id);
    assert.deepStrictEqual(await reading(sb, id), expected);
    assert.deepStrictEqual(canon(a.getContents()), expected);
    assert.deepStrictEqual(canon(b.getContents()), expected);
  });

  await t.test('a reset reloads the editor and drops what was not sent; the record gone empties it', async (t2) => {
    const storage = await createStorage(t2, 'A');
    const id = await storage.insert({});
    await storage.updateText(id, 'body', 'before');
    const editor = createEditor();
    const resets = [];
    const binding = E.createTextBinding(storage, id, 'body', editor, { onReset: () => resets.push(editor.text()) });
    t2.after(() => binding.stop());
    await binding.ready;
    editor.type(0, 'unsent');
    await storage.set(id, { title: 'reset' });
    await waitUntil(() => resets.length === 1);
    assert.deepStrictEqual([resets, binding.shadow, binding.pending, editor.text()], [[''], '', false, '']);
    await storage.updateText(id, 'body', 'after');
    await waitUntil(() => editor.text() === 'after');
    editor.type(5, '!');
    await binding.flush();
    assert.strictEqual((await storage.get(id)).body, 'after!');
    await storage.delete(id);
    await waitUntil(() => resets.length === 2);
    assert.deepStrictEqual([resets[1], editor.text(), binding.shadow], ['', '', '']);
  });

  await t.test(
    'a send that keeps failing reloads the editor later each time and stops after five in a row, a STALE no event explains alike',
    async (t2) => {
      const storage = await createStorage(t2, 'A');
      const id = await storage.insert({});
      await storage.updateText(id, 'body', 'base');
      for (const failure of [
        () => new TypeError('a delta the field refuses'),
        () => Object.assign(new Error('changed under the delta'), { code: 'STALE' }),
      ]) {
        // The storage as the binding sees it, but a send never lands.
        const failing = new Proxy(storage, {
          get: (target, name) => {
            if (name === 'applyDelta') return async () => Promise.reject(failure());
            const value = target[name];
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const editor = createEditor();
        const errors = [];
        const resets = [];
        const stops = [];
        const binding = E.createTextBinding(failing, id, 'body', editor, {
          onError: (error) => errors.push(error.code ?? error.name),
          onStop: (reason) => stops.push(reason?.code ?? reason?.name ?? null),
          // An editor that types again after every reload — what makes a failure repeat.
          onReset: () => {
            resets.push(editor.text());
            editor.type(0, 'x');
          },
        });
        t2.after(() => binding.stop());
        await binding.ready;
        editor.type(0, 'x');
        await waitUntil(() => errors.length === 5, { timeout: 3000 });
        await binding.flush();
        assert.deepStrictEqual(resets, ['base', 'base', 'base', 'base'], 'a reload between them, the edit dropped');
        assert.strictEqual(editor.text(), 'xbase', 'typed after the last reload, never sent');
        assert.strictEqual((await storage.get(id)).body, 'base');
        assert.strictEqual(binding.stopped, true);
        assert.deepStrictEqual(stops, [errors[4]], 'onStop hears the last failure, once');
        editor.type(0, 'y');
        // A stopped binding answers flush() at once, whatever was typed after it.
        await Promise.race([
          binding.flush(),
          new Promise((resolve, reject) => setTimeout(() => reject(new Error('flush hangs')), 200)),
        ]);
        assert.strictEqual(binding.pending, false);
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.strictEqual(errors.length, 5, 'nothing after the stop');
      }
    },
  );

  await t.test(
    'an editor that throws on a peer’s change is loaded from the field again, never left apart',
    async (t2) => {
      const storage = await createStorage(t2, 'A');
      const id = await storage.insert({});
      await storage.updateText(id, 'body', 'base');
      const editor = createEditor();
      let throwNext = false;
      const update = editor.updateContents;
      editor.updateContents = (delta) => {
        if (throwNext) {
          throwNext = false;
          throw new Error('the view is busy');
        }
        update(delta);
      };
      const errors = [];
      const resets = [];
      const binding = E.createTextBinding(storage, id, 'body', editor, {
        onError: (error) => errors.push(error.message),
        onReset: () => resets.push(editor.text()),
      });
      t2.after(() => binding.stop());
      await binding.ready;
      throwNext = true;
      await storage.splice(id, 'body', 4, 0, '!');
      await waitUntil(() => resets.length === 1, { timeout: 2000 });
      assert.deepStrictEqual(errors, ['the view is busy']);
      assert.strictEqual(editor.text(), 'base!', 'the editor holds the field');
      editor.type(0, '>');
      await binding.flush();
      assert.strictEqual((await storage.get(id)).body, '>base!', 'and edits it as before');
    },
  );

  await t.test('a first load the editor refuses stops the binding: ready rejects, onStop hears why', async (t2) => {
    const storage = await createStorage(t2, 'A');
    const id = await storage.insert({});
    await storage.updateText(id, 'body', 'base');
    const editor = createEditor();
    editor.setContents = () => {
      throw new Error('no document');
    };
    const stops = [];
    const binding = E.createTextBinding(storage, id, 'body', editor, {
      onError: () => {},
      onStop: (reason) => stops.push(reason.message),
    });
    await assert.rejects(binding.ready, /no document/);
    assert.strictEqual(binding.stopped, true);
    assert.deepStrictEqual(stops, ['no document']);
    await binding.flush();
  });

  await t.test(
    'a peer’s change made of the same characters, landing while a delta is in flight, reloads the editor rather than leave it apart',
    async (t2) => {
      const storage = await createStorage(t2, 'A');
      const id = await storage.insert({});
      await storage.updateText(id, 'body', 'abcdef');
      // Between the send and the delta's turn, another writer cuts the 'c' and types a 'c' again: the text
      // the delta expects is there, and the delta lands by index over the new letter.
      let first = true;
      const racing = new Proxy(storage, {
        get: (target, name) => {
          if (name === 'applyDelta') {
            return async (...args) => {
              if (first) {
                first = false;
                await target.splice(id, 'body', 2, 1, 'c');
                await tick();
              }
              return target.applyDelta(...args);
            };
          }
          const value = target[name];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const editor = createEditor();
      const resets = [];
      const binding = E.createTextBinding(racing, id, 'body', editor, { onReset: () => resets.push(editor.text()) });
      t2.after(() => binding.stop());
      await binding.ready;
      editor.erase(2, 1);
      await waitUntil(() => resets.length === 1);
      await binding.flush();
      const field = (await storage.get(id)).body;
      assert.strictEqual(field, 'abdef', 'the delta cut the letter at its index');
      assert.deepStrictEqual([editor.text(), binding.shadow], [field, field], 'read again from the field');
    },
  );

  await t.test('what is typed while the field is read again goes with the contents it replaces', async (t2) => {
    const storage = await createStorage(t2, 'A');
    const id = await storage.insert({});
    await storage.updateText(id, 'body', 'before');
    // The read of the field waits for a gate, so an edit lands while it is in progress.
    let gate = Promise.resolve();
    let open = () => {};
    const slow = new Proxy(storage, {
      get: (target, name) => {
        if (name === 'transact') {
          return async (...args) => {
            await gate;
            return target.transact(...args);
          };
        }
        const value = target[name];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const editor = createEditor();
    const resets = [];
    const binding = E.createTextBinding(slow, id, 'body', editor, { onReset: () => resets.push(editor.text()) });
    t2.after(() => binding.stop());
    await binding.ready;
    gate = new Promise((resolve) => (open = resolve));
    await storage.set(id, { title: 'reset' });
    await tick();
    editor.type(0, 'lost ');
    open();
    await waitUntil(() => resets.length === 1);
    await binding.flush();
    assert.deepStrictEqual([editor.text(), (await storage.get(id)).body], ['', undefined], 'dropped, never sent');
    await storage.updateText(id, 'body', 'after');
    await waitUntil(() => editor.text() === 'after');
    editor.type(5, '!');
    await binding.flush();
    assert.deepStrictEqual([editor.text(), (await storage.get(id)).body], ['after!', 'after!']);
  });

  await t.test('a send that failed holds what follows until the editor is read again', async (t2) => {
    const storage = await createStorage(t2, 'A');
    const id = await storage.insert({});
    await storage.updateText(id, 'body', 'base');
    let refuse = true;
    const flaky = new Proxy(storage, {
      get: (target, name) => {
        if (name === 'applyDelta') {
          return async (...args) => {
            if (refuse) {
              refuse = false;
              throw new TypeError('a delta the field refuses');
            }
            return target.applyDelta(...args);
          };
        }
        const value = target[name];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const editor = createEditor();
    const errors = [];
    const resets = [];
    const binding = E.createTextBinding(flaky, id, 'body', editor, {
      onError: (error) => errors.push(error.message),
      onReset: () => resets.push(editor.text()),
    });
    t2.after(() => binding.stop());
    await binding.ready;
    editor.type(0, 'x');
    await waitUntil(() => errors.length === 1);
    // Typed before the reload: it was sent over the delta the failure dropped, and the reload never came.
    editor.type(0, 'y');
    assert.strictEqual(binding.pending, true, 'held for the reload');
    await waitUntil(() => resets.length === 1);
    await binding.flush();
    assert.deepStrictEqual([editor.text(), (await storage.get(id)).body], ['base', 'base']);
    editor.type(4, '!');
    await binding.flush();
    assert.deepStrictEqual([editor.text(), (await storage.get(id)).body], ['base!', 'base!']);
  });

  await t.test(
    'diffSpans and diffBlocks give the delta between two readings; spans, blocks and deltas round-trip; transforms agree with the storage’s order',
    async (t2) => {
      const storage = await createStorage(t2, 'A');
      const id = await storage.insert({});
      await storage.updateText(id, 'body', 'Title\nFirst paragraph.');
      await storage.splitBlock(id, 'body', 0, { type: 'heading', attrs: { level: 1 } });
      await storage.splitBlock(id, 'body', 7, { type: 'paragraph' });
      await storage.insertEmbed(id, 'body', 14, { type: 'image', attrs: { src: 'a.png' } });
      await storage.mark(id, 'body', 1, 6, 'bold', true);
      const before = await storage.spans(id, 'body');
      // Round trips.
      assert.deepStrictEqual(E.blocksToSpans(E.spansToBlocks(before)), before);
      assert.deepStrictEqual(E.spansToBlocks(before), await storage.blocks(id, 'body'));
      assert.deepStrictEqual(E.deltaToSpans(E.spansToDelta(before)), canonSpans(before));
      assert.deepStrictEqual(E.spansToBlocks([{ type: 'text', text: 'ab', marks: {} }])[0], {
        index: null,
        type: null,
        parents: [],
        attrs: {},
        spans: [{ type: 'text', text: 'ab', marks: {} }],
      });
      assert.throws(() => E.deltaToSpans([{ retain: 1 }]), TypeError);
      // A new reading: the heading's level, a word, the image gone, a mark off, a paragraph under a quote.
      const after = E.spansToBlocks(before);
      after[0].attrs = { level: 2 };
      after[0].spans = [{ type: 'text', text: 'Title!\n', marks: {} }];
      after[1].parents = ['blockquote'];
      after[1].spans = [{ type: 'text', text: 'First paragraph.', marks: {} }];
      const delta = E.diffBlocks(E.spansToBlocks(before), after);
      assert.deepStrictEqual(delta, [
        { retain: 1, attributes: { embed: { type: 'heading', parents: [], attrs: { level: 2 }, isEmbed: false } } },
        { retain: 5, attributes: { bold: null } },
        { insert: '!' },
        { retain: 1 },
        { retain: 1, attributes: { embed: { type: 'paragraph', parents: ['blockquote'], attrs: {}, isEmbed: false } } },
        { retain: 6 },
        { delete: 1 },
      ]);
      await storage.applyDelta(id, 'body', delta);
      // The paragraph's marker moved one along with the inserted `!`: the indices read again.
      assert.deepStrictEqual(await storage.blocks(id, 'body'), E.spansToBlocks(E.blocksToSpans(after)));
      assert.deepStrictEqual(E.diffSpans(await storage.spans(id, 'body'), E.blocksToSpans(after)), []);
      // Nothing to nothing, something to nothing.
      assert.deepStrictEqual(E.diffSpans([], []), []);
      assert.deepStrictEqual(E.diffSpans(before, []), [{ delete: textOf(before).length }]);
      // Transforms: the storage lands a before b; both orders of applying read the same.
      const base = 'hello';
      const a = [{ retain: 5 }, { insert: ' world' }];
      const b = [{ delete: 1 }, { insert: 'J' }, { retain: 4, attributes: { bold: true } }];
      const ab = E.applyToText(E.applyToText(base, a), E.transform(a, b, true));
      const ba = E.applyToText(E.applyToText(base, b), E.transform(b, a, false));
      assert.deepStrictEqual([ab, ba], ['Jello world', 'Jello world']);
      assert.deepStrictEqual(E.transform([{ insert: 'x' }], [{ insert: 'y' }], true), [{ retain: 1 }, { insert: 'y' }]);
      assert.deepStrictEqual(E.transform([{ insert: 'x' }], [{ insert: 'y' }], false), [{ insert: 'y' }]);
      assert.deepStrictEqual(E.compose([{ insert: 'ab' }], [{ retain: 1 }, { delete: 1 }, { insert: 'c' }]), [
        { insert: 'ac' },
      ]);
      // Over a retain a null still takes the mark off, as Quill keeps it.
      assert.deepStrictEqual(
        E.compose([{ retain: 2, attributes: { bold: true } }], [{ retain: 2, attributes: { bold: null } }]),
        [{ retain: 2, attributes: { bold: null } }],
      );
      assert.deepStrictEqual(
        E.compose([{ insert: 'ab', attributes: { bold: true } }], [{ retain: 2, attributes: { bold: null } }]),
        [{ insert: 'ab' }],
      );
      assert.strictEqual(E.transformIndex(3, [{ insert: 'ab' }]), 5);
      assert.strictEqual(E.transformIndex(3, [{ retain: 3 }, { insert: 'ab' }]), 5);
      assert.strictEqual(E.transformIndex(3, [{ retain: 3 }, { insert: 'ab' }], true), 3);
      assert.strictEqual(E.transformIndex(3, [{ retain: 1 }, { delete: 5 }]), 1);
      assert.strictEqual(
        E.applyToText('abc', [{ retain: 1 }, { insert: { embed: null } }, { delete: 1 }]),
        `a${E.EMBED}c`,
      );
      assert.throws(() => E.transform([{ retain: 0 }], []), TypeError);
      assert.throws(() => E.transformIndex(-1, []), TypeError);
      assert.throws(() => E.applyToText(5, []), TypeError);
    },
  );

  await t.test(
    'a selection travels as tokens that survive the edits around it, and a presence room’s cursors resolve to indices',
    async (t2) => {
      const storage = await createStorage(t2, 'A');
      const id = await storage.insert({});
      await storage.updateText(id, 'body', 'hello world');
      const tokens = await E.selectionToTokens(storage, id, 'body', { anchor: 6, head: 11 });
      assert.deepStrictEqual(
        [tokens.id, tokens.field, typeof tokens.anchor, typeof tokens.head],
        [id, 'body', 'string', 'string'],
      );
      await storage.splice(id, 'body', 0, 0, 'well, ');
      assert.deepStrictEqual(await E.tokensToSelection(storage, tokens), { anchor: 12, head: 17 });
      const caret = await E.selectionToTokens(storage, id, 'body', { anchor: 3 });
      assert.strictEqual(caret.anchor, caret.head);
      assert.strictEqual(await E.selectionToTokens(storage, id, 'nope', { anchor: 0 }), null);
      await storage.splice(id, 'body', 12, 5);
      assert.deepStrictEqual(
        await E.tokensToSelection(storage, tokens),
        { anchor: 12, head: 12 },
        'a cut keeps the place',
      );
      const gone = await E.selectionToTokens(storage, id, 'body', { anchor: 2 });
      await storage.set(id, { title: 'reset' });
      assert.strictEqual(await E.tokensToSelection(storage, gone), null, 'the field is gone');
      await storage.updateText(id, 'body', 'well, hello ');
      // A caret made in the field as it is now: the one before the reset has no place.
      const fresh = await E.selectionToTokens(storage, id, 'body', { anchor: 3 });
      const presence = createPresence(storage, { timeout: 1000 });
      t2.after(() => presence.destroy());
      await presence.set({ name: 'ada', cursor: fresh });
      await presence.apply({
        p: 1,
        scope: '*',
        s: [['someone', 1, Date.now(), { cursor: { id, field: 'body', anchor: tokens.anchor } }]],
      });
      await presence.apply({
        p: 1,
        scope: '*',
        s: [['other', 1, Date.now(), { cursor: { id: 'x', field: 'body', anchor: tokens.anchor } }]],
      });
      // A peer whose token this field cannot read: its cursor alone is left out.
      await presence.apply({
        p: 1,
        scope: '*',
        s: [['broken', 1, Date.now(), { cursor: { id, field: 'body', anchor: 'x' } }]],
      });
      await presence.apply({
        p: 1,
        scope: '*',
        s: [['odd', 1, Date.now(), { cursor: { id, field: 'body', anchor: fresh.anchor, head: 7 } }]],
      });
      const cursors = await E.presenceCursors(presence, storage, id, 'body');
      assert.deepStrictEqual(
        cursors.map(({ node, anchor, head }) => [node, anchor, head]),
        [[storage.nodeId, 3, 3]],
        'this node’s caret; the other’s place is gone, the third is on another record, the broken tokens left out',
      );
      assert.strictEqual(cursors[0].state.name, 'ada');
      await assert.rejects(() => E.tokensToSelection(storage, { id }), TypeError);
      await assert.rejects(() => E.selectionToTokens(storage, id, 'body', {}), TypeError);
      await assert.rejects(() => E.presenceCursors({}, storage, id, 'body'), TypeError);
    },
  );

  await t.test('the delta algebra keeps its laws over random deltas; one style in any key order is one op', () => {
    const rnd = prng(29);
    const randomDelta = (length) => {
      const ops = [];
      let at = 0;
      for (let step = 0; step < 32; step++) {
        const r = rnd();
        if (r < 0.3) ops.push({ insert: 'xyz'.slice(0, 1 + Math.floor(rnd() * 3)) });
        else if (at < length && r < 0.6) {
          const n = 1 + Math.floor(rnd() * Math.min(3, length - at));
          ops.push({ delete: n });
          at += n;
        } else if (at < length) {
          const n = 1 + Math.floor(rnd() * Math.min(4, length - at));
          ops.push({ retain: n });
          at += n;
        }
        if (at >= length && rnd() < 0.5) break;
      }
      return ops;
    };
    const lengthAfter = (length, delta) => E.applyToText('a'.repeat(length), delta).length;
    for (let i = 0; i < 300; i++) {
      const text = 'abcdefghij'.slice(0, Math.floor(rnd() * 10));
      const a = randomDelta(text.length);
      const b = randomDelta(lengthAfter(text.length, a));
      assert.strictEqual(
        E.applyToText(E.applyToText(text, a), b),
        E.applyToText(text, E.compose(a, b)),
        `compose: ${JSON.stringify([text, a, b])}`,
      );
      const c = randomDelta(text.length);
      const left = E.applyToText(E.applyToText(text, a), E.transform(a, c, true));
      const right = E.applyToText(E.applyToText(text, c), E.transform(c, a, false));
      assert.strictEqual(left, right, `transform: ${JSON.stringify([text, a, c])}`);
    }
    assert.deepStrictEqual(
      E.compose(
        [{ insert: 'a', attributes: { bold: true, italic: true } }],
        [{ retain: 1 }, { insert: 'b', attributes: { italic: true, bold: true } }],
      ),
      [{ insert: 'ab', attributes: { bold: true, italic: true } }],
      'two inserts of one style, keys in another order: one op',
    );
  });

  await t.test('an adapter’s fit holds what its document differs by, and maps indices across it', () => {
    const plain = (text) => [{ type: 'text', text, marks: {} }];
    let shown = 'ab\r\ncd';
    const fit = E.createFit(() => plain(shown), E.diffSpans);
    assert.throws(() => E.createFit(null, E.diffSpans), TypeError);
    assert.strictEqual(fit.toDoc(3), 3, 'nothing held: an index is the same on both sides');
    assert.strictEqual(fit.toField(3), 3);
    // The field reads `ab\ncd`; the document shows a `\r` more before the break.
    fit.hold(plain('ab\ncd'), [{ retain: 2 }, { insert: '\r' }]);
    assert.strictEqual(fit.toDoc(3), 4, 'after the break, one further in the document');
    assert.strictEqual(fit.toField(4), 3, 'and back, through the delta made from the document');
    // The editor's next edit takes what was held with it, in front.
    const delta = fit.send([{ retain: 6 }, { insert: '!' }], null);
    assert.deepStrictEqual(delta, [{ retain: 2 }, { insert: '\r' }, { retain: 3 }, { insert: '!' }]);
    assert.deepStrictEqual(fit.unfit, []);
    assert.strictEqual(fit.base, null);
    shown = 'x';
    assert.strictEqual(fit.toField(9), 9, 'nothing held again: the document is not read');
  });

  await t.test('undo steps answer whether there is a step and take it once the binding’s edits landed', async () => {
    assert.throws(
      () =>
        E.undoSteps(
          {},
          () => null,
          () => {},
        ),
      TypeError,
    );
    const taken = [];
    const failures = [];
    const manager = {
      canUndo: true,
      canRedo: false,
      undo: async () => taken.push('undo'),
      redo: async () => {
        throw new Error('redo failed');
      },
    };
    let flushed = 0;
    let binding = null;
    const steps = E.undoSteps(
      manager,
      () => binding,
      (error) => failures.push(error.message),
    );
    assert.strictEqual(steps.redo(true), false, 'no step to redo: nothing runs');
    assert.strictEqual(steps.undo(false), true, 'a dry run answers and takes nothing');
    await tick();
    assert.deepStrictEqual(taken, []);
    assert.strictEqual(steps.undo(true), true);
    binding = { flush: async () => void flushed++ };
    assert.strictEqual(steps.undo(true), true);
    manager.canRedo = true;
    steps.redo(true);
    await tick();
    assert.deepStrictEqual(taken, ['undo', 'undo']);
    assert.strictEqual(flushed, 2, 'the binding flushed before each step it was there for');
    assert.deepStrictEqual(failures, ['redo failed'], 'a step that fails is reported, never thrown');
    const warned = [];
    const report = E.failureReporter({ logger: { warn: (entry) => warned.push(entry) } }, 'r', 'body');
    const heard = [];
    report('editor.undo', (error) => heard.push(error.message))(new Error('one'));
    report('editor.cursors')(new Error('two'));
    assert.deepStrictEqual(heard, ['one']);
    assert.deepStrictEqual(
      warned.map(({ event, id, field, err }) => [event, id, field, err.message]),
      [['editor.cursors', 'r', 'body', 'two']],
    );
  });
};

const textOf = (spans) => spans.map((span) => (span.type === 'text' ? span.text : E.EMBED)).join('');
// Spans as a delta round trip gives: adjacent text spans of equal marks merged.
const canonSpans = (spans) => E.deltaToSpans(E.spansToDelta(spans));

module.exports = { runEditorTests, createEditor };
