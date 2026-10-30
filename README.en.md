# dsh-memory-toolkit

**Memory-side tooling for DSH (DeepSeek Harness).** A standalone vector memory engine, a read-only
memory-database audit toolkit, a self-maintained fork of the local memory plugin, and a tiny
persona ↔ memory audit.

All four pieces come from one self-hosted workflow, split out so they can be used together or on their own:
**the engine decides what to remember and how to find it again; the toolkit makes it visible and
fixable; the plugin wires it into a session.**

---

## 1. What's inside

| Directory | What it is | Form |
|---|---|---|
| [`memory-engine/`](./memory-engine/README.md) | Memory engine (offline layer): standalone vector store · incremental sync · hash-rotation fallback sweep · hybrid recall (vector + FTS5 + lexicon BM25 + RRF + degraded fixed-top-K + side-channel recall log) · document index · startup self-check · local encoding bridge | plain Node ESM + `node:sqlite` |
| [`memory-db-tools/`](./memory-db-tools/README.md) | Memory database toolkit: read-only export / six-way audit analysis / structure probe / feature-word probe / persona overlap / board-ledger probe / zero-write proof / new-session briefing | a set of standalone CLIs |
| [`dsh-memory-local/`](./dsh-memory-local/README.md) | Local memory plugin: a self-maintained fork of upstream `dsh-memory` (cross-session memory + recall prompt section + pointer injection), with build / idempotent deploy / one-command rollback / post-deploy self-check | DSH plugin |
| [`persona-memory-audit.mjs`](./persona-memory-audit.mjs) | Persona ↔ memory audit: pins down "persona body size" and "memory visibility" and reports red past thresholds | single-file CLI |
| [`lib/`](./lib) | Zero-dependency shared bits (argument allow-list / HTTP liveness judgement / zstd frames / session file names / pitfall scoring) | pure modules |

## Shared-source notice

Some files in this repository **share a source with an internal production implementation**
(the same engineering effort, evolved over time, with two landing places).

