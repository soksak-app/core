use super::login_shell::login_shell;

// The login shell is the one that the directory service names for the user of the process
// (docs/spec/cli.md#agents-in-the-application).
// contract: setup.host.reads-the-login-shell-environment
#[test]
fn the_login_shell_is_the_shell_of_the_user_database() {
    let name = std::process::Command::new("/usr/bin/id")
        .arg("-un")
        .output()
        .unwrap();
    assert!(name.status.success(), "id: {name:?}");
    let name = String::from_utf8(name.stdout).unwrap();
    let output = std::process::Command::new("/usr/bin/dscl")
        .args([
            ".",
            "-read",
            &format!("/Users/{}", name.trim()),
            "UserShell",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "dscl: {output:?}");
    let text = String::from_utf8(output.stdout).unwrap();
    let want = text
        .trim()
        .strip_prefix("UserShell: ")
        .unwrap_or_else(|| panic!("dscl printed {text:?}"));
    assert_eq!(login_shell(), Ok(want.to_string()));
}
