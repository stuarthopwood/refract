// Spec 060 (S1-05): local frustration scoring for the Usage view's humour card. Counts only; the
// text passed in is scored and dropped, never stored (ADR 0006). The word lists live here and
// nowhere else; ASCII only, matched case-insensitively.

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FrustrationScore {
    pub yelling: i64,
    pub profanity: i64,
    pub blame: i64,
}

const PROFANITY: &[&str] = &[
    "damn", "dammit", "goddamn", "crap", "crappy", "shit", "shitty", "bullshit", "fuck", "fucking",
    "fucked", "fck", "wtf", "ffs", "bloody", "piss", "pissed", "bastard", "arse",
];

const BLAME_PHRASES: &[&str] = &["you broke", "your fault", "why did you", "i told you"];

const YELL_MIN_LETTERS: usize = 8;
const YELL_UPPER_SHARE: f64 = 0.7;
const YELL_BANGS: usize = 3;

/// Yelling is 1 or 0 per message: at least 8 letters and over 70% upper-case, or three or more
/// `!`. Profanity counts word hits; blame counts phrase hits.
pub fn score(text: &str) -> FrustrationScore {
    let letters = text.chars().filter(char::is_ascii_alphabetic).count();
    let upper = text.chars().filter(char::is_ascii_uppercase).count();
    let bangs = text.chars().filter(|c| *c == '!').count();
    let shouting = letters >= YELL_MIN_LETTERS && (upper as f64) > YELL_UPPER_SHARE * letters as f64;

    let lower = text.to_ascii_lowercase();
    let profanity = lower
        .split(|c: char| !c.is_ascii_alphabetic())
        .filter(|word| PROFANITY.contains(word))
        .count();
    let blame: usize = BLAME_PHRASES
        .iter()
        .map(|phrase| lower.matches(phrase).count())
        .sum();

    FrustrationScore {
        yelling: i64::from(shouting || bangs >= YELL_BANGS),
        profanity: profanity as i64,
        blame: blame as i64,
    }
}
