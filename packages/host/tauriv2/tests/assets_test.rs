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
    assert_eq!(*reported.lock().unwrap(), ["/missing.js", "/other.css", "/page.html"]);
}
