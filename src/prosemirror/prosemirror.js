'use strict';

// The ProseMirror adapter (@alexify/syncom/prosemirror): a ProseMirror
// editor bound to a text field through the editor binding
// (src/editor/editor.js). ProseMirror is INJECTED — `{ model, state,
// transform, view? }`, the caller's own modules — and nothing here requires
// it.
//
// The document is one text with block markers (Automerge's model): every
// block-level node in document order — a container (a list, a list item, a
// quote), a textblock, a leaf block — is a marker `{ type, parents, attrs }`
// whose `parents` are the containers it sits in, and a textblock's inline
// content follows its marker: text with its marks (a mark's attributes, or
// `true`), an inline node as an embed. A container's marker opens a new
// one, so two list items are two markers and one item with two paragraphs
// is one. Reading it back opens a container where the parents name one that
// is not open, and wraps text that stands outside a textblock in the
// schema's default one; what the schema cannot hold is left out.
//
// The field comes to fit the schema with the editor's next edit, never as an
// answer to a peer's: what the document differs from the field by (`unfit`)
// is held, and goes out composed with that edit. Two editors that answered a
// merge each with a fit of their own sent the same structure twice, or each
// a part of it — a field neither fit, answered again, without end. Until the
// edit, the adapter maps an index of the document to the field's through
// `unfit` (`indexOf`, `posOf`, the selection, the cursors); every reader of
// the field builds the same document from it.
//
// An edit in the editor reaches the field as the delta between the
// document before and after it (`diffSpans`), one transaction each; a
// peer's delta builds the document after it and lands as one replace
// step — the smallest the two documents differ by — with the selection
// moved through the delta by text index. Undo is the storage's
// (`@alexify/syncom/undo` over the binding's `source`), never ProseMirror's
// history; a presence room's cursors are decorations.

const {
  createTextBinding,
  compose,
  spansToDelta,
  deltaToSpans,
  diffSpans,
  transformIndex,
  selectionToTokens,
  presenceCursors,
} = require('../editor/editor.js');

const marksOf = (marks) => {
  const out = {};
  for (const mark of marks) out[mark.type.name] = Object.keys(mark.attrs).length > 0 ? { ...mark.attrs } : true;
  return out;
};

/** A document as typed spans: a marker per block-level node in document order, a textblock's inline content after it. */
const docToSpans = (doc) => {
  const out = [];
  const walk = (node, parents) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      out.push({ type: 'block', value: { type: child.type.name, parents, attrs: { ...child.attrs }, isEmbed: false } });
      if (child.isTextblock) {
        for (let k = 0; k < child.childCount; k++) {
          const inline = child.child(k);
          const marks = marksOf(inline.marks);
          if (inline.isText) out.push({ type: 'text', text: inline.text, marks });
          else {
            const value = { type: inline.type.name, parents: [], attrs: { ...inline.attrs }, isEmbed: true };
            out.push({ type: 'embed', value, marks });
          }
        }
      } else if (!child.isLeaf) walk(child, [...parents, child.type.name]);
    }
  };
  walk(doc, []);
  return out;
};

// The node a record stands for, or null where the schema cannot hold it.
const build = (record) => {
  if (record.node !== undefined) return record.node;
  const content = [];
  for (const child of record.children) {
    const node = build(child);
    if (node !== null) content.push(node);
  }
  try {
    return record.type.createAndFill(record.attrs, content) ?? record.type.createAndFill(record.attrs);
  } catch {
    return null;
  }
};

