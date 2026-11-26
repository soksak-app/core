//! Tests of the account runs and the account homes of a plugin (docs/spec/native-surfaces.md#account-runs). Each test starts real programs without a
//! shell and carries the contract row that it checks.

use std::ffi::OsString;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::account_run::{create, homes, remove};
use crate::program_run::{Declaration, Declarations, End, Finished, ProgramRuns, Request, Slot};

use crate::test_folder as folder;

const PLUGIN: &str = "plugin-a";

fn declarations(program: &str) -> Declarations {
    Declarations::from([(
        "account-status".to_string(),
        Declaration {
            program: program.to_string(),
            slots: vec![
                Slot::Pattern("[a-z][a-z0-9-]*".to_string()),
                Slot::Pattern("/.+".to_string()),
            ],
        },
    )])
}

/// An account run of plugin in the data folder data, whose plugin folder is the folder plugin of data.
fn account_request(plugin: &str, run: u64, data: &Path, program: &str, home: &Path) -> Request {
    Request {
        surface: plugin.to_string(),
        plugin: plugin.to_string(),
        id: run,
        name: "account-status".to_string(),
        args: vec!["claude".to_string(), home.to_string_lossy().into_owned()],
        project: Some(data.to_path_buf()),
        plugin_folder: Ok(data.join("plugin")),
        environment: vec![("PATH".into(), OsString::from("/usr/bin:/bin"))],
        account: Some(declarations(program)),
    }
}

