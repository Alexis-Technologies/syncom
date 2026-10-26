'use strict';

// The CodeMirror 6 adapter (@alexify/syncom/codemirror): a CodeMirror editor
// bound to a text field through the editor binding (src/editor/editor.js).
// CodeMirror is INJECTED — `{ state, view? }`, the caller's own
// @codemirror/state and @codemirror/view — and nothing here requires it.
//
// A CodeMirror document is the field's text as it is: an edit is its
// ChangeSet read as a delta — a retain, a cut and an insert per changed
// range, in the document before it — and a peer's delta is a ChangeSet
// again, so the selection maps through it as through any change. Marks are
// not CodeMirror's and are left alone; an embed slot reads as U+FFFC. What
// the editor makes of a text otherwise — CodeMirror reads `\r\n` and `\r`
// as line breaks — is sent as an edit of the adapter's own, so the field
// holds what the editor shows. Undo is the storage's
// (`@alexify/syncom/undo` over the binding's `source`): leave CodeMirror's
// history out. A presence room's cursors are decorations.

const {
  createTextBinding,
  diffSpans,
  applyToText,
  selectionToTokens,
  presenceCursors,
  EMBED,
} = require('../editor/editor.js');

/** A ChangeSet as a delta over the document before it. */
const deltaOfChanges = (changes) => {
  const ops = [];
  let at = 0;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (fromA > at) ops.push({ retain: fromA - at });
    if (toA > fromA) ops.push({ delete: toA - fromA });
    const text = inserted.toString();
    if (text.length > 0) ops.push({ insert: text });
    at = toA;
  });
  return ops;
};

/** A delta as change specs over the document it applies to: positions in that document. */
const changesOfDelta = (delta) => {
  const changes = [];
  let at = 0;
  for (const op of delta) {
    if (op.retain !== undefined) at += op.retain;
    else if (op.delete !== undefined) {
      changes.push({ from: at, to: at + op.delete });
      at += op.delete;
    } else changes.push({ from: at, insert: typeof op.insert === 'string' ? op.insert : EMBED });
  }
  return changes;
};

const textOf = (ops) => {
  let text = '';
  for (const op of ops) text += typeof op.insert === 'string' ? op.insert : EMBED;
  return text;
};

const checkModules = (cm) => {
  if (
    !cm ||
    typeof cm.state?.StateField?.define !== 'function' ||
    typeof cm.state?.Annotation?.define !== 'function' ||
    typeof cm.state?.Transaction !== 'function'
  ) {
    throw new TypeError(
      'createCodeMirror() takes { state, view? }: the @codemirror/state and @codemirror/view modules',
    );
  }
};

/**
 * Binds a CodeMirror editor to text field `path` of record `id`.
 * `extension` goes into the editor's state; `attach(view)` starts the
 * binding over the view (an EditorView, or anything with `state` and a
 * `dispatch` that applies at once).
 */
