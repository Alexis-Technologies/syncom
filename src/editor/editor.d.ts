// The `@alexify/syncom/editor` subpath: the editor-agnostic binding every
// editor adapter builds on — deltas composed and transformed, a text field
// kept the same as an editor's document, readings as blocks and back, the
// delta between two readings, selections as cursor tokens, a presence
// room's cursors. The storage it takes runs the text plugin.

import type { Storage, TextMethods, DeltaOp, TextSpan, TextBlock } from '../../index.js';
import type { Presence } from '../presence/presence.js';

export type { DeltaOp, TextSpan, TextBlock };

/** A storage with the text plugin's methods — what the binding and the selection helpers take. */
export type TextStorage = Storage & TextMethods;

/** U+FFFC, the character an embed slot reads as. */
export declare const EMBED: '￼';

/** The delta that does `a` then `b`, as one; a document (inserts alone) composed with a delta is the document after it. */
export declare function compose(a: readonly DeltaOp[], b: readonly DeltaOp[]): DeltaOp[];

/**
 * `b` rewritten to apply after `a`, the two made over one base. With
 * `priority`, `a`'s insert comes first where both insert at one index.
 */
export declare function transform(a: readonly DeltaOp[], b: readonly DeltaOp[], priority?: boolean): DeltaOp[];

/** Where `index` is once `delta` has applied; with `priority`, an insert at the index itself stays behind it. */
export declare function transformIndex(index: number, delta: readonly DeltaOp[], priority?: boolean): number;

/** `text` once `delta` has applied, an embed slot as U+FFFC. */
export declare function applyToText(text: string, delta: readonly DeltaOp[]): string;

/** A reading's typed spans as a document delta: text with its marks as attributes, a slot as `{ insert: { embed } }`. */
export declare function spansToDelta(spans: readonly TextSpan[]): DeltaOp[];

/** A document delta (inserts alone) as typed spans; a delta with a retain or a delete is a `TypeError`. */
export declare function deltaToSpans(ops: readonly DeltaOp[]): TextSpan[];

/** Typed spans cut at the block markers — what `blocks()` reads — with a leading block of type `null` for text before the first marker. */
export declare function spansToBlocks(spans: readonly TextSpan[]): TextBlock[];

/** Blocks back to typed spans: a marker per block of a type, then its spans. */
export declare function blocksToSpans(blocks: readonly TextBlock[]): TextSpan[];

/**
 * The delta that takes the reading `before` to the reading `after`: the
 * text's difference as cuts and inserts, a slot's marker changed as
 * `{ retain: 1, attributes: { embed } }`, the marks changed over what stays
 * as attributes — what `applyDelta()` makes the field's edits.
 */
export declare function diffSpans(before: readonly TextSpan[], after: readonly TextSpan[]): DeltaOp[];

/** `diffSpans` over two block lists. */
export declare function diffBlocks(before: readonly TextBlock[], after: readonly TextBlock[]): DeltaOp[];

/** A selection as cursor tokens: what a presence state carries, what `tokensToSelection` reads back. */
export interface SelectionTokens {
  id: string;
  field: string;
  anchor: string;
  head: string;
}

export interface Selection {
  anchor: number;
  head: number;
}

/** A selection as cursor tokens that survive the edits around them; `null` for a field not there. */
export declare function selectionToTokens(
  storage: TextStorage,
  id: string,
  path: string,
  selection: { anchor: number; head?: number },
): Promise<SelectionTokens | null>;

/** The indices the tokens stand at now; `null` once either place is gone. */
export declare function tokensToSelection(storage: TextStorage, tokens: SelectionTokens): Promise<Selection | null>;

/** One cursor of a presence room, resolved: the node, its whole state, the indices. */
export interface PresenceCursor extends Selection {
  node: string;
  state: Record<string, unknown>;
}

/** The cursors a presence room holds on `path` of `id` — each state's `key` (`cursor`) as `SelectionTokens` — resolved to indices now. */
export declare function presenceCursors(
  presence: Presence,
  storage: TextStorage,
  id: string,
  path: string,
  options?: { key?: string },
): Promise<PresenceCursor[]>;

