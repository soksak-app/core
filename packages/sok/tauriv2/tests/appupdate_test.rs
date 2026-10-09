//! The candidate of an application update and the preparation of its release
//! (docs/spec/installation.md#application-update).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};
use soksak_sok::appupdate::{
    core_update_candidate, replace_app, stage_app_update, AppUpdate, ReplaceOptions,
};
use soksak_sok::install::{CoreRelease, Index, RegistryCore, Release, Revoked, RevokedCore};

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// A temporary folder that is removed at the end of the test.
struct Dir(PathBuf);

impl Dir {
    fn new() -> Dir {
        let path = std::env::temp_dir().join(format!(
            "sok-appupdate{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&path).expect("create temporary directory");
        Dir(path)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        // Cleanup after the test; a folder that stays has a name of its own.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A checked index that lists the given core versions, each with a release for the key.
fn core_index(key: &str, revoked: &[&str], versions: &[&str]) -> Index {
    let release = || Release {
        url: "file:///releases/x.zip".into(),
        sha256: "a".repeat(64),
    };
    Index {
        format: 1,
        plugins: vec![],
        sidecars: vec![],
        core: Some(RegistryCore {
            versions: versions
                .iter()
                .map(|version| CoreRelease {
                    version: version.to_string(),
                    releases: BTreeMap::from([(key.to_string(), release())]),
                })
                .collect(),
        }),
        packs: vec![],
        revoked: Revoked {
            plugins: vec![],
            sidecars: vec![],
            core: revoked
                .iter()
                .map(|version| RevokedCore {
                    version: version.to_string(),
                    reason: "broken".into(),
                })
                .collect(),
        },
    }
}

// contract: app-update.state.selects-the-candidate
#[test]
fn the_candidate_is_the_newest_listed_core_after_the_running_one_with_a_release() {
    const KEY: &str = "darwin-arm64-tauriv2";
    let cases: [(&str, Index, &str, Option<&str>); 6] = [
        (
            "the newest version",
            core_index(KEY, &[], &["0.0.8", "0.0.9", "0.0.10"]),
            "0.0.8",
            Some("0.0.10"),
        ),
        (
            "a revoked version is skipped",
            core_index(KEY, &["0.0.10"], &["0.0.9", "0.0.10"]),
            "0.0.8",
            Some("0.0.9"),
        ),
        (
            "the running version is not an update",
            core_index(KEY, &[], &["0.0.8"]),
            "0.0.8",
            None,
        ),
        (
            "an older version is not an update",
            core_index(KEY, &[], &["0.0.7"]),
            "0.0.8",
            None,
        ),
        (
            "a version without a release for the key is skipped",
            core_index("darwin-arm64-wailsv3", &[], &["0.0.9"]),
            "0.0.8",
            None,
        ),
        (
            "an index without core lists none",
            Index {
                core: None,
                ..core_index(KEY, &[], &[])
            },
            "0.0.8",
            None,
        ),
    ];
    for (name, index, running, want) in cases {
        let got = core_update_candidate(&index, running, KEY);
        assert_eq!(
            got.as_ref().map(|update| update.version.as_str()),
            want,
            "{name}"
        );
    }
    let got = core_update_candidate(&core_index(KEY, &[], &["0.0.9"]), "0.0.8", KEY).unwrap();
    assert_eq!(got.release.url, "file:///releases/x.zip");
}

/// Writes the zip of an application bundle whose Info.plist names the version; returns its path and sha256.
fn bundle_zip(parent: &Path, version: &str) -> (PathBuf, String) {
    let bundle = parent
        .join(format!("source-{version}"))
        .join("soksak.app/Contents");
    std::fs::create_dir_all(bundle.join("MacOS")).unwrap();
    std::fs::write(
        bundle.join("Info.plist"),
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>"#
        ),
    )
    .unwrap();
    std::fs::write(bundle.join("MacOS/soksak"), "#!/bin/sh\n").unwrap();
    let zip = parent.join(format!("soksak-{version}-darwin-arm64-tauriv2.zip"));
    let status = Command::new("ditto")
        .args(["-c", "-k", "--keepParent"])
        .arg(parent.join(format!("source-{version}/soksak.app")))
        .arg(&zip)
        .status()
        .expect("run ditto");
    assert!(status.success());
    let sum = format!("{:x}", Sha256::digest(std::fs::read(&zip).unwrap()));
    (zip, sum)
}

fn update(zip: &Path, version: &str, sha256: &str) -> AppUpdate {
    AppUpdate {
        version: version.into(),
        release: Release {
            url: format!("file://{}", zip.display()),
            sha256: sha256.into(),
        },
    }
}

// contract: app-update.stage.verifies-and-extracts
#[test]
#[cfg_attr(
    not(target_os = "macos"),
    ignore = "application bundles are staged and replaced on macOS only"
)]
fn staging_checks_the_hash_extracts_the_bundle_and_checks_its_version() {
    let (config, work) = (Dir::new(), Dir::new());
    let (zip, sum) = bundle_zip(&work.0, "0.0.9");
    let bundle = stage_app_update(&config.0, &update(&zip, "0.0.9", &sum)).unwrap();
    assert_eq!(bundle, config.0.join("updates/0.0.9/soksak.app"));
    assert!(bundle.join("Contents/MacOS/soksak").exists());
    // A staged folder that exists is replaced, so staging twice leaves one bundle.
    std::fs::write(config.0.join("updates/0.0.9/stale"), "x").unwrap();
    stage_app_update(&config.0, &update(&zip, "0.0.9", &sum)).unwrap();
    assert!(!config.0.join("updates/0.0.9/stale").exists());
}

// contract: app-update.stage.rejects-a-wrong-release
#[test]
#[cfg_attr(
    not(target_os = "macos"),
    ignore = "application bundles are staged and replaced on macOS only"
)]
fn staging_rejects_a_wrong_hash_and_a_wrong_bundle_version() {
    let (config, work) = (Dir::new(), Dir::new());
    let (zip, sum) = bundle_zip(&work.0, "0.0.9");
    let error = stage_app_update(&config.0, &update(&zip, "0.0.9", &"0".repeat(64))).unwrap_err();
    assert!(error.contains(&format!("has sha256 {sum}")), "{error}");
    let (other, other_sum) = bundle_zip(&work.0, "0.0.8");
    let error = stage_app_update(&config.0, &update(&other, "0.0.9", &other_sum)).unwrap_err();
    assert!(error.contains("version is 0.0.8, not 0.0.9"), "{error}");
    assert!(
        !config.0.join("updates/0.0.9").exists(),
        "a rejected release left a staged folder"
    );
    let missing = update(&work.0.join("none.zip"), "0.0.9", &sum);
    assert!(stage_app_update(&config.0, &missing).is_err());
}

