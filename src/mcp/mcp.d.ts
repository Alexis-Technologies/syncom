// The `@alexify/syncom/mcp` subpath: the tools an agent calls over a database in the shape of the Model Context
// Protocol — `{ name, description, inputSchema, execute }` per collection; registering them with an MCP server or
// WebMCP's `navigator.modelContext` is the caller's.

import type { Database } from '../../index.js';

/** The subset of JSON Schema the tools declare and `execute()` checks. */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  enum?: readonly unknown[];
}

/** A tool: `execute(args)` checks `args` against `inputSchema` (a TypeError naming the member refused) and answers JSON. */
export interface AgentTool<A extends Record<string, unknown> = Record<string, unknown>, R = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  execute(args?: A): Promise<R>;
}

export interface ToolsOptions {
  /** The collections to make tools for; every one of `db.collections` by default. */
  collections?: readonly string[];
  /** No `insert`, `upsert` or `delete` tool. */
  readOnly?: boolean;
  /** The most rows a `query` answers (1000 by default and at most). */
  limit?: number;
}

/** A record `changes` names: its id, and whether it is deleted now. */
export interface ToolChange {
  id: string;
  deleted: boolean;
}

/** What `changes` and `wait_changes` answer: where to ask from next, and the records changed — null where the log cannot resume at `since`. */
export interface ToolChanges {
  eventId: string;
  changes: ToolChange[] | null;
}

/** The tools over `db`'s collections: query, count, get, changes, wait_changes — and insert, upsert, delete unless `readOnly`. */
export declare function createTools(db: Database, options?: ToolsOptions): AgentTool[];
/** `args` against a schema: a TypeError naming the member refused, nothing otherwise. */
export declare function checkArgs(schema: JsonSchema, args: unknown): void;
/** The most rows a `query` tool answers. */
export declare const MAX_LIMIT: 1000;
