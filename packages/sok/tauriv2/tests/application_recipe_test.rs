//! Checks the package and source recipes of an application (docs/spec/installation.md#applications): the brew of the
//! machine answers whether it has a package as the recipe declares it, and a source recipe clones a repository with the git
//! of the machine at a ref into the folder of the application and runs its build commands there; a failed step names
//! itself with its output. The source checks point the https address of the recipe at a repository of the check with the
//! git setting url.<base>.insteadOf, so the clone runs as for a remote address but reads no network. Installing a package
//! changes the machine, so that step runs only in the installation check of a connector plugin (F194.5.8).

use std::ffi::OsString;
use std::process::Command;

use soksak_sok::application::{check_application_package, install_application_source};

fn path() -> OsString {
    std::env::var_os("PATH").expect("PATH")
}

#[test]
fn a_package_that_brew_has_as_declared_is_accepted() {
    check_application_package("brew", "jq", false, &path()).unwrap();
    check_application_package("brew", "iterm2", true, &path()).unwrap();
}

#[test]
fn a_package_that_brew_does_not_have_is_refused_with_its_answer() {
    let error =
        check_application_package("brew", "no-such-cask-soksak", true, &path()).unwrap_err();
    assert!(
        error.contains("application package brew info --cask no-such-cask-soksak"),
        "{error}"
    );
    assert!(error.contains("No Cask with this name exists"), "{error}");
}

#[test]
fn a_package_of_the_other_kind_is_refused() {
    assert!(check_application_package("brew", "iterm2", false, &path()).is_err());
}

/// A git repository with a build script at a tag; the git settings of the command point the https address at it.
fn local_repository() -> (tempfile::TempDir, Vec<(String, String)>) {
    let repository = tempfile::tempdir().unwrap();
    let run = |arguments: &[&str]| {
        let output = Command::new("git")
            .args(arguments)
            .current_dir(repository.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {arguments:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run(&["init", "-q", "-b", "main"]);
    std::fs::write(
        repository.path().join("build.sh"),
        "#!/bin/sh\nmkdir -p bin && printf '#!/bin/sh\\n' > bin/sketcher && chmod +x bin/sketcher\n",
    )
    .unwrap();
    run(&["add", "build.sh"]);
    run(&[
        "-c",
        "user.name=check",
        "-c",
        "user.email=check@example.test",
        "commit",
        "-q",
        "-m",
        "build",
    ]);
    run(&["tag", "v1.0.0"]);
    let settings = vec![
        ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
        (
            "GIT_CONFIG_KEY_0".to_string(),
            format!("url.{}.insteadOf", repository.path().display()),
        ),
        (
            "GIT_CONFIG_VALUE_0".to_string(),
            "https://example.test/sketcher.git".to_string(),
        ),
    ];
    (repository, settings)
}

#[test]
fn a_source_is_cloned_at_its_ref_and_built_in_the_folder_of_the_application() {
    let (_repository, settings) = local_repository();
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("applications/sketcher/1.0.0");
    let commands = vec![vec!["sh".to_string(), "build.sh".to_string()]];
    install_application_source(
        "https://example.test/sketcher.git",
        "v1.0.0",
        &commands,
        &target,
        &path(),
        &settings,
    )
    .unwrap();
    let metadata = std::fs::metadata(target.join("bin/sketcher")).unwrap();
    assert!(std::os::unix::fs::PermissionsExt::mode(&metadata.permissions()) & 0o111 != 0);
}

#[test]
fn a_failed_build_command_names_itself_with_its_output_and_leaves_no_folder() {
    let (_repository, settings) = local_repository();
    let root = tempfile::tempdir().unwrap();
    let commands = vec![vec![
        "sh".to_string(),
        "-c".to_string(),
        "echo broken build >&2; exit 3".to_string(),
    ]];
    let error = install_application_source(
        "https://example.test/sketcher.git",
        "v1.0.0",
        &commands,
        &root.path().join("sketcher"),
        &path(),
        &settings,
    )
    .unwrap_err();
    assert!(
        error.contains("application source command sh -c"),
        "{error}"
    );
    assert!(error.contains("broken build"), "{error}");
    assert_eq!(
        std::fs::read_dir(root.path()).unwrap().count(),
        0,
        "the failed installation left a folder"
    );
}
