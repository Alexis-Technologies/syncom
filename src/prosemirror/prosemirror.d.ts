// The `@alexify/syncom/prosemirror` subpath: a ProseMirror editor bound to a
// text field through the editor binding. ProseMirror is injected — the
// caller's own prosemirror-* modules — and only its types are named here
// (optional peerDependencies).

import type * as PMModel from 'prosemirror-model';
import type * as PMState from 'prosemirror-state';
import type * as PMTransform from 'prosemirror-transform';
import type * as PMView from 'prosemirror-view';
import type { Storage, TextMethods, TextSpan } from '../../index.js';
import type { TextBinding, TextBindingOptions, PresenceCursor } from '../editor/editor.js';
import type { Presence } from '../presence/presence.js';
import type { UndoManager } from '../undo/undo.js';

/** The prosemirror-* modules the adapter works with: `view` only for `cursorPlugin`. */
export interface ProseMirrorModules {
  model: typeof PMModel;
  state: typeof PMState;
  transform: typeof PMTransform;
  view?: typeof PMView;
}

/** What `attach()` takes: an EditorView, or anything with a state and a dispatch that applies at once. */
export interface ProseMirrorTarget {
  readonly state: PMState.EditorState;
  dispatch(tr: PMState.Transaction): void;
}

export interface CursorPluginOptions {
  /** The key of the presence state the selection travels under; `cursor` by default. */
  field?: string;
  /** The caret of another node; a `<span class="syncom-caret" data-node>` by default. */
  render?: (cursor: PresenceCursor) => HTMLElement | null;
  /** The class of another node's selection; `syncom-selection` by default. */
  className?: string;
}

export interface ProseMirrorBinding {
  readonly key: PMState.PluginKey;
  /** Goes into the editor's state: `EditorState.create({ schema, plugins: [binding.plugin] })`. */
  readonly plugin: PMState.Plugin;
  /** The source the binding's transactions carry — what an undo manager tracks. */
  readonly source: unknown;
  /** The text binding, once attached. */
  readonly binding: TextBinding | null;
  /** Starts the binding over a view whose state has the plugin; once. */
  attach(view: ProseMirrorTarget): TextBinding;
  /** A presence room's cursors as decorations, and this editor's selection published to it. Needs `view`. */
  cursorPlugin(presence: Presence, options?: CursorPluginOptions): PMState.Plugin;
  /** ProseMirror commands over an undo manager of the storage's (`createUndo({ trackedSources: [binding.source] })`). */
  commands(manager: UndoManager): { undo: PMState.Command; redo: PMState.Command };
  stop(): void;
}

/** Binds a ProseMirror editor to text field `path` of record `id`. */
export declare function createProseMirror(
  storage: Storage & TextMethods,
  id: string,
  path: string,
  pm: ProseMirrorModules,
  options?: TextBindingOptions,
): ProseMirrorBinding;

/** A document as typed spans: a marker per block-level node in document order, a textblock's inline content after it. */
export declare function docToSpans(doc: PMModel.Node): TextSpan[];

/** Typed spans as a document of `schema`; what the schema cannot hold is left out. */
export declare function spansToDoc(spans: readonly TextSpan[], schema: PMModel.Schema): PMModel.Node;

/** The text index a document position stands at. */
export declare function indexOfPos(doc: PMModel.Node, pos: number): number;

/** The document position a text index stands at: inside a textblock. */
export declare function posOfIndex(doc: PMModel.Node, index: number): number;
