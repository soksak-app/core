//! A request for a page file that the host cannot serve is reported once for its path (docs/spec/diagnostics.md).

use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::Mutex;

use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Runtime};

/// Wraps the page files of the application. `report` receives the path of each file that the wrapped files do not
/// hold, once for each path; a path without a file extension is a document route and is not reported.
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
        let found = self.inner.get(key);
        let path: &str = key.as_ref();
        if found.is_none() && std::path::Path::new(path).extension().is_some() {
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

    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.inner.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.inner.csp_hashes(html_path)
    }
}
