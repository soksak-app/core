// The agentprobe sidecar: the fixture sidecar of the agent layout window check (docs/spec/cli.md#acting-on-a-layout). It reads
// the lines of the host on its standard input (docs/spec/sidecars.md#messages) and starts for a surface, on the request
// `{"operation": "start", "sok": <path>}`, a process that carries SOKSAK_CONFIG_DIR and SOKSAK_SURFACE
// (docs/spec/sidecars.md#processes-of-a-surface), writes them as its first line and runs `<sok> context` in its place. When the
// process ends, the sidecar sends the surface `{"event": "process", configDirectory, surface, context}`.
//
//     sok-agentprobe                   the sidecar that the host starts
//     sok-agentprobe --process <sok>   the process of a surface
use std::collections::HashMap;
use std::ffi::{CString, c_char};
use std::io::{BufRead, Read, Write};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde_json::{Value, json};

unsafe extern "C" {
    fn soksak_process_set_display_name(display_name: *const c_char, error: *mut c_char, error_capacity: usize) -> i32;
}

/// The displayName of sidecar.json, embedded at build time.
const DISPLAY_NAME: &str = env!("AGENTPROBE_DISPLAY_NAME");

/// Registers the declared display name of the sidecar before it reads its input (docs/spec/process-identity.md).
fn set_display_name() -> Result<(), String> {
    let name = CString::new(DISPLAY_NAME).map_err(|error| format!("display name {DISPLAY_NAME}: {error}"))?;
    let mut error = [0 as c_char; 512];
    // SAFETY: the name is NUL-terminated and the error buffer has the capacity passed.
    let status = unsafe { soksak_process_set_display_name(name.as_ptr(), error.as_mut_ptr(), error.len()) };
    if status != 0 {
        // SAFETY: the function writes a NUL-terminated diagnostic into the buffer on failure.
        let text = unsafe { std::ffi::CStr::from_ptr(error.as_ptr()) }.to_string_lossy().into_owned();
        return Err(format!("display name {DISPLAY_NAME}: {text}"));
    }
    Ok(())
}

/// The process of a surface: writes its two variables as one JSON line and replaces itself with `<sok> context`, so the
/// process that the sidecar started is the process of `sok`. It returns only when the replacement failed.
fn process(sok: &str) -> ! {
    let variable = |name| std::env::var(name).ok();
    let line = json!({"configDirectory": variable("SOKSAK_CONFIG_DIR"), "surface": variable("SOKSAK_SURFACE")});
    let mut out = std::io::stdout();
    if let Err(error) = writeln!(out, "{line}").and_then(|()| out.flush()) {
        eprintln!("write the variables: {error}");
        std::process::exit(126);
    }
    let error = Command::new(sok).arg("context").exec();
    eprintln!("run {sok}: {error}");
    std::process::exit(127);
}

/// The standard output of the sidecar, shared by the reader of the input and the waits of the processes.
type Output = Arc<Mutex<std::io::Stdout>>;

/// Writes one message line of the sidecar. A failed write means that the host no longer reads, so the sidecar ends.
fn write(output: &Output, message: Value) {
    let mut out = output.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Err(error) = writeln!(out, "{message}").and_then(|()| out.flush()) {
        eprintln!("write a message: {error}");
        std::process::exit(1);
    }
}

/// A running process of a surface. The wait of the process reaps it under the lock and leaves None, so a close that finds
/// Some kills the process before anything reaped it.
type Running = Arc<Mutex<Option<Child>>>;

/// The state of the sidecar: its output, its SOKSAK_CONFIG_DIR, the running processes by surface and the threads that wait for
/// them, which the end of the sidecar joins so that it ends after the reports that they have begun.
struct Sidecar {
    output: Output,
    config: Option<String>,
    running: HashMap<String, Vec<Running>>,
    waits: Vec<JoinHandle<()>>,
}

