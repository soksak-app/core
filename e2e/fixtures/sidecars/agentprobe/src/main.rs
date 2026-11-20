// The agentprobe sidecar: the fixture sidecar of the agent layout window check (docs/spec/cli.md#acting-on-a-layout). It reads
// the lines of the host on its standard input (docs/spec/sidecars.md#messages) and starts for a surface, on the request
// `{"operation": "start", "sok": <path>}`, a process that carries SOKSAK_CONFIG_DIR (docs/spec/sidecars.md#processes-of-a-surface),
// writes it as its first line and runs `<sok> context` in its place. When the process ends, the sidecar sends the surface
// `{"event": "process", configDirectory, context}`. It records each process that it starts with its start time and answers the
// process queries of the host (docs/spec/sidecars.md#process-identity).
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

/// The process of a surface: writes its SOKSAK_CONFIG_DIR as one JSON line and replaces itself with `<sok> context`, so the
/// process that the sidecar started is the process of `sok`. It returns only when the replacement failed.
fn process(sok: &str) -> ! {
    let variable = |name| std::env::var(name).ok();
    let line = json!({"configDirectory": variable("SOKSAK_CONFIG_DIR")});
    let mut out = std::io::stdout();
    if let Err(error) = writeln!(out, "{line}").and_then(|()| out.flush()) {
        eprintln!("write the configuration directory: {error}");
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

/// The processes that the sidecar started and has not reaped: the surface and the start time in milliseconds since the Unix epoch of
/// each, by process id. A process is recorded before the next line of the host is read and removed under the lock of its Running
/// when it is reaped, so a process query never names a reaped process.
type Started = Arc<Mutex<HashMap<u32, (String, i64)>>>;

/// The size of `struct kinfo_proc` of `sys/sysctl.h` and the offset of `kp_proc.p_starttime` in it, a `struct timeval` of an 8-byte
/// second and a 4-byte microsecond. The crate libc declares no `kinfo_proc` for Apple platforms, so these values come from the
/// header; a sysctl answer of another size is an error.
const KINFO_PROC_SIZE: usize = 648;
const KINFO_PROC_STARTED: usize = 0;

/// The start time of the process `pid` in milliseconds since the Unix epoch, from the process table of the `kern.proc.pid` sysctl,
/// which the host reads too (docs/spec/sidecars.md#process-identity).
fn start_time(pid: u32) -> Result<i64, String> {
    let mut name = [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_PID, pid as libc::c_int];
    let mut buffer = [0u8; KINFO_PROC_SIZE];
    let mut size = KINFO_PROC_SIZE;
    // SAFETY: name has the four integers of the request, and buffer has the size that size states.
    let result = unsafe {
        libc::sysctl(name.as_mut_ptr(), name.len() as libc::c_uint, buffer.as_mut_ptr().cast(), &raw mut size, std::ptr::null_mut(), 0)
    };
    if result != 0 {
        return Err(format!("read process {pid}: {}", std::io::Error::last_os_error()));
    }
    if size != KINFO_PROC_SIZE {
        return Err(format!("read process {pid}: the process table answered {size} of {KINFO_PROC_SIZE} bytes"));
    }
    // The process table holds the integers in the byte order of the machine, which is little-endian on every Mac.
    let seconds = i64::from_le_bytes(buffer[KINFO_PROC_STARTED..KINFO_PROC_STARTED + 8].try_into().expect("eight bytes"));
    let micros = i32::from_le_bytes(buffer[KINFO_PROC_STARTED + 8..KINFO_PROC_STARTED + 12].try_into().expect("four bytes"));
    Ok(seconds * 1000 + i64::from(micros) / 1000)
}

/// The state of the sidecar: its output, its SOKSAK_CONFIG_DIR, the running processes by surface, the processes that it started and
/// the threads that wait for them, which the end of the sidecar joins so that it ends after the reports that they have begun.
struct Sidecar {
    output: Output,
    config: Option<String>,
    running: HashMap<String, Vec<Running>>,
    started: Started,
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
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("process of {surface}: start: {error}"))?;
        let pid = child.id();
        let started = match start_time(pid) {
            Ok(started) => started,
            Err(error) => {
                // The process is not recorded, so it is ended and reaped before the error is answered.
                let ended = child.kill().and_then(|()| child.wait().map(|_| ()));
                return Err(format!("process of {surface}: {error}{}", ended.err().map(|error| format!("; end it: {error}")).unwrap_or_default()));
            }
        };
        self.started.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(pid, (surface.to_string(), started));
        let mut stdout = child.stdout.take().expect("the output of the process is piped");
        let mut stderr = child.stderr.take().expect("the error output of the process is piped");
        let cell: Running = Arc::new(Mutex::new(Some(child)));
        self.running.entry(surface.to_string()).or_default().push(cell.clone());
        let output = self.output.clone();
        let records = self.started.clone();
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
            let mut slot = cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(mut child) = slot.take() else {
                // The close of the surface ended and reaped the process; it sends no report.
                return;
            };
            let waited = child.wait();
            records.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&pid);
            drop(slot);
            let body = match (read, errors, waited) {
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
                self.started.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&child.id());
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
        if let Some(process) = message.get("process") {
            self.answer_process(process, &message["request"], text);
            return;
        }
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

    /// Answers the process query of the host for the process `process`: its surface and start time when the sidecar started it and has
    /// not reaped it, else the surface null (docs/spec/sidecars.md#process-identity).
    fn answer_process(&self, process: &Value, request: &Value, text: &str) {
        let (Some(pid), Some(request)) = (process.as_u64().and_then(|pid| u32::try_from(pid).ok()), request.as_u64()) else {
            eprintln!("the host sent a process query without a process id and a request number: {text}");
            return;
        };
        let answer = match self.started.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).get(&pid) {
            Some((surface, started)) => json!({"process": pid, "request": request, "surface": surface, "started": started}),
            None => json!({"process": pid, "request": request, "surface": null}),
        };
        write(&self.output, answer);
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

/// The report of a process that ended with `status`: its first line holds its configuration directory and the rest of its output is
/// the output of `sok context`. A process whose replacement failed, or that ended before its first line, is an error with its error output.
fn report(surface: &str, sok: &str, output: &[u8], errors: &[u8], status: std::process::ExitStatus) -> Value {
    let errors = String::from_utf8_lossy(errors).into_owned();
    if status.code() == Some(127) && errors.starts_with(&format!("run {sok}: ")) {
        return json!({"error": format!("process of {surface}: {}", errors.trim_end())});
    }
    let text = String::from_utf8_lossy(output);
    let Some((first, rest)) = text.split_once('\n') else {
        return json!({"error": format!("process of {surface}: ended with {status} before it wrote its configuration directory: {errors}")});
    };
    let variables: Value = match serde_json::from_str(first) {
        Ok(value) => value,
        Err(error) => return json!({"error": format!("process of {surface}: its first line {first:?} is not JSON: {error}")}),
    };
    json!({
        "event": "process",
        "configDirectory": variables["configDirectory"],
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
        started: Arc::new(Mutex::new(HashMap::new())),
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