/** Typed spans as a document of `schema`, the markers' parents opened as containers; what the schema cannot hold is left out. */
const spansToDoc = (spans, schema) => {
  const firstTextblock = Object.values(schema.nodes).find((type) => type.isTextblock);
  const textblockIn = (type) => {
    const fit = type.contentMatch.defaultType;
    return fit !== undefined && fit !== null && fit.isTextblock ? fit : firstTextblock;
  };
  const root = { type: schema.topNodeType, attrs: null, children: [] };
  const stack = [{ name: null, record: root }];
  const top = () => stack[stack.length - 1].record;
  const container = (type) => type !== undefined && !type.isTextblock && !type.isLeaf && !type.isInline;
  // Keeps the open containers the parents name, opens the ones they name that are not.
  const align = (parents) => {
    let depth = 0;
    while (depth < parents.length && depth + 1 < stack.length && stack[depth + 1].name === parents[depth]) depth++;
    stack.length = depth + 1;
    for (let i = depth; i < parents.length; i++) {
      const type = schema.nodes[parents[i]];
      if (!container(type)) continue;
      const record = { type, attrs: null, children: [] };
      top().children.push(record);
      stack.push({ name: parents[i], record });
    }
  };
  let block = null;
  const textblock = () => {
    if (block === null) {
      block = { type: textblockIn(top().type), attrs: null, children: [] };
      top().children.push(block);
    }
    return block;
  };
  const markList = (marks) => {
    const out = [];
    for (const name of Object.keys(marks ?? {})) {
      const value = marks[name];
      const type = schema.marks[name];
      if (type === undefined || value === null || value === false || Array.isArray(value)) continue;
      try {
        out.push(type.create(value === true ? null : value));
      } catch {
        // A mark the schema refuses these attributes for: left out.
      }
    }
    return out;
  };
  for (const span of spans) {
    if (span.type === 'block') {
      const { type: name, parents, attrs } = span.value;
      align(Array.isArray(parents) ? parents : []);
      const type = schema.nodes[name];
      if (type === undefined || type.isInline) {
        block = null;
        textblock();
        continue;
      }
      const record = { type, attrs, children: [] };
      top().children.push(record);
      block = type.isTextblock ? record : null;
      if (container(type)) stack.push({ name, record });
      continue;
    }
    if (span.type === 'text') {
      if (span.text.length > 0) textblock().children.push({ node: schema.text(span.text, markList(span.marks)) });
      continue;
    }
    const type = span.value === null ? undefined : schema.nodes[span.value.type];
    if (type === undefined || !type.isInline) continue;
    try {
      textblock().children.push({ node: type.create(span.value.attrs, null, markList(span.marks)) });
    } catch {
      // An inline node the schema refuses these attributes for: left out.
    }
  }
  return build(root) ?? schema.topNodeType.createAndFill();
};

// Where each textblock's content starts, in the document and in the text.
const layoutOf = (doc) => {
  const blocks = [];
  let index = 0;
  const walk = (node, start) => {
    let pos = start;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      index += 1;
      if (child.isTextblock) {
        blocks.push({ pos: pos + 1, index, size: child.content.size });
        index += child.content.size;
      } else if (!child.isLeaf) walk(child, pos + 1);
      pos += child.nodeSize;
    }
  };
  walk(doc, 0);
  return { blocks, length: index };
};

/** The text index a document position stands at. */
const indexOfPos = (doc, pos) => {
  const { blocks, length } = layoutOf(doc);
  for (const block of blocks) {
    if (pos < block.pos) return block.index;
    if (pos <= block.pos + block.size) return block.index + (pos - block.pos);
  }
  return length;
};

/** The document position a text index stands at: inside a textblock, the nearest one after it where it is none. */
const posOfIndex = (doc, index) => {
  const { blocks } = layoutOf(doc);
  for (const block of blocks) {
    if (index <= block.index + block.size) return block.pos + Math.max(0, index - block.index);
  }
  const last = blocks[blocks.length - 1];
  return last === undefined ? 0 : last.pos + last.size;
};

const checkModules = (pm) => {
  if (
    !pm ||
    typeof pm.state?.Plugin !== 'function' ||
    typeof pm.state?.PluginKey !== 'function' ||
    typeof pm.state?.TextSelection !== 'function' ||
    typeof pm.transform?.ReplaceStep !== 'function'
  ) {
    throw new TypeError('createProseMirror() takes { model, state, transform, view? }: the prosemirror-* modules');
  }
};

/**
 * Binds a ProseMirror editor to text field `path` of record `id`.
 * `plugin` goes into the editor's state; `attach(view)` starts the binding
 * over the view (an EditorView, or anything with `state` and a `dispatch`
 * that applies at once).
 */
