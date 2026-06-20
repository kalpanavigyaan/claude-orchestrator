/**
 * MCP Streamable HTTP adapter — :4319
 *
 * Bridges any Claude session (fleet-console runner via setMcpServers) to the
 * Rust tool-server-core gRPC service on :50051.  A single Windows process serves
 * all distros and repos; no per-distro install required.
 *
 * Environment:
 *   TOOL_SERVER_MCP_PORT   HTTP port (default 4319)
 *   TOOL_SERVER_GRPC_ADDR  gRPC address (default 127.0.0.1:50051)
 */

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { call, type ToolResult } from "./grpc-client.js";
import { embCall } from "./embeddings-client.js";
import { z } from "zod";

const MCP_PORT = parseInt(process.env.TOOL_SERVER_MCP_PORT ?? "4319", 10);
const GRPC_ADDR = process.env.TOOL_SERVER_GRPC_ADDR ?? "127.0.0.1:50051";
const EMB_ADDR = process.env.EMBEDDINGS_GRPC_ADDR ?? "127.0.0.1:50052";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function grpcToMcp(result: ToolResult): { content: Array<{ type: "text"; text: string }> } {
  if (!result.ok) {
    return { content: [{ type: "text", text: `Error: ${result.error}` }] };
  }
  const text = result.text || (result.data ? JSON.stringify(result.data, null, 2) : "ok");
  return { content: [{ type: "text", text }] };
}

async function grpc(method: string, req: object) {
  return grpcToMcp(await call(method, req, GRPC_ADDR));
}

async function emb(method: string, req: object) {
  try {
    const result = await embCall(method, req, EMB_ADDR);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text" as const, text: `Embeddings service error: ${msg}` }] };
  }
}

// ---------------------------------------------------------------------------
// MCP server + tool registrations
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "tool-server",
  version: "0.1.0",
});

// ─── Default-on tool selection ──────────────────────────────────────────────
// Every registered tool ships its JSON schema in *every* request to Claude, so
// loading all 26 tools has a fixed per-request token cost. By default we expose
// a curated, high-leverage subset that always works without the embeddings
// service. Override with the TOOL_SERVER_TOOLS env var:
//   unset / "default"  → curated set below (recommended)
//   "all"              → register every tool
//   "a,b,c"            → register exactly those tool names
const DEFAULT_TOOLS = [
  "region_extract",  // read just the enclosing function/region (highest ROI: 90% reduction per file read)
  "tds",             // diff hunks ± context instead of whole files
];
const TOOLS_ENV = (process.env.TOOL_SERVER_TOOLS ?? "").trim().toLowerCase();
const TOOL_ALLOW: Set<string> | null =
  TOOLS_ENV === "all"
    ? null
    : new Set(
        TOOLS_ENV === "" || TOOLS_ENV === "default"
          ? DEFAULT_TOOLS
          : TOOLS_ENV.split(",").map((s) => s.trim()).filter(Boolean),
      );

// Wrap server.tool so only allow-listed tools are registered (and announced to
// the model). Filtered-out tools never reach the wire, saving schema tokens.
const registerTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
server.tool = ((name: string, ...rest: unknown[]) => {
  if (TOOL_ALLOW && !TOOL_ALLOW.has(name)) return undefined as never;
  return registerTool(name, ...rest);
}) as typeof server.tool;

// ─── Token tools ────────────────────────────────────────────────────────────

server.tool(
  "rtk",
  "Reduced Token Kernel — greedy-select chunks that fit a token budget, ranked by relevance/density.",
  {
    chunks: z.array(z.object({
      id: z.string().default(""),
      text: z.string(),
      relevance_score: z.number().min(0).max(1).default(0),
    })),
    budget_tokens: z.number().int().min(1).describe("Maximum total tokens in output"),
    query: z.string().default(""),
  },
  async ({ chunks, budget_tokens, query }) =>
    grpc("rtk", { chunks, budget_tokens, query })
);

server.tool(
  "tds",
  "Token Diff Slicer — extract unified diff hunks ± context lines, token-count each hunk.",
  {
    diff: z.string().describe("Unified diff text"),
    context_lines: z.number().int().min(0).default(3),
    budget_tokens: z.number().int().min(0).default(0).describe("0 = no limit"),
  },
  async ({ diff, context_lines, budget_tokens }) =>
    grpc("tds", { diff, context_lines, budget_tokens })
);

server.tool(
  "noise_filter",
  "Noise-Token Filter — strip shebangs, auto-gen headers, redundant blank lines from source.",
  {
    content: z.string(),
    language: z.string().default(""),
    file_path: z.string().default(""),
  },
  async (args) => grpc("noiseFilter", args)
);

