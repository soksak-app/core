//! Checks the release recipe of an application (docs/spec/installation.md#applications): the installer downloads the
//! release of the application's own repository through a TLS server that the check owns, compares its SHA-256, unpacks it
//! into the folder of the application, and leaves no folder when a step fails.

use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use sha2::{Digest, Sha256};
use soksak_sok::application::install_application_release;
use soksak_sok::fetch::{Fetcher, Limit};

#[path = "tls_support_test.rs"]
mod tls_support_test;
use tls_support_test::{Reply, fetcher, serve};

/// A server that answers every path with the bytes, and a fetcher that trusts it with a release limit that holds them.
fn release_server(body: Vec<u8>) -> (String, Fetcher) {
    let body = Arc::new(body);
    let server = serve(move |_| Reply::Body(body.as_ref().clone()));
    let mut fetcher = fetcher(&server);
    fetcher.release = Limit {
        bytes: 1 << 20,
        timeout: Duration::from_secs(10),
    };
    (server.url, fetcher)
}

fn sum(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn recipe(value: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    serde_json::from_value(value).unwrap()
}

/// An executable, a folder and a symbolic link inside the folder, as the release of a bundle holds.
fn gzip_tar() -> Vec<u8> {
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::default(),
    ));
    let mut folder = tar::Header::new_gnu();
    folder.set_entry_type(tar::EntryType::Directory);
    folder.set_mode(0o755);
    folder.set_size(0);
    builder
        .append_data(&mut folder.clone(), "sketcher/", &[][..])
        .unwrap();
    builder
        .append_data(&mut folder, "sketcher/bin/", &[][..])
        .unwrap();
    let mut file = tar::Header::new_gnu();
    file.set_mode(0o755);
    file.set_size(10);
    builder
        .append_data(&mut file, "sketcher/bin/sketcher", &b"#!/bin/sh\n"[..])
        .unwrap();
    let mut link = tar::Header::new_gnu();
    link.set_entry_type(tar::EntryType::Symlink);
    link.set_mode(0o777);
    link.set_size(0);
    builder
        .append_link(&mut link, "sketcher/current", "bin")
        .unwrap();
    builder.into_inner().unwrap().finish().unwrap()
}

#[test]
fn a_release_is_downloaded_compared_and_unpacked_into_the_folder_of_the_application() {
    let data = gzip_tar();
    let (url, fetcher) = release_server(data.clone());
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("applications/sketcher/1.0.0");
    let recipe = recipe(
        json!({"kind": "release", "url": format!("{url}/sketcher.tar.gz"), "sha256": sum(&data), "unpack": "tar.gz"}),
    );
    install_application_release(&fetcher, &recipe, &target).unwrap();
    let executable = target.join("sketcher/bin/sketcher");
    assert!(
        std::os::unix::fs::PermissionsExt::mode(
            &std::fs::metadata(&executable).unwrap().permissions()
        ) & 0o111
            != 0
    );
    assert_eq!(
        std::fs::read_link(target.join("sketcher/current")).unwrap(),
        std::path::Path::new("bin")
    );
}

#[test]
fn a_release_of_another_hash_is_refused_and_leaves_no_folder() {
    let data = gzip_tar();
    let (url, fetcher) = release_server(data.clone());
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("sketcher");
    let zeros = "0".repeat(64);
    let recipe = recipe(
        json!({"kind": "release", "url": format!("{url}/sketcher.tar.gz"), "sha256": zeros, "unpack": "tar.gz"}),
    );
    let error = install_application_release(&fetcher, &recipe, &target).unwrap_err();
    assert!(
        error.contains(&format!("sha256 {} is not {}", sum(&data), "0".repeat(64))),
        "{error}"
    );
    assert_eq!(
        std::fs::read_dir(root.path()).unwrap().count(),
        0,
        "the failed installation left a folder"
    );
}

#[test]
fn a_link_that_leaves_the_folder_is_refused() {
    let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::default(),
    ));
    let mut link = tar::Header::new_gnu();
    link.set_entry_type(tar::EntryType::Symlink);
    link.set_mode(0o777);
    link.set_size(0);
    builder
        .append_link(&mut link, "escape", "../../outside")
        .unwrap();
    let data = builder.into_inner().unwrap().finish().unwrap();
    let (url, fetcher) = release_server(data.clone());
    let root = tempfile::tempdir().unwrap();
    let recipe = recipe(
        json!({"kind": "release", "url": format!("{url}/sketcher.tar.gz"), "sha256": sum(&data), "unpack": "tar.gz"}),
    );
    let error =
        install_application_release(&fetcher, &recipe, &root.path().join("sketcher")).unwrap_err();
    assert!(
        error.contains("release entry escape links outside the folder"),
        "{error}"
    );
}

#[test]
fn a_release_without_unpack_is_one_executable() {
    let data = b"#!/bin/sh\necho sketcher\n".to_vec();
    let (url, fetcher) = release_server(data.clone());
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("sketcher");
    let recipe = recipe(
        json!({"kind": "release", "url": format!("{url}/download/sketcher"), "sha256": sum(&data), "unpack": "none"}),
    );
    install_application_release(&fetcher, &recipe, &target).unwrap();
    let metadata = std::fs::metadata(target.join("sketcher")).unwrap();
    assert!(std::os::unix::fs::PermissionsExt::mode(&metadata.permissions()) & 0o111 != 0);
}

/// A zip is extracted by the bundle extraction of the platform, which darwin implements; another platform refuses it.
#[test]
fn a_zip_release_is_extracted_by_the_platform() {
    let mut buffer = std::io::Cursor::new(Vec::new());
    {
        let mut builder = zip::ZipWriter::new(&mut buffer);
        let options = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
        builder.start_file("sketcher/sketcher", options).unwrap();
        builder.write_all(b"#!/bin/sh\n").unwrap();
        builder.finish().unwrap();
    }
    let data = buffer.into_inner();
    let (url, fetcher) = release_server(data.clone());
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("sketcher");
    let recipe = recipe(
        json!({"kind": "release", "url": format!("{url}/sketcher.zip"), "sha256": sum(&data), "unpack": "zip"}),
    );
    let result = install_application_release(&fetcher, &recipe, &target);
    let key = soksak_sok::platform::current().unwrap().key().unwrap();
    if !key.starts_with("darwin-") {
        assert!(result.unwrap_err().contains("not implemented on"), "{key}");
        return;
    }
    result.unwrap();
    let metadata = std::fs::metadata(target.join("sketcher/sketcher")).unwrap();
    assert!(std::os::unix::fs::PermissionsExt::mode(&metadata.permissions()) & 0o111 != 0);
}
