//! The start of the process of the host removes the variables of an agent before it starts any process
//! (docs/spec/cli.md#the-window-of-an-agent). `start_process` reads the arguments of the process, so this target has no test
//! harness (`harness = false` in Cargo.toml): the test runs a child of the same binary without arguments, which runs the start and
//! then a process.

#[path = "support/main_thread.rs"]
mod main_thread;

use std::process::Command;

/// The environment variable that tells that the process is the child that runs the start.
const CHILD: &str = "SOKSAK_AGENT_VARIABLES_START";

/// The variables of an agent, as the sok of another application sets them.
const VARIABLES: [&str; 2] = ["SOKSAK_CONFIG_DIR", "SOKSAK_SURFACE"];

// The child inherits SOKSAK_CONFIG_DIR and SOKSAK_SURFACE of another application, runs the start of the host and then starts a
// process, as the host starts the sok of an application update or a sidecar; that process holds neither variable.
// contract: host.environment.removes-the-agent-variables
fn the_start_removes_the_agent_variables_before_it_starts_a_process() -> Result<(), String> {
    let output = Command::new(std::env::current_exe().map_err(|error| error.to_string())?)
        .env(CHILD, "1")
        .env("SOKSAK_CONFIG_DIR", "/other/config")
        .env("SOKSAK_SURFACE", "other-surface")
        .output()
        .map_err(|error| format!("child: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || stdout != "SOKSAK_CONFIG_DIR: absent\nSOKSAK_SURFACE: absent\n" {
        return Err(format!(
            "child ended with {:?}, output {stdout:?}, error output {:?}, want both variables absent",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Runs the start of the process, then starts /usr/bin/printenv for each variable of an agent and prints its value or `absent`.
fn environment_after_the_start() {
    soksak_host::start_process();
    for name in VARIABLES {
        let output = match Command::new("/usr/bin/printenv").arg(name).output() {
            Ok(output) => output,
            Err(error) => {
                println!("printenv {name}: {error}");
                std::process::exit(2);
            }
        };
        match output.status.code() {
            Some(0) => print!("{name}: {}", String::from_utf8_lossy(&output.stdout)),
            // printenv ends with the status 1 for a variable that the environment does not hold.
            Some(1) => println!("{name}: absent"),
            _ => {
                println!("printenv {name} ended with {:?}", output.status);
                std::process::exit(2);
            }
        }
    }
}

const TESTS: &[main_thread::MainTest] = &[(
    "the_start_removes_the_agent_variables_before_it_starts_a_process",
    the_start_removes_the_agent_variables_before_it_starts_a_process,
)];

fn main() {
    if std::env::var_os(CHILD).is_some() {
        environment_after_the_start();
        return;
    }
    main_thread::run(TESTS);
}
