//! The start of the process of the host removes the variables of an agent before it starts any process
//! (docs/spec/cli.md#the-window-of-an-agent). `start_process` reads the arguments of the process, so this target has no test
//! harness (`harness = false` in Cargo.toml): the test runs a child of the same binary without arguments, which runs the start and
//! then a process.

#[path = "support/main_thread.rs"]
mod main_thread;

use std::process::Command;

/// The environment variable that tells that the process is the child that runs the start.
const CHILD: &str = "SOKSAK_AGENT_VARIABLES_START";

/// The variable of an agent, as the sidecar of another application sets it.
const VARIABLE: &str = "SOKSAK_CONFIG_DIR";

// The child inherits SOKSAK_CONFIG_DIR of another application, runs the start of the host and then starts a process, as the host
// starts the sok of an application update or a sidecar; that process does not hold the variable.
// contract: host.environment.removes-the-agent-variable
fn the_start_removes_the_agent_variable_before_it_starts_a_process() -> Result<(), String> {
    let output = Command::new(std::env::current_exe().map_err(|error| error.to_string())?)
        .env(CHILD, "1")
        .env("SOKSAK_CONFIG_DIR", "/other/config")
        .output()
        .map_err(|error| format!("child: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || stdout != "SOKSAK_CONFIG_DIR: absent\n" {
        return Err(format!(
            "child ended with {:?}, output {stdout:?}, error output {:?}, want the variable absent",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

/// Runs the start of the process, then starts /usr/bin/printenv for SOKSAK_CONFIG_DIR and prints its value or `absent`.
fn environment_after_the_start() {
    soksak_host::start_process();
    let name = VARIABLE;
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

const TESTS: &[main_thread::MainTest] = &[(
    "the_start_removes_the_agent_variable_before_it_starts_a_process",
    the_start_removes_the_agent_variable_before_it_starts_a_process,
)];

fn main() {
    if std::env::var_os(CHILD).is_some() {
        environment_after_the_start();
        return;
    }
    main_thread::run(TESTS);
}
