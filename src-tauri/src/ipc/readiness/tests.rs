use super::*;

#[test]
fn step_parse_accepts_the_three_readiness_keys() {
    assert_eq!(Step::parse("git"), Some(Step::Git));
    assert_eq!(Step::parse("omp"), Some(Step::Omp));
    assert_eq!(Step::parse("ompSignedIn"), Some(Step::OmpSignedIn));
}

#[test]
fn step_parse_rejects_unknown_keys_and_case_or_whitespace_variants() {
    for raw in [
        "github",
        "",
        "Git",
        "GIT",
        " git",
        "git ",
        "omp\n",
        "ompsignedin",
        "OmpSignedIn",
    ] {
        assert_eq!(Step::parse(raw), None, "{raw:?} must be rejected");
    }
}

#[test]
fn step_from_args_rejects_non_string_and_missing_arguments() {
    for args in [
        vec![Value::from(1)],
        vec![Value::Null],
        vec![serde_json::json!(["git"])],
        vec![],
    ] {
        let err = step_from_args(&args).expect_err("must reject");
        assert_eq!(err.code, "invalid-argument");
    }
    assert_eq!(step_from_args(&[Value::from("omp")]).unwrap(), Step::Omp);
}
