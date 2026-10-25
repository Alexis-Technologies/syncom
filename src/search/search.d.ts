// The `@alexify/syncom/search` subpath: the trigram text index behind `$text`.
// Give `createSearch()` to `open({ search })`; the catalog feeds it each
// searchable record's text and asks it to rank a query. Platform-neutral.

import type { TextIndex } from './index.js';

export type { TextIndex } from './index.js';

export interface SearchOptions {
  /** The share (0 to 1) of a query's distinct trigrams a record must hold to match; 0.3 by default. */
  minOverlap?: number;
}

/** Index text: NFD, combining marks stripped, lower case, letters and digits only, one space between words. */
export function normalize(text: unknown): string;
/** The per-word, space-padded trigrams of `text`, normalized. */
export function trigrams(text: unknown): string[];
/** A factory for `open({ search })`: one TF-IDF-ranked trigram index per searchable entity. */
export function createSearch(options?: SearchOptions): (entity: string) => TextIndex & { readonly size: number };