const createProseMirror = (storage, id, path, pm, options = {}) => {
  checkModules(pm);
  const { Plugin, PluginKey, TextSelection, Selection } = pm.state;
  const { ReplaceStep } = pm.transform;
  const key = new PluginKey('syncom');
  const source = options.source ?? Symbol('prosemirror');
  let view = null;
  let report = null;
  let text = null;
  // The field as the binding sees it (its text, and the editor's edits sent
  // and not landed yet), as spans; what the editor's document differs from
  // it by, held for the next edit; and the way back, made when asked.
  let base = null;
  let unfit = [];
  let back = null;
  const hold = (doc) => {
    unfit = diffSpans(base, docToSpans(doc));
    back = null;
  };
  // A field index as the document's, and back.
  const toDoc = (index) => (unfit.length === 0 ? index : transformIndex(index, unfit, true));
  const toField = (index) => {
    if (unfit.length === 0) return index;
    back ??= diffSpans(docToSpans(view.state.doc), base);
    return transformIndex(index, back, true);
  };

  const plugin = new Plugin({
    key,
    // The editor's own edits, as the delta between the documents — after
    // what the field lacked of the document before, held till now.
    appendTransaction(trs, before, after) {
      if (report === null || !trs.some((tr) => tr.docChanged && tr.getMeta(key) === undefined)) return null;
      const now = docToSpans(after.doc);
      const local = diffSpans(docToSpans(before.doc), now);
      const delta = unfit.length === 0 ? local : compose(unfit, local);
      base = now;
      unfit = [];
      back = null;
      if (delta.length > 0) report(delta);
      return null;
    },
  });

  // Lands `doc` in the editor without reporting it: the smallest replace
  // step the two documents differ by, the whole document where that step
  // would not give it; the selection at `selection` (text indices).
  const land = (doc, selection) => {
    const { state } = view;
    const tr = state.tr;
    const from = state.doc.content.findDiffStart(doc.content);
    if (from !== null) {
      let { a, b } = state.doc.content.findDiffEnd(doc.content);
      const overlap = from - Math.min(a, b);
      if (overlap > 0) {
        a += overlap;
        b += overlap;
      }
      const step = new ReplaceStep(from, a, doc.slice(from, b));
      if (tr.maybeStep(step).failed !== null || !tr.doc.eq(doc)) {
        tr.replaceWith(0, tr.doc.content.size, doc.content);
      }
    }
    if (selection !== null) {
      try {
        tr.setSelection(
          TextSelection.create(tr.doc, posOfIndex(tr.doc, selection[0]), posOfIndex(tr.doc, selection[1])),
        );
      } catch {
        tr.setSelection(Selection.atStart(tr.doc));
      }
    }
    tr.setMeta(key, 'remote');
    tr.setMeta('addToHistory', false);
    view.dispatch(tr);
  };

  // A peer's change is never answered with an edit: the document is built
  // from the field, and what it differs from the field by is held.
  const adapter = {
    setContents: (ops) => {
      base = deltaToSpans(ops);
      const doc = spansToDoc(base, view.state.schema);
      land(doc, [0, 0]);
      hold(doc);
    },
    updateContents: (delta) => {
      const { state } = view;
      const { selection } = state;
      // The selection as field indices through the delta, before the field moves.
      const at =
        selection instanceof TextSelection
          ? [selection.anchor, selection.head].map((pos) =>
              transformIndex(toField(indexOfPos(state.doc, pos)), delta, true),
            )
          : null;
      base = deltaToSpans(compose(spansToDelta(base ?? docToSpans(state.doc)), delta));
      const doc = spansToDoc(base, state.schema);
      unfit = diffSpans(base, docToSpans(doc));
      back = null;
      land(doc, at === null ? null : at.map(toDoc));
    },
    onChange: (listener) => {
      report = listener;
      return () => {
        if (report === listener) report = null;
      };
    },
  };

  const attach = (target) => {
    if (!target || typeof target.dispatch !== 'function' || !target.state) {
      throw new TypeError('attach() takes an EditorView (state and dispatch)');
    }
    if (text !== null) throw new TypeError('attach(): this binding is attached already');
    if (key.get(target.state) === undefined) throw new TypeError('attach(): the view’s state has not the plugin');
    view = target;
    text = createTextBinding(storage, id, path, adapter, { ...options, source });
    return text;
  };

  // A presence room's cursors as decorations, and this editor's selection
  // published to it — `pm.view` (prosemirror-view) is needed for the first.
  const cursorPlugin = (presence, { field = 'cursor', render = null, className = 'syncom-selection' } = {}) => {
    if (typeof pm.view?.Decoration?.widget !== 'function') {
      throw new TypeError('cursorPlugin() needs pm.view: the prosemirror-view module');
    }
    const { Decoration, DecorationSet } = pm.view;
    const cursorKey = new PluginKey('syncom-cursors');
    const caret = (cursor) => {
      const element = document.createElement('span');
      element.className = 'syncom-caret';
      element.dataset.node = cursor.node;
      return element;
    };
    return new Plugin({
      key: cursorKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (tr, set) => tr.getMeta(cursorKey) ?? set.map(tr.mapping, tr.doc),
      },
      props: { decorations: (state) => cursorKey.getState(state) },
      view: (editor) => {
        let stopped = false;
        let shown = 0;
        let published = null;
        const refresh = async () => {
          const mine = ++shown;
          const cursors = await presenceCursors(presence, storage, id, path, { key: field });
          if (stopped || mine !== shown) return;
          const { doc } = editor.state;
          const decorations = [];
          for (const cursor of cursors) {
            if (cursor.node === presence.node) continue;
            const head = posOfIndex(doc, toDoc(cursor.head));
            const anchor = posOfIndex(doc, toDoc(cursor.anchor));
            decorations.push(Decoration.widget(head, () => (render ?? caret)(cursor), { key: cursor.node }));
            if (anchor !== head) {
              const attrs = { class: className, 'data-node': cursor.node };
              decorations.push(Decoration.inline(Math.min(anchor, head), Math.max(anchor, head), attrs));
            }
          }
          editor.dispatch(editor.state.tr.setMeta(cursorKey, DecorationSet.create(doc, decorations)));
        };
        const publish = async () => {
          if (text === null) return;
          await text.flush();
          if (stopped) return;
          const { doc, selection } = editor.state;
          const tokens = await selectionToTokens(storage, id, path, {
            anchor: toField(indexOfPos(doc, selection.anchor)),
            head: toField(indexOfPos(doc, selection.head)),
          });
          const next = JSON.stringify(tokens);
          if (stopped || tokens === null || next === published) return;
          published = next;
          await presence.set({ ...(presence.local ?? {}), [field]: tokens });
        };
        const changed = () => void refresh();
        presence.on('change', changed);
        void refresh();
        return {
          update: (_editor, before) => {
            if (!before.selection.eq(editor.state.selection) || !before.doc.eq(editor.state.doc)) void publish();
            if (!before.doc.eq(editor.state.doc)) void refresh();
          },
          destroy: () => {
            stopped = true;
            presence.off('change', changed);
          },
        };
      },
    });
  };

  // ProseMirror commands over an undo manager of the storage's: the field's
  // edits taken back after every edit sent has landed.
  const commands = (manager) => {
    if (!manager || typeof manager.undo !== 'function' || typeof manager.redo !== 'function') {
      throw new TypeError('commands() takes an undo manager: createUndo() from @alexify/syncom/undo');
    }
    const command = (name, can) => (_state, dispatch) => {
      if (!manager[can]) return false;
      if (dispatch) {
        const settled = text === null ? Promise.resolve() : text.flush();
        void settled.then(() => manager[name]());
      }
      return true;
    };
    return { undo: command('undo', 'canUndo'), redo: command('redo', 'canRedo') };
  };

  const attached = (name) => {
    if (view === null) throw new TypeError(`${name}(): attach() first`);
  };

  return Object.freeze({
    key,
    plugin,
    source,
    attach,
    cursorPlugin,
    commands,
    /** The field's index at document position `pos` — through what the field lacks of the document, until an edit sends it. */
    indexOf: (pos) => {
      attached('indexOf');
      return toField(indexOfPos(view.state.doc, pos));
    },
    /** The document position at the field's index `index`. */
    posOf: (index) => {
      attached('posOf');
      return posOfIndex(view.state.doc, toDoc(index));
    },
    get binding() {
      return text;
    },
    stop: () => {
      text?.stop();
      report = null;
    },
  });
};

module.exports = { createProseMirror, docToSpans, spansToDoc, indexOfPos, posOfIndex };
