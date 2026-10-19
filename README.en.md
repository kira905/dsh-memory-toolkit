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
| [`memory-engine/`](./memory-engine/README.md) | Memory engine (offline layer): standalone vector store · incremental sync · hash-rotation fallback sweep · hybrid recall (vector + FTS5 + RRF) · document index · startup self-check · local encoding bridge | plain Node ESM + `node:sqlite` |
| [`memory-db-tools/`](./memory-db-tools/README.md) | Memory database toolkit: read-only export / six-way audit analysis / structure probe / feature-word probe / persona overlap / board-ledger probe / zero-write proof / new-session briefing | a set of standalone CLIs |
| [`dsh-memory-local/`](./dsh-memory-local/README.md) | Local memory plugin: a self-maintained fork of upstream `dsh-memory` (cross-session memory + recall prompt section + pointer injection), with build / idempotent deploy / one-command rollback / post-deploy self-check | DSH plugin |
| [`persona-memory-audit.mjs`](./persona-memory-audit.mjs) | Persona ↔ memory audit: pins down "persona body size" and "memory visibility" and reports red past thresholds | single-file CLI |
| [`lib/`](./lib) | Zero-dependency shared bits (argument allow-list / HTTP liveness judgement / zstd frames / session file names / pitfall scoring) | pure modules |

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

> **Subtree exception**: `dsh-memory-local/` is a fork of upstream `dsh-memory` (MIT) and that subtree
> **keeps the upstream MIT license** (see its `package.json` `license` field and `FORK-BASE.json`).
> Everything else is original work, released under AGPL-3.0 + commercial licensing.

## 8. Related repositories

- [`dsh-butler-archive`](https://github.com/kira905/dsh-butler-archive) — DSH autonomous-ops butler (archived)
- [`dsh-session-toolkit`](https://github.com/kira905/dsh-session-toolkit) — session titles / session hygiene
- [`dsh-ecosystem-panel`](https://github.com/kira905/dsh-ecosystem-panel) — ecosystem panel
- [`dsh-firstaid`](https://github.com/kira905/dsh-firstaid) — first-aid / rollback drills

Each companion repo is independent in scope, versioning and licensing.
