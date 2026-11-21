//! Checks the setup parts in the application (docs/spec/cli.md#agents-in-the-application): the host reads the environment of
//! the login shell, brings the skill current at start and runs the setup operations of the setup library. The tests run the real
//! login shell /bin/zsh with start files in a disposable home, the sok fixture of an application bundle
//! (tests/fixtures/setup/sok) and the fixture program of the claude command (docs/spec/cases/setup/fixture.sh).

#[path = "support/folder.rs"]
mod folder;
#[path = "support/records.rs"]
mod records;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use soksak_host::platform::{self, Platform};
use soksak_host::setup::{InstallRequest, LoginShellProcesses, Parts, Setups};

/// The login shell of the tests: zsh reads .zprofile and .zshrc of the disposable home as a login and interactive shell.
const SHELL: &str = "/bin/zsh";

/// The tests change HOME of this process, so they run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

/// The platform of this system with /bin/zsh as the login shell, because the test cannot change the user database.
struct ZshLogin(&'static dyn Platform);

impl LoginShellProcesses for ZshLogin {
    fn login_shell(&self) -> Result<String, String> {
        Ok(SHELL.to_string())
    }
    fn new_process_group(&self, command: &mut Command) -> Result<(), String> {
        self.0.new_process_group(command)
    }
    fn end_process_group(&self, pid: u32) -> Result<(), String> {
        self.0.end_process_group(pid)
    }
}

/// A file of the repository.
fn repository_file(relative: &str) -> PathBuf {
    let mut folder = Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf();
    loop {
        if folder.join(relative).exists() {
            return folder.join(relative);
        }
        assert!(folder.pop(), "no folder above the package holds {relative}");
    }
}

/// Copies the file to path with mode 0755 and returns the canonical path of the copy.
fn copy_to(source: &Path, path: &Path) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::copy(source, path).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.canonicalize().unwrap()
}

/// A disposable home whose login shell finds the claude fixture and the sok of an application bundle only through the PATH that
/// its .zprofile sets, and sets CLAUDE_CONFIG_DIR.
struct Home {
    folder: folder::Folder,
    log: folder::Folder,
    sok: PathBuf,
    config: PathBuf,
}

impl Home {
    fn new(zshrc: &str) -> Home {
        let folder = folder::Folder::new();
        let home = folder.path().canonicalize().unwrap();
        // The space in the bundle name makes the step quote <sok>.
        let sok = copy_to(
            &repository_file("packages/host/rust/tests/fixtures/setup/sok"),
            &home.join("Applications/Fixture App.app/Contents/MacOS/sok"),
        );
        // The first run of a new executable can wait at its start while the system checks the file, so the test runs it once
        // before the bound of the login shell read applies.
        let first = Command::new(&sok)
            .args(["setup", "environment"])
            .output()
            .unwrap();
        assert!(
            first.status.success(),
            "the first run of {}: {first:?}",
            sok.display()
        );
        let tools = home.join("tools");
        // The fixture as sudo records a run of sudo, which no operation of the application may start.
        for name in ["claude", "sudo"] {
            copy_to(
                &repository_file("docs/spec/cases/setup/fixture.sh"),
                &tools.join(name),
            );
        }
        let config = home.join("agent-config");
        for dir in [home.join(".claude"), config.clone()] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let log = folder::Folder::new();
        // The login PATH leaves out every directory that holds a codex command, so the registration with codex runs the same way on
        // any machine; the codex registration has its own case (docs/spec/cli.md#mcp-registration).
        let zprofile = format!(
            "export PATH={:?}:{:?}:$PATH\nwithout=\"\"\nfor dir in ${{(s,:,)PATH}}; do [ -x \"$dir/codex\" ] || without=\"$without:$dir\"; done\nexport PATH=\"${{without#:}}\"\nexport CLAUDE_CONFIG_DIR={:?}\n",
            sok.parent().unwrap(),
            tools,
            config
        );
        std::fs::write(home.join(".zprofile"), zprofile).unwrap();
        std::fs::write(home.join(".zshrc"), zshrc).unwrap();
        // SAFETY: the tests of this file hold SERIAL while they change the environment, and no other thread of this test
        // executable reads it meanwhile. The commands that the setup library starts inherit the environment of the host process with
        // the three variables of the login shell, so the log of the fixture is named in the environment of this process.
        unsafe {
            std::env::set_var("HOME", &home);
            for name in [
                "ZDOTDIR",
                "CLAUDE_CONFIG_DIR",
                "SETUP_FIXTURE_FAIL",
                "SETUP_FIXTURE_SKIP_WRITE",
                "SOKSAK_FIXTURE_LEAK",
            ] {
                std::env::remove_var(name);
            }
            std::env::set_var("SETUP_FIXTURE_LOG", log.path().join("commands.log"));
        }
        Home {
            folder,
            log,
            sok,
            config,
        }
    }

