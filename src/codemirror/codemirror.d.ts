// The `@alexify/syncom/codemirror` subpath: a CodeMirror 6 editor bound to a
// text field through the editor binding. CodeMirror is injected — the
// caller's own @codemirror/state and @codemirror/view — and only its types
// are named here (optional peerDependencies).

import type * as CMState from '@codemirror/state';
import type * as CMView from '@codemirror/view';
import type { Storage, TextMethods, DeltaOp } from '../../index.js';
import type { TextBinding, TextBindingOptions, PresenceCursor } from '../editor/editor.js';
import type { Presence } from '../presence/presence.js';
import type { UndoManager } from '../undo/undo.js';

/** The CodeMirror modules the adapter works with: `view` only for `cursors`. */
export interface CodeMirrorModules {
  state: typeof CMState;
  view?: typeof CMView;
}

/** What `attach()` takes: an EditorView, or anything with a state and a dispatch that applies at once. */
export interface CodeMirrorTarget {
  readonly state: CMState.EditorState;
  dispatch(...specs: CMState.TransactionSpec[]): void;
}

export interface CodeMirrorCursorOptions {
  /** The key of the presence state the selection travels under; `cursor` by default. */
  field?: string;
  /** The class of another node's selection; `syncom-selection` by default. */
  className?: string;
  /** The caret of another node; a `<span class="syncom-caret" data-node>` by default. */
  render?: (cursor: PresenceCursor) => HTMLElement;
}

export interface CodeMirrorBinding {
  /** Goes into the editor's state: `EditorState.create({ doc: '', extensions: [binding.extension] })`. */
  readonly extension: CMState.Extension;
  /** The source the binding's transactions carry — what an undo manager tracks. */
  readonly source: unknown;
  /** The text binding, once attached. */
  readonly binding: TextBinding | null;
  /** Starts the binding over a view whose state has the extension; once. */
  attach(view: CodeMirrorTarget): TextBinding;
  /** A presence room's cursors as decorations, and this editor's selection published to it. Needs `view`. */
  cursors(presence: Presence, options?: CodeMirrorCursorOptions): { extension: CMState.Extension; stop(): void };
  /** CodeMirror commands over an undo manager of the storage's, and the keys for `keymap.of()`. */
  commands(manager: UndoManager): { undo: CMView.Command; redo: CMView.Command; keys: CMView.KeyBinding[] };
  /**
   * The field's index at document offset `pos`, through the line breaks the
   * editor reads otherwise until its next edit sends them; after `attach()`.
   */
  indexOf(pos: number): number;
  /** The document offset at the field's index `index`; after `attach()`. */
  posOf(index: number): number;
  stop(): void;
}

/** Binds a CodeMirror editor to text field `path` of record `id`. */
export declare function createCodeMirror(
  storage: Storage & TextMethods,
  id: string,
  path: string,
  cm: CodeMirrorModules,
  options?: TextBindingOptions,
): CodeMirrorBinding;

/** A ChangeSet as a delta over the document before it. */
export declare function deltaOfChanges(changes: CMState.ChangeSet): DeltaOp[];

/** A delta as change specs over the document it applies to. */
export declare function changesOfDelta(delta: readonly DeltaOp[]): CMState.ChangeSpec[];
