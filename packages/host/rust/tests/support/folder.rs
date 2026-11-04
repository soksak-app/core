//! The temporary folder of one test: removed when the value is dropped, also while a failed assertion unwinds, and a removal
//! that fails is reported.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// A unique empty folder that is removed when the value is dropped.
pub struct Folder(PathBuf);

impl Folder {
    /// Creates `h<process>-<n>` in the temporary directory of the system. The name is short because tests place unix sockets
    /// inside the folder, and a socket address holds at most 103 bytes.
    pub fn new() -> Folder {
        let path = std::env::temp_dir().join(format!(
            "h{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir(&path)
            .unwrap_or_else(|error| panic!("cannot create {}: {error}", path.display()));
        Folder(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn text(&self) -> &str {
        self.0.to_str().expect("UTF-8 path")
    }
}

impl std::ops::Deref for Folder {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for Folder {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            let message = format!("cannot remove {}: {error}", self.0.display());
            // A panic during the unwinding of a failed assertion aborts the process, so that case reports on stderr.
            if std::thread::panicking() {
                eprintln!("{message}");
            } else {
                panic!("{message}");
            }
        }
    }
}
