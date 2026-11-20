// Byte caps and character rules shared by the agent and the developer, so the two parties cannot
// drift (spec 138 FR-004). Caps are UTF-8 bytes, not characters.

use super::model::{
    MAX_GROUP_BYTES, MAX_REQUEST_ID_BYTES, MAX_TEXT_BYTES, MAX_TITLE_BYTES, MAX_VALUE_BYTES,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Text,
    Title,
    Group,
    Value,
    RequestId,
}

impl Field {
    pub fn name(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Title => "title",
            Self::Group => "group",
            Self::Value => "value",
            Self::RequestId => "requestId",
        }
    }

    pub fn max_bytes(self) -> usize {
        match self {
            Self::Text => MAX_TEXT_BYTES,
            Self::Title => MAX_TITLE_BYTES,
            Self::Group => MAX_GROUP_BYTES,
            Self::Value => MAX_VALUE_BYTES,
            Self::RequestId => MAX_REQUEST_ID_BYTES,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldErrorKind {
    TooLarge,
    InvalidInput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FieldError {
    pub kind: FieldErrorKind,
    pub field: Field,
}

/// `char::is_control` misses U+2028 and U+2029, which still break a line in a prompt.
fn is_banned(field: Field, c: char) -> bool {
    if field == Field::Value {
        return c.is_control() && c != '\n' && c != '\t';
    }
    c.is_control() || c == '\u{2028}' || c == '\u{2029}'
}

pub fn validate(field: Field, input: &str) -> Result<(), FieldError> {
    if input.len() > field.max_bytes() {
        return Err(FieldError {
            kind: FieldErrorKind::TooLarge,
            field,
        });
    }
    if input.chars().any(|c| is_banned(field, c)) {
        return Err(FieldError {
            kind: FieldErrorKind::InvalidInput,
            field,
        });
    }
    Ok(())
}

#[cfg(test)]
#[path = "validate.test.rs"]
mod tests;