    fn home(&self) -> PathBuf {
        self.folder.path().canonicalize().unwrap()
    }

    /// The lines of the fixture log: the external commands that ran.
    fn commands(&self) -> Vec<String> {
        match std::fs::read_to_string(self.log.path().join("commands.log")) {
            Ok(text) => text.lines().map(str::to_string).collect(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => panic!("read the fixture log: {error}"),
        }
    }

    /// The setup operations of the bundle sok of the home, and the receiver of each setup-changed.
    fn setups(&self) -> (Setups, Receiver<()>) {
        let (changed, receive) = mpsc::channel();
        let changed = Mutex::new(changed);
        let setups = Setups::new(
            self.sok.clone(),
            "com.soksak.test".into(),
            Box::new(ZshLogin(platform::current().unwrap())),
            Box::new(move || changed.lock().unwrap().send(()).unwrap()),
        )
        .unwrap();
        (setups, receive)
    }
}

/// The process id that a start file wrote to the file.
fn pid_of(file: &Path) -> i32 {
    std::fs::read_to_string(file)
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

/// Waits for the exit of the process pid through the process exit event of kqueue; a process that already ended is refused by the
/// registration with ESRCH.
fn wait_exited(pid: i32) {
    unsafe {
        let queue = libc::kqueue();
        assert!(queue >= 0, "kqueue: {}", std::io::Error::last_os_error());
        let change = libc::kevent {
            ident: pid as libc::uintptr_t,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_ONESHOT,
            fflags: libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        let mut event: libc::kevent = std::mem::zeroed();
        let result = libc::kevent(queue, &change, 1, &mut event, 1, std::ptr::null());
        let error = std::io::Error::last_os_error();
        libc::close(queue);
        assert!(
            result >= 0 || error.raw_os_error() == Some(libc::ESRCH),
            "watch the exit of {pid}: {error}"
        );
    }
}

/// The parts as `part | file | state | reason | step` lines without the path entry, and the step of the path entry.
fn lines(parts: &Parts) -> (Vec<String>, Option<String>) {
    let value = serde_json::to_value(parts).unwrap();
    let mut path = None;
    let mut lines = Vec::new();
    for part in value["parts"].as_array().unwrap() {
        if part["part"] == "path" {
            path = Some(part["step"].as_str().unwrap().to_string());
            continue;
        }
        lines.push(format!(
            "{} | {} | {} | {} | {}",
            part["part"].as_str().unwrap(),
            part["file"].as_str().unwrap(),
            part["state"].as_str().unwrap(),
            part["reason"].as_str().unwrap_or(""),
            part["step"].as_str().unwrap()
        ));
    }
    (lines, path)
}

// contract: setup.host.reads-the-login-shell-environment, setup.host.start-brings-the-skill-current
#[test]
fn setup_reads_the_login_shell_environment_and_brings_the_skill_current() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    // The start files print before the line, and a process that they start holds the output open after it.
    let h = Home::new(
        "echo start-file output\necho start-file error >&2\nsleep 600 &\necho $! > \"$HOME/background.pid\"\n",
    );
    let differing = h.config.join("skills/soksak/SKILL.md");
    std::fs::create_dir_all(differing.parent().unwrap()).unwrap();
    std::fs::write(&differing, "an earlier skill\n").unwrap();
    let (setups, changed) = h.setups();
    setups.start();
    setups.start();
    changed.recv().unwrap();
    wait_exited(pid_of(&h.home().join("background.pid")));
    let skill = soksak_sok::agents::SKILL;
    let home_skill = h.home().join(".claude/skills/soksak/SKILL.md");
    for file in [&home_skill, &differing] {
        assert_eq!(
            std::fs::read_to_string(file).unwrap(),
            skill,
            "the start did not bring {} current",
            file.display()
        );
    }
    assert_eq!(h.commands(), Vec::<String>::new(), "the start ran commands");
    let step = format!("'{}'", h.sok.display());
    let (got, path) = lines(&setups.state().unwrap());
    // The user PATH registration applies on macOS and preserves the existing command.
    if let Some(path) = path {
        assert!(path.is_empty(), "{path}");
    }
    assert_eq!(
        got,
        [
            format!(
                "skill | {} | ok |  | {step} skill install",
                home_skill.display()
            ),
            format!(
                "skill | {} | ok |  | {step} skill install",
                differing.display()
            ),
            format!(
                "mcp | {} | missing | absent | {step} mcp install",
                h.config.join(".claude.json").display()
            ),
            format!(
                "hook | {} | missing | absent | {step} setup install hook",
                h.home().join(".claude/settings.json").display()
            ),
            format!(
                "hook | {} | missing | absent | {step} setup install hook",
                h.config.join("settings.json").display()
            ),
        ]
    );
}

// contract: setup.host.reads-the-login-shell-environment-without-the-launcher
#[test]
fn the_sidecar_environment_is_the_login_shell_environment_without_the_variables_of_the_launcher() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let h = Home::new("");
    // SAFETY: the test holds SERIAL while it changes the environment. The variable stands for a variable of the process that
    // started the application, such as a session variable of an agent.
    unsafe { std::env::set_var("SOKSAK_FIXTURE_LEAK", "launcher") };
    let (setups, changed) = h.setups();
    setups.start();
    changed.recv().unwrap();
    let environment = setups.sidecar_environment().unwrap();
    // SAFETY: as above.
    unsafe { std::env::remove_var("SOKSAK_FIXTURE_LEAK") };
    assert_eq!(
        environment.get("SOKSAK_FIXTURE_LEAK"),
        None,
        "a variable of the launcher reached the login shell: {environment:?}"
    );
    assert_eq!(
        environment.get("HOME"),
        Some(&h.home().display().to_string())
    );
    assert!(
        environment
            .get("PATH")
            .is_some_and(|path| path.starts_with(&h.sok.parent().unwrap().display().to_string())),
        "the PATH of the start files: {environment:?}"
    );
    for name in ["PWD", "SHLVL", "_"] {
        assert_eq!(
            environment.get(name),
            None,
            "{name} of the shell process: {environment:?}"
        );
    }
}

// contract: setup.host.reconciles-user-path
#[test]
fn setup_registers_user_path_on_start() {
    let _serial = SERIAL.lock().unwrap_or_else(|error| error.into_inner());
    let home = Home::new("export PATH=/usr/bin:/bin\n");
    let (setups, changed) = home.setups();
    setups.start();
    changed.recv().unwrap();
    let entry = home.home().join(".local/bin/sok");
    assert_eq!(
        entry
            .canonicalize()
            .unwrap_or_else(|error| panic!("{}: {error}", entry.display())),
        home.sok
    );
    assert!(home.commands().is_empty());
    let before = setups.state().unwrap();
    assert_eq!(before.parts[0].state, soksak_sok::setup::State::Ok);
    let disabled = setups
        .change(soksak_host::setup::ChangeRequest {
            part: "path".into(),
            enabled: false,
        })
        .unwrap();
    assert_eq!(disabled.parts[0].enabled, Some(false));
    let (restarted, changed) = home.setups();
    restarted.start();
    changed.recv().unwrap();
    assert_eq!(restarted.state().unwrap().parts[0].enabled, Some(false));
    assert_eq!(
        entry.symlink_metadata().unwrap_err().kind(),
        std::io::ErrorKind::NotFound
    );
}

// contract: setup.host.start-brings-the-skill-current
#[test]
fn setup_records_a_skill_file_that_cannot_be_written() {
    use std::os::unix::fs::PermissionsExt;
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let logs = folder::Folder::new();
    let log = records::start_writer(logs.path());
    // The start of the writer writes the records that the earlier tests of this process made while no writer was in use, so the
    // test judges only the records after them.
    log.flush().unwrap();
    let earlier = records::read_events(&records::event_log_path(logs.path())).len();
    let h = Home::new("");
    let folder = h.home().join(".claude/skills/soksak");
    let file = folder.join("SKILL.md");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(&file, "an earlier skill\n").unwrap();
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o555)).unwrap();
    let (setups, changed) = h.setups();
    setups.start();
    changed.recv().unwrap();
    std::fs::set_permissions(&folder, std::fs::Permissions::from_mode(0o755)).unwrap();
    log.flush().unwrap();
    soksak_host::event_record::use_host_event_log(None);
    let recorded: Vec<Value> = records::read_events(&records::event_log_path(logs.path()))
        .into_iter()
        .skip(earlier)
        .filter(|event| event["event"] == "host.setup.skill")
        .map(|event| json!([event["level"], event["fields"]]))
        .collect();
    assert_eq!(
        recorded,
        [json!(["error", { "file": file.display().to_string(), "reason": "permission denied" }])]
    );
    assert_eq!(h.commands(), Vec::<String>::new(), "the start ran commands");
}

