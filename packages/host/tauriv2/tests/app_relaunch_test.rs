//! The command that diagnostics.host.relaunch starts at the end of the process
//! (docs/spec/endpoint.md#diagnostic-builds).

use std::path::PathBuf;
use std::process::Command;

#[path = "support/folder.rs"]
mod folder;
#[path = "support/records.rs"]
mod records;

use soksak_host_tauriv2::app_update::{prepare_relaunch, start_relaunch};

// contract: app-relaunch.host.starts-sok-of-the-running-bundle
#[test]
fn the_relaunch_starts_sok_of_the_running_bundle_with_the_arguments_of_the_application() {
    let folder = folder::Folder::new();
    let running = folder.path().join("soksak.app");
    std::fs::create_dir_all(running.join("Contents/MacOS")).unwrap();
    let executable = running.join("Contents/MacOS/soksak-tauriv2");
    let arguments = ["--config-dir".to_string(), "/config".to_string()];
    let command = prepare_relaunch(&executable, 4321, &arguments).unwrap();
    let sok = running.join("Contents/MacOS/sok");
    assert_eq!(command.get_program(), sok.as_os_str());
    let args: Vec<String> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        args,
        [
            "app",
            "relaunch",
            "--wait",
            "4321",
            "--target",
            &running.display().to_string(),
            "--",
            "--config-dir",
            "/config"
        ]
    );
    let outside = folder.path().join("soksak-tauriv2");
    assert_eq!(
        prepare_relaunch(&outside, 4321, &[]).unwrap_err(),
        format!(
            "application relaunch: {} does not run from an application bundle",
            outside.display()
        )
    );
}

// contract: app-relaunch.host.records-the-detached-command
#[test]
fn the_detached_relaunch_command_is_recorded_when_it_starts() {
    // The standard error and the writer of the records belong to the process, so the scenario runs in a child process.
    if let Some(config) = std::env::var_os("SOKSAK_RELAUNCH_CHILD") {
        let config = PathBuf::from(config);
        let running = config.join("running/soksak.app");
        std::fs::create_dir_all(running.join("Contents/MacOS")).unwrap();
        std::fs::write(
            running.join("Contents/MacOS/sok"),
            "#!/bin/sh\necho 'sok: the relaunch failed' >&2\nexit 1\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(running.join("Contents/MacOS/sok"))
            .unwrap()
            .permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o755);
        std::fs::set_permissions(running.join("Contents/MacOS/sok"), permissions).unwrap();
        soksak_host_tauriv2::application_log::start_standard_error(&config, "check").unwrap();
        let writer = records::start_writer(&config);
        let mut command =
            prepare_relaunch(&running.join("Contents/MacOS/soksak-tauriv2"), 4321, &[]).unwrap();
        let mut child = start_relaunch(&mut command).unwrap();
        child.wait().unwrap();
        let missing = config.join("missing-sok");
        let error = start_relaunch(&mut Command::new(&missing)).unwrap_err();
        assert!(
            error.starts_with(&format!(
                "application relaunch: start {}: ",
                missing.display()
            )),
            "{error}"
        );
        writer.flush(std::time::Duration::from_secs(5)).unwrap();
        std::fs::write(config.join("child-pid"), child.id().to_string()).unwrap();
        return;
    }
    let config = folder::Folder::new();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "the_detached_relaunch_command_is_recorded_when_it_starts",
            "--nocapture",
        ])
        .env("SOKSAK_RELAUNCH_CHILD", config.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "the child check failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    // The boot of the child names the file, so the folder is searched for the only standard error file.
    let files: Vec<PathBuf> = std::fs::read_dir(config.path().join("logs"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "stderr")
        })
        .collect();
    assert_eq!(files.len(), 1, "standard error files {files:?}");
    let standard_error = std::fs::read_to_string(&files[0]).unwrap();
    assert!(
        standard_error.contains("sok: the relaunch failed"),
        "the standard error file of the host holds {standard_error:?}"
    );
    let pid: u64 = std::fs::read_to_string(config.path().join("child-pid"))
        .unwrap()
        .parse()
        .unwrap();
    let started: Vec<serde_json::Value> =
        records::read_events(&records::event_log_path(config.path()))
            .into_iter()
            .filter(|event| event["event"] == "host.relaunch.start")
            .collect();
    assert_eq!(started.len(), 1, "host.relaunch.start events {started:?}");
    assert_eq!(started[0]["fields"]["pid"].as_u64(), Some(pid));
    let line = started[0]["fields"]["command"].as_str().unwrap();
    assert!(
        line.contains("/Contents/MacOS/sok app relaunch --wait 4321 --target "),
        "the command line is {line:?}"
    );
}
