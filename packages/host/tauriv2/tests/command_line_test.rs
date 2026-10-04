//! 애플리케이션 인자의 규칙(docs/spec/hosts.md#application-arguments)을 검사한다.

use soksak_host_tauriv2::command_line::{parse_arguments, Arguments};

fn parse(args: &[&str]) -> Result<Arguments, String> {
    parse_arguments(args.iter().map(|arg| arg.to_string()))
}

// contract: host.arguments.declared-only
#[test]
fn application_arguments_are_declared_only() {
    for args in [&["--config-dir", "/tmp/a"][..], &["--config-dir=/tmp/a"]] {
        assert_eq!(
            parse(args).map(|parsed| parsed.config_dir),
            Ok(Some("/tmp/a".to_string())),
            "{args:?}"
        );
    }
    assert_eq!(parse(&[]).map(|parsed| parsed.config_dir), Ok(None));
    for (args, want) in [
        (
            &["--config-dri", "/tmp/a"][..],
            "unknown argument --config-dri",
        ),
        (&["-config-dir", "/tmp/a"], "unknown argument -config-dir"),
        (&["/tmp/a"], "unknown argument /tmp/a"),
        (&["--config-dir"], "--config-dir needs a value"),
        (&["--config-dir="], "--config-dir needs a value"),
        (
            &["--config-dir", "/tmp/a", "--config-dir=/tmp/b"],
            "--config-dir is given twice",
        ),
    ] {
        assert_eq!(parse(args).map(|_| ()), Err(want.to_string()), "{args:?}");
    }
}