impl Sidecar {
    /// Starts the process of `surface` that runs `sok`, and a thread that waits for its end and sends the surface its report.
    fn start(&mut self, surface: &str, sok: &str) -> Result<(), String> {
        let Some(config) = &self.config else {
            return Err("the host started the sidecar without SOKSAK_CONFIG_DIR".to_string());
        };
        let me = std::env::current_exe().map_err(|error| format!("the path of the sidecar: {error}"))?;
        let mut child = Command::new(me)
            .arg("--process")
            .arg(sok)
            .env("SOKSAK_CONFIG_DIR", config)
            .env("SOKSAK_SURFACE", surface)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("process of {surface}: start: {error}"))?;
        let mut stdout = child.stdout.take().expect("the output of the process is piped");
        let mut stderr = child.stderr.take().expect("the error output of the process is piped");
        let cell: Running = Arc::new(Mutex::new(Some(child)));
        self.running.entry(surface.to_string()).or_default().push(cell.clone());
        let output = self.output.clone();
        let surface = surface.to_string();
        let sok = sok.to_string();
        self.waits.push(std::thread::spawn(move || {
            let errors = std::thread::spawn(move || {
                let mut text = Vec::new();
                stderr.read_to_end(&mut text).map(|_| text)
            });
            let mut text = Vec::new();
            let read = stdout.read_to_end(&mut text);
            let errors = errors.join().unwrap_or_else(|_| Err(std::io::Error::other("the read of the error output panicked")));
            let Some(mut child) = cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take() else {
                // The close of the surface ended and reaped the process; it sends no report.
                return;
            };
            let body = match (read, errors, child.wait()) {
                (Err(error), _, _) => json!({"error": format!("process of {surface}: read its output: {error}")}),
                (_, Err(error), _) => json!({"error": format!("process of {surface}: read its error output: {error}")}),
                (_, _, Err(error)) => json!({"error": format!("process of {surface}: wait: {error}")}),
                (Ok(_), Ok(errors), Ok(status)) => report(&surface, &sok, &text, &errors, status),
            };
            write(&output, json!({"surface": surface, "body": body}));
        }));
        Ok(())
    }

    /// Ends the running processes of `surface` and reaps them.
    fn close(&mut self, surface: &str) -> Result<(), String> {
        let mut failures = Vec::new();
        for cell in self.running.remove(surface).unwrap_or_default() {
            let mut slot = cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(mut child) = slot.take() {
                if let Err(error) = child.kill() {
                    failures.push(format!("kill process {}: {error}", child.id()));
                }
                if let Err(error) = child.wait() {
                    failures.push(format!("wait for process {}: {error}", child.id()));
                }
            }
        }
        if failures.is_empty() { Ok(()) } else { Err(failures.join("; ")) }
    }

    /// Applies one line of the host.
    fn line(&mut self, text: &str) {
        let message: Value = match serde_json::from_str(text) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("the host sent a line that is not JSON: {error}: {text}");
                return;
            }
        };
        let Some(surface) = message["surface"].as_str() else {
            eprintln!("the host sent a line without a surface: {text}");
            return;
        };
        if message["closed"] == json!(true) {
            let answer = match self.close(surface) {
                Ok(()) => json!({"surface": surface, "closed": true}),
                Err(error) => json!({"surface": surface, "closed": true, "error": error}),
            };
            write(&self.output, answer);
            return;
        }
        let body = &message["body"];
        let result = match (body["operation"].as_str(), body["sok"].as_str()) {
            (Some("start"), Some(sok)) => self.start(surface, sok),
            (Some("start"), None) => Err(format!("start needs sok, the path of the sok program, not {}", body["sok"])),
            _ => Err(format!("unknown operation {}", body["operation"])),
        };
        if let Err(error) = result {
            write(&self.output, json!({"surface": surface, "body": {"error": error}}));
        }
    }

    /// Ends the processes that still run and waits for the reports that have begun.
    fn end(mut self) {
        let surfaces: Vec<String> = self.running.keys().cloned().collect();
        for surface in surfaces {
            if let Err(error) = self.close(&surface) {
                eprintln!("end the processes of {surface}: {error}");
            }
        }
        for wait in self.waits {
            if wait.join().is_err() {
                eprintln!("the wait of a process panicked");
            }
        }
    }
}

/// The report of a process that ended with `status`: its first line holds its variables and the rest of its output is the output
/// of `sok context`. A process whose replacement failed, or that ended before its first line, is an error with its error output.
fn report(surface: &str, sok: &str, output: &[u8], errors: &[u8], status: std::process::ExitStatus) -> Value {
    let errors = String::from_utf8_lossy(errors).into_owned();
    if status.code() == Some(127) && errors.starts_with(&format!("run {sok}: ")) {
        return json!({"error": format!("process of {surface}: {}", errors.trim_end())});
    }
    let text = String::from_utf8_lossy(output);
    let Some((first, rest)) = text.split_once('\n') else {
        return json!({"error": format!("process of {surface}: ended with {status} before it wrote its variables: {errors}")});
    };
    let variables: Value = match serde_json::from_str(first) {
        Ok(value) => value,
        Err(error) => return json!({"error": format!("process of {surface}: its first line {first:?} is not JSON: {error}")}),
    };
    json!({
        "event": "process",
        "configDirectory": variables["configDirectory"],
        "surface": variables["surface"],
        "context": {"status": status.code(), "signal": status.signal(), "stdout": rest, "stderr": errors},
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let [flag, sok] = args.as_slice()
        && flag == "--process"
    {
        process(sok);
    }
    if !args.is_empty() {
        eprintln!("unknown arguments {args:?}");
        std::process::exit(2);
    }
    if let Err(error) = set_display_name() {
        eprintln!("{error}");
        std::process::exit(1);
    }
    let mut sidecar = Sidecar {
        output: Arc::new(Mutex::new(std::io::stdout())),
        // The host sets SOKSAK_CONFIG_DIR when it starts the sidecar; an empty value names no directory.
        config: std::env::var("SOKSAK_CONFIG_DIR").ok().filter(|value| !value.is_empty()),
        running: HashMap::new(),
        waits: Vec::new(),
    };
    for text in std::io::stdin().lock().lines() {
        match text {
            Ok(text) => sidecar.line(&text),
            Err(error) => {
                eprintln!("read the input: {error}");
                break;
            }
        }
    }
    // The end of the input is the stop of the sidecar.
    sidecar.end();
}
