//! A request for a page file that the host cannot serve is reported once for its path (docs/spec/diagnostics.md).

use std::borrow::Cow;
use std::sync::{Arc, Mutex};

use soksak_host_tauriv2::assets::ReportingAssets;
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Wry};

/// Serves `present.js` and nothing else.
struct Fixture;

impl Assets<Wry> for Fixture {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        (key.as_ref() == "/present.js").then(|| Cow::Borrowed(&b"ok"[..]))
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

// contract: assets.missing.writes-one-error-line-for-each-path
#[test]
fn missing_assets_report_each_path_once() {
    let reported = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = reported.clone();
    let assets: ReportingAssets<Wry> = ReportingAssets::new(
        Box::new(Fixture),
        Box::new(move |path| sink.lock().unwrap().push(path.to_string())),
    );
    // The framework looks up `<path>.html` and `<path>/index.html` after a path that it does not find, and those two
    // lookups are not requests of the page.
    for path in [
        "/present.js",
        "/missing.js",
        "/missing.js.html",
        "/missing.js/index.html",
        "/missing.js",
        "/other.css",
        "/other.css.html",
        "/other.css/index.html",
        "/page.html",
        "/page.html.html",
        "/page.html/index.html",
        "/",
        "/no-extension",
    ] {
        let key: AssetKey = path.into();
        let _ = Assets::<Wry>::get(&assets, &key);
    }
    assert_eq!(
        *reported.lock().unwrap(),
        ["/missing.js", "/other.css", "/page.html"]
    );
}

/// Serves `present.js` and the start document.
struct WithStart;

impl Assets<Wry> for WithStart {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        match key.as_ref() {
            "/present.js" => Some(Cow::Borrowed(&b"ok"[..])),
            "/index.html" => Some(Cow::Borrowed(&b"<html>"[..])),
            _ => None,
        }
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

// contract: assets.missing.does-not-answer-with-the-start-document
#[test]
fn a_missing_file_is_not_answered_with_the_start_document() {
    let assets: ReportingAssets<Wry> = ReportingAssets::new(Box::new(WithStart), Box::new(|_| {}));
    let get = |path: &str| Assets::<Wry>::get(&assets, &path.into()).is_some();
    // The framework looks up `<path>`, `<path>.html`, `<path>/index.html` and then the start document.
    assert!(!get("/missing.js"));
    assert!(!get("/missing.js.html"));
    assert!(!get("/missing.js/index.html"));
    assert!(
        !get("/index.html"),
        "the start document answered a missing file"
    );
    // The start document and a document route are served.
    assert!(get("/index.html"), "the start document is not served");
    assert!(!get("/route"));
    assert!(!get("/route.html"));
    assert!(!get("/route/index.html"));
    assert!(
        get("/index.html"),
        "the start document is not served as the fallback of a route"
    );
    assert!(get("/present.js"));
}
