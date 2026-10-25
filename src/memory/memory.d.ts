// A backend in memory (@alexify/syncom/memory): `memory()` keeps every file in
// a Map — nothing survives the process, two storages opened over one of them
// share it. What a test, a server-side render, a benchmark or a node that
// must not touch the disk opens over; the top layer of a `layered()` backend.

import type { Fsi } from '../../index.js';

export type { Fsi };

export interface MemoryFsi extends Fsi {
  /** Exclusive create: rejects with `EEXIST` when the file is there. */
  create(dir: string, name: string, content: string): Promise<void>;
  /** The number of files held. */
  readonly size: number;
  /** Every file, `dir/name` to content. */
  dump(): Record<string, string>;
}

export declare function memory(): MemoryFsi;
