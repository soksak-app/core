//! Checks the rules of the application arguments (docs/spec/hosts.md#application-arguments).

use soksak_host::command_line::{Arguments, parse_arguments};

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
    // A pair of the macOS argument domain passes, as Foundation reads it from the command line itself.
    for args in [
        &["-AppleShowScrollBars", "Always", "--config-dir", "/tmp/a"][..],
        &[
            "--config-dir",
            "/tmp/a",
            "-AppleShowScrollBars",
            "WhenScrolling",
            "-_Key2",
            "-x",
        ],
    ] {
        assert_eq!(
            parse(args).map(|parsed| parsed.config_dir),
            Ok(Some("/tmp/a".to_string())),
            "{args:?}"
        );
    }
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
        (
            &["-AppleShowScrollBars"],
            "-AppleShowScrollBars needs a value",
        ),
        (
            &["-AppleShowScrollBars", ""],
            "-AppleShowScrollBars needs a value",
        ),
        (
            &[
                "-AppleShowScrollBars",
                "Always",
                "-AppleShowScrollBars",
                "Always",
            ],
            "-AppleShowScrollBars is given twice",
        ),
        (&["-"], "unknown argument -"),
        (&["-Apple.Show", "Always"], "unknown argument -Apple.Show"),
        (&["-1Key", "Always"], "unknown argument -1Key"),
    ] {
        assert_eq!(parse(args).map(|_| ()), Err(want.to_string()), "{args:?}");
    }
}
