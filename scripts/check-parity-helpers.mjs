// Kept apart from `check-parity.mjs` so tests can import it without running the report.

// Text after `#[cfg(test)]` that opens a Rust module: optional line comments, then `mod name {`.
// Comment lines consume their own newline so no `\s*` pair overlaps (no quadratic backtracking).
const MOD_AFTER_ATTR = /^\s*(?:\/\/[^\n]*\n\s*)*mod\s+\w+\s*\{/;

export function matchModAfterAttr(text) {
  return MOD_AFTER_ATTR.exec(text);
}
