//! A request for a page file that the host cannot serve is reported once for its path (docs/spec/diagnostics.md).

use std::borrow::Cow;
use std::sync::{Arc, Mutex};

use soksak_host::assets::{Assets, ReportingAssets};

/// Serves `present.js` and nothing else.
struct Fixture;

impl Assets for Fixture {
    fn get(&self, key: &str) -> Option<Cow<'_, [u8]>> {
        (key == "/present.js").then(|| Cow::Borrowed(&b"ok"[..]))
    }
}

// contract: assets.missing.writes-one-error-line-for-each-path
#[test]
fn missing_assets_report_each_path_once() {
    let reported = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = reported.clone();
    let assets = ReportingAssets::new(
        Box::new(Fixture),
        Box::new(move |path| sink.lock().unwrap().push(path.to_string())),
    );
    for path in [
        "/present.js",
        "/missing.js",
        "/missing.js",
        "/other.css",
        "/",
        "/no-extension",
    ] {
        let _ = assets.get(path);
    }
    assert_eq!(*reported.lock().unwrap(), ["/missing.js", "/other.css"]);
}

// A lookup that is not a request of the page reports nothing.
// contract: assets.missing.writes-one-error-line-for-each-path
#[test]
fn a_held_lookup_reports_nothing() {
    let reported = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = reported.clone();
    let assets = ReportingAssets::new(
        Box::new(Fixture),
        Box::new(move |path| sink.lock().unwrap().push(path.to_string())),
    );
    assert!(assets.held("/present.js").is_some());
    assert!(assets.held("/missing.js").is_none());
    assert!(reported.lock().unwrap().is_empty());
}
