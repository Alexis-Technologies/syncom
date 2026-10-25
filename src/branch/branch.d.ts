// The `@alexify/syncom/branch` subpath: a storage forked from another — a
// new identity standing at the parent's state or at a tag of it — merged
// back, or the parent into it, as ops. Platform-neutral; bundles no engine.

import type { Storage, StorageOptions, Version, VersionVector } from '../../index.js';

export interface BranchOptions extends Omit<StorageOptions, 'path'> {
  /** The branch's directory — a new one. */
  path: string;
  /** Fork at a tag of the parent, or at any version its log can still give exactly (`HISTORY_GONE` otherwise), instead of its present. */
  from?: { tag: string } | { at: Version } | null;
}

export interface BranchInfo {
  /** The parent's node id. */
  parent: string;
  /** Where the fork stood: the position, the tag or the version it was taken at (`at` as given — a `Date` as its JSON). */
  forkedAt: { eventId: string; vector: VersionVector; ts: number; tag: string | null; at: Version | null };
  createdAt: number;
}

export interface MergeResult {
  /** Ops applied, and the pages they went in. */
  ops: number;
  pages: number;
  /** The source's log no longer held what the other needed: its state was joined instead, and its vector adopted. */
  joined: boolean;
}

/**
 * A storage forked from `parent` at `path`: a new identity standing at the
 * parent's state (or at `from.tag`, or at `from.at`), opened with the
 * options given (`sync` gets `retention: { ops: 0 }` and `autoStart:
 * false`). Rejects with `BRANCH_EXISTS` when `path` holds any files — a
 * branch or another storage is never taken over — `TAG_NOT_FOUND` for a
 * `from.tag` the parent lacks, `HISTORY_GONE` for a `from.at` its log no
 * longer gives exactly.
 */
export function branch(parent: Storage, options: BranchOptions): Promise<Storage>;
/** Hands `into` everything `source` has that it lacks — ops through `applyRemote`, or a join of state when the source compacted past it. */
export function merge(source: Storage, options: { into: Storage }): Promise<MergeResult>;
/** What a storage opened on a branch's directory was forked from, or `null` for one that is no branch; `CORRUPT` for an unreadable `branch.json`. */
export function branchInfo(storage: Storage): Promise<BranchInfo | null>;
/** Closes a branch and removes its files (the empty directories stay); a storage that is no branch is a `TypeError`, an unreadable `branch.json` `CORRUPT`. */
export function drop(storage: Storage): Promise<void>;