// contract: setup.host.reads-the-login-shell-environment
#[test]
fn setup_fails_when_the_login_shell_ends_before_the_line() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let h = Home::new("echo start-file output\necho boom >&2\necho second >&2\nexit 3\n");
    let (setups, changed) = h.setups();
    setups.start();
    changed.recv().unwrap();
    let want = format!("login shell {SHELL}: exit status 3: boom");
    assert_eq!(setups.state(), Err(want.clone()));
    assert_eq!(
        setups.install(InstallRequest {
            parts: json!(["skill"])
        }),
        Err(want)
    );
}

// contract: setup.host.reads-the-login-shell-environment
#[test]
fn setup_fails_when_the_login_shell_waits() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let gate = folder::Folder::new();
    let fifo = gate.path().join("gate");
    let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(
        unsafe { libc::mkfifo(name.as_ptr(), 0o600) },
        0,
        "mkfifo: {}",
        std::io::Error::last_os_error()
    );
    let h = Home::new(&format!(
        "echo start-file output\necho $$ > \"$HOME/shell.pid\"\nread line < {fifo:?}\n"
    ));
    let (setups, changed) = h.setups();
    setups.start();
    changed.recv().unwrap();
    assert_eq!(
        setups.state(),
        Err(format!("login shell {SHELL}: no environment within 10 s"))
    );
    wait_exited(pid_of(&h.home().join("shell.pid")));
}

