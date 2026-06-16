use crate::proto::tools::{
    ChunkhoundRequest, RegionRequest, SseRequest, GraphifyRequest, HorizonRequest, SafrRequest,
    DhlRequest, ToolResult,
};
use crate::tools::token::{ok_result, err_result};
use petgraph::graph::DiGraph;
use petgraph::visit::Bfs;
use std::fs;
use std::path::Path;
use tree_sitter::{Language, Node, Parser};

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

fn detect_language(file_path: &str) -> Option<(&'static str, Language)> {
    let ext = Path::new(file_path).extension()?.to_str()?;
    match ext {
        "py" => Some(("python", tree_sitter_python::LANGUAGE.into())),
        "js" | "mjs" | "cjs" => Some(("javascript", tree_sitter_javascript::LANGUAGE.into())),
        "ts" | "tsx" | "mts" | "cts" => {
            Some(("typescript", tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()))
        }
        "rs" => Some(("rust", tree_sitter_rust::LANGUAGE.into())),
        _ => None,
    }
}

fn read_file(path: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))
}

// ---------------------------------------------------------------------------
// Chunkhound: walk AST to extract function/class/method boundaries
// ---------------------------------------------------------------------------

pub fn chunkhound(req: ChunkhoundRequest) -> ToolResult {
    let (lang_name, language) = match detect_language(&req.file_path) {
        Some(l) => l,
        None => return err_result("unsupported file type; supported: py, js/mjs, ts/tsx, rs"),
    };
    let source = match read_file(&req.file_path) {
        Ok(s) => s,
        Err(e) => return err_result(&e),
    };

    let mut parser = Parser::new();
    parser.set_language(&language).unwrap();
    let tree = match parser.parse(&source, None) {
        Some(t) => t,
        None => return err_result("tree-sitter parse failed"),
    };

    let kinds_filter: Vec<String> = req.kinds.iter().map(|s| s.to_lowercase()).collect();

    let mut chunks: Vec<serde_json::Value> = Vec::new();
    let source_bytes = source.as_bytes();

    fn walk(
        node: Node,
        source: &[u8],
        lang_name: &str,
        kinds_filter: &[String],
        chunks: &mut Vec<serde_json::Value>,
    ) {
        let chunk_kinds: &[&str] = match lang_name {
            "python" => &["function_definition", "class_definition", "decorated_definition"],
            "javascript" | "typescript" => &[
                "function_declaration",
                "function_expression",
                "arrow_function",
                "class_declaration",
                "method_definition",
            ],
            "rust" => &["function_item", "impl_item", "struct_item", "enum_item", "trait_item"],
            _ => &[],
        };

        if chunk_kinds.contains(&node.kind()) {
            let kind = normalize_kind(node.kind());
            if kinds_filter.is_empty() || kinds_filter.contains(&kind) {
                let name = extract_name(&node, source).unwrap_or_default();
                let start = node.start_position();
                let end = node.end_position();
                let text = &source[node.start_byte()..node.end_byte()];
                chunks.push(serde_json::json!({
                    "kind": kind,
                    "name": name,
                    "start_line": start.row + 1,
                    "end_line": end.row + 1,
                    "start_byte": node.start_byte(),
                    "end_byte": node.end_byte(),
                    "text": String::from_utf8_lossy(text),
                }));
            }
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            walk(child, source, lang_name, kinds_filter, chunks);
        }
    }

    walk(tree.root_node(), source_bytes, lang_name, &kinds_filter, &mut chunks);

    ok_result(serde_json::json!({
        "file": req.file_path,
        "language": lang_name,
        "chunks": chunks,
        "count": chunks.len(),
    }))
}

fn normalize_kind(kind: &str) -> String {
    match kind {
        "function_definition" | "function_declaration" | "function_expression" | "function_item" => "function",
        "class_definition" | "class_declaration" => "class",
        "method_definition" => "method",
        "arrow_function" => "arrow_function",
        "impl_item" => "impl",
        "struct_item" => "struct",
        "enum_item" => "enum",
        "trait_item" => "trait",
        _ => kind,
    }.to_string()
}