- **How much**: measured by the **line-level shared-source ratio** (among same-named comparable files, how
  many non-empty lines of this repository's files are found in the reference files, multiset-deducted); this
  repository's "≥50% line-share" figure is **64%**.
- **What that means**: this repository is a **distilled export** of that implementation — **neither a verbatim
  copy nor a fully rewritten independent implementation**. Before reading any single file as an "independent
  reference implementation", run the check below.
- **How to re-run it**: the shared-source scanner ships with `dsh-quality-toolkit` as `dsh-sim-scan.mjs`
  (`--repo <this repo> --prod-root <reference root>`); the bucket thresholds and the measurement caliber live
  in its `config/sim-scan.json`, not buried in code.
- **License**: see `LICENSE` at the repository root (when a subdirectory carries its own exception, that
  subdirectory's `LICENSE` wins).

## Recall chain: degradation / second (lexicon) path / hit log — new in 0.2.0

Three long-standing recall problems, each with a fix you can switch off in one move. **No shipped
default changed.**

| Problem | What it does now | Switch | Shipped default |
|---|---|---|---|
| An encode timeout/failure used to mean **zero memories injected for that turn** | Queries are truncated to 256 chars; encoding gets a budget (1500 ms default); timeout / throw / empty vector all **degrade to a fixed top-K** (most recently updated first, 8 by default). The result carries `degraded.mode = "fixed-topk"` and `encodeError.name` | `fallbackTopK` / `encodeTimeoutMs` / `--fallback-top-k` / `--encode-timeout-ms` | degradation **always on** (it only exists on the failure path) |
| Pure vectors are blind to **exact terms**; FTS5 cannot help in Chinese (`unicode61` does not segment CJK) | **Second path**: longest-match segmentation against a jieba dictionary + **BM25** (tf saturation + length normalisation + corpus idf × word specificity), fused with vector/FTS through RRF(k=60) | `enabled` in `memory-engine/dict/lexicon-config.json`, `MEMORY_ENGINE_LEXICON=on/off`, `--lexicon on` | **off** (with it off, results are **byte-identical** to before — see below) |
| You cannot tell afterwards what was recalled, which row matched, or whether it was any good | **Side-channel JSONL**: query / hit ids / scores / degraded flag / timestamp; byte-based rotation + age pruning, so it cannot grow without bound | point it at a directory: `--recall-log <dir>` or `DSH_MEMORY_RECALL_LOG_DIR`; `DSH_MEMORY_RECALL_LOG=off` disables | **off** (a library should not write files as a side effect of a plain query) |

**Why it is built this way** (long form in [`memory-engine/README.md`](./memory-engine/README.md), section "Design rationale"):

- **Degradation goes by recency, not by padding.** With no query vector there is no semantic signal left;
  the most likely useful thing is what was written most recently. Three tiers: the source's `recent()` →
  metadata sorted by `updated_at` → the highest ids in the vector store. Non-empty, deterministic, and
  pinned rows still excluded.
- **The lexicon path ships off.** Its gain is "exact words come back"; its cost is "fusion re-ranks".
  The promise of this repo is "defaults do not change", so it is off and enabled with one config line.
  Once on, `stats.lexiconStatus` flips from `off` to `ok` and hits appear with `sources: ["vector","lexicon"]`.
- **The log ships off.** Queries can be private; a library should not persist them on every call. Turn it on
  by giving a directory, and the bytes / generations / days caps keep it bounded. **Memory text is never
  logged** — ids and scores only.
- **Why not reuse the production patch.** On the production side this is a line-anchored replay patch
  (`patch-*-lexicon.mjs`); that cannot survive a move into a standalone repo. Here it is a module rewritten
  from behaviour, proven equivalent by fixtures and a before/after diff — not by matching sha256.

**Dictionary size and licence.** `词典.txt` (1,029,582 B) + `词频.txt` (219,541 B) come from
[jieba](https://github.com/fxsjy/jieba) `extra_dict/dict.txt.small` (MIT) and are bundled under
`memory-engine/dict/`, about **1.25 MB** in total (`npm pack --dry-run`: tarball **1.1 MB**, unpacked
**2.8 MB**, **140** files). They are bundled because otherwise the feature is unusable right after
`npm i`; `MEMORY_ENGINE_DICT_DIR` can point the assets elsewhere if a packager wants them out of the tarball.

Licensing follows **subtree precedence**: `memory-engine/dict/` keeps the upstream **MIT** licence (full text
and copyright notice in [`dict/LICENSE-词典.md`](./memory-engine/dict/LICENSE-词典.md)), which does **not**
conflict with the repo-level AGPL-3.0 — MIT and AGPL are compatible, and shipping the notice alongside is
enough (the same arrangement as the `dsh-memory-local/` fork). Dictionary files are kept byte-for-byte
(`-text` in `.gitattributes`), so their sha256 can be compared with upstream directly.

**Reproduce the claims:**

```bash
cd memory-engine
node tools/verify-recall-chain.mjs                                  # 15 checks: truncation / degradation / lexicon / log / multi-source / CLI
node tools/verify-recall-chain.mjs --baseline <pre-change lib dir>  # +2 checks: byte-identical results with the lexicon path off
```

## Layered soft eviction + id-band sentinel — new in 0.2.0

Two old problems: memories could only be deleted, never demoted; and when several machines share one
database, nothing shouted when a machine started writing into another machine's id band. One tool each,
and **everything ships dry-run / read-only**.

| Tool | What it does | Usage | Default |
|---|---|---|---|
| `cli/layer-migrate.mjs` | Adds a `layer` column, backfills existing rows into the "default layer" | `--db <db>` (dry run) · `--apply --backup <file>` · `--restore <backup> [--apply]` | **dry run** — no `--apply`, not one byte written |
| `cli/layer-move.mjs` | Moves a **whole layer** into the in-database side table `memories_evicted` (nothing deleted); one command out, one command back | `--layer <name> --apply` · `--back --apply` · `--dump <f>` / `--verify <f>` | **dry run** |
| `cli/band-sentinel.mjs` | Checks whether the *next* new id would land in someone else's band | `--line` · `--apply --out <file>` | **read-only** — even the report file is off by default |

Layer names and the id-band table live in configuration (`memory-engine/config/layers.json`,
`memory-engine/config/bands.json`). No layer name and no machine name is hard-coded in the code.

### Single machine vs. multiple machines: how it degrades

- **Single machine (default)** = exactly one band in the config. The sentinel reads **only the local
  database's** `sqlite_sequence` and checks that the next new id falls inside `[base, base+width)`.
  No ssh, no guessing about peers, no pretending to know another machine. That alone catches the most
  common incident shape: a merge pushes `seq` up, and every new memory afterwards lands in another
  machine's band.
- **Multiple machines (opt-in)** = several bands, and the non-local entries carry
  `remote: { ssh, node, db? }`. Only then are peers probed — and the remote command, alias and node path
  all come from the config file.
- **A peer being unreachable** ⇒ the verdict says "not probed / unreachable" and the **exit code is not 4**
  (this is the false-red learned the hard way: folding "cannot connect" into "the band is broken" produces
  daily alarms that bury the real incident). `4` is reserved for "the local database cannot be read".
  Add `--require-all` if you *want* an unprobed peer to fail (then rc=5).

Verdicts reuse the good half of the production rule: the `seq`-derived next id outside this band ⇒ red;
rows in a **higher** band ⇒ red (a higher id cannot be produced legally by this machine); rows in a
**lower** foreign band ⇒ **disclosed, not red** (historical merge-ins; deleting them would delete memories,
and they do not affect future ids).

### Why nothing touches the database by default

All three commands default to dry-run or read-only, for one reason: they all modify the memory database,
and this repository is a toolkit — it must not decide *when* and *which* database gets touched. Concretely:

- `layer-migrate --apply` **requires** both `--db` and `--backup`: no explicit path ⇒ no write (so a slip
  cannot hit the database in your home directory), and no backup ⇒ refuse (backing up before a schema
  change is a hard gate, not advice).
- Moving is dry-run by default; before a real move you `--dump` a per-row fingerprint, and after moving
  back you `--verify` against it.
- The sentinel is read-only: no writes, no `sqlite_sequence` touch, no VACUUM. To wire it into cron or a
  self-check, pass `--apply --out <file>` explicitly — and machine-readable content **only goes to the
  file, never to stdout** (stdout stays for humans).

### Moving is not deleting

`layer-move` moves a whole layer into the **side table** `memories_evicted` inside the same database file.
Rows are copied verbatim and carry two extra columns: `content_sha` (a fingerprint bound to that row's
content) and `batch`. Moving back **verifies the fingerprints first**: if even one row in the side table
was modified, the whole batch is refused (never "half restored, half lost").

- **Hard invariant**: moved rows + remaining rows == rows before the move (asserted inside the transaction,
  rolled back otherwise).
- **Cost of choosing a side table over a separate database file**: moved rows still occupy space in the
  same file — soft eviction saves context and recall surface, not disk; and the side table has no FTS index,
  so moved rows are invisible to engine recall and can only be fetched with SQL or `--back`. In exchange,
  moving in and out happens in one transaction, the invariant can be asserted on the spot, and no
  easy-to-delete sidecar database is left behind.
- A move that would empty the main table is refused by default (`--force` to proceed): that is usually a
  mistyped layer name.

**Reproduce these claims:**

```bash
cd memory-engine
node test/run.mjs 12-layering       # 21 checks: dry-run zero-write / backfill / idempotence / restore / invariant / fingerprint equality / band red-green controls
node cli/layer-migrate.mjs --help
node cli/layer-move.mjs --help
node cli/band-sentinel.mjs --help
```

## Session logs → memories: the boundaries of distillation — new in 0.2.0

Until now there was exactly one input surface for memories: memories already in the database
(that is what `cli/distill.mjs` consumes). This release adds a second one — **a session log goes in**,
and out come ≤N **traceable, batch-revertible** conclusion rows. Two new files; the old entry point is untouched.

| File | What it does | Ships as |
|---|---|---|
| `lib/session-source.mjs` | Session JSONL adapter: keeps only conclusion sentences that can point back to their source, each carrying **session + line + byte offset + 48-char verbatim anchor** | local-only, zero dependencies |
| `cli/distill-sessions.mjs` | New entry point: extract → budget gate → one model call → snapshot → write back (`distilled` prefix + batch tag) | **dry-run** |

### 1. No summary-style writes

What gets kept is the **original sentence**, not a summary of "what this passage was about".
These never reach the database (each is counted and reported once at the end):

- greetings ("hi", "ok", "got it") and questions (ending in a question mark);
- process narration ("first … then … next … finally", even if the word "decided" happens to appear);
- speculation ("I think / maybe / probably"), unless the same sentence also carries a rule word such as "always/must";
- tool output (tool events, command echoes) and image/thinking blocks;
- any passage longer than the length cap (240 chars by default) — better dropped than stuffed in.

### 2. Only conclusions that point back to their source

Every conclusion carries the sentences it was built from: session id + line number + line byte offset +
**the first 48 characters of the original sentence**. The session id is taken from the `{"type":"session", …}`
line of the input log — **both the `id` and the `sessionId` field names are accepted**; if neither is present,
pass `--session-id`; otherwise everything is labelled `unknown` (provenance degrades to "file name + line number"
and the CLI says so explicitly). The model may only *synthesize*, and it must report which
candidates it used (`refs`); out-of-range refs, empty conclusions, anything over 120 characters, and duplicates are
**dropped outright** (the result's `rejected` list says why). If provenance cannot be established, nothing is written.

Tags (same prefix as the older digest rows — that prefix is what the rollback tool matches):

```
distilled src=<batch key> srcids=<lines,...> date=<YYYYMMDD> sess=<session> run=session:<batch id>
```

### 3. No daily budget, no run

**If `--max-tokens` is not given and the ledger has no budget either, the model is not called at all**: the tool
prints "no daily budget configured ⇒ skipping this round (on purpose)" and exits **0** (that is not an error).
It does **not** inherit the kernel's 150000 default, and it never treats "unconfigured" as "unlimited".
If the budget is already spent for the day, or this one call is estimated to exceed what is left, it also skips
and reports usage.

Measured (deepseek-flash, three self-made fixture sessions, one call each): prompt **344–355** + completion
**80–98** = **424–453 tokens per round** (1311 total; the pre-call estimate is 1018 per round, ~2.3× conservative).
Suggested `--max-tokens 20000`: roughly 19 rounds/day by estimate, ~45 by measurement.

### Reverting: one batch, one key

One run = one batch = one source key, so reverting is one command (and it reuses the existing rollback tool):

```bash
node memory-engine/cli/distill-rollback.mjs --db <memory.db> --key <batch key> --apply
```

The rollback tool takes a `VACUUM INTO` snapshot before deleting and writes a one-shot restore script; its DELETE
statement always carries `AND tags LIKE 'distilled%'`, so even a wrong key cannot touch real memories.
`distill-sessions` takes its own pre-write snapshot (`--snapshot-dir`); **if that snapshot fails, nothing is written**.

### Compressed logs (`.jsonl.zstd`) and "never fail silently"

DSH session logs are zstd-compressed, and they are **multi-frame** (one frame per append). `session-source` walks the
frame structure and decompresses **frame by frame** (node 22.15+ / 24 ship zstd, so still zero dependencies). If it
cannot decode them it raises a plain-language error telling you to decompress first — it never decodes only the first
frame, pretends it is done, or returns an empty result silently.

**Reproduce these claims:**

```bash
cd memory-engine
node test/run.mjs 13-session-distill   # 40 checks: anchors / multi-frame zstd / budget-gate states / snapshot fail-closed / batch revert
node cli/distill-sessions.mjs --help
node cli/distill-sessions.mjs --source <session.jsonl>                      # no budget ⇒ prints "skipped", rc=0
node cli/distill-sessions.mjs --source <session.jsonl> --max-tokens 30000   # dry-run ⇒ lists what would be written
```

## 2. Requirements

- **Node.js ≥ 22** (built-in `node:sqlite`, ESM)
- Windows / Linux / macOS. Every default path is derived from **environment variables or the current
  working directory** — there are no hard-coded machine paths in this repo
- Local vector encoding in `memory-engine/` additionally needs `@huggingface/transformers` (optional)

## 3. Install

```bash
git clone https://github.com/kira905/dsh-memory-toolkit.git
cd dsh-memory-toolkit
npm install          # the root package has no runtime dependencies
```

For local ONNX vector encoding (optional):

```bash
cd memory-engine
npm install          # pulls @huggingface/transformers (large, 300+ MB)
```

You can skip it entirely: the engine also supports an HTTP encoding bridge and a pure FTS5 fallback path.

## 4. Quick start

```bash
# ① Toolkit usage and options (zero side effects)
node memory-db-tools/audit-export.mjs --help

# ② Persona ↔ memory audit (read-only)
node persona-memory-audit.mjs --help

# ③ New-session briefing (read-only)
node memory-db-tools/list-memory-summary.mjs --help

# ④ Engine startup self-check (run npm install inside memory-engine/ first)
cd memory-engine && node cli/selfcheck.mjs --json
```

A typical **quarterly memory audit** (read-only; artifacts go where you point them):

```bash
node memory-db-tools/audit-export.mjs --out ./_audit/memories.json
node memory-db-tools/audit-analyze.mjs --in ./_audit/memories.json --out ./_audit
node memory-db-tools/audit-struct-probe.mjs --in ./_audit/memories.json
node memory-db-tools/audit-verify-unchanged.mjs --baseline ./_audit/memories.json --expect-unchanged
```

## 5. Integration points with DSH

This repo runs **without** DSH, but three seams are deliberate:

| Seam | Notes |
|---|---|
| `DSH_HOME` (default `~/.dsh`) | Memory DB (`memory/memory.db`), vector store (`memory-vectors/`), presets (`.agent-presets/`) and profile overrides (`profiles/<profile>/cordis.patch.yml`) are all derived from it |
| Deployment shape of `dsh-memory-local/` | The plugin **occupies the upstream slot** `profiles/<profile>/node_modules/dsh-memory` (no new package name, no profile rewiring); in `cordis.patch.yml`, `insert.name` must stay `dsh-memory` |
| Environment injection | `MEMORY_ENGINE_*` (db / vectors / model / batch / recall), `DOC_INDEX_*` (document index scope), `DSH_ARCHIVE` (backup root), `DSH_PROD_ROOTS` (production-tree gate) |

## 6. Data and safety

- **Read-only on the memory DB**: the engine and every `audit-*` tool open `memory.db` with
  `readOnly: true`; the only write surfaces are the standalone vector store and output directories you pass in.
- **No telemetry, no exfiltration**; the only outbound calls are the LLM / embedding endpoints you enable yourself.
- **Credentials are read from environment variables or a local config file only**; no secrets are present in the code.
- **Production write gate**: restore / rollback style scripts refuse to touch a production tree unless
  `--allow-production` is given (`--dry-run` is read-only and always allowed).

## 7. License

**AGPL-3.0** (GNU Affero General Public License v3.0) — full text in [LICENSE](./LICENSE).

Free to use and modify for personal, educational and open-source projects. For **closed-source or
commercial** use (where AGPL's copyleft does not apply) please open an issue in
[Issues](https://github.com/kira905/dsh-memory-toolkit/issues) to obtain a **commercial license**.

> **Subtree exceptions**: `dsh-memory-local/` is a fork of upstream `dsh-memory` (MIT) and that subtree
> **keeps the upstream MIT license** (see its `package.json` `license` field and `FORK-BASE.json`).
> `memory-engine/dict/` (dictionary and word-frequency tables) comes from jieba (MIT) and likewise
> **keeps the upstream MIT license** (see `dict/LICENSE-词典.md`).
> Everything else is original work, released under AGPL-3.0 + commercial licensing.
> Subtree licences take precedence: when redistributing the package, the two MIT subtrees need only their
> original copyright notices; AGPL copyleft does not apply to them.

## 8. Related repositories

- [`dsh-butler-archive`](https://github.com/kira905/dsh-butler-archive) — DSH autonomous-ops butler (archived)
- [`dsh-session-toolkit`](https://github.com/kira905/dsh-session-toolkit) — session titles / session hygiene
- [`dsh-ecosystem-panel`](https://github.com/kira905/dsh-ecosystem-panel) — ecosystem panel
- [`dsh-firstaid`](https://github.com/kira905/dsh-firstaid) — first-aid / rollback drills

Each companion repo is independent in scope, versioning and licensing.
