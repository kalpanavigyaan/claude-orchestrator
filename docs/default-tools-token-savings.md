# Default Tool Set & How It Reduces Tokens

The tool server exposes **26** code-intelligence tools. Every registered tool ships
its name, description, and JSON parameter schema in **every request** to Claude, so
a large menu has a fixed input-token cost *and* makes tool selection noisier — even
for tools that are never called.

To keep Claude fast and cheap, the MCP adapter now exposes a **curated default
subset** of high-leverage tools and lets you change it with one env var.

## How to control the tool set

Set `TOOL_SERVER_TOOLS` when starting the adapter (via
[scripts/start-tool-server.ps1](../scripts/start-tool-server.ps1)):

```powershell
# Curated default subset (recommended) — also the default when unset
.\scripts\start-tool-server.ps1

# Expose every tool (the old behaviour)
.\scripts\start-tool-server.ps1 -Tools "all"

# Expose an exact custom list
.\scripts\start-tool-server.ps1 -Tools "safr,chunkhound,region_extract,tds,log_dedup"
```

| `TOOL_SERVER_TOOLS` value | Tools exposed |
|---|---|
| unset / `default` | the 8 curated tools below |
| `all` | all 26 tools |
| `a,b,c` | exactly those tool names |

The active selection is printed at startup:
`[tool-server-mcp] … | exposing 8 tools [safr, chunkhound, …]`.

## Two layers of control

There are two independent layers, both defaulting to the same curated 8 tools:

1. **Adapter menu (`TOOL_SERVER_TOOLS`)** — controls which tool *schemas* are shipped
   to Claude at all. This is the real input-token win: schemas for excluded tools
   never reach the wire. Set globally at tool-server startup (above).
2. **Per-session selection (Intelligence tab)** — within whatever the adapter exposes,
   each session picks which tools Claude may actually *call*. New sessions start with
   the 8 defaults pre-checked; use **Defaults / All / None** or toggle individual
   tools. Deselected tools are blocked in `canUseTool` (enforced even in auto mode),
   and the selection is persisted in the session record. Unchecking **Enable tool
   server for this session** detaches the toolset entirely and disables the checkboxes.

## The 8 default tools and why each one saves tokens

These are read-side tools that return **slices instead of whole files/logs**, and all
of them work without the optional Python embeddings service.

| Tool | What it does | Why it saves tokens |
|---|---|---|
| **`safr`** | Detects a file's language and returns the recommended tool chain + chunk strategy. No file read. | Routes Claude to a slice-returning tool instead of reading the whole file "to figure out what to do". |
| **`chunkhound`** | Walks the AST and emits function/class/method boundaries as named chunks. | Claude loads only the relevant function instead of the entire file. |
| **`region_extract`** | Returns the AST node enclosing a symbol or line (± context). | Reads one enclosing function, not the whole file, to inspect/edit a symbol. |
| **`symbol_scope`** | Returns a symbol's definition **plus** its usages across search roots (excludes `node_modules`/`target`/`.git`). | Replaces "read every candidate file" with definition + usage snippets only. |
| **`tds`** | Token Diff Slicer — extracts unified-diff hunks ± context and token-counts each. | PR/diff review sends changed hunks, not whole before/after files; can stop at a budget. |
| **`noise_filter`** | Strips shebangs, auto-gen headers, and redundant blank lines from source. | Removes boilerplate before source reaches the prompt; reports `saved_tokens`. |
| **`log_dedup`** | Templatizes numbers/UUIDs/hashes/IPs and groups identical log templates. | Collapses thousands of near-identical log lines into a handful of templates + counts. |
| **`stack_collapse`** | Keeps head + tail + app frames, collapses stdlib/vendor frames. | A 200-frame trace becomes the few frames that matter. |

### Why these 8 (and not the rest)

- **Always-positive, zero setup.** They run on the Rust core alone — no embeddings
  service required — so they never error when embeddings are off.
- **Cover the most common token sinks:** reading code, reviewing diffs, and reading
  logs/stack traces.
- **Small menu = small fixed tax.** ~18 of 26 schemas are removed from every request,
  and fewer choices means faster, more reliable tool selection.

## Optional tools (enable when the task needs them)

Add these to `-Tools` for specific workloads:

| Add | When |
|---|---|
| `rlec_cache`, `rlec_search` | Semantic retrieval over an indexed repo (requires `-WithEmbeddings`). Beats bulk reads once indexed. |
| `mem_set`, `mem_get`, `mem_list`, `mem_delete` | Multi-turn / multi-agent work — persist facts so context isn't re-derived. |
| `graphify`, `ast_horizon` | Cross-file dependency navigation with a bounded BFS horizon. |
| `log_classify`, `trace_minimize` | Debugging / performance sessions. |
| `rtk`, `budget`, `cog` | Orchestrated pipelines that assemble/cap context against a hard token budget. |
| `semantic_dedupe`, `context_rank`, `embed` | Programmatic dedupe/rank/embed of text arrays (requires `-WithEmbeddings`). |

Not recommended by default:

- **`import_prune`** is currently a thin alias of `graphify`
  ([tool-server/core/src/tools/ast.rs](../tool-server/core/src/tools/ast.rs#L398)) — exposing both
  just gives the model two identical tools. Use `graphify`.

## The bigger token wins live in `fleet-console`

Tool selection trims the per-request schema tax. The largest token/cost levers are
config defaults in `fleet-console` — see the full review at
[docs/reviews/2026-06-16-token-efficiency-review.md](reviews/2026-06-16-token-efficiency-review.md):
slow the 5-second usage poll, default extended thinking **off** for unattended
sessions, cap auto-continues with `maxTurns`, and use a cheaper model for light work.