fn extract_name(node: &Node, source: &[u8]) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "identifier" || child.kind() == "name" || child.kind() == "type_identifier" {
            let bytes = &source[child.start_byte()..child.end_byte()];
            return Some(String::from_utf8_lossy(bytes).to_string());
        }
    }
    None
}

// ---------------------------------------------------------------------------
// AST-Region Extractor: extract enclosing node for a symbol or line
// ---------------------------------------------------------------------------

pub fn region_extract(req: RegionRequest) -> ToolResult {
    let (lang_name, language) = match detect_language(&req.file_path) {
        Some(l) => l,
        None => return err_result("unsupported file type"),
    };
    let source = match read_file(&req.file_path) {
        Ok(s) => s,
        Err(e) => return err_result(&e),
    };
    let mut parser = Parser::new();
    parser.set_language(&language).unwrap();
    let tree = match parser.parse(&source, None) {
        Some(t) => t,
        None => return err_result("parse failed"),
    };
    let source_bytes = source.as_bytes();
    let context_lines = if req.context_lines > 0 { req.context_lines as usize } else { 3 };

    // Find by symbol name or line number
    let target_node = if !req.symbol.is_empty() {
        find_by_symbol(tree.root_node(), source_bytes, &req.symbol)
    } else if req.line > 0 {
        find_by_line(tree.root_node(), (req.line - 1) as usize)
    } else {
        return err_result("provide symbol or line");
    };

    match target_node {
        None => ok_result(serde_json::json!({ "found": false })),
        Some(node) => {
            let start_row = node.start_position().row;
            let end_row = node.end_position().row;
            let lines: Vec<&str> = source.lines().collect();
            let from = start_row.saturating_sub(context_lines);
            let to = (end_row + context_lines + 1).min(lines.len());
            let excerpt = lines[from..to].join("\n");

            ok_result(serde_json::json!({
                "found": true,
                "kind": normalize_kind(node.kind()),
                "start_line": start_row + 1,
                "end_line": end_row + 1,
                "context_from": from + 1,
                "context_to": to,
                "text": excerpt,
            }))
        }
    }
}

fn find_by_symbol<'a>(node: Node<'a>, source: &[u8], symbol: &str) -> Option<Node<'a>> {
    if extract_name(&node, source).as_deref() == Some(symbol) {
        return Some(node);
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if let Some(n) = find_by_symbol(child, source, symbol) {
            return Some(n);
        }
    }
    None
}

fn find_by_line(node: Node, line: usize) -> Option<Node> {
    if node.start_position().row <= line && node.end_position().row >= line {
        // Return deepest matching node
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(n) = find_by_line(child, line) {
                return Some(n);
            }
        }
        return Some(node);
    }
    None
}

// ---------------------------------------------------------------------------
// SSE: Symbol-Scoped Extractor
// ---------------------------------------------------------------------------

pub fn symbol_scope(req: SseRequest) -> ToolResult {
    let (lang_name, language) = match detect_language(&req.file_path) {
        Some(l) => l,
        None => return err_result("unsupported file type"),
    };
    let source = match read_file(&req.file_path) {
        Ok(s) => s,
        Err(e) => return err_result(&e),
    };
    let mut parser = Parser::new();
    parser.set_language(&language).unwrap();
    let tree = match parser.parse(&source, None) {
        Some(t) => t,
        None => return err_result("parse failed"),
    };
    let source_bytes = source.as_bytes();
    let context = if req.context_lines > 0 { req.context_lines as usize } else { 3 };

    // Find definition
    let def_node = find_by_symbol(tree.root_node(), source_bytes, &req.symbol);
    let definition = def_node.map(|n| {
        let lines: Vec<&str> = source.lines().collect();
        let from = n.start_position().row.saturating_sub(context);
        let to = (n.end_position().row + context + 1).min(lines.len());
        serde_json::json!({
            "file": req.file_path,
            "start_line": n.start_position().row + 1,
            "end_line": n.end_position().row + 1,
            "text": lines[from..to].join("\n"),
        })
    });

    // Find usages by grepping search_roots
    let mut usages: Vec<serde_json::Value> = Vec::new();
    let symbol = &req.symbol;
    for root in &req.search_roots {
        grep_symbol_in_dir(Path::new(root), symbol, context, &mut usages, 0);
    }

    ok_result(serde_json::json!({
        "symbol": symbol,
        "definition": definition,
        "usages": usages,
        "usage_count": usages.len(),
    }))
}