server.tool(
  "budget",
  "Context-Window Budgeter — fractional-knapsack packing of items by priority within a token budget.",
  {
    items: z.array(z.object({
      id: z.string(),
      text: z.string(),
      priority: z.number().min(0).max(1),
    })),
    budget_tokens: z.number().int().min(1),
  },
  async ({ items, budget_tokens }) => grpc("budget", { items, budget_tokens })
);

server.tool(
  "cog",
  "Claude Output Governor — truncate text to max_tokens at a sentence/paragraph/line boundary.",
  {
    text: z.string(),
    max_tokens: z.number().int().min(1),
    boundary: z.enum(["sentence", "paragraph", "line"]).default("sentence"),
  },
  async ({ text, max_tokens, boundary }) => grpc("cog", { text, max_tokens, boundary })
);

// ─── Log tools ───────────────────────────────────────────────────────────────

server.tool(
  "log_dedup",
  "Log-Pattern Deduper — replace numbers/UUIDs/hashes with placeholders, group identical templates.",
  {
    log_text: z.string(),
    max_groups: z.number().int().min(1).default(100),
  },
  async ({ log_text, max_groups }) => grpc("logDedup", { log_text, max_groups })
);

server.tool(
  "stack_collapse",
  "Stack-Trace Collapser — keep head+tail+app frames, collapse stdlib/vendor middle frames.",
  {
    stack_text: z.string(),
    head_frames: z.number().int().min(0).default(3),
    tail_frames: z.number().int().min(0).default(3),
  },
  async ({ stack_text, head_frames, tail_frames }) =>
    grpc("stackCollapse", { stack_text, head_frames, tail_frames })
);

server.tool(
  "log_classify",
  "LIC — classify log lines by intent: failure | degraded | normal | verbose.",
  { log_text: z.string() },
  async ({ log_text }) => grpc("logClassify", { log_text })
);

server.tool(
  "trace_minimize",
  "ETM — parse entry/exit execution trace, collapse cold paths below threshold_ms.",
  {
    trace_text: z.string(),
    threshold_ms: z.number().min(0).default(10.0),
  },
  async ({ trace_text, threshold_ms }) => grpc("traceMinimize", { trace_text, threshold_ms })
);

// ─── Memory (Cavemem) ────────────────────────────────────────────────────────

server.tool(
  "mem_set",
  "Cavemem — store a value in the central persistent key-value store with optional TTL.",
  {
    namespace: z.string().describe("e.g. session_id:repo_path"),
    key: z.string(),
    value: z.string(),
    ttl_seconds: z.number().int().min(0).default(0).describe("0 = no expiry"),
  },
  async ({ namespace, key, value, ttl_seconds }) =>
    grpc("memSet", { namespace, key, value, ttl_seconds })
);

server.tool(
  "mem_get",
  "Cavemem — retrieve a stored value.",
  {
    namespace: z.string(),
    key: z.string(),
  },
  async ({ namespace, key }) => grpc("memGet", { namespace, key })
);

server.tool(
  "mem_list",
  "Cavemem — list all keys in a namespace (optionally filtered by prefix).",
  {
    namespace: z.string(),
    prefix: z.string().default(""),
  },
  async ({ namespace, prefix }) => grpc("memList", { namespace, prefix })
);

server.tool(
  "mem_delete",
  "Cavemem — delete a stored value.",
  {
    namespace: z.string(),
    key: z.string(),
  },
  async ({ namespace, key }) => grpc("memDelete", { namespace, key })
);

// ─── AST / Graph tools ───────────────────────────────────────────────────────

server.tool(
  "chunkhound",
  "Chunkhound — walk AST and emit function/class/method boundaries as named chunks.",
  {
    file_path: z.string().describe("Absolute path to source file"),
    kinds: z.array(z.string()).default([]).describe("function|class|method|impl (empty=all)"),
  },
  async ({ file_path, kinds }) => grpc("chunkhound", { file_path, kinds })
);

server.tool(
  "region_extract",
  "AST-Region Extractor — find the AST node enclosing a symbol name or line number.",
  {
    file_path: z.string(),
    symbol: z.string().default(""),
    line: z.number().int().min(0).default(0),
    context_lines: z.number().int().min(0).default(3),
  },
  async ({ file_path, symbol, line, context_lines }) =>
    grpc("regionExtract", { file_path, symbol, line, context_lines })
);

server.tool(
  "symbol_scope",
  "SSE — find symbol definition + all usages across search_roots.",
  {
    file_path: z.string().describe("File where symbol is defined"),
    symbol: z.string(),
    search_roots: z.array(z.string()).default([]),
    context_lines: z.number().int().min(0).default(3),
  },
  async ({ file_path, symbol, search_roots, context_lines }) =>
    grpc("symbolScope", { file_path, symbol, search_roots, context_lines })
);

