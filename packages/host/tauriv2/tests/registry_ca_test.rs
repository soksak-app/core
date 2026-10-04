//! 진단 build 의 --registry-ca(docs/spec/hosts.md#application-arguments)를 검사한다. 신뢰를 실제 TLS 연결로 보는
//! 검사는 sok 의 fetch 검사가 맡고, 여기서는 인자를 읽고 인증 기관을 받기에 넘기는지를 본다.
#![cfg(feature = "diagnostics")]

use soksak_host_tauriv2::command_line::{apply_arguments, parse_arguments};

fn parse(args: &[&str]) -> soksak_host_tauriv2::command_line::Arguments {
    parse_arguments(args.iter().map(|arg| arg.to_string())).expect("arguments")
}

// contract: host.arguments.registry-ca-in-diagnostic-builds
#[test]
fn a_diagnostic_build_reads_the_registry_authority() {
    let folder = tempfile::tempdir().unwrap();
    let empty = folder.path().join("empty.pem");
    std::fs::write(&empty, "no certificate\n").unwrap();
    let parsed = parse(&["--registry-ca", empty.to_str().unwrap()]);
    assert_eq!(parsed.registry_ca.as_deref(), empty.to_str());
    assert_eq!(
        apply_arguments(&parsed),
        Err(format!(
            "--registry-ca {}: the file holds no certificate",
            empty.display()
        ))
    );
    let missing = folder.path().join("missing.pem");
    let error = apply_arguments(&parse(&[&format!("--registry-ca={}", missing.display())]))
        .expect_err("missing file");
    assert!(
        error.starts_with(&format!("--registry-ca {}: ", missing.display())),
        "{error}"
    );
}
