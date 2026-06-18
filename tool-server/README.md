# Tool Server

A Rust gRPC service exposing **26 code-intelligence tools** over MCP HTTP. Attach it to any fleet-console session so Claude can work with **slices** of files and logs instead of reading entire files — reducing input tokens by up to 88% on typical operations.

```
tool-server/
  core/          Rust gRPC service — 21 token/AST/log/memory tools  (:50051)
  embeddings/    Python FAISS + sentence-transformers service        (:50052)  (optional)
  mcp-adapter/   TypeScript MCP HTTP adapter                        (:4319)
  proto/         Protobuf definitions for both gRPC services
  proof/         Reproducible token-savings measurements
```

---

## Quick start

```powershell
# From the repo root (Windows PowerShell):
.\scripts\start-tool-server.ps1
```

This builds the Rust binary (`cargo build --release`), installs the MCP adapter npm deps, compiles TypeScript, and starts all services. When ready:

```
tool-server is running:
  gRPC core  :50051  (pid 1234)
  MCP HTTP   http://127.0.0.1:4319/mcp  (pid 5678)
```

Enable it in fleet-console by setting `toolServer.enabled: true` in `fleet-console/config/config.yaml`, then restart fleet-console.

```powershell
# Options:
.\scripts\start-tool-server.ps1 -NoBuild              # skip cargo build (binary already compiled)
.\scripts\start-tool-server.ps1 -WithEmbeddings        # also start the Python embeddings service
.\scripts\start-tool-server.ps1 -Tools "all"           # expose all 26 tools (default: curated 8)
.\scripts\start-tool-server.ps1 -Tools "safr,tds,log_dedup"  # expose exact list
```

### Prerequisites

