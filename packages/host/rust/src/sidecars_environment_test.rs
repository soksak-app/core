//! Checks that the environment of a sidecar process puts the folder of the host executable, where the application bundle holds
//! sok, first on PATH (docs/spec/sidecars.md#processes-of-a-surface).

use std::collections::BTreeMap;
use std::process::Command;

use super::sidecar_environment;

// contract: sidecars.environment.sok-folder-first-on-path
#[test]
fn a_sidecar_environment_puts_the_sok_folder_first_on_path() {
    let executable = std::env::current_exe().expect("test executable");
    let folder = executable.parent().expect("test executable folder");
    let base = BTreeMap::from([(
        "PATH".to_string(),
        format!("/usr/bin:{}:/opt/bin", folder.display()),
    )]);
    let mut command = Command::new("/usr/bin/true");
    sidecar_environment(&mut command, std::path::Path::new("/fixture/config"), Some(base))
        .expect("sidecar environment");
    let path = command
        .get_envs()
        .find(|(name, _)| *name == "PATH")
        .and_then(|(_, value)| value)
        .expect("PATH of the sidecar")
        .to_string_lossy()
        .into_owned();
    let want = format!("{}:/usr/bin:/opt/bin", folder.display());
    assert_eq!(path, want, "sidecar PATH");
}
