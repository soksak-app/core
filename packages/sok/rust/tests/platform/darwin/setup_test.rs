//! Checks the setup operations of sok that macOS decides (docs/spec/cli.md#mcp-registration, docs/spec/cli.md#setup-parts): the
//! running sok must be the sok of an application bundle, and the judgement with which `sok path install` refuses the running sok
//! and `sok mcp install` refuses the running sok on a read-only volume. The read-only volume is the sealed system volume of
//! macOS, which statvfs reports read-only; the writable volume is the one of the temporary folder of the test.

#![cfg(target_os = "macos")]

#[path = "../../support/agents.rs"]
mod agents;
#[path = "../../support/folder.rs"]
mod folder;

use std::path::Path;

use serde_json::Value;

use agents::{Machine, calls, path_of, run_sok};
use folder::Folder;
use soksak_sok::setup::require_writable_volume;

// contract: cli.mcp.install-requires-a-bundle-sok
#[test]
fn mcp_install_requires_a_bundle_sok() {
    let machine = Machine::new("mcp-not-bundle");
    let sok = machine.bundle_sok("Test.app");
    let plain = machine.sok_in(&machine.root.path().join("build"));
    let path = path_of(&[
        sok.parent().expect("folder"),
        &machine.tools(&["claude"]),
        Path::new("/usr/bin"),
        Path::new("/bin"),
    ]);
    let variables = [("HOME", machine.home_text()), ("PATH", path)];
    let variables: Vec<(&str, &str)> = variables.iter().map(|(n, v)| (*n, v.as_str())).collect();
    let expected = format!(
        "the running sok, {}, is not the sok of an application bundle",
        plain.display()
    );
    let install = run_sok(&plain, &["mcp", "install"], &variables);
    assert_eq!(
        (install.code, install.stderr.as_str()),
        (1, format!("sok: {expected}\n").as_str())
    );
    let check = run_sok(&plain, &["setup", "check"], &variables);
    let parts = check.json()["parts"].clone();
    let mcp = parts
        .as_array()
        .expect("parts")
        .iter()
        .find(|part| part["part"] == "mcp")
        .expect("mcp part")
        .clone();
    assert_eq!(
        (mcp["state"].clone(), mcp["error"].clone()),
        (Value::from("error"), Value::from(expected))
    );
    assert_eq!(calls(&machine), Vec::<String>::new());
}

// contract: cli.setup.refuses-a-read-only-volume
#[test]
fn refuses_a_sok_on_a_read_only_volume() {
    let system = Path::new("/usr/bin/true");
    assert_eq!(
        require_writable_volume(system),
        Err(
            "/usr/bin/true is on a read-only volume; move the application to a folder such as /Applications and start it again"
                .to_string()
        )
    );
    let root = Folder::new("read-only");
    let writable = root.path().join("sok");
    std::fs::write(&writable, "").expect("sok");
    assert_eq!(require_writable_volume(&writable), Ok(()));
}