fn plugin_script(data: &Path, body: &str) {
    let path = data.join("plugin/bin/account");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A program that writes its working folder to the file of its second argument and waits for its background child.
const HOLDING: &str = "pwd > \"$2\"\nsleep 60 & wait";

fn start(
    runs: &Arc<ProgramRuns>,
    plugin: &str,
    run: u64,
    data: &Path,
    marker: &Path,
) -> JoinHandle<Result<Finished, String>> {
    let runs = Arc::clone(runs);
    let request = account_request(plugin, run, data, "plugin:bin/account", marker);
    std::thread::spawn(move || runs.run(request))
}

fn wait_for(marker: &Path) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(text) = std::fs::read_to_string(marker)
            && let Some(line) = text.strip_suffix('\n')
        {
            return line.to_string();
        }
        assert!(
            Instant::now() < deadline,
            "the program did not start {}",
            marker.display()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

// contract: account.run.working-folder-is-the-plugin-data-folder
#[test]
fn an_account_run_starts_in_the_plugin_data_folder() {
    let data = folder::Folder::new();
    plugin_script(data.path(), "pwd\necho \"$1\"");
    let runs = ProgramRuns::new();
    let home = data.path().join("accounts/account-1");
    let finished = runs
        .run(account_request(
            PLUGIN,
            1,
            data.path(),
            "plugin:bin/account",
            &home,
        ))
        .unwrap();
    let real = std::fs::canonicalize(data.path()).unwrap();
    assert_eq!(
        finished.stdout.text,
        format!("{}\nclaude\n", real.display())
    );
    let refused = runs
        .run(Request {
            args: vec!["Claude".to_string(), "/h".to_string()],
            ..account_request(PLUGIN, 2, data.path(), "plugin:bin/account", &home)
        })
        .unwrap_err();
    assert_eq!(
        refused,
        "program account-status argument 1 Claude does not match its pattern"
    );
}

// contract: account.run.refuses-a-path-program
#[test]
fn an_account_run_refuses_a_program_path() {
    let data = folder::Folder::new();
    let runs = ProgramRuns::new();
    let error = runs
        .run(account_request(
            PLUGIN,
            1,
            data.path(),
            "bin/account",
            &data.path().join("h"),
        ))
        .unwrap_err();
    assert_eq!(
        error,
        "program account-status must be a plugin path or a bare name in an account run"
    );
}

// contract: account.run.refuses-fifth-open-run, account.run.refuses-an-open-run-identifier, account.run.window-close-ends-the-run
#[test]
fn the_fifth_and_a_repeated_account_run_are_refused_and_the_window_ends_the_rest() {
    let data = folder::Folder::new();
    plugin_script(data.path(), HOLDING);
    let runs = Arc::new(ProgramRuns::new());
    let markers: Vec<_> = (1..=4)
        .map(|run| data.path().join(format!("marker-{run}")))
        .collect();
    let handles: Vec<_> = markers
        .iter()
        .enumerate()
        .map(|(index, marker)| start(&runs, PLUGIN, index as u64 + 1, data.path(), marker))
        .collect();
    for marker in &markers {
        wait_for(marker);
    }
    let fifth = runs
        .run(account_request(
            PLUGIN,
            5,
            data.path(),
            "plugin:bin/account",
            &data.path().join("m5"),
        ))
        .unwrap_err();
    assert_eq!(fifth, "program run: 4 runs are open on plugin plugin-a");
    let other = start(
        &runs,
        "plugin-b",
        1,
        data.path(),
        &data.path().join("other"),
    );
    wait_for(&data.path().join("other"));
    // The end of a surface of the same name leaves the account run open, so its run identifier stays refused.
    runs.end_surface("plugin-b");
    runs.end_view("plugin-b");
    let again = runs
        .run(account_request(
            "plugin-b",
            1,
            data.path(),
            "plugin:bin/account",
            &data.path().join("m7"),
        ))
        .unwrap_err();
    assert_eq!(
        again,
        "program run: run 1 is already open on plugin plugin-b"
    );
    runs.end_window();
    assert_eq!(other.join().unwrap().unwrap().end, Some(End::WindowClosed));
    for handle in handles {
        assert_eq!(handle.join().unwrap().unwrap().end, Some(End::WindowClosed));
    }
}

// contract: account.run.cancel-is-idempotent
#[test]
fn a_repeated_account_run_cancel_ends_the_run_once() {
    let data = folder::Folder::new();
    plugin_script(data.path(), HOLDING);
    let runs = Arc::new(ProgramRuns::new());
    let marker = data.path().join("marker");
    let handle = start(&runs, PLUGIN, 1, data.path(), &marker);
    wait_for(&marker);
    runs.cancel(PLUGIN, 1);
    runs.cancel_account(PLUGIN, 9);
    assert!(
        !handle.is_finished(),
        "another cancel ended the account run"
    );
    runs.cancel_account(PLUGIN, 1);
    runs.cancel_account(PLUGIN, 1);
    assert_eq!(handle.join().unwrap().unwrap().end, Some(End::Cancelled));
}

fn names(config: &std::path::Path) -> Vec<String> {
    let listed = homes(config, "plugin-x").unwrap();
    serde_json::from_value(listed["names"].clone()).unwrap()
}

// contract: account.home.lists-the-folders, account.home.creates-a-private-folder
#[test]
fn account_homes_are_listed_created_and_removed() {
    let config = folder::Folder::new();
    let listed = homes(config.path(), "plugin-x").unwrap();
    let accounts = config.path().join("plugin-data/plugin-x/accounts");
    assert_eq!(listed["folder"], accounts.to_string_lossy().as_ref());
    assert!(names(config.path()).is_empty());
    for id in ["account-2", "account-1"] {
        create(config.path(), "plugin-x", id).unwrap();
    }
    std::fs::write(accounts.join("note"), "").unwrap();
    let mode = std::fs::metadata(accounts.join("account-1"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o700);
    std::fs::write(accounts.join("account-1/settings.json"), "{}").unwrap();
    assert_eq!(names(config.path()), ["account-1", "account-2"]);
    remove(config.path(), "plugin-x", "account-1").unwrap();
    remove(config.path(), "plugin-x", "account-1").unwrap();
    assert_eq!(names(config.path()), ["account-2"]);
}

// contract: account.home.refuses-an-identifier
#[test]
fn an_account_home_refuses_an_identifier_and_a_plugin() {
    let config = folder::Folder::new();
    for id in [
        "",
        "Account",
        "../x",
        "a/b",
        "a2345678901234567890123456789012345678901",
    ] {
        let want = format!("account home {id} is not an account identifier");
        assert_eq!(create(config.path(), "plugin-x", id).unwrap_err(), want);
        assert_eq!(remove(config.path(), "plugin-x", id).unwrap_err(), want);
    }
    for plugin in ["..", "a/b", "X"] {
        let want = format!("account home: plugin {plugin} is not a plugin identifier");
        assert_eq!(
            create(config.path(), plugin, "account-1").unwrap_err(),
            want
        );
        assert_eq!(homes(config.path(), plugin).unwrap_err(), want);
    }
    assert_eq!(std::fs::read_dir(config.path()).unwrap().count(), 0);
}
