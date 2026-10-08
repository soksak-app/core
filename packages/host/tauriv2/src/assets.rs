//! A request for a page file that the host cannot serve is reported once for its path (docs/spec/diagnostics.md).

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::Mutex;

use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Runtime};

/// The key of the start document, which the framework serves for a path that names no file.
const START: &str = "/index.html";

thread_local! {
    /// The path that the wrapped files did not hold in the lookup that the current thread runs, and whether it names a
    /// file, which a file extension shows.
    static MISSING: RefCell<Option<(String, bool)>> = const { RefCell::new(None) };
}

/// What a lookup of the framework is.
enum Step {
    /// The lookup of a path of the page.
    Request,
    /// `<path>.html` or `<path>/index.html` after a missing path.
    Lookup,
    /// The fallback to the start document after a missing path.
    Start,
}

/// Wraps the page files of the application. `report` receives the path of each file that the wrapped files do not
/// hold, once for each path; a path without a file extension is a document route and is not reported, and neither is
/// the lookup of `<path>.html` or `<path>/index.html` that follows a missing path. The start document does not answer a
/// missing path with a file extension, so the framework answers its asset error.
pub struct ReportingAssets<R: Runtime> {
    inner: Box<dyn Assets<R>>,
    report: Box<dyn Fn(&str) + Send + Sync>,
    reported: Mutex<HashSet<String>>,
}

impl<R: Runtime> ReportingAssets<R> {
    pub fn new(inner: Box<dyn Assets<R>>, report: Box<dyn Fn(&str) + Send + Sync>) -> Self {
        Self {
            inner,
            report,
            reported: Mutex::new(HashSet::new()),
        }
    }
}

impl<R: Runtime> Assets<R> for ReportingAssets<R> {
    fn setup(&self, app: &tauri::App<R>) {
        self.inner.setup(app);
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        let path: &str = key.as_ref();
        // The framework looks up `<path>`, `<path>.html` and `<path>/index.html` of a request and then falls back to
        // the start document. The lookups after a missing file are not requests of the page, and the start document
        // does not answer a missing file.
        let step = MISSING.with(|missing| {
            let mut missing = missing.borrow_mut();
            let step = match missing.as_ref() {
                Some((base, _))
                    if path == format!("{base}.html") || path == format!("{base}/index.html") =>
                {
                    Step::Lookup
                }
                Some((_, true)) if path == START => Step::Start,
                _ => Step::Request,
            };
            if !matches!(step, Step::Lookup) {
                *missing = None;
            }
            step
        });
        match step {
            Step::Start => None,
            Step::Lookup => self.inner.get(key),
            Step::Request => {
                let found = self.inner.get(key);
                let file = std::path::Path::new(path).extension().is_some();
                if found.is_none() {
                    MISSING.with(|missing| *missing.borrow_mut() = Some((path.to_string(), file)));
                }
                if found.is_none() && file {
                    let first = self
                        .reported
                        .lock()
                        .expect("the reported paths are not poisoned")
                        .insert(path.to_string());
                    if first {
                        (self.report)(path);
                    }
                }
                found
            }
        }
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.inner.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.inner.csp_hashes(html_path)
    }
}
