use super::*;

fn too_large(field: Field) -> Result<(), FieldError> {
    Err(FieldError {
        kind: FieldErrorKind::TooLarge,
        field,
    })
}

fn invalid(field: Field) -> Result<(), FieldError> {
    Err(FieldError {
        kind: FieldErrorKind::InvalidInput,
        field,
    })
}

#[test]
fn text_201_bytes_too_large() {
    assert_eq!(validate(Field::Text, &"a".repeat(200)), Ok(()));
    assert_eq!(
        validate(Field::Text, &"a".repeat(201)),
        too_large(Field::Text)
    );
}

#[test]
fn multibyte_counted_in_bytes() {
    // 100 two-byte characters are 200 bytes (allowed); one more is 202 bytes though only 101 chars.
    assert_eq!(validate(Field::Text, &"é".repeat(100)), Ok(()));
    assert_eq!(
        validate(Field::Text, &"é".repeat(101)),
        too_large(Field::Text)
    );
}

#[test]
fn control_char_rejected() {
    for bad in ["a\nb", "a\tb", "a\u{0}b", "a\u{7f}b", "a\u{85}b"] {
        assert_eq!(validate(Field::Text, bad), invalid(Field::Text), "{bad:?}");
    }
    assert_eq!(validate(Field::Title, "a\nb"), invalid(Field::Title));
    assert_eq!(validate(Field::Group, "a\nb"), invalid(Field::Group));
}

#[test]
fn u2028_and_u2029_rejected() {
    for field in [Field::Text, Field::Title, Field::Group] {
        assert_eq!(validate(field, "a\u{2028}b"), invalid(field));
        assert_eq!(validate(field, "a\u{2029}b"), invalid(field));
    }
}

#[test]
fn value_allows_newline_and_tab() {
    assert_eq!(validate(Field::Value, "line one\n\tline two"), Ok(()));
    assert_eq!(validate(Field::Value, "a\u{0}b"), invalid(Field::Value));
}

#[test]
fn value_1025_bytes_too_large() {
    assert_eq!(validate(Field::Value, &"a".repeat(1024)), Ok(()));
    assert_eq!(
        validate(Field::Value, &"a".repeat(1025)),
        too_large(Field::Value)
    );
}

#[test]
fn group_61_bytes_too_large() {
    assert_eq!(validate(Field::Group, &"a".repeat(60)), Ok(()));
    assert_eq!(
        validate(Field::Group, &"a".repeat(61)),
        too_large(Field::Group)
    );
}

#[test]
fn title_121_bytes_too_large() {
    assert_eq!(validate(Field::Title, &"a".repeat(120)), Ok(()));
    assert_eq!(
        validate(Field::Title, &"a".repeat(121)),
        too_large(Field::Title)
    );
}

#[test]
fn request_id_65_bytes_too_large() {
    assert_eq!(validate(Field::RequestId, &"a".repeat(64)), Ok(()));
    assert_eq!(
        validate(Field::RequestId, &"a".repeat(65)),
        too_large(Field::RequestId)
    );
}