server.tool(
  "graphify",
  "Graphify — build import/call graph from a seed file and BFS-slice to given depth.",
  {
    file_path: z.string(),
    search_roots: z.array(z.string()).default([]),
    depth: z.number().int().min(1).default(3),
    seed_symbol: z.string().default(""),
  },
  async ({ file_path, search_roots, depth, seed_symbol }) =>
    grpc("graphify", { file_path, search_roots, depth, seed_symbol })
);

server.tool(
  "import_prune",
  "Import-Graph Pruner — return only import nodes reachable within horizon depth.",
  {
    file_path: z.string(),
    search_roots: z.array(z.string()).default([]),
    depth: z.number().int().min(1).default(2),
    seed_symbol: z.string().default(""),
  },
  async ({ file_path, search_roots, depth, seed_symbol }) =>
    grpc("importPrune", { file_path, search_roots, depth, seed_symbol })
);

server.tool(
  "ast_horizon",
  "AST-Horizon Pruner — keep AST subtrees reachable from seed_symbol within depth.",
  {
    file_path: z.string(),
    seed_symbol: z.string(),
    depth: z.number().int().min(1).default(3),
  },
  async ({ file_path, seed_symbol, depth }) =>
    grpc("astHorizon", { file_path, seed_symbol, depth })
);

server.tool(
  "safr",
  "SAFR — detect language of a file and return the recommended tool chain + chunk strategy.",
  {
    file_path: z.string(),
  },
  async ({ file_path }) => grpc("safr", { file_path })
);

server.tool(
  "dhl",
  "DHL — generic BFS horizon limiter on any dependency graph: keep nodes within horizon of seed.",
  {
    edges: z.array(z.object({ from: z.string(), to: z.string() })),
    seed_node: z.string(),
    horizon: z.number().int().min(1).default(3),
  },
  async ({ edges, seed_node, horizon }) => grpc("dhl", { edges, seed_node, horizon })
);

// ─── Phase 4: Embedding tools ─────────────────────────────────────────────

server.tool(
  "rlec_cache",
  "RLEC — embed and cache repo/file chunks into the central semantic index for fast retrieval.",
  {
    namespace: z.string().describe("e.g. repo_path or session_id:repo"),
    entries: z.array(z.object({ id: z.string(), text: z.string() })),
  },
  async ({ namespace, entries }) => emb("Cache", { namespace, entries })
);

server.tool(
  "rlec_search",
  "RLEC — semantic search over a cached namespace: return top-k most relevant chunks.",
  {
    query: z.string(),
    namespace: z.string(),
    top_k: z.number().int().min(1).default(10),
    threshold: z.number().min(0).max(1).default(0.0),
  },
  async ({ query, namespace, top_k, threshold }) => emb("Search", { query, namespace, top_k, threshold })
);

server.tool(
  "semantic_dedupe",
  "Semantic-Chunk Deduper — cluster texts by cosine similarity and return one representative per cluster.",
  {
    texts: z.array(z.string()),
    threshold: z.number().min(0).max(1).default(0.85).describe("Min similarity to merge into same cluster"),
  },
  async ({ texts, threshold }) => emb("Dedupe", { texts, threshold })
);

server.tool(
  "context_rank",
  "Context-Relevance Classifier — score and rank candidate chunks against a query embedding.",
  {
    query: z.string(),
    candidates: z.array(z.string()),
    top_k: z.number().int().min(1).default(10),
  },
  async ({ query, candidates, top_k }) => emb("Rank", { query, candidates, top_k })
);

server.tool(
  "embed",
  "Embed — compute embedding vectors for a list of texts (useful for downstream similarity tasks).",
  {
    texts: z.array(z.string()),
    namespace: z.string().default(""),
  },
  async ({ texts, namespace }) => emb("Embed", { texts, namespace })
);

// ---------------------------------------------------------------------------
// HTTP server — one transport per request (stateless Streamable HTTP)
// ---------------------------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, grpc: GRPC_ADDR, embeddings: EMB_ADDR }));
    return;
  }

  if (req.url === "/mcp" || req.url?.startsWith("/mcp?")) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

httpServer.listen(MCP_PORT, "0.0.0.0", () => {
  const sel = TOOL_ALLOW ? `${TOOL_ALLOW.size} tools [${[...TOOL_ALLOW].join(", ")}]` : "all tools";
  console.log(`[tool-server-mcp] HTTP MCP listening on :${MCP_PORT}  gRPC -> ${GRPC_ADDR}  | exposing ${sel}`);
});

process.on("SIGINT", () => {
  httpServer.close();
  process.exit(0);
});
