// The `@alexify/syncom/order` subpath: fractional indexes as strings that
// sort with `<` — a position for a record among its siblings, kept in an
// ordinary register field and ordered by `order()`. Platform-neutral.

export interface BetweenOptions {
  /** Random digits appended to the key, so two nodes inserting between the same keys at once rarely clash; 0 by default. */
  jitter?: number;
}

/** A key that sorts between `lower` and `upper`; `null` or `undefined` leaves a side open. Throws RangeError for bounds out of order. */
export function between(lower?: string | null, upper?: string | null, options?: BetweenOptions): string;
/** `n` increasing keys between the bounds, spread evenly. */
export function spread(
  lower: string | null | undefined,
  upper: string | null | undefined,
  n: number,
  options?: BetweenOptions,
): string[];
/** The order of two keys: -1, 0 or 1 — what `a < b` says. */
export function compare(a: string, b: string): -1 | 0 | 1;
/** Whether `key` is a well-formed fractional index. */
export function isKey(key: unknown): boolean;
