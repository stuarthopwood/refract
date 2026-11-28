// Most-recent-command output (FR-020, R-6). PowerShell tabs print OSC 133 `A` (prompt start) at every prompt;
// the scanner records where each one ends as an absolute stream offset, and the extractor turns those into
// the byte range of the last command's output. Everything else here is plain text clean-up for the model.
// No terminal bytes are logged here.

use std::collections::VecDeque;

use serde::Serialize;

/// How many prompt offsets are kept; older prompts are not reachable from "most recent command".
pub const MAX_MARKERS: usize = 64;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
/// What follows `ESC ]` in the sequence this scanner wants.
const OSC_BODY: &[u8] = b"133;A";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum State {
    #[default]
    Ground,
    /// Saw `ESC`.
    Esc,
    /// Saw `ESC ]` and this many bytes of `OSC_BODY`.
    Body(usize),
    /// Saw all of `ESC ] 133 ; A`: waiting for BEL or `ESC \`.
    Terminator,
    /// Saw `ESC` where a terminator was due: only `\` finishes it.
    TerminatorEsc,
}

/// Finds `ESC ] 133 ; A` (ended by BEL or `ESC \`) across read boundaries and keeps the absolute offset just
/// past each one, which is where the prompt text begins.
#[derive(Debug, Default)]
pub struct MarkerScanner {
    state: State,
    offsets: VecDeque<u64>,
}

impl MarkerScanner {
    pub fn new() -> Self {
        Self::default()
    }

    /// Scans `data`, whose first byte sits at absolute offset `base` in the stream.
    pub fn feed(&mut self, data: &[u8], base: u64) {
        let mut state = self.state;
        for (index, &byte) in data.iter().enumerate() {
            let (next, found) = step(state, byte);
            state = next;
            if found {
                self.record(base + index as u64 + 1);
            }
        }
        self.state = state;
    }

    fn record(&mut self, offset: u64) {
        if self.offsets.len() == MAX_MARKERS {
            self.offsets.pop_front();
        }
        self.offsets.push_back(offset);
    }

    /// Forgets prompts that fall before `start`, the oldest offset the ring still holds.
    pub fn drop_before(&mut self, start: u64) {
        while self.offsets.front().is_some_and(|offset| *offset < start) {
            self.offsets.pop_front();
        }
    }

    pub fn offsets(&self) -> Vec<u64> {
        self.offsets.iter().copied().collect()
    }
}

// A byte that breaks a partial match may itself begin a new one, so it is re-read from `Ground`.
fn step(state: State, byte: u8) -> (State, bool) {
    match state {
        State::Ground => (
            if byte == ESC {
                State::Esc
            } else {
                State::Ground
            },
            false,
        ),
        State::Esc => match byte {
            b']' => (State::Body(0), false),
            ESC => (State::Esc, false),
            _ => (State::Ground, false),
        },
        State::Body(matched) => {
            if byte == OSC_BODY[matched] {
                let next = if matched + 1 == OSC_BODY.len() {
                    State::Terminator
                } else {
                    State::Body(matched + 1)
                };
                (next, false)
            } else {
                step(State::Ground, byte)
            }
        }
        State::Terminator => match byte {
            BEL => (State::Ground, true),
            ESC => (State::TerminatorEsc, false),
            _ => (State::Ground, false),
        },
        State::TerminatorEsc => match byte {
            b'\\' => (State::Ground, true),
            _ => step(State::Ground, byte),
        },
    }
}

