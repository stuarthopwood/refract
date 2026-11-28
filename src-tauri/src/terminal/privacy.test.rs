// SC-005: terminal bytes never leave the app except to the renderer's channel. This is the source scan: it
// fails when a function handling a buffer (or any file on the byte path) could log, print or panic with it.
// `privacy_e2e.test.rs` runs the same promise end to end.

use std::path::Path;

/// Macros that print, log or panic with their arguments.
const BANNED: &[&str] = &[
    "log::",
    "tracing::",
    "println!",
    "eprintln!",
    "print!",
    "eprint!",
    "dbg!",
    "panic!",
    "assert_eq!",
    "assert_ne!",
    "debug_assert_eq!",
    "debug_assert_ne!",
    "unreachable!",
    "todo!",
    "unimplemented!",
];

/// Calls that build an error or message text from their arguments.
const MESSAGE_BUILDERS: &[&str] = &[
    "format!",
    "write!",
    "writeln!",
    "IpcError::new",
    "invalid_argument",
    "PtyError",
];

/// Parameter names that mean terminal text when the type is a string.
const BUFFER_NAMES: &[&str] = &[
    "data", "bytes", "buf", "buffer", "text", "output", "chunk", "snapshot", "input", "frame",
];

/// Files that move terminal bytes: no banned macro may appear anywhere in them.
const BYTE_PATH: &[&str] = &[
    "frame.rs",
    "handlers.rs",
    "markers.rs",
    "pty.rs",
    "ring.rs",
    "stream.rs",
    "tab.rs",
];

/// Files that never see bytes; only their buffer-taking functions are held to the rule. A new file must
/// be listed here or in `BYTE_PATH`, so it cannot skip the scan unnoticed.
const OTHER: &[&str] = &["guard.rs", "limits.rs", "mod.rs", "persist.rs", "shell.rs"];

fn is_ident(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn blank(out: &mut [u8], from: usize, to: usize) {
    let to = to.min(out.len());
    for byte in &mut out[from.min(to)..to] {
        if *byte != b'\n' {
            *byte = b' ';
        }
    }
}

/// `src` with comments and the insides of string and char literals blanked, same length and line breaks.
fn mask(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out = bytes.to_vec();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                let end = src[i..].find('\n').map_or(bytes.len(), |p| i + p);
                blank(&mut out, i, end);
                i = end;
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                let end = src[i + 2..].find("*/").map_or(bytes.len(), |p| i + p + 4);
                blank(&mut out, i, end);
                i = end;
            }
            b'"' => {
                let mut j = i + 1;
                while j < bytes.len() && bytes[j] != b'"' {
                    j += if bytes[j] == b'\\' { 2 } else { 1 };
                }
                blank(&mut out, i + 1, j);
                i = j + 1;
            }
            b'r' if i == 0
                || !is_ident(bytes[i - 1])
                || (bytes[i - 1] == b'b' && (i == 1 || !is_ident(bytes[i - 2]))) =>
            {
                let mut j = i + 1;
                while bytes.get(j) == Some(&b'#') {
                    j += 1;
                }
                if bytes.get(j) == Some(&b'"') {
                    let closing = format!("\"{}", "#".repeat(j - i - 1));
                    let start = j + 1;
                    let end = src[start..]
                        .find(&closing)
                        .map_or(bytes.len(), |p| start + p);
                    blank(&mut out, start, end);
                    i = end + closing.len();
                } else {
                    i += 1;
                }
            }
            b'\'' => {
                if bytes.get(i + 1) == Some(&b'\\') {
                    let end = src[i + 3..].find('\'').map_or(bytes.len(), |p| i + 3 + p);
                    blank(&mut out, i + 1, end);
                    i = end + 1;
                } else {
                    let width = src[i + 1..].chars().next().map_or(0, char::len_utf8);
                    if width > 0 && bytes.get(i + 1 + width) == Some(&b'\'') {
                        blank(&mut out, i + 1, i + 1 + width);
                        i += width + 2;
                    } else {
                        i += 1;
                    }
                }
            }
            _ => i += 1,
        }
    }
    String::from_utf8(out).expect("blanking whole literals keeps UTF-8 valid")
}

