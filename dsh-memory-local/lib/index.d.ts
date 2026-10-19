// FORK-EDIT(2026-10-14): R1 解耦 —— 纯类型面一律 `import type`（编译期擦除，不绑运行时符号；
// 改前这两行是 R1 hard 的另一半）。
import type z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";

//#region src/store.d.ts

/**
 * SQLite-backed memory store: a plain `memories` table with an external-content
 * FTS5 index kept in sync by triggers. Owned entirely by this package — the
 * harness's own SQLite backends index sessions, not durable user facts.
 * @module dsh-memory/store
 */
/** Monotonic on-disk schema version; a mismatch rebuilds the derived index. */
declare const SCHEMA_VERSION = 1;
/** One stored memory as tools and the prompt section see it. */
interface MemoryRecord {
  id: number;
  text: string;
  /** Normalized, space-joined tag list; empty string when untagged. */
  tags: string;
  /** Pinned memories always render in the prompt section, ahead of recent ones. */
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}
/** A search hit: the record plus its FTS rank (lower is a better match). */
interface MemoryMatch extends MemoryRecord {
  rank: number;
}
/**
 * Normalize a tag list to the lowercase, deduplicated, space-joined form the
 * FTS index stores, so `Foo`, `foo`, and a repeated `foo` all match `foo`.
 * @param tags - tags as supplied by the model or config.
 * @returns the normalized space-joined list, empty when nothing survives.
 */
declare function normalizeTags(tags: readonly string[]): string;
/**
 * Compile a free-text query into an FTS5 MATCH expression. Every token is
 * quoted, so FTS5 operators a model happens to type (`OR`, `*`, `-`, `"`) are
 * matched literally instead of changing the query's meaning or raising a
 * syntax error mid-tool-call.
 * @param query - the raw query text.
 * @returns the MATCH expression, or undefined when the query has no usable token.
 */
declare function compileMatch(query: string): string | undefined;
/**
 * The durable memory store. One instance owns one SQLite connection; `close()`
 * is idempotent and runs from the plugin's disposer.
 */
declare class MemoryStore {
  #private;
  /**
   * Open (creating if absent) the store at `path`, applying the schema.
   * @param path - database file path, or `:memory:` for an ephemeral store.
   */
  constructor(path: string);
  /**
   * Store one memory.
   * @param text - the fact to remember.
   * @param tags - normalized tag list.
   * @param pinned - whether it always renders in the prompt section.
   * @returns the new record.
   */
  write(text: string, tags: string, pinned: boolean): MemoryRecord;
  /**
   * Full-text search over memory text and tags, best match first.
   * @param query - free-text query; FTS operators in it are matched literally.
   * @param limit - maximum hits to return.
   * @returns the ranked matches, empty when the query has no usable token.
   */
  search(query: string, limit: number): MemoryMatch[];
  /**
   * The memories the prompt section renders: pinned first, then most recently
   * updated, with no record repeated.
   * @param recentCount - how many unpinned recent memories to include.
   * @returns pinned records followed by recent ones.
   */
  forPrompt(recentCount: number): MemoryRecord[];
  /**
   * Delete one memory.
   * @param id - the record id.
   * @returns whether a record was deleted.
   */
  forget(id: number): boolean;
  /**
   * Total stored memories.
   * @returns the row count.
   */
  count(): number;
  /** Close the connection; idempotent, so plugin disposal and tests may both call it. */
  close(): void;
}
//#endregion
//#region src/index.d.ts
declare const name = "memory";
declare const inject: string[];
/** Plugin config. Every bound is a field: none of these are safe to hardcode across deployments. */
interface Config {
  /**
   * SQLite file for this deployment's memories, or `:memory:` for an ephemeral
   * store. Required: a code-side default would silently scatter durable user
   * facts into whatever directory the harness happened to start in. The shipped
   * bundle patch supplies `dshHomePath('memory/memory.db')`.
   */
  path: string;
  /** Unpinned recent memories rendered in the prompt section. */
  promptRecentCount: number;
  /** Cap on the rendered prompt section; memories past it are dropped, pinned ones first to survive. */
  promptMaxChars: number;
  /** Maximum characters accepted for one memory. */
  maxTextChars: number;
  /** Default `limit` for `memory_search` when the model omits it. */
  searchLimitDefault: number;
  /** Hard cap on `memory_search` results, whatever the model asks for. */
  searchLimitMax: number;
  /** Prompt-section order; `-100` is the harness identity and `0` the persona. */
  promptOrder: number;
}
declare const Config: z<Config>;
/**
 * Open the store, register the three tools, and contribute the recall section.
 * @param ctx - plugin context; the store, tools, and section are disposed with it.
 * @param config - validated {@link Config}.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, MemoryMatch, MemoryRecord, MemoryStore, SCHEMA_VERSION, apply, compileMatch, inject, name, normalizeTags };