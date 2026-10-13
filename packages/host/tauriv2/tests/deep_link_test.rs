use std::cell::RefCell;
use std::collections::BTreeMap;

use soksak_host_tauriv2::deep_link::{DeepLinkQueue, parse_deep_link};

fn params(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

// contract: deep-link.parse.accepts-core-and-plugin-owners
#[test]
fn deep_link_parse_accepts_core_and_plugin_owners() {
    let link = parse_deep_link("soksak://core/tab.move?tab=a&x=1").expect("core link was refused");
    assert_eq!(link.owner, "core");
    assert_eq!(link.command, "tab.move");
    assert_eq!(link.name(), "core.tab.move");
    assert_eq!(link.params, params(&[("tab", "a"), ("x", "1")]));
    let plugin = parse_deep_link("soksak://sample/open").expect("plugin link was refused");
    assert_eq!(plugin.name(), "sample.open");
    assert!(plugin.params.is_empty());
}

// contract: deep-link.parse.decodes-percent-encoded-params
#[test]
fn deep_link_parse_decodes_percent_encoded_params() {
    let link = parse_deep_link("soksak://core/x?q=a+b%20c&%E2%82%A9=%EA%B0%80&path=%2Ftmp%2Fa.hwp")
        .expect("encoded link was refused");
    assert_eq!(
        link.params,
        params(&[("q", "a b c"), ("₩", "가"), ("path", "/tmp/a.hwp")])
    );
}

// contract: deep-link.parse.rejects-other-scheme
#[test]
fn deep_link_parse_rejects_other_scheme() {
    assert_eq!(
        parse_deep_link("https://core/x").unwrap_err(),
        r#"scheme "https" is not soksak"#
    );
}

// contract: deep-link.parse.rejects-missing-owner-or-command
#[test]
fn deep_link_parse_rejects_missing_owner_or_command() {
    for (value, want) in [
        ("soksak:///x", "owner is missing"),
        ("soksak://core", "command is missing"),
        ("soksak://core/", "command is missing"),
        ("soksak://core/a/b", "command has more than one segment"),
    ] {
        assert_eq!(parse_deep_link(value).unwrap_err(), want, "{value}");
    }
}

// contract: deep-link.parse.rejects-bad-query
#[test]
fn deep_link_parse_rejects_bad_query() {
    for (value, want) in [
        ("soksak://core/x?a=%zz", "invalid percent-encoding"),
        ("soksak://core/x?a=%", "invalid percent-encoding"),
        ("soksak://core/x?a=1&a=2", "parameter a is repeated"),
    ] {
        assert_eq!(parse_deep_link(value).unwrap_err(), want, "{value}");
    }
}

// contract: deep-link.parse.rejects-long-url
#[test]
fn deep_link_parse_rejects_long_url() {
    let long = format!("soksak://core/x?a={}", "a".repeat(8192));
    assert_eq!(
        parse_deep_link(&long).unwrap_err(),
        "URL is longer than 8192 characters"
    );
    assert_eq!(
        parse_deep_link("soksak://[::1/x").unwrap_err(),
        "URL does not parse"
    );
}

// contract: deep-link.parse.rejects-empty-param-name
#[test]
fn deep_link_parse_rejects_empty_param_name() {
    assert_eq!(
        parse_deep_link("soksak://core/x?=x").unwrap_err(),
        "parameter name is empty"
    );
}

// contract: deep-link.launch.kept-links-run-in-order-when-window-ready
#[test]
fn deep_link_queue_runs_kept_links_in_order_when_window_is_ready() {
    let queue = DeepLinkQueue::new();
    let ran = RefCell::new(Vec::new());
    let run = |value: &str| ran.borrow_mut().push(value.to_string());
    queue.keep("soksak://core/a".to_string(), &run);
    queue.keep("soksak://core/b".to_string(), &run);
    assert!(
        ran.borrow().is_empty(),
        "kept links ran before the window was ready"
    );
    queue.ready(&run);
    assert_eq!(*ran.borrow(), ["soksak://core/a", "soksak://core/b"]);
}

// contract: deep-link.launch.later-link-runs-at-once
#[test]
fn deep_link_queue_runs_later_link_at_once() {
    let queue = DeepLinkQueue::new();
    let ran = RefCell::new(Vec::new());
    let run = |value: &str| ran.borrow_mut().push(value.to_string());
    queue.ready(&run);
    queue.keep("soksak://core/c".to_string(), &run);
    queue.ready(&run);
    assert_eq!(*ran.borrow(), ["soksak://core/c"]);
}
