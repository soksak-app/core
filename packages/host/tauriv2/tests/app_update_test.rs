//! The host stages the candidate of an application update and no other version
//! (docs/spec/installation.md#application-update).

use std::path::{Path, PathBuf};
use std::process::Command;

use soksak_host_tauriv2::app_update::{prepare_start, read_state, stage};
use soksak_sok::fetch::Fetcher;
use soksak_sok::plugins::use_registry;

/// Writes the zip of a bundle of version 0.0.9, a registry index that lists it for the key and a configuration folder
/// that uses the index; returns the configuration folder.
fn update_registry(work: &Path, key: &str) -> PathBuf {
    let contents = work.join("soksak.app/Contents");
    std::fs::create_dir_all(contents.join("MacOS")).unwrap();
    std::fs::write(
        contents.join("Info.plist"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.0.9</string></dict></plist>"#,
    )
    .unwrap();
    std::fs::write(contents.join("MacOS/soksak"), "#!/bin/sh\n").unwrap();
    let zip = work.join(format!("soksak-0.0.9-{key}.zip"));
    let status = Command::new("ditto")
        .args(["-c", "-k", "--keepParent"])
        .arg(work.join("soksak.app"))
        .arg(&zip)
        .status()
        .expect("run ditto");
    assert!(status.success());
    let output = Command::new("shasum")
        .args(["-a", "256"])
        .arg(&zip)
        .output()
        .expect("run shasum");
    let sum = String::from_utf8(output.stdout)
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .to_string();
    let index = format!(
        r#"{{"format": 1, "plugins": [], "sidecars": [], "core": {{"versions": [{{"version": "0.0.9", "releases": {{"{key}": {{"url": "file://{}", "sha256": "{sum}"}}}}}}]}}, "packs": [], "revoked": {{"plugins": [], "sidecars": []}}}}"#,
        zip.display()
    );
    let index_path = work.join("index.json");
    std::fs::write(&index_path, index).unwrap();
    let config = work.join("config");
    std::fs::create_dir_all(&config).unwrap();
    use_registry(&config, index_path.to_str().unwrap(), &Fetcher::default()).unwrap();
    config
}

// contract: app-update.host.stages-only-the-candidate
#[test]
fn the_host_stages_the_candidate_and_no_other_version() {
    const KEY: &str = "darwin-arm64-tauriv2";
    let work = tempfile::tempdir().unwrap();
    let config = update_registry(work.path(), KEY);
    let state = read_state(&config, "0.0.8", KEY).unwrap();
    assert_eq!(state.version, "0.0.8");
    assert_eq!(
        state
            .available
            .as_ref()
            .map(|update| update.version.as_str()),
        Some("0.0.9")
    );
    let error = stage(&config, "0.0.8", KEY, "0.0.10").unwrap_err();
    assert!(error.contains("0.0.10 is not the candidate"), "{error}");
    let bundle = stage(&config, "0.0.8", KEY, "0.0.9").unwrap();
    assert_eq!(bundle, config.join("updates/0.0.9/soksak.app"));
    // The running version has no candidate, so nothing is staged for it.
    let error = stage(&config, "0.0.9", KEY, "0.0.9").unwrap_err();
    assert!(error.contains("0.0.9 is not the candidate"), "{error}");
}

// contract: app-update.apply.starts-sok-from-a-copy-and-checks-the-bundle
#[test]
fn the_update_starts_sok_from_a_copy_beside_the_updates_and_checks_the_staged_bundle() {
    let config = tempfile::tempdir().unwrap();
    let running_parent = tempfile::tempdir().unwrap();
    let running = running_parent.path().join("soksak.app");
    std::fs::create_dir_all(running.join("Contents/MacOS")).unwrap();
    let executable = running.join("Contents/MacOS/soksak-tauriv2");
    std::fs::write(running.join("Contents/MacOS/sok"), "#!/bin/sh\nexit 0\n").unwrap();
    let staged = config.path().join("updates/0.0.9/soksak.app");
    std::fs::create_dir_all(staged.join("Contents")).unwrap();
    std::fs::write(staged.join("Contents/Info.plist"), "<plist/>").unwrap();
    let arguments = vec![
        "--config-dir".to_string(),
        config.path().display().to_string(),
    ];
    let command = prepare_start(config.path(), &executable, &staged, 4321, &arguments).unwrap();
    let copied = config.path().join("updates/sok");
    assert_eq!(command.get_program(), copied.as_os_str());
    let got: Vec<String> = command
        .get_args()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect();
    let want: Vec<String> = [
        "app",
        "update",
        "--wait",
        "4321",
        "--bundle",
        &staged.display().to_string(),
        "--target",
        &running.display().to_string(),
        "--",
        "--config-dir",
        &config.path().display().to_string(),
    ]
    .iter()
    .map(|argument| argument.to_string())
    .collect();
    assert_eq!(got, want);
    use std::os::unix::fs::PermissionsExt;
    assert_ne!(
        std::fs::metadata(&copied).unwrap().permissions().mode() & 0o111,
        0,
        "the copy of sok is not executable"
    );
    // A bundle outside the updates folder, a bundle without Info.plist and an application outside a bundle are refused.
    let other = running_parent.path().join("other.app");
    let outside = running_parent.path().join("soksak-tauriv2");
    let cases: [(&str, &Path, &Path); 3] = [
        ("a bundle outside updates", &executable, &other),
        (
            "a staged folder that is not a bundle",
            &executable,
            &config.path().join("updates/0.0.9"),
        ),
        ("an application outside a bundle", &outside, &staged),
    ];
    for (name, executable, bundle) in cases {
        assert!(
            prepare_start(config.path(), executable, bundle, 4321, &[]).is_err(),
            "{name} was accepted"
        );
    }
}
