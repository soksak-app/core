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

    /// Installs the sidecar fixture program (docs/spec/cases/sidecars/fixture.sh) in this folder as the executable named
    /// `executable`: a symbolic link of that name points to the program, and the file `control` of the folder holds the control
    /// text that the program reads beside its link. It panics on any error.
    pub fn fixture(&self, executable: &str, control: &str) {
        // The program is found from the manifest folder of the host package: rust, host, packages and the repository root.
        let program = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/spec/cases/sidecars/fixture.sh");
        let program = program
            .canonicalize()
            .unwrap_or_else(|error| panic!("cannot find {}: {error}", program.display()));
        std::os::unix::fs::symlink(&program, self.0.join(executable))
            .unwrap_or_else(|error| panic!("cannot link {executable}: {error}"));
        std::fs::write(self.0.join("control"), control)
            .unwrap_or_else(|error| panic!("cannot write the control file: {error}"));
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