| Requirement | Notes |
|---|---|
| **Rust + Cargo** | Install from [rustup.rs](https://rustup.rs). Only needed for the first build; use `-NoBuild` after. |
| **Node.js 18+** | For the MCP adapter |
| **Python 3.10+** *(optional)* | For the embeddings service. `pip install -e tool-server/embeddings` |

---

## Default tool set

Every registered tool ships its JSON schema in every request to Claude — a fixed input-token cost even for unused tools. The adapter therefore registers a **curated default subset** of 8 tools and lets you override via `TOOL_SERVER_TOOLS`:

```powershell
# Default (curated 8 tools — recommended)
.\scripts\start-tool-server.ps1

# All 26 tools (old behaviour)
.\scripts\start-tool-server.ps1 -Tools "all"

# Custom list
.\scripts\start-tool-server.ps1 -Tools "safr,chunkhound,region_extract,tds,log_dedup"
```

The active selection is printed at startup:
```
[tool-server-mcp] … | exposing 8 tools [safr, chunkhound, region_extract, …]
```

---

## Tools reference

### Token tools

| Tool | Description | Token savings |
|---|---|---|
| **`rtk`** | Reduced Token Kernel — greedy-select chunks that fit a token budget, ranked by relevance/density | Packs only the highest score-per-token chunks; drops the rest |
| **`tds`** | Token Diff Slicer — extract unified diff hunks ± context lines, token-count each hunk | Send changed hunks, not whole files — **87% fewer tokens** on real diffs |
| **`noise_filter`** | Strip shebangs, auto-gen headers, redundant blank lines from source | Removes boilerplate before it reaches the prompt |
| **`budget`** | Context-Window Budgeter — fractional-knapsack packing of items by priority | Fill a hard context budget with the highest-value items |
| **`cog`** | Claude Output Governor — truncate text to max_tokens at a sentence/paragraph/line boundary | Cap oversized output cleanly |

### Log tools

| Tool | Description | Token savings |
|---|---|---|
| **`log_dedup`** | Log-Pattern Deduper — replace numbers/UUIDs/timestamps/paths/hashes with placeholders, group identical templates | Collapse thousands of similar log lines — **63% fewer tokens** on real logs |
| **`stack_collapse`** | Stack-Trace Collapser — keep head + tail + app frames, collapse stdlib/vendor frames | A 200-frame trace becomes a few relevant frames |
| **`log_classify`** | Log-Intent Classifier — label lines: `failure` / `degraded` / `normal` / `verbose` | Claude skips verbose/normal lines and reads only failures |
| **`trace_minimize`** | Execution-Trace Minimizer — collapse cold paths below a time threshold | Keep only hot/slow functions from profiling traces |

### Memory (Cavemem)

| Tool | Description |
|---|---|
| **`mem_set`** | Store a value in the persistent key-value store with optional TTL |
| **`mem_get`** | Retrieve a stored value |
| **`mem_list`** | List all keys in a namespace (with optional prefix filter) |
| **`mem_delete`** | Delete a key |

Backed by a `sled` embedded KV DB (`./data/cavemem`). Persists facts and summaries across sessions so Claude doesn't re-read or re-derive context.

### AST tools

| Tool | Description | Token savings |
|---|---|---|
| **`safr`** | Semantic-Aware File Router — detect language, return recommended tool chain | Routes Claude to slice-returning tools instead of whole-file reads |
| **`chunkhound`** | Walk AST and emit function/class/method chunk boundaries | Load only the relevant chunk |
| **`region_extract`** | Find the AST node enclosing a symbol name or line number | Read one enclosing function, not the whole file — **88% fewer tokens** on real code |
| **`symbol_scope`** | Find a symbol's definition + all usages across search roots | Returns def + snippets only (excludes `node_modules`/`target`/`.git`) |
| **`ast_horizon`** | Keep AST subtrees reachable from a seed symbol within depth N | Limits exploration to a bounded subtree |

Supported languages: `py`, `js`, `ts`, `rs`. `safr` falls back to grep-based tools for other languages.

### Graph tools

| Tool | Description |
|---|---|
| **`graphify`** | Build import/call graph from a seed file and BFS-slice to depth N |
| **`import_prune`** | Return only import nodes reachable within horizon depth (alias of `graphify`) |
| **`dhl`** | Dependency Horizon Limiter — BFS prune any dependency graph given an edge list |

### Embeddings (requires `-WithEmbeddings`)

| Tool | Description |
|---|---|
| **`rlec_cache`** | Embed and cache repo/file chunks into the semantic index |
| **`rlec_search`** | Semantic search over a cached namespace — return top-k relevant chunks |
| **`semantic_dedupe`** | Cluster texts by cosine similarity; keep one representative per cluster |
| **`context_rank`** | Score and rank candidate chunks against a query embedding |
| **`embed`** | Compute raw embedding vectors for a list of texts |

Model: `all-MiniLM-L6-v2` (dim 384), FAISS `IndexFlatIP` (cosine), persisted to `./data/embeddings`.

---

## Default tools (enabled out of the box)

These 8 tools are enabled by default because they:
- Work without the embeddings service
- Return slices instead of whole files/logs (the biggest read-side savings)
- Have measured savings on real data (see below)

| Tool | Measured token saving | Scenario |
|---|---|---|
| `region_extract` | **88.4%** | `createSession()` vs reading the whole 1,790-line `orchestrator.mjs` |
| `tds` | **87.2%** | `git diff` of 9 changed files vs reading all changed files in full |
| `log_dedup` | **63.0%** | 291 npm log lines → 75 templates |
| `noise_filter` | ~0% on clean code | Significant on generated/boilerplate-heavy files |
| `safr` | Routes Claude away from whole-file reads | — |
| `chunkhound` | Enables function-level loading | — |
| `symbol_scope` | Replaces candidate-file grepping | — |
| `stack_collapse` | Compresses long stack traces | — |

**Reproducible proof** — run on your own data:

```bash
cd tool-server/proof
npm install
node prove-token-savings.mjs
# → RESULTS.txt with before/after token counts from your real repo
```

Full analysis: [docs/default-tools-token-savings.md](../docs/default-tools-token-savings.md)

---

## Per-session tool selection (fleet-console UI)

In fleet-console, each session can have its own subset of enabled tools. Open the **Intelligence tab** in the right sidebar:

- The 8 default tools are pre-checked and tagged `default`
- Uncheck any tool to block it — blocked tools are denied in `canUseTool` even in Auto (full access) mode
- Use **Defaults / All / None** quick-picks
- Changes are persisted in the session record and survive server restarts

This is a second layer of control on top of the adapter's allow-list: the adapter controls which schemas are even registered (and sent to Claude), while the per-session selection controls which registered tools Claude is actually allowed to call.

---

## Architecture

```
Claude session (fleet-console runner)
  │  MCP Streamable HTTP  :4319/mcp
  ▼
MCP Adapter (TypeScript)  tool-server/mcp-adapter/src/index.ts
  │  gRPC  :50051                  │  gRPC  :50052
  ▼                                ▼
Rust core  tool-server/core/    Python embeddings  tool-server/embeddings/
21 tools via ToolServer RPC      5 tools via EmbeddingServer RPC
(tiktoken_rs cl100k_base)        (sentence-transformers + FAISS)
```

The MCP adapter is **stateless**: one transport per request (`sessionIdGenerator: undefined`). All state lives in the Rust core (Cavemem `sled` DB) and the embeddings service (FAISS index on disk). The adapter simply routes MCP tool calls to the right gRPC backend.

### Token counting

The Rust core counts tokens with `tiktoken_rs::cl100k_base` (GPT-4 BPE), which is the best available public proxy for Claude's tokenizer. Absolute counts differ slightly from Claude's actual tokenizer, but the direction and relative magnitude of savings are accurate.

---

## WSL / remote sessions

The tool server runs on the **Windows host** and is served to all WSL distros over HTTP. The fleet-console orchestrator injects the Windows host IP (`windowsHostIP`) into each WSL runner's config at spawn time. No per-distro installation is needed.

The MCP adapter binds `0.0.0.0:4319` so WSL runners can reach it at the injected host IP.
