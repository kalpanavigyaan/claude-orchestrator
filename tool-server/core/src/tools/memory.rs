use crate::proto::tools::{MemSetRequest, MemGetRequest, MemListRequest, MemDeleteRequest, ToolResult};
use crate::tools::token::{ok_result, err_result, ok_text};
use sled::Db;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

static DB: OnceLock<Db> = OnceLock::new();

pub fn db() -> &'static Db {
    DB.get_or_init(|| {
        let data_dir = std::env::var("CAVEMEM_DIR")
            .unwrap_or_else(|_| "./data/cavemem".to_string());
        sled::open(&data_dir).expect("failed to open Cavemem sled database")
    })
}

fn make_key(namespace: &str, key: &str) -> Vec<u8> {
    format!("{}\x00{}", namespace, key).into_bytes()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Cavemem set: store a value with optional TTL.
pub fn mem_set(req: MemSetRequest) -> ToolResult {
    if req.namespace.is_empty() || req.key.is_empty() {
        return err_result("namespace and key are required");
    }
    let db = db();
    let expires_at = if req.ttl_seconds > 0 {
        now_secs() + req.ttl_seconds as u64
    } else {
        0
    };

    // Encode as JSON: { "value": ..., "expires_at": ... }
    let record = serde_json::json!({
        "value": req.value,
        "expires_at": expires_at,
    });
    let encoded = serde_json::to_vec(&record).unwrap();
    let key = make_key(&req.namespace, &req.key);
    db.insert(key, encoded).map_err(|e| e.to_string()).unwrap();

    ok_result(serde_json::json!({ "ok": true, "expires_at": expires_at }))
}

/// Cavemem get: retrieve a value by namespace + key.
pub fn mem_get(req: MemGetRequest) -> ToolResult {
    let db = db();
    let key = make_key(&req.namespace, &req.key);
    match db.get(&key) {
        Ok(Some(bytes)) => {
            let record: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
            let expires_at = record["expires_at"].as_u64().unwrap_or(0);
            if expires_at > 0 && now_secs() > expires_at {
                // Expired — delete and return not found
                let _ = db.remove(&key);
                return ok_result(serde_json::json!({ "found": false }));
            }
            ok_result(serde_json::json!({
                "found": true,
                "value": record["value"],
                "expires_at": expires_at,
            }))
        }
        Ok(None) => ok_result(serde_json::json!({ "found": false })),
        Err(e) => err_result(&format!("sled error: {e}")),
    }
}

/// Cavemem list: list all keys in a namespace with optional prefix.
pub fn mem_list(req: MemListRequest) -> ToolResult {
    let db = db();
    let prefix = make_key(&req.namespace, &req.prefix);
    let now = now_secs();
    let mut entries: Vec<serde_json::Value> = Vec::new();

    for result in db.scan_prefix(&prefix) {
        match result {
            Ok((k, v)) => {
                let key_str = String::from_utf8_lossy(&k).to_string();
                let parts: Vec<&str> = key_str.splitn(2, '\x00').collect();
                let key_part = if parts.len() == 2 { parts[1] } else { &key_str };

                let record: serde_json::Value = serde_json::from_slice(&v).unwrap_or_default();
                let expires_at = record["expires_at"].as_u64().unwrap_or(0);
                if expires_at > 0 && now > expires_at {
                    continue; // skip expired
                }
                entries.push(serde_json::json!({
                    "key": key_part,
                    "expires_at": expires_at,
                }));
            }
            Err(_) => continue,
        }
    }

    ok_result(serde_json::json!({
        "namespace": req.namespace,
        "entries": entries,
        "count": entries.len(),
    }))
}

/// Cavemem delete: remove a key.
pub fn mem_delete(req: MemDeleteRequest) -> ToolResult {
    let db = db();
    let key = make_key(&req.namespace, &req.key);
    match db.remove(key) {
        Ok(Some(_)) => ok_result(serde_json::json!({ "deleted": true })),
        Ok(None) => ok_result(serde_json::json!({ "deleted": false, "reason": "not found" })),
        Err(e) => err_result(&format!("sled error: {e}")),
    }
}
