use crate::proto::tools::{LogRequest, StackRequest, LicRequest, EtmRequest, ToolResult};
use crate::tools::token::{ok_result, err_result};
use regex::Regex;
use std::collections::HashMap;

/// Log-Pattern Deduper.
/// Replaces numbers, UUIDs, hashes with placeholders to form templates; groups identical templates.
pub fn log_dedup(req: LogRequest) -> ToolResult {
    let max_groups = if req.max_groups > 0 { req.max_groups as usize } else { 100 };

    // Compiled once — order matters: UUID before hex hash before plain number
    let uuid_re = Regex::new(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    ).unwrap();
    let hash_re = Regex::new(r"\b[0-9a-f]{8,64}\b").unwrap();
    let num_re = Regex::new(r"\b\d+(\.\d+)?\b").unwrap();
    let ip_re = Regex::new(r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b").unwrap();
    let ts_re = Regex::new(
        r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?"
    ).unwrap();
    let path_re = Regex::new(r"(/[a-zA-Z0-9_.\-]+){2,}").unwrap();

    fn templatize(line: &str, uuid_re: &Regex, hash_re: &Regex, num_re: &Regex,
                  ip_re: &Regex, ts_re: &Regex, path_re: &Regex) -> String {
        let s = ts_re.replace_all(line, "{TS}");
        let s = uuid_re.replace_all(&s, "{UUID}");
        let s = ip_re.replace_all(&s, "{IP}");
        let s = hash_re.replace_all(&s, "{H}");
        let s = path_re.replace_all(&s, "{PATH}");
        num_re.replace_all(&s, "{N}").to_string()
    }

    let mut groups: HashMap<String, Vec<&str>> = HashMap::new();
    for line in req.log_text.lines() {
        let t = templatize(line, &uuid_re, &hash_re, &num_re, &ip_re, &ts_re, &path_re);
        groups.entry(t).or_default().push(line);
    }

    let mut sorted_groups: Vec<(&String, &Vec<&str>)> = groups.iter().collect();
    sorted_groups.sort_by_key(|(_, v)| std::cmp::Reverse(v.len()));
    sorted_groups.truncate(max_groups);

    let result: Vec<serde_json::Value> = sorted_groups
        .into_iter()
        .map(|(template, lines)| {
            serde_json::json!({
                "template": template,
                "count": lines.len(),
                "representative": lines[0],
            })
        })
        .collect();

    ok_result(serde_json::json!({
        "groups": result,
        "total_lines": req.log_text.lines().count(),
        "unique_templates": result.len(),
    }))
}

/// Stack-Trace Collapser.
/// Detects Java/Python/Rust/Node frame patterns; keeps head + tail + app frames.
pub fn stack_collapse(req: StackRequest) -> ToolResult {
    let head = if req.head_frames > 0 { req.head_frames as usize } else { 3 };
    let tail = if req.tail_frames > 0 { req.tail_frames as usize } else { 3 };

    // Frame patterns for different languages
    let java_re = Regex::new(r"^\s+at [\w$.]+\(").unwrap();
    let python_re = Regex::new(r"^\s+File \"[^\"]+\", line \d+").unwrap();
    let rust_re = Regex::new(r"^\s+\d+:\s+0x[0-9a-f]+ - ").unwrap();
    let node_re = Regex::new(r"^\s+at ([\w.<>]+) \(").unwrap();

    // Vendor/stdlib frame indicators to filter from middle
    let stdlib_re = Regex::new(
        r"(java\.|sun\.|com\.sun\.|jdk\.|/usr/lib|site-packages|node_modules|<built-in|core/src/|std::)"
    ).unwrap();

    let lines: Vec<&str> = req.stack_text.lines().collect();
    let mut frames: Vec<(usize, bool)> = Vec::new(); // (line_index, is_app_frame)

    for (i, line) in lines.iter().enumerate() {
        let is_frame = java_re.is_match(line) || python_re.is_match(line)
            || rust_re.is_match(line) || node_re.is_match(line);
        if is_frame {
            let is_app = !stdlib_re.is_match(line);
            frames.push((i, is_app));
        }
    }

    if frames.is_empty() {
        return ok_result(serde_json::json!({
            "text": req.stack_text,
            "collapsed": false,
        }));
    }

    let frame_count = frames.len();
    let keep: std::collections::HashSet<usize> = frames[..head.min(frame_count)]
        .iter()
        .chain(frames[frame_count.saturating_sub(tail)..].iter())
        .chain(frames.iter().filter(|(_, is_app)| *is_app))
        .map(|(i, _)| *i)
        .collect();

    let mut output_lines: Vec<&str> = Vec::new();
    let mut last_was_frame = false;
    let mut skipped = 0usize;

    for (i, line) in lines.iter().enumerate() {
        let is_frame_line = frames.iter().any(|(fi, _)| *fi == i);
        if is_frame_line {
            if !keep.contains(&i) {
                skipped += 1;
                last_was_frame = true;
                continue;
            }
            if last_was_frame && skipped > 0 {
                output_lines.push("    ... [collapsed frames] ...");
                skipped = 0;
            }
        }
        output_lines.push(line);
        last_was_frame = is_frame_line;
    }

    ok_result(serde_json::json!({
        "text": output_lines.join("\n"),
        "collapsed": true,
        "total_frames": frame_count,
        "kept_frames": keep.len(),
    }))
}

/// LIC: Log-Intent Classifier.
/// Classifies log lines by severity and intent.
pub fn log_classify(req: LicRequest) -> ToolResult {
    let error_re = Regex::new(r"(?i)\b(error|exception|fail(ed|ure)?|critical|fatal|panic|crash)\b").unwrap();
    let warn_re = Regex::new(r"(?i)\b(warn(ing)?|deprecated|slow|timeout|retry|degraded)\b").unwrap();
    let info_re = Regex::new(r"(?i)\b(info|start(ed|ing)?|stop(ped|ping)?|connect(ed|ing)?|listen(ing)?|ready|success(ful)?)\b").unwrap();

    let mut classified: Vec<serde_json::Value> = Vec::new();
    for line in req.log_text.lines() {
        let intent = if error_re.is_match(line) {
            "failure"
        } else if warn_re.is_match(line) {
            "degraded"
        } else if info_re.is_match(line) {
            "normal"
        } else {
            "verbose"
        };
        classified.push(serde_json::json!({
            "line": line,
            "intent": intent,
        }));
    }

    // Summary counts
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for item in &classified {
        if let Some(intent) = item["intent"].as_str() {
            *counts.entry(intent).or_insert(0) += 1;
        }
    }

    ok_result(serde_json::json!({
        "lines": classified,
        "summary": counts,
    }))
}

/// ETM: Execution-Trace Minimizer.
/// Parses entry/exit trace with timestamps, collapses cold paths.
pub fn trace_minimize(req: EtmRequest) -> ToolResult {
    let threshold_ms = if req.threshold_ms > 0.0 { req.threshold_ms } else { 10.0 };

    // Expect lines like: "ENTER func_name 1234.56ms" or "EXIT func_name 5678.90ms"
    let enter_re = Regex::new(r"(?i)\bENTER\b\s+(\S+)\s+([\d.]+)").unwrap();
    let exit_re = Regex::new(r"(?i)\bEXIT\b\s+(\S+)\s+([\d.]+)").unwrap();

    struct Frame {
        name: String,
        enter_ms: f32,
    }
    let mut stack: Vec<Frame> = Vec::new();
    let mut durations: Vec<(String, f32)> = Vec::new();

    for line in req.trace_text.lines() {
        if let Some(cap) = enter_re.captures(line) {
            let name = cap[1].to_string();
            let ms: f32 = cap[2].parse().unwrap_or(0.0);
            stack.push(Frame { name, enter_ms: ms });
        } else if let Some(cap) = exit_re.captures(line) {
            let name = &cap[1];
            let ms: f32 = cap[2].parse().unwrap_or(0.0);
            if let Some(pos) = stack.iter().rposition(|f| f.name == *name) {
                let dur = ms - stack[pos].enter_ms;
                durations.push((name.to_string(), dur));
                stack.remove(pos);
            }
        }
    }

    let hot: Vec<serde_json::Value> = durations
        .iter()
        .filter(|(_, dur)| *dur >= threshold_ms)
        .map(|(name, dur)| serde_json::json!({ "function": name, "duration_ms": dur }))
        .collect();

    let cold_count = durations.iter().filter(|(_, dur)| *dur < threshold_ms).count();

    ok_result(serde_json::json!({
        "hot_path": hot,
        "cold_collapsed": cold_count,
        "threshold_ms": threshold_ms,
        "total_frames": durations.len(),
    }))
}
