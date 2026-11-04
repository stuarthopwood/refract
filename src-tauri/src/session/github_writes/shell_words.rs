// Quote-aware shell tokenizer: simple commands as word lists; heredoc and `$(...)` bodies stay opaque.

/// Splits `input` into simple commands (word lists) at unquoted `&&`, `||`, `;`, `|`, `&`, parens and newlines.
pub(super) fn split_commands(input: &str) -> Vec<Vec<String>> {
    let chars: Vec<char> = input.chars().collect();
    let mut commands: Vec<Vec<String>> = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut word: Option<String> = None;
    let mut heredocs: Vec<String> = Vec::new();
    let mut i = 0;

    fn end_word(word: &mut Option<String>, words: &mut Vec<String>) {
        if let Some(w) = word.take() {
            words.push(w);
        }
    }
    fn end_command(
        word: &mut Option<String>,
        words: &mut Vec<String>,
        commands: &mut Vec<Vec<String>>,
    ) {
        end_word(word, words);
        if !words.is_empty() {
            commands.push(std::mem::take(words));
        }
    }

    while i < chars.len() {
        let c = chars[i];
        match c {
            ' ' | '\t' | '\r' => {
                end_word(&mut word, &mut words);
                i += 1;
            }
            '\n' => {
                end_command(&mut word, &mut words, &mut commands);
                i += 1;
                for delimiter in std::mem::take(&mut heredocs) {
                    i = skip_heredoc_body(&chars, i, &delimiter);
                }
            }
            '\\' => {
                // A backslash-newline joins lines; anything else is a literal character.
                match chars.get(i + 1) {
                    Some('\n') => {}
                    Some(&next) => word.get_or_insert_with(String::new).push(next),
                    None => {}
                }
                i += 2;
            }
            '\'' => {
                let w = word.get_or_insert_with(String::new);
                i += 1;
                while i < chars.len() && chars[i] != '\'' {
                    w.push(chars[i]);
                    i += 1;
                }
                i += 1;
            }
            '"' => {
                let w = word.get_or_insert_with(String::new);
                i += 1;
                while i < chars.len() && chars[i] != '"' {
                    if chars[i] == '\\' && i + 1 < chars.len() {
                        let next = chars[i + 1];
                        if matches!(next, '"' | '\\' | '$' | '`') {
                            w.push(next);
                        } else if next != '\n' {
                            w.push('\\');
                            w.push(next);
                        }
                        i += 2;
                    } else if chars[i] == '$' && chars.get(i + 1) == Some(&'(') {
                        i = copy_subshell(&chars, i, w);
                    } else {
                        w.push(chars[i]);
                        i += 1;
                    }
                }
                i += 1;
            }
            '$' if chars.get(i + 1) == Some(&'(') => {
                let w = word.get_or_insert_with(String::new);
                i = copy_subshell(&chars, i, w);
            }
            '`' => {
                let w = word.get_or_insert_with(String::new);
                w.push('`');
                i += 1;
                while i < chars.len() && chars[i] != '`' {
                    w.push(chars[i]);
                    i += 1;
                }
                w.push('`');
                i += 1;
            }
            '#' if word.is_none() => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '<' if chars.get(i + 1) == Some(&'<') && chars.get(i + 2) != Some(&'<') => {
                end_word(&mut word, &mut words);
                words.push("<<".to_string());
                i += 2;
                if chars.get(i) == Some(&'-') {
                    i += 1;
                }
                while i < chars.len() && matches!(chars[i], ' ' | '\t') {
                    i += 1;
                }
                let mut delimiter = String::new();
                while i < chars.len() && !chars[i].is_whitespace() && !is_operator(chars[i]) {
                    if !matches!(chars[i], '\'' | '"' | '\\') {
                        delimiter.push(chars[i]);
                    }
                    i += 1;
                }
                if !delimiter.is_empty() {
                    heredocs.push(delimiter);
                }
            }
            '&' if word.as_deref().is_some_and(|w| w.ends_with('>'))
                || chars.get(i + 1) == Some(&'>') =>
            {
                // `2>&1` and `&>` are redirections, not command separators.
                word.get_or_insert_with(String::new).push('&');
                i += 1;
            }
            ';' | '|' | '&' | '(' | ')' => {
                end_command(&mut word, &mut words, &mut commands);
                i += 1;
                if matches!(c, '|' | '&') && chars.get(i) == Some(&c) {
                    i += 1;
                }
            }
            _ => {
                word.get_or_insert_with(String::new).push(c);
                i += 1;
            }
        }
    }
    end_command(&mut word, &mut words, &mut commands);
    commands
}

fn is_operator(c: char) -> bool {
    matches!(c, ';' | '|' | '&' | '(' | ')')
}

/// Copies a balanced `$(...)` verbatim into `out` and returns the index after it.
fn copy_subshell(chars: &[char], start: usize, out: &mut String) -> usize {
    let mut depth = 0usize;
    let mut i = start;
    while i < chars.len() {
        let c = chars[i];
        out.push(c);
        match c {
            '(' => depth += 1,
            ')' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return i + 1;
                }
            }
            '\'' | '"' => {
                i += 1;
                while i < chars.len() && chars[i] != c {
                    out.push(chars[i]);
                    i += 1;
                }
                if i < chars.len() {
                    out.push(chars[i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    i
}

/// Index just past the heredoc terminator line, or the end of input when it never closes.
fn skip_heredoc_body(chars: &[char], mut i: usize, delimiter: &str) -> usize {
    while i < chars.len() {
        let end = chars[i..]
            .iter()
            .position(|&c| c == '\n')
            .map_or(chars.len(), |p| i + p);
        let line: String = chars[i..end].iter().collect();
        i = (end + 1).min(chars.len());
        if line.trim() == delimiter {
            break;
        }
    }
    i
}

/// Every string literal (`'..'`, `".."`, backtick, or triple-quoted) in `code`, unescaped.
pub(super) fn string_literals(code: &str) -> Vec<String> {
    let chars: Vec<char> = code.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let q = chars[i];
        if !matches!(q, '\'' | '"' | '`') {
            i += 1;
            continue;
        }
        let triple = chars.get(i + 1) == Some(&q) && chars.get(i + 2) == Some(&q);
        i += if triple { 3 } else { 1 };
        let mut lit = String::new();
        while i < chars.len() {
            let c = chars[i];
            if c == '\\' && i + 1 < chars.len() {
                lit.push(match chars[i + 1] {
                    'n' => '\n',
                    't' => '\t',
                    other => other,
                });
                i += 2;
            } else if c == q
                && (!triple || (chars.get(i + 1) == Some(&q) && chars.get(i + 2) == Some(&q)))
            {
                i += if triple { 3 } else { 1 };
                break;
            } else {
                lit.push(c);
                i += 1;
            }
        }
        out.push(lit);
    }
    out
}
