//! Writes a plugin release in the layout that `pnpm pack` writes (docs/spec/installation.md#plugin-release): a gzip tar with
//! `package/package.json` and `package/<path>` for each file that `files` of `package.json` lists, named
//! `<scope>-<name>-<version>.tgz` for the package `@<scope>/<name>`.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// The files under path relative to root, in path order.
fn files_under(root: &Path, path: &Path, found: &mut Vec<PathBuf>) {
    if path.is_dir() {
        let mut entries: Vec<PathBuf> = std::fs::read_dir(path)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()))
            .map(|entry| entry.unwrap().path())
            .collect();
        entries.sort();
        for entry in entries {
            files_under(root, &entry, found);
        }
    } else {
        found.push(path.strip_prefix(root).unwrap().to_path_buf());
    }
}

/// Writes the release of the plugin in dir into out and returns {release, sha256}.
pub fn pack(dir: &Path, out: &Path) -> Value {
    let read = |name: &str| -> Value {
        let text = std::fs::read_to_string(dir.join(name))
            .unwrap_or_else(|error| panic!("{}: {error}", dir.join(name).display()));
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("{name}: {error}"))
    };
    let package = read("package.json");
    let version = package["version"]
        .as_str()
        .expect("package.json version")
        .to_string();
    let mut files = vec![PathBuf::from("package.json")];
    for listed in package["files"].as_array().expect("package.json files") {
        files_under(
            dir,
            &dir.join(listed.as_str().expect("files entry")),
            &mut files,
        );
    }
    let name = package["name"].as_str().expect("package.json name");
    let release = out.join(format!(
        "{}-{version}.tgz",
        name.trim_start_matches('@').replace('/', "-")
    ));
    entries(
        &release,
        files.iter().map(|path| {
            let source = dir.join(path);
            let mode = std::os::unix::fs::PermissionsExt::mode(
                &std::fs::metadata(&source).unwrap().permissions(),
            );
            (
                format!("package/{}", path.display()),
                std::fs::read(&source).unwrap(),
                mode & 0o777,
            )
        }),
    );
    let data = std::fs::read(&release).unwrap();
    let sum: String = Sha256::digest(&data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    json!({"release": release.display().to_string(), "sha256": sum})
}

/// Writes a gzip tar at path with each (name, content, mode) entry as a regular file.
pub fn entries(path: &Path, items: impl IntoIterator<Item = (String, Vec<u8>, u32)>) {
    let file =
        std::fs::File::create(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let zipped = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut release = tar::Builder::new(zipped);
    for (name, content, mode) in items {
        let mut header = tar::Header::new_ustar();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(content.len() as u64);
        header.set_mode(mode);
        release
            .append_data(&mut header, &name, content.as_slice())
            .unwrap();
    }
    release.into_inner().unwrap().finish().unwrap();
}