fn grep_symbol_in_dir(
    dir: &Path,
    symbol: &str,
    context: usize,
    out: &mut Vec<serde_json::Value>,
    depth: usize,
) {
    if depth > 6 { return; }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if name == "node_modules" || name == "target" || name == ".git" {
                continue;
            }
            grep_symbol_in_dir(&path, symbol, context, out, depth + 1);
        } else if is_source_file(&path) {
            if let Ok(content) = fs::read_to_string(&path) {
                let lines: Vec<&str> = content.lines().collect();
                for (i, line) in lines.iter().enumerate() {
                    if line.contains(symbol) {
                        let from = i.saturating_sub(context);
                        let to = (i + context + 1).min(lines.len());
                        out.push(serde_json::json!({
                            "file": path.to_string_lossy(),
                            "line": i + 1,
                            "context": lines[from..to].join("\n"),
                        }));
                    }
                }
            }
        }
    }
}

fn is_source_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("py" | "js" | "mjs" | "ts" | "tsx" | "rs" | "go" | "c" | "cpp" | "h" | "java")
    )
}

// ---------------------------------------------------------------------------
// Graphify: build import/call graph, BFS slice
// ---------------------------------------------------------------------------

pub fn graphify(req: GraphifyRequest) -> ToolResult {
    let source = match read_file(&req.file_path) {
        Ok(s) => s,
        Err(e) => return err_result(&e),
    };
    let (lang_name, language) = match detect_language(&req.file_path) {
        Some(l) => l,
        None => return err_result("unsupported file type"),
    };
    let mut parser = Parser::new();
    parser.set_language(&language).unwrap();
    let tree = match parser.parse(&source, None) {
        Some(t) => t,
        None => return err_result("parse failed"),
    };
    let source_bytes = source.as_bytes();
    let depth = if req.depth > 0 { req.depth as usize } else { 3 };

    // Extract import edges
    let imports = extract_imports(tree.root_node(), source_bytes, lang_name);
    let mut graph: DiGraph<String, ()> = DiGraph::new();
    let mut node_map: std::collections::HashMap<String, petgraph::graph::NodeIndex> =
        std::collections::HashMap::new();

    let file_node = Path::new(&req.file_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let get_or_add = |g: &mut DiGraph<String, ()>,
                      nm: &mut std::collections::HashMap<String, _>,
                      name: String| {
        *nm.entry(name.clone()).or_insert_with(|| g.add_node(name))
    };

    let root_idx = get_or_add(&mut graph, &mut node_map, file_node.clone());

    for imp in &imports {
        let imp_idx = get_or_add(&mut graph, &mut node_map, imp.clone());
        graph.add_edge(root_idx, imp_idx, ());
    }

    // BFS to depth
    let mut bfs = Bfs::new(&graph, root_idx);
    let mut bfs_depth: std::collections::HashMap<petgraph::graph::NodeIndex, usize> =
        std::collections::HashMap::new();
    bfs_depth.insert(root_idx, 0);

    let mut adjacency: Vec<serde_json::Value> = Vec::new();
    while let Some(nx) = bfs.next(&graph) {
        let d = *bfs_depth.get(&nx).unwrap_or(&0);
        if d >= depth { continue; }
        let neighbors: Vec<String> = graph
            .neighbors(nx)
            .map(|n| graph[n].clone())
            .collect();
        for nb in graph.neighbors(nx) {
            bfs_depth.entry(nb).or_insert(d + 1);
        }
        adjacency.push(serde_json::json!({
            "node": graph[nx],
            "depth": d,
            "edges": neighbors,
        }));
    }

    ok_result(serde_json::json!({
        "seed": file_node,
        "depth": depth,
        "language": lang_name,
        "adjacency": adjacency,
        "node_count": node_map.len(),
    }))
}

fn extract_imports(node: Node, source: &[u8], lang: &str) -> Vec<String> {
    let mut imports = Vec::new();
    let import_kinds: &[&str] = match lang {
        "python" => &["import_statement", "import_from_statement"],
        "javascript" | "typescript" => &["import_declaration", "export_statement"],
        "rust" => &["use_declaration", "extern_crate_declaration"],
        _ => &[],
    };
    fn walk(node: Node, source: &[u8], kinds: &[&str], out: &mut Vec<String>) {
        if kinds.contains(&node.kind()) {
            let text = String::from_utf8_lossy(&source[node.start_byte()..node.end_byte()]);
            // Extract module name: first string_literal or dotted_name
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                let ck = child.kind();
                if ck == "dotted_name" || ck == "identifier" || ck == "string_literal"
                    || ck == "string" || ck == "scoped_identifier"
                {
                    let name = String::from_utf8_lossy(&source[child.start_byte()..child.end_byte()]);
                    out.push(name.trim_matches('"').trim_matches('\'').to_string());
                    break;
                }
            }
        }
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            walk(child, source, kinds, out);
        }
    }
    walk(node, source, import_kinds, &mut imports);
    imports
}