/// A folder that looks like an application bundle and whose Info.plist holds text.
fn fake_bundle(parent: &Path, name: &str, text: &str) -> PathBuf {
    let bundle = parent.join(name);
    std::fs::create_dir_all(bundle.join("Contents")).unwrap();
    std::fs::write(bundle.join("Contents/Info.plist"), text).unwrap();
    bundle
}

fn plist_text(bundle: &Path) -> String {
    std::fs::read_to_string(bundle.join("Contents/Info.plist")).unwrap()
}

/// A process that runs until it is ended.
fn sleeping() -> std::process::Child {
    Command::new("sleep").arg("60").spawn().expect("run sleep")
}

// contract: app-update.replace.replaces-the-bundle-after-the-process-ended
#[test]
#[cfg_attr(
    not(target_os = "macos"),
    ignore = "application bundles are staged and replaced on macOS only"
)]
fn the_bundle_is_replaced_after_the_process_ended_and_the_application_starts() {
    let parent = Dir::new();
    let target = fake_bundle(&parent.0, "soksak.app", "old");
    let staged = fake_bundle(&parent.0.join("updates/0.0.9"), "soksak.app", "new");
    let mut process = sleeping();
    let pid = process.id();
    let started = std::sync::Mutex::new(vec![]);
    let (bundle, to) = (staged.clone(), target.clone());
    let replacing = std::thread::scope(|scope| {
        let handle = scope.spawn(|| {
            replace_app(
                &ReplaceOptions {
                    pid: pid as i32,
                    bundle: bundle.clone(),
                    target: to.clone(),
                    arguments: vec!["--config-dir".into(), "/config".into()],
                    timeout: Duration::from_secs(30),
                },
                &|opened: &Path, arguments: &[String]| {
                    assert_eq!(plist_text(opened), "new", "the started bundle");
                    started.lock().unwrap().push(format!(
                        "{} {}",
                        opened.display(),
                        arguments.join(" ")
                    ));
                    Ok(())
                },
            )
        });
        std::thread::sleep(Duration::from_millis(300));
        assert!(
            !handle.is_finished(),
            "the replacement finished while the process ran"
        );
        process.kill().unwrap();
        process.wait().unwrap();
        handle.join().unwrap()
    });
    replacing.unwrap();
    assert_eq!(
        *started.lock().unwrap(),
        [format!("{} --config-dir /config", target.display())]
    );
    for gone in [
        PathBuf::from(format!("{}.previous", target.display())),
        PathBuf::from(format!("{}.new", target.display())),
        staged,
    ] {
        assert!(!gone.exists(), "{} is left", gone.display());
    }
}