/// Removes escape sequences (CSI, OSC, two- and three-byte escapes) and control characters other than
/// newline and tab, and drops `\r`, so what is left is the text a person would read.
pub fn strip_ansi(bytes: &[u8]) -> String {
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        index += 1;
        match byte {
            ESC => index = skip_escape(bytes, index),
            b'\n' | b'\t' => out.push(byte),
            b'\r' | 0x00..=0x1f | 0x7f => {}
            _ => out.push(byte),
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// `index` is the byte after `ESC`; returns the index after the whole sequence. A sequence cut off by the end
// of the data is dropped.
fn skip_escape(bytes: &[u8], index: usize) -> usize {
    let Some(&kind) = bytes.get(index) else {
        return index;
    };
    match kind {
        b'[' => {
            let mut at = index + 1;
            while at < bytes.len() {
                let byte = bytes[at];
                at += 1;
                if (0x40..=0x7e).contains(&byte) {
                    break;
                }
            }
            at
        }
        b']' => {
            let mut at = index + 1;
            while at < bytes.len() {
                match bytes[at] {
                    BEL => return at + 1,
                    ESC if bytes.get(at + 1) == Some(&b'\\') => return at + 2,
                    _ => at += 1,
                }
            }
            at
        }
        _ => {
            // Intermediate bytes (such as the `(` of `ESC ( B`) precede one final byte.
            let mut at = index;
            while bytes
                .get(at)
                .is_some_and(|byte| (0x20..=0x2f).contains(byte))
            {
                at += 1;
            }
            (at + 1).min(bytes.len())
        }
    }
}

/// The raw bytes of the most recent command's output, or `None` when the prompts seen cannot name one.
///
/// `snapshot` is the ring's bytes, `start` the absolute offset of its first byte and `markers` the prompt
/// offsets. When only the prompt line follows the latest marker the command has finished, so its output is
/// `[A(n-1), A(n))`; otherwise something is still printing and it is `[A(n), end)`.
pub fn extract_recent_command(snapshot: &[u8], start: u64, markers: &[u64]) -> Option<Vec<u8>> {
    let latest = *markers.last()?;
    let at = |offset: u64| {
        usize::try_from(offset.saturating_sub(start))
            .map_or(snapshot.len(), |i| i.min(snapshot.len()))
    };
    let after_latest = &snapshot[at(latest)..];
    let prompt_only = !strip_ansi(after_latest).trim_end().contains('\n');
    if !prompt_only {
        return Some(after_latest.to_vec());
    }
    let previous = *markers.get(markers.len().checked_sub(2)?)?;
    Some(snapshot[at(previous)..at(latest)].to_vec())
}

/// Keeps the last `cap` bytes of `text` without splitting a character. Returns the text, whether it was cut,
/// and the full length in bytes.
pub fn cap_keeping_end(text: String, cap: usize) -> (String, bool, usize) {
    let total = text.len();
    if total <= cap {
        return (text, false, total);
    }
    let mut cut = total - cap;
    while !text.is_char_boundary(cut) {
        cut += 1;
    }
    (text[cut..].to_string(), true, total)
}

/// Which text `terminal.readOutput` was asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    RecentCommand,
    LastLines,
}

impl OutputMode {
    /// The wire value; anything else is `None`.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "recent-command" => Some(Self::RecentCommand),
            "last-lines" => Some(Self::LastLines),
            _ => None,
        }
    }
}

/// Whether the text came from prompt markers or the plain tail (`TerminalOutput.source` on the wire).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputSource {
    Marker,
    Tail,
}

/// What `terminal.readOutput` returns (contracts/terminal-ipc.md).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub text: String,
    pub truncated: bool,
    pub total_bytes: usize,
    pub source: OutputSource,
}

/// Strips and caps the marker-bound output when there is one, else the tail (`tail` runs only then).
pub fn compose_output(
    recent: Option<Vec<u8>>,
    tail: impl FnOnce() -> Vec<u8>,
    cap: usize,
) -> TerminalOutput {
    let (raw, source) = match recent {
        Some(raw) => (raw, OutputSource::Marker),
        None => (tail(), OutputSource::Tail),
    };
    let (text, truncated, total_bytes) = cap_keeping_end(strip_ansi(&raw), cap);
    TerminalOutput {
        text,
        truncated,
        total_bytes,
        source,
    }
}

#[cfg(test)]
#[path = "markers.test.rs"]
mod tests;