// ---------------------------------------------------------------------------
// Import-Graph Pruner (reuses graphify internals, returns only kept nodes)
// ---------------------------------------------------------------------------

pub fn import_prune(req: GraphifyRequest) -> ToolResult {
    // Same as graphify but returns only the pruned node set (dropped nodes at depth > horizon)
    let result = graphify(req);
    result // graphify already respects depth — pruned = nodes beyond depth are simply not included
}

// ---------------------------------------------------------------------------
// AST-Horizon Pruner
// ---------------------------------------------------------------------------

pub fn ast_horizon(req: HorizonRequest) -> ToolResult {
    let (lang_name, language) = match detect_language(&req.file_path) {
        Some(l) => l,
        None => return err_result("unsupported file type"),
    };
    let source = match read_file(&req.file_path) {
        Ok(s) => s,
        Err(e) => return err_result(&e),
    };
    let mut parser = Parser::new();
    parser.set_language(&language).unwrap();
    let tree = match parser.parse(&source, None) {
        Some(t) => t,
        None => return err_result("parse failed"),
    };
    let source_bytes = source.as_bytes();
    let depth = if req.depth > 0 { req.depth as usize } else { 3 };

    let seed = find_by_symbol(tree.root_node(), source_bytes, &req.seed_symbol);
    let node = match seed {
        Some(n) => n,
        None => return ok_result(serde_json::json!({ "found": false })),
    };

    // Collect subtree within depth
    let mut kept_ranges: Vec<(usize, usize)> = Vec::new();
    fn collect_depth(node: Node, depth: usize, current: usize, out: &mut Vec<(usize, usize)>) {
        if current > depth { return; }
        out.push((node.start_byte(), node.end_byte()));
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            collect_depth(child, depth, current + 1, out);
        }
    }
    collect_depth(node, depth, 0, &mut kept_ranges);

    // Merge overlapping ranges
    kept_ranges.sort();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (s, e) in kept_ranges {
        if let Some(last) = merged.last_mut() {
            if s <= last.1 {
                last.1 = last.1.max(e);
                continue;
            }
        }
        merged.push((s, e));
    }

    let mut result = String::new();
    for (s, e) in &merged {
        result.push_str(&String::from_utf8_lossy(&source_bytes[*s..*e]));
        result.push('\n');
    }

    ok_result(serde_json::json!({
        "found": true,
        "seed_symbol": req.seed_symbol,
        "depth": depth,
        "text": result,
        "ranges": merged.iter().map(|(s, e)| serde_json::json!({ "start_byte": s, "end_byte": e })).collect::<Vec<_>>(),
    }))
}