/// Index of the bracket closing the one at `open`, in masked text.
fn closer(masked: &[u8], open: usize) -> Option<usize> {
    let (up, down) = match masked[open] {
        b'(' => (b'(', b')'),
        b'{' => (b'{', b'}'),
        b'[' => (b'[', b']'),
        _ => return None,
    };
    let mut depth = 0usize;
    for (index, &byte) in masked.iter().enumerate().skip(open) {
        if byte == up {
            depth += 1;
        } else if byte == down {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}

fn line_of(text: &str, index: usize) -> usize {
    text[..index].bytes().filter(|&b| b == b'\n').count() + 1
}

/// Where `pattern` starts in `masked`, not as the tail of a longer name.
fn occurrences(masked: &str, pattern: &str) -> Vec<usize> {
    masked
        .match_indices(pattern)
        .map(|(at, _)| at)
        .filter(|&at| at == 0 || !is_ident(masked.as_bytes()[at - 1]))
        .collect()
}

fn has_word(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(at, _)| {
        let before = at == 0 || !is_ident(text.as_bytes()[at - 1]);
        let after = text
            .as_bytes()
            .get(at + word.len())
            .is_none_or(|&b| !is_ident(b));
        before && after
    })
}

struct Function {
    name: String,
    buffer_params: Vec<String>,
    body: Option<(usize, usize)>,
}

/// Splits a parameter list at its top-level commas; `->` inside a closure type is not a bracket.
fn split_params(params: &str) -> Vec<&str> {
    let bytes = params.as_bytes();
    let mut parts = Vec::new();
    let (mut depth, mut start) = (0i32, 0);
    for (index, &byte) in bytes.iter().enumerate() {
        match byte {
            b'(' | b'[' | b'{' | b'<' => depth += 1,
            b'>' if index > 0 && bytes[index - 1] == b'-' => {}
            b')' | b']' | b'}' | b'>' => depth -= 1,
            b',' if depth == 0 => {
                parts.push(&params[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    parts.push(&params[start..]);
    parts
}

fn is_buffer(name: &str, ty: &str) -> bool {
    ty.contains("[u8]")
        || ty.contains("Vec<u8>")
        || ty.contains("Bytes")
        || (BUFFER_NAMES.contains(&name) && (ty.contains("str") || ty.contains("String")))
}

fn functions(src: &str, masked: &str) -> Vec<Function> {
    let bytes = masked.as_bytes();
    let mut found = Vec::new();
    for at in occurrences(masked, "fn ") {
        let mut cursor = at + 3;
        let name_len = masked[cursor..]
            .bytes()
            .take_while(|&b| is_ident(b))
            .count();
        if name_len == 0 {
            continue;
        }
        let name = masked[cursor..cursor + name_len].to_string();
        cursor += name_len;
        if bytes.get(cursor) == Some(&b'<') {
            let mut depth = 0i32;
            while cursor < bytes.len() {
                match bytes[cursor] {
                    b'<' => depth += 1,
                    b'>' if bytes[cursor - 1] != b'-' => depth -= 1,
                    _ => {}
                }
                cursor += 1;
                if depth == 0 {
                    break;
                }
            }
        }
        if bytes.get(cursor) != Some(&b'(') {
            continue;
        }
        let Some(close) = closer(bytes, cursor) else {
            continue;
        };
        let buffer_params = split_params(&src[cursor + 1..close])
            .into_iter()
            .filter_map(|part| {
                let (name, ty) = part.split_once(':')?;
                let name = name.trim().trim_start_matches("mut ").trim();
                is_buffer(name, ty).then(|| name.to_string())
            })
            .collect();
        let mut depth = 0i32;
        let mut body = None;
        for (index, &byte) in bytes.iter().enumerate().skip(close + 1) {
            match byte {
                b'(' | b'[' => depth += 1,
                b')' | b']' => depth -= 1,
                b';' if depth == 0 => break,
                b'{' if depth == 0 => {
                    body = closer(bytes, index).map(|end| (index, end));
                    break;
                }
                _ => {}
            }
        }
        found.push(Function {
            name,
            buffer_params,
            body,
        });
    }
    found
}

/// What the scan saw and what it refused.
#[derive(Default)]
struct Scan {
    buffer_functions: Vec<String>,
    violations: Vec<String>,
}

fn banned_hits(file: &str, masked: &str, base: usize, range: &str) -> Vec<String> {
    BANNED
        .iter()
        .flat_map(|pattern| occurrences(range, pattern))
        .map(|at| format!("{file}:{} uses a banned macro", line_of(masked, base + at)))
        .collect()
}

fn scan_source(file: &str, src: &str, whole_file: bool) -> Scan {
    let masked = mask(src);
    let mut scan = Scan::default();
    if whole_file {
        scan.violations
            .extend(banned_hits(file, &masked, 0, &masked));
    }
    for function in functions(src, &masked) {
        if function.buffer_params.is_empty() {
            continue;
        }
        scan.buffer_functions
            .push(format!("{file}::{}", function.name));
        let Some((open, close)) = function.body else {
            continue;
        };
        let body = &masked[open..=close];
        if !whole_file {
            scan.violations.extend(
                banned_hits(file, &masked, open, body)
                    .into_iter()
                    .map(|hit| format!("{hit} in `{}`, which takes a buffer", function.name)),
            );
        }
        for builder in MESSAGE_BUILDERS {
            for at in occurrences(body, builder) {
                let after = open + at + builder.len();
                let Some(args_open) = masked[after..]
                    .bytes()
                    .position(|b| !b.is_ascii_whitespace() && b != b'!')
                    .map(|p| after + p)
                    .filter(|&p| masked.as_bytes()[p] == b'(')
                else {
                    continue;
                };
                let Some(args_close) = closer(masked.as_bytes(), args_open) else {
                    continue;
                };
                let args = &src[args_open..=args_close];
                if let Some(name) = function.buffer_params.iter().find(|n| has_word(args, n)) {
                    scan.violations.push(format!(
                        "{file}:{} puts `{name}` into a message in `{}`",
                        line_of(&masked, open + at),
                        function.name
                    ));
                }
            }
        }
    }
    scan
}

fn terminal_sources() -> Vec<(String, String)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/terminal");
    let mut files: Vec<(String, String)> = std::fs::read_dir(&dir)
        .expect("src/terminal is readable")
        .map(|entry| entry.expect("directory entry").path())
        .filter_map(|path| {
            let name = path.file_name()?.to_str()?.to_string();
            (name.ends_with(".rs") && !name.ends_with(".test.rs")).then_some((name, path))
        })
        .map(|(name, path)| {
            (
                name,
                std::fs::read_to_string(path).expect("source is UTF-8"),
            )
        })
        .collect();
    files.sort();
    files
}

#[test]
fn every_terminal_source_file_is_covered_by_the_scan() {
    let names: Vec<String> = terminal_sources()
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    let mut covered: Vec<&str> = BYTE_PATH.iter().chain(OTHER).copied().collect();
    covered.sort_unstable();

    assert_eq!(names, covered);
}

#[test]
fn no_function_that_takes_a_buffer_can_log_print_panic_or_put_it_in_a_message() {
    let mut seen = Vec::new();
    let mut violations = Vec::new();
    for (name, src) in terminal_sources() {
        let scan = scan_source(&name, &src, BYTE_PATH.contains(&name.as_str()));
        seen.extend(scan.buffer_functions);
        violations.extend(scan.violations);
    }

    // The scan is only worth its pass if it found the functions that matter.
    for expected in [
        "frame.rs::encode_data",
        "ring.rs::push",
        "stream.rs::ingest",
        "pty.rs::write_input",
        "tab.rs::input",
        "guard.rs::validate_input_size",
        "markers.rs::strip_ansi",
    ] {
        assert!(
            seen.iter().any(|f| f == expected),
            "{expected} not found in {seen:?}"
        );
    }
    assert!(violations.is_empty(), "{violations:#?}");
}

#[test]
fn the_scan_flags_logging_in_a_buffer_function_and_nothing_else() {
    let src = r#"
        fn takes(bytes: &[u8]) { log::warn!("{}", bytes.len()); }
        fn other(path: &str) { log::warn!("{path}"); }
        fn quiet(bytes: &[u8]) { let _ = "log::warn!"; /* println!("x") */ }
    "#;

    let scan = scan_source("x.rs", src, false);

    assert_eq!(scan.violations.len(), 1, "{:?}", scan.violations);
    assert!(scan.violations[0].contains("`takes`"));
}

#[test]
fn the_scan_flags_a_buffer_interpolated_into_a_message_but_not_a_constant() {
    let src = r#"
        fn leaks(data: &str) -> String { format!("bad input {data}") }
        fn leaks_err(chunk: Vec<u8>) -> IpcError { IpcError::new("x", String::from_utf8_lossy(&chunk)) }
        fn limit(data: &str) -> String { let n = data.len(); format!("limit is {MAX}") }
    "#;

    let scan = scan_source("x.rs", src, false);

    assert_eq!(scan.violations.len(), 2, "{:?}", scan.violations);
    assert!(scan.violations[0].contains("`data`"));
    assert!(scan.violations[1].contains("`chunk`"));
}

#[test]
fn a_byte_path_file_may_not_contain_a_banned_macro_anywhere() {
    let src = "fn startup() { eprintln!(\"hi\"); }\n// dbg!(x)\n";

    let scan = scan_source("x.rs", src, true);

    assert_eq!(scan.violations.len(), 1, "{:?}", scan.violations);
    assert!(scan.violations[0].starts_with("x.rs:1"));
}