// contract: app-update.replace.restores-the-bundle-when-the-start-fails
#[test]
#[cfg_attr(
    not(target_os = "macos"),
    ignore = "application bundles are staged and replaced on macOS only"
)]
fn the_earlier_bundle_starts_again_when_the_new_one_fails_to_start() {
    let parent = Dir::new();
    let target = fake_bundle(&parent.0, "soksak.app", "old");
    let staged = fake_bundle(&parent.0, "staged.app", "new");
    let mut process = sleeping();
    let pid = process.id() as i32;
    process.kill().unwrap();
    process.wait().unwrap();
    let texts = std::sync::Mutex::new(vec![]);
    let error = replace_app(
        &ReplaceOptions {
            pid,
            bundle: staged,
            target: target.clone(),
            arguments: vec![],
            timeout: Duration::from_secs(30),
        },
        &|opened: &Path, _: &[String]| {
            let mut texts = texts.lock().unwrap();
            texts.push(plist_text(opened));
            if texts.len() == 1 {
                return Err("the application cannot start".into());
            }
            Ok(())
        },
    )
    .unwrap_err();
    assert!(error.contains("the application cannot start"), "{error}");
    assert_eq!(*texts.lock().unwrap(), ["new", "old"]);
    assert_eq!(plist_text(&target), "old");
}

// contract: app-update.replace.refuses-before-it-changes-anything
#[test]
#[cfg_attr(
    not(target_os = "macos"),
    ignore = "application bundles are staged and replaced on macOS only"
)]
fn the_replacement_refuses_what_is_not_a_bundle_or_when_the_process_keeps_running() {
    let parent = Dir::new();
    let staged = fake_bundle(&parent.0, "staged.app", "new");
    let mut process = sleeping();
    let pid = process.id() as i32;
    let open = |_: &Path, _: &[String]| -> Result<(), String> { panic!("the application started") };
    let plain = parent.0.join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    let other = fake_bundle(&parent.0, "a.app", "old");
    for (name, bundle, target) in [
        ("a target that is not a bundle", staged.clone(), plain),
        ("a missing bundle", parent.0.join("none.app"), other),
        ("the same bundle", staged.clone(), staged.clone()),
    ] {
        let options = ReplaceOptions {
            pid,
            bundle,
            target,
            arguments: vec![],
            timeout: Duration::from_secs(1),
        };
        assert!(replace_app(&options, &open).is_err(), "{name} was accepted");
    }
    // A process that keeps running past the timeout leaves the target as it was.
    let target = fake_bundle(&parent.0, "b.app", "old");
    let options = ReplaceOptions {
        pid,
        bundle: staged,
        target: target.clone(),
        arguments: vec![],
        timeout: Duration::from_millis(200),
    };
    let error = replace_app(&options, &open).unwrap_err();
    assert!(error.contains("did not end within"), "{error}");
    assert_eq!(plist_text(&target), "old");
    process.kill().unwrap();
    process.wait().unwrap();
}
