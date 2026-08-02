// Cargo compiles every integration-test target as an independent crate. Each target
// imports only the shared source-inspection helpers it needs, so the remaining helpers
// are intentionally unused in that target while still being used by sibling tests.
#![allow(dead_code)]

use std::{fs, path::PathBuf};

pub fn read_source(relative_path: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative_path);
    fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()))
}

pub fn occurrences(source: &str, needle: &str) -> usize {
    source.match_indices(needle).count()
}

pub fn extract_function_body(source: &str, signature: &str) -> Option<String> {
    let start = source.find(signature)?;
    let open = source[start..].find('{')? + start;
    let bytes = source.as_bytes();
    let mut depth = 1i32;
    let mut cursor = open + 1;

    while cursor < bytes.len() && depth > 0 {
        match bytes[cursor] {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            _ => {}
        }
        cursor += 1;
    }

    (depth == 0).then(|| source[open..cursor].to_string())
}

pub fn extract_between(source: &str, start_marker: &str, end_marker: &str) -> Option<String> {
    let start = source.find(start_marker)?;
    let end = source[start..].find(end_marker)? + start + end_marker.len();
    Some(source[start..end].to_string())
}