const createCodeMirror = (storage, id, path, cm, options = {}) => {
  checkModules(cm);
  const { StateField, StateEffect, Annotation, Transaction } = cm.state;
  const remote = Annotation.define();
  const source = options.source ?? Symbol('codemirror');
  let view = null;
  let report = null;
  let text = null;
  const started = [];

  // The editor's own edits, as each transaction applies.
  const reporter = StateField.define({
    create: () => null,
    update: (value, tr) => {
      if (tr.docChanged && report !== null && tr.annotation(remote) === undefined) {
        const delta = deltaOfChanges(tr.changes);
        if (delta.length > 0) report(delta);
      }
      return value;
    },
  });

  // Lands changes in the editor without reporting them, then sends what the
  // editor made of the text otherwise (line breaks) as an edit of its own.
  const land = (changes, expected) => {
    view.dispatch({
      changes,
      annotations: [remote.of(true), Transaction.addToHistory.of(false)],
    });
    const shown = view.state.doc.toString();
    if (shown !== expected && report !== null) {
      report(diffSpans([{ type: 'text', text: expected, marks: {} }], [{ type: 'text', text: shown, marks: {} }]));
    }
  };

  const adapter = {
    setContents: (ops) => {
      const expected = textOf(ops);
      land({ from: 0, to: view.state.doc.length, insert: expected }, expected);
    },
    updateContents: (delta) => {
      land(changesOfDelta(delta), applyToText(view.state.doc.toString(), delta));
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
    if (target.state.field(reporter, false) === undefined) {
      throw new TypeError('attach(): the view’s state has not the extension');
    }
    view = target;
    text = createTextBinding(storage, id, path, adapter, { ...options, source });
    for (const start of started) start();
    return text;
  };

  // A presence room's cursors as decorations, and this editor's selection
  // published to it — `cm.view` (@codemirror/view) is needed for them.
  const cursors = (presence, { field = 'cursor', className = 'syncom-selection', render = null } = {}) => {
    if (typeof cm.view?.Decoration?.mark !== 'function' || typeof cm.view?.WidgetType !== 'function') {
      throw new TypeError('cursors() needs cm.view: the @codemirror/view module');
    }
    const { Decoration, EditorView, WidgetType } = cm.view;
    const set = StateEffect.define();
    class Caret extends WidgetType {
      constructor(cursor) {
        super();
        this.cursor = cursor;
      }
      eq(other) {
        return other.cursor.node === this.cursor.node;
      }
      toDOM() {
        if (render !== null) return render(this.cursor);
        const element = document.createElement('span');
        element.className = 'syncom-caret';
        element.dataset.node = this.cursor.node;
        return element;
      }
    }
    let stopped = false;
    let shown = 0;
    let published = null;
    let publishing = false;
    const refresh = async () => {
      if (view === null) return;
      const mine = ++shown;
      const found = await presenceCursors(presence, storage, id, path, { key: field });
      if (stopped || mine !== shown) return;
      const length = view.state.doc.length;
      const ranges = [];
      for (const cursor of found) {
        if (cursor.node === presence.node) continue;
        const head = Math.min(cursor.head, length);
        const anchor = Math.min(cursor.anchor, length);
        ranges.push(Decoration.widget({ widget: new Caret(cursor), side: 1 }).range(head));
        if (anchor !== head) {
          const attributes = { 'data-node': cursor.node };
          ranges.push(
            Decoration.mark({ class: className, attributes }).range(Math.min(anchor, head), Math.max(anchor, head)),
          );
        }
      }
      view.dispatch({ effects: set.of(Decoration.set(ranges, true)) });
    };
    const publish = async () => {
      if (publishing || text === null) return;
      publishing = true;
      try {
        await text.flush();
        if (stopped) return;
        const { anchor, head } = view.state.selection.main;
        const tokens = await selectionToTokens(storage, id, path, { anchor, head });
        const next = JSON.stringify(tokens);
        if (stopped || tokens === null || next === published) return;
        published = next;
        await presence.set({ ...(presence.local ?? {}), [field]: tokens });
      } finally {
        publishing = false;
      }
    };
    const changed = () => void refresh();
    started.push(() => {
      presence.on('change', changed);
      void refresh();
      void publish();
    });
    if (view !== null) started[started.length - 1]();
    const decorations = StateField.define({
      create: () => Decoration.none,
      update: (value, tr) => {
        for (const effect of tr.effects) if (effect.is(set)) return effect.value;
        // This editor's selection moved, or the text did: publish once the queue is through.
        if (tr.selection !== undefined || tr.docChanged) queueMicrotask(() => void publish());
        return tr.docChanged ? value.map(tr.changes) : value;
      },
      provide: (self) => EditorView.decorations.from(self),
    });
    return {
      extension: decorations,
      stop: () => {
        stopped = true;
        presence.off('change', changed);
      },
    };
  };

  // CodeMirror commands over an undo manager of the storage's: the field's
  // edits taken back after every edit sent has landed.
  const commands = (manager) => {
    if (!manager || typeof manager.undo !== 'function' || typeof manager.redo !== 'function') {
      throw new TypeError('commands() takes an undo manager: createUndo() from @alexify/syncom/undo');
    }
    const command = (name, can) => () => {
      if (!manager[can]) return false;
      const settled = text === null ? Promise.resolve() : text.flush();
      void settled.then(() => manager[name]());
      return true;
    };
    const undo = command('undo', 'canUndo');
    const redo = command('redo', 'canRedo');
    return {
      undo,
      redo,
      keys: [
        { key: 'Mod-z', run: undo, preventDefault: true },
        { key: 'Mod-y', mac: 'Mod-Shift-z', run: redo, preventDefault: true },
      ],
    };
  };

  return Object.freeze({
    extension: reporter,
    source,
    attach,
    cursors,
    commands,
    get binding() {
      return text;
    },
    stop: () => {
      text?.stop();
      report = null;
    },
  });
};

module.exports = { createCodeMirror, deltaOfChanges, changesOfDelta };