// contract: setup.host.state-and-install
#[test]
fn setup_installs_the_skill_and_the_registration_one_at_a_time() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let gate = folder::Folder::new();
    let fifo = gate.path().join("gate");
    let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(
        unsafe { libc::mkfifo(name.as_ptr(), 0o600) },
        0,
        "mkfifo: {}",
        std::io::Error::last_os_error()
    );
    // The shell waits at the gate, so the first install holds the setup operation while it waits for the environment.
    let h = Home::new(&format!(
        "if [ ! -e \"$HOME/setup-read\" ]; then\n  read line < {fifo:?}\n  : > \"$HOME/setup-read\"\nfi\n"
    ));
    let (setups, changed) = h.setups();
    setups.start();
    let (answer, answers) = mpsc::channel();
    let setups = Arc::new(setups);
    for _ in 0..2 {
        let (setups, answer) = (Arc::clone(&setups), answer.clone());
        std::thread::spawn(move || {
            answer
                .send(setups.install(InstallRequest {
                    parts: json!(["skill", "mcp"]),
                }))
                .unwrap();
        });
    }
    let refused = answers.recv().unwrap();
    assert_eq!(
        refused,
        Err("another setup operation is running".to_string())
    );
    std::fs::write(&fifo, "open\n").unwrap();
    let installed = serde_json::to_value(answers.recv().unwrap().unwrap()).unwrap();
    let states: Vec<String> = installed["parts"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|part| part["part"] != "path")
        .map(|part| {
            format!(
                "{} {} {}",
                part["part"].as_str().unwrap(),
                part["state"].as_str().unwrap(),
                part["changed"]
            )
        })
        .collect();
    // The skill files were written by the start, which ends before the install takes the environment.
    // The install lists every part as the check reads it afterwards; hook is not named, so it stays missing.
    assert_eq!(
        states,
        [
            "skill ok false",
            "skill ok false",
            "mcp ok true",
            "hook missing false",
            "hook missing false"
        ]
    );
    let registration = format!(
        "claude mcp add --scope user soksak -- {} mcp",
        h.sok.display()
    );
    assert!(
        h.commands().contains(&registration),
        "the install ran {:?}",
        h.commands()
    );
    // One setup-changed after the skill write at start and one after the install.
    changed.recv().unwrap();
    changed.recv().unwrap();
    let state = serde_json::to_value(setups.state().unwrap()).unwrap();
    let mcp = state["parts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|part| part["part"] == "mcp")
        .unwrap()
        .clone();
    assert_eq!(mcp["state"], json!("ok"));

    let want = format!(
        "the path entry needs administrator rights: run sudo '{}' path install in a terminal",
        h.sok.display()
    );
    assert_eq!(
        setups.install(InstallRequest {
            parts: json!(["path", "skill"])
        }),
        Err(want)
    );
    for parts in [
        json!(null),
        json!([]),
        json!(["skill", "skill"]),
        json!("skill"),
        json!([1]),
    ] {
        assert_eq!(
            setups.install(InstallRequest {
                parts: parts.clone()
            }),
            Err("parts must be a non-empty list of setup parts without repetition".to_string()),
            "parts {parts}"
        );
    }
    assert_eq!(
        setups.install(InstallRequest {
            parts: json!(["other"])
        }),
        Err("unknown setup part: other".to_string())
    );
    assert!(
        changed.try_recv().is_err(),
        "a refused install sent setup-changed"
    );
}