// ---------------------------------------------------------------------------
// SAFR: Semantic-Aware File Router
// ---------------------------------------------------------------------------

pub fn safr(req: SafrRequest) -> ToolResult {
    let ext = Path::new(&req.file_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    let (language, strategy, recommended_tools) = match ext {
        "py" => (
            "python",
            "function-level chunking, docstring extraction",
            vec!["chunkhound", "region_extract", "symbol_scope", "graphify"],
        ),
        "ts" | "tsx" => (
            "typescript",
            "interface/class/function chunking, type extraction",
            vec!["chunkhound", "region_extract", "symbol_scope", "graphify"],
        ),
        "js" | "mjs" | "cjs" => (
            "javascript",
            "function/arrow/class chunking",
            vec!["chunkhound", "region_extract", "graphify"],
        ),
        "rs" => (
            "rust",
            "function/struct/impl chunking, trait boundary",
            vec!["chunkhound", "region_extract", "ast_horizon", "graphify"],
        ),
        "go" => (
            "go",
            "function/struct chunking (generic grep-based)",
            vec!["region_extract", "symbol_scope"],
        ),
        "md" | "txt" | "rst" => (
            "prose",
            "paragraph-level chunking, heading extraction",
            vec!["noise_filter", "budget", "rtk"],
        ),
        "json" | "yaml" | "toml" | "xml" => (
            "config",
            "section-level chunking",
            vec!["noise_filter", "rtk"],
        ),
        "log" => (
            "log",
            "line dedup + intent classification + stack collapse",
            vec!["log_dedup", "log_classify", "stack_collapse"],
        ),
        _ => (
            "unknown",
            "generic text chunking",
            vec!["noise_filter", "rtk"],
        ),
    };

    ok_result(serde_json::json!({
        "file": req.file_path,
        "language": language,
        "strategy": strategy,
        "recommended_tools": recommended_tools,
    }))
}

// ---------------------------------------------------------------------------
// DHL: Dependency Horizon Limiter (generic graph BFS)
// ---------------------------------------------------------------------------

pub fn dhl(req: DhlRequest) -> ToolResult {
    let horizon = if req.horizon > 0 { req.horizon as usize } else { 3 };
    let mut graph: DiGraph<String, ()> = DiGraph::new();
    let mut node_map: std::collections::HashMap<String, petgraph::graph::NodeIndex> =
        std::collections::HashMap::new();

    let mut get_or_add = |g: &mut DiGraph<String, ()>,
                          nm: &mut std::collections::HashMap<String, _>,
                          name: String| {
        *nm.entry(name.clone()).or_insert_with(|| g.add_node(name))
    };

    for edge in &req.edges {
        let from = get_or_add(&mut graph, &mut node_map, edge.from.clone());
        let to = get_or_add(&mut graph, &mut node_map, edge.to.clone());
        graph.add_edge(from, to, ());
    }

    let seed = match node_map.get(&req.seed_node) {
        Some(&idx) => idx,
        None => return err_result("seed_node not found in edges"),
    };

    let mut bfs = Bfs::new(&graph, seed);
    let mut depths: std::collections::HashMap<petgraph::graph::NodeIndex, usize> =
        std::collections::HashMap::new();
    depths.insert(seed, 0);

    let mut kept: Vec<String> = Vec::new();
    let mut pruned: Vec<String> = Vec::new();

    while let Some(nx) = bfs.next(&graph) {
        let d = *depths.get(&nx).unwrap_or(&0);
        for nb in graph.neighbors(nx) {
            depths.entry(nb).or_insert(d + 1);
        }
        if d <= horizon {
            kept.push(graph[nx].clone());
        } else {
            pruned.push(graph[nx].clone());
        }
    }

    ok_result(serde_json::json!({
        "seed": req.seed_node,
        "horizon": horizon,
        "kept": kept,
        "pruned": pruned,
        "kept_count": kept.len(),
        "pruned_count": pruned.len(),
    }))
}
