//! Shared parts of the tests of the agent commands of sok (docs/spec/cli.md#agents): a disposable machine whose application bundle
//! folders hold the built sok, the run of a sok with only the variables that a test sets, and the fixture program
//! docs/spec/cases/setup/fixture.sh copied as the claude and sudo commands.

#![allow(dead_code)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;

use super::folder::Folder;

/// The fixture program of the external commands of the setup operations, found from the manifest folder upwards.
pub fn fixture_program() -> PathBuf {
    let start = Path::new(env!("CARGO_MANIFEST_DIR"));
    start
        .ancestors()
        .map(|folder| folder.join("docs/spec/cases/setup/fixture.sh"))
        .find(|file| file.is_file())
        .unwrap_or_else(|| {
            panic!(
                "no docs/spec/cases/setup/fixture.sh holds {}",
                start.display()
            )
        })
}

/// A disposable machine: a home folder and application bundle folders that hold the built sok as a hard link, so each is a sok of
/// an application bundle at its own path.
pub struct Machine {
    pub root: Folder,
    pub home: PathBuf,
}

impl Machine {
    pub fn new(label: &str) -> Machine {
        let root = Folder::new(label);
        let home = root.path().join("home");
        std::fs::create_dir(&home).expect("home");
        Machine { root, home }
    }

    /// Places the built sok at `<root>/<bundle>/Contents/MacOS/sok` and returns that path with symbolic links resolved.
    pub fn bundle_sok(&self, bundle: &str) -> PathBuf {
        let folder = self.root.path().join(bundle).join("Contents/MacOS");
        self.sok_in(&folder)
    }

    /// Places the built sok in the folder and returns its path with symbolic links resolved.
    pub fn sok_in(&self, folder: &Path) -> PathBuf {
        std::fs::create_dir_all(folder).expect("sok folder");
        let sok = folder.join("sok");
        std::fs::hard_link(env!("CARGO_BIN_EXE_sok"), &sok).expect("link sok");
        sok.canonicalize().expect("canonical sok")
    }

    pub fn folder(&self, name: &str) -> PathBuf {
        let folder = self.home.join(name);
        std::fs::create_dir_all(&folder).expect("folder");
        folder
    }

    pub fn home_text(&self) -> String {
        self.home.display().to_string()
    }

    /// The folder `<root>/tools` with the fixture program copied under each of the names, such as `claude` and `sudo`.
    pub fn tools(&self, names: &[&str]) -> PathBuf {
        let tools = self.root.path().join("tools");
        std::fs::create_dir_all(&tools).expect("tools");
        for name in names {
            std::fs::copy(fixture_program(), tools.join(name)).expect("copy fixture");
            std::fs::set_permissions(tools.join(name), std::fs::Permissions::from_mode(0o755))
                .expect("mode");
        }
        tools
    }

    /// The log of the fixture program, which the variable SETUP_FIXTURE_LOG names.
    pub fn log(&self) -> PathBuf {
        self.root.path().join("fixture.log")
    }

    /// The PATH of the claude fixture and the system tools.
    pub fn claude_path(&self) -> String {
        path_of(&[
            &self.tools(&["claude"]),
            Path::new("/usr/bin"),
            Path::new("/bin"),
        ])
    }
}

/// The result of one run of sok.
pub struct Run {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Run {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.stdout)
            .unwrap_or_else(|error| panic!("{error}: {} {}", self.stdout, self.stderr))
    }
}

/// Runs the sok with only the given variables in its environment and standard input from /dev/null. With HOME, the fixture
/// program logs to `fixture.log` beside the home folder of the machine.
pub fn run_sok(sok: &Path, args: &[&str], variables: &[(&str, &str)]) -> Run {
    let mut command = Command::new(sok);
    command
        .args(args)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, value) in variables {
        command.env(name, value);
        if *name == "HOME" {
            let log = Path::new(value).parent().expect("root").join("fixture.log");
            command.env("SETUP_FIXTURE_LOG", log);
        }
    }
    let output = command.output().expect("run sok");
    Run {
        code: output.status.code().expect("exit status"),
        stdout: String::from_utf8(output.stdout).expect("stdout"),
        stderr: String::from_utf8(output.stderr).expect("stderr"),
    }
}

pub fn path_of(folders: &[&Path]) -> String {
    std::env::join_paths(folders)
        .expect("PATH")
        .into_string()
        .expect("UTF-8 PATH")
}

/// The skill text that sok writes: the text that it embeds (docs/spec/cli.md#agent-sources).
pub fn skill_text() -> Vec<u8> {
    soksak_sok::agents::SKILL.as_bytes().to_vec()
}

/// The names of the files of a folder that are not the given ones, such as a temporary file that a write left.
pub fn other_files(folder: &Path, names: &[&str]) -> Vec<String> {
    std::fs::read_dir(folder)
        .expect("read folder")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| !names.contains(&name.as_str()))
        .collect()
}

/// The commands that the fixture program ran, one line each.
pub fn calls(machine: &Machine) -> Vec<String> {
    match std::fs::read_to_string(machine.log()) {
        Ok(text) => text.lines().map(String::from).collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => panic!("fixture.log: {error}"),
    }
}

/// A registration entry of the configuration file.
pub fn entry(command: &Path) -> Value {
    serde_json::json!({"type": "stdio", "command": command.display().to_string(), "args": ["mcp"], "env": {}})
}

pub fn add_call(registered: &Path) -> String {
    format!(
        "claude mcp add --scope user soksak -- {} mcp",
        registered.display()
    )
}
