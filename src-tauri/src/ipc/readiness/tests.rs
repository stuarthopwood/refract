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

#[test]
fn omp_gate_fails_below_the_floor() {
    for version in ["omp/17.9.0", "16.0.0", "18.6.2", "18.5.9"] {
        let check = classify_omp_version(version);
        assert!(!check.ok, "{version} should fail");
        assert!(check.hint.unwrap().contains("18.6.3"));
    }
}

#[test]
fn omp_gate_passes_the_tested_line_without_warning() {
    for version in ["18.6.3", "18.17.0", "18.17.9"] {
        let check = classify_omp_version(version);
        assert!(check.ok, "{version} should pass");
        assert_eq!(check.warning, None, "{version} should not warn");
    }
}

#[test]
fn omp_gate_warns_on_newer_minors_and_majors() {
    for version in ["18.22.2", "19.1.1", "20.0.0"] {
        let check = classify_omp_version(version);
        assert!(check.ok, "{version} should start");
        assert_eq!(check.warning, Some(true), "{version} should warn");
        assert!(check.hint.unwrap().contains("18.17.x"));
    }
}

#[test]
fn omp_gate_fails_when_no_version_is_found() {
    assert!(!classify_omp_version("garbage").ok);
}