/**
 * What an editor gives the binding: its document replaced whole, a delta
 * applied without being reported back, and its own edits reported as
 * deltas over the document as it was.
 */
export interface EditorAdapter {
  setContents(ops: DeltaOp[]): void;
  updateContents(delta: DeltaOp[]): void;
  onChange(listener: (delta: DeltaOp[]) => void): () => void;
}

export interface TextBindingOptions {
  /** Tells the binding's commits apart in the storage's events; a fresh symbol by default. */
  source?: unknown;
  /** A reload — a reset, an unset, the record gone: what was not sent is dropped. */
  onReset?: () => void;
  /** A failure that reloaded the editor; logged at warn without one. */
  onError?: (error: Error) => void;
  /**
   * The binding stopped: `stop()` (`null`), five failures in a row, or a
   * first load that failed (the last failure). Nothing more is sent or taken.
   */
  onStop?: (reason: Error | null) => void;
}

export interface TextBinding {
  readonly id: string;
  readonly field: string;
  readonly source: unknown;
  /** Resolves once the editor holds the field. */
  readonly ready: Promise<void>;
  /** The field's text as the storage reads it, after every change the binding processed. */
  readonly shadow: string;
  /** Whether an edit is on its way to the field. */
  readonly pending: boolean;
  /** Whether the binding stopped; what was not sent then stays unsent. */
  readonly stopped: boolean;
  /** Resolves once every edit reported so far has landed — or at once when the binding stopped (see `stopped`). */
  flush(): Promise<void>;
  stop(): void;
}

/**
 * Binds an editor, through `adapter`, to text field `path` of record `id`:
 * the editor's edits reach the field as one transaction each — refused as
 * `STALE` and rebased when a peer's edit landed first — and the field's
 * changes reach the editor as deltas, rebased over what it holds beyond
 * the field.
 */
export declare function createTextBinding(
  storage: TextStorage,
  id: string,
  path: string,
  adapter: EditorAdapter,
  options?: TextBindingOptions,
): TextBinding;

/**
 * What an adapter's document differs from the field by, for an editor whose
 * schema cannot hold all a field does or that reads its text otherwise:
 * held — never sent for itself — and composed in front of the editor's next
 * edit. `Base` is the adapter's reading of the field (spans, a string).
 */
export interface Fit<Base> {
  /** The delta from the field (`base`) to the document; empty while the document shows the field as it is. */
  readonly unfit: DeltaOp[];
  /** The field as the binding sees it while the document differs from it. */
  readonly base: Base | null;
  /** The field reads as `base`, the document differs from it by `unfit` (`back` the other way, when known). */
  hold(base: Base | null, unfit?: DeltaOp[], back?: DeltaOp[] | null): void;
  /** The delta to send for the editor's edit `local`: what the field lacked of the document, then the edit. */
  send(local: DeltaOp[], base: Base | null): DeltaOp[];
  /** A field index as the document's. */
  toDoc(index: number): number;
  /** A document index as the field's. */
  toField(index: number): number;
}

/** A fit over the document `read()` reads, `diff(from, to)` the delta between two of its readings. */
export declare function createFit<Base>(read: () => Base, diff: (from: Base, to: Base) => DeltaOp[]): Fit<Base>;

/** What `undoSteps` takes: an undo manager of the storage's (`createUndo()` of @alexify/syncom/undo). */
export interface UndoStepsManager {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  undo(): unknown;
  redo(): unknown;
}

/** Whether there is a step to take; with `run`, it is taken once the binding's edits have landed. */
export interface UndoSteps {
  undo(run: boolean): boolean;
  redo(run: boolean): boolean;
}

/**
 * Undo and redo for an adapter's commands: a step is taken once every edit
 * the binding (`binding()`, null before it is made) sent has landed; a
 * failure goes to `report`.
 */
export declare function undoSteps(
  manager: UndoStepsManager,
  binding: () => TextBinding | null,
  report: (error: Error) => void,
): UndoSteps;

/** How an adapter reports a failure of its own work (cursors, undo): to `onError`, or a warn `event` on the storage's logger. */
export declare function failureReporter(
  storage: Storage,
  id: string,
  path: string,
): (event: string, onError?: (error: Error) => void) => (error: Error) => void;
