// The process of the service (docs/spec/persistent-services.md#service-transport): it takes the exclusive lock of its service
// folder, listens on a socket in a private short temporary folder, publishes endpoint.json `{protocol, pid, socket, token}` with
// mode 0600 and prints the same line when the listener is ready. It exits after a shutdown once no client remains, on SIGTERM or
// SIGINT, and when its service folder or endpoint.json is removed or names another service; each exit closes the sessions and
// removes the endpoint (while it names this process) and the socket folder.
use std::collections::HashMap;
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::{Value, json};

use crate::events::{EventLog, record};
use crate::iosurface::Surface;
use crate::service::{Child, Class, Conn, Handled, Identity, Level, Log, Platform, Service, Transfer};

struct ProcessChild(std::process::Child);

impl Child for ProcessChild {
    fn pid(&self) -> u32 {
        self.0.id()
    }

    fn close(&mut self) -> Result<(), String> {
        drop(self.0.stdin.take());
        let status = self.0.wait().map_err(|error| format!("wait for session process {}: {error}", self.0.id()))?;
        if status.success() { Ok(()) } else { Err(format!("session process {} ended with {status}", self.0.id())) }
    }
}

struct Processes(PathBuf);

impl Platform for Processes {
    fn transfer(&mut self, width: u32, height: u32) -> Result<Box<dyn Transfer>, String> {
        Ok(Box::new(Surface::create(width, height)?))
    }

    fn child(&mut self, session: &str) -> Result<Box<dyn Child>, String> {
        let child = Command::new(&self.0)
            .arg("--session")
            .arg(session)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("start session process {session}: {error}"))?;
        Ok(Box::new(ProcessChild(child)))
    }
}

struct Shared {
    service: Mutex<Service>,
    writers: Mutex<HashMap<Conn, UnixStream>>,
    endpoint: PathBuf,
    socket_dir: PathBuf,
    pid: u32,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // default: a lock that a panicking thread poisoned still holds whole state, and the panic ends the process anyway.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    // SAFETY: the buffer holds the given number of bytes.
    unsafe { libc::arc4random_buf(buffer.as_mut_ptr().cast(), buffer.len()) };
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Whether endpoint.json names this process.
fn names_self(endpoint: &Path, pid: u32) -> bool {
    std::fs::read(endpoint)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.get("pid").and_then(Value::as_u64))
        == Some(u64::from(pid))
}

/// Ends the service: closes every session, records the exit and removes the endpoint and the socket folder.
fn exit(shared: &Shared, cause: &str) -> ! {
    let mut service = lock(&shared.service);
    let failures = service.close_all(cause);
    for failure in &failures {
        record("error", "exit", failure);
    }
    service.log().event(Level::Info, Class::Lifecycle, "sidecar.rasterprobe.exit", None, None, &[],
        json!({"cause": cause, "failures": failures}));
    if names_self(&shared.endpoint, shared.pid)
        && let Err(error) = std::fs::remove_file(&shared.endpoint)
    {
        record("error", "exit", &format!("{}: {error}", shared.endpoint.display()));
    }
    if let Err(error) = std::fs::remove_dir_all(&shared.socket_dir) {
        record("error", "exit", &format!("{}: {error}", shared.socket_dir.display()));
    }
    record("info", "exit", cause);
    std::process::exit(if failures.is_empty() { 0 } else { 1 });
}

/// Writes the lines of a handled message in order while the service lock keeps the order of the connections.
fn deliver(shared: &Shared, handled: &Handled) {
    let mut writers = lock(&shared.writers);
    for out in &handled.out {
        let Some(writer) = writers.get_mut(&out.conn) else { continue };
        let mut line = out.line.to_string();
        line.push('\n');
        // A connection that cannot be written ends, and its reader sees the end.
        if let Err(error) = writer.write_all(line.as_bytes()) {
            record("error", "write", &format!("connection {}: {error}", out.conn));
        }
    }
}

fn after(shared: &Shared, conn: Conn, handled: &Handled) {
    if handled.kill {
        record("info", "kill", "the service ends at once by request");
        // SAFETY: the process sends itself the signal that ends it without cleanup, as a crash would.
        unsafe { libc::kill(libc::getpid(), libc::SIGKILL) };
    }
    if handled.close
        && let Some(writer) = lock(&shared.writers).get(&conn)
    {
        // A connection that already ended needs no shutdown.
        let _ = writer.shutdown(std::net::Shutdown::Both);
    }
    if handled.exit {
        exit(shared, "shutdown");
    }
}

fn serve(shared: Arc<Shared>, conn: Conn, stream: UnixStream) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) if !line.ends_with('\n') => break,
            Ok(_) => {
                let handled = {
                    let mut service = lock(&shared.service);
                    let handled = service.line(conn, line.trim_end_matches('\n'));
                    deliver(&shared, &handled);
                    handled
                };
                after(&shared, conn, &handled);
            }
            Err(error) => {
                record("error", "read", &format!("connection {conn}: {error}"));
                break;
            }
        }
    }
    let handled = {
        let mut service = lock(&shared.service);
        let handled = service.connection_closed(conn);
        lock(&shared.writers).remove(&conn);
        deliver(&shared, &handled);
        handled
    };
    after(&shared, conn, &handled);
}

/// Waits for SIGTERM, SIGINT and changes of the service folder, and ends the service when one ends its run.
fn watch(shared: Arc<Shared>, dir: PathBuf) {
    // SAFETY: the calls take valid descriptors and kevent structures that live through each call.
    unsafe {
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
        libc::signal(libc::SIGINT, libc::SIG_IGN);
        let queue = libc::kqueue();
        if queue < 0 {
            exit(&shared, "kqueue failed");
        }
        let path = CString::new(dir.as_os_str().as_encoded_bytes()).expect("the service folder holds no NUL");
        let folder = libc::open(path.as_ptr(), libc::O_EVTONLY);
        if folder < 0 {
            exit(&shared, "the service folder cannot be watched");
        }
        let change = |ident: usize, filter: i16, fflags: u32| libc::kevent {
            ident,
            filter,
            flags: libc::EV_ADD | libc::EV_ENABLE | libc::EV_CLEAR,
            fflags,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        let changes = [
            change(libc::SIGTERM as usize, libc::EVFILT_SIGNAL, 0),
            change(libc::SIGINT as usize, libc::EVFILT_SIGNAL, 0),
            change(folder as usize, libc::EVFILT_VNODE, libc::NOTE_WRITE | libc::NOTE_DELETE | libc::NOTE_RENAME | libc::NOTE_REVOKE),
        ];
        if libc::kevent(queue, changes.as_ptr(), changes.len() as i32, std::ptr::null_mut(), 0, std::ptr::null()) < 0 {
            exit(&shared, "kevent registration failed");
        }
        loop {
            let mut event: libc::kevent = std::mem::zeroed();
            let count = libc::kevent(queue, std::ptr::null(), 0, &mut event, 1, std::ptr::null());
            if count <= 0 {
                continue;
            }
            if event.filter == libc::EVFILT_SIGNAL {
                exit(&shared, if event.ident == libc::SIGTERM as usize { "SIGTERM" } else { "SIGINT" });
            }
            if !dir.is_dir() {
                exit(&shared, "the service folder was removed");
            }
            if !names_self(&shared.endpoint, shared.pid) {
                exit(&shared, "endpoint.json was removed or names another service");
            }
        }
    }
}

pub fn run(service_dir: &Path, log_dir: Option<PathBuf>) -> Result<(), String> {
    let pid = std::process::id();
    let lock_file: File = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(service_dir.join("lock"))
        .map_err(|error| format!("{}: {error}", service_dir.join("lock").display()))?;
    // SAFETY: the descriptor is open for the life of the process, which keeps the lock.
    if unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(format!("{}: another service holds the lock", service_dir.display()));
    }
    // The lock lives as long as the process.
    std::mem::forget(lock_file);

    // The socket folder lies in the temporary folder that TMPDIR names, so the folder of a test run holds it and removes
    // it with that run also when the sidecar is killed.
    let template = CString::new(std::env::temp_dir().join("rasterprobe.XXXXXX").into_os_string().into_vec())
        .map_err(|error| format!("the socket folder template: {error}"))?;
    let mut template = template.into_bytes_with_nul();
    // SAFETY: the template is a writable NUL-terminated buffer that mkdtemp fills in place.
    if unsafe { libc::mkdtemp(template.as_mut_ptr().cast()) }.is_null() {
        return Err(format!("mkdtemp: {}", std::io::Error::last_os_error()));
    }
    template.pop();
    let socket_dir = PathBuf::from(String::from_utf8(template).map_err(|error| error.to_string())?);
    std::fs::set_permissions(&socket_dir, std::fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())?;
    let socket = socket_dir.join("s");
    let listener = UnixListener::bind(&socket).map_err(|error| format!("{}: {error}", socket.display()))?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())?;

    let token = random_hex(32);
    let identity = Identity {
        version: crate::VERSION.to_string(),
        pid,
        token: token.clone(),
        directory: service_dir.display().to_string(),
    };
    let executable = std::env::current_exe().map_err(|error| format!("current executable: {error}"))?;
    let log = EventLog::new(log_dir);
    log_start(&log, pid);
    let service = Service::new(identity, Box::new(Processes(executable)), Box::new(log));
    let endpoint = service_dir.join("endpoint.json");
    let shared = Arc::new(Shared {
        service: Mutex::new(service),
        writers: Mutex::new(HashMap::new()),
        endpoint: endpoint.clone(),
        socket_dir,
        pid,
    });

    let line = json!({"protocol": 1, "pid": pid, "socket": socket.display().to_string(), "token": token}).to_string();
    let next = service_dir.join("endpoint.json.next");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(&next)
        .map_err(|error| format!("{}: {error}", next.display()))?;
    file.write_all(line.as_bytes()).map_err(|error| format!("{}: {error}", next.display()))?;
    drop(file);
    std::fs::rename(&next, &endpoint).map_err(|error| format!("{}: {error}", endpoint.display()))?;
    let mut stdout = std::io::stdout();
    stdout.write_all(format!("{line}\n").as_bytes()).map_err(|error| format!("ready line: {error}"))?;
    stdout.flush().map_err(|error| format!("ready line: {error}"))?;
    // The host reads only the ready line, and the service outlives the host that started it, so later output goes nowhere.
    let null = OpenOptions::new().write(true).open("/dev/null").map_err(|error| format!("/dev/null: {error}"))?;
    // SAFETY: both descriptors are open; dup2 replaces the standard output.
    unsafe { libc::dup2(null.as_raw_fd(), libc::STDOUT_FILENO) };
    record("info", "start", &format!("version {} pid {pid} endpoint {}", crate::VERSION, endpoint.display()));

    let watched = Arc::clone(&shared);
    let dir = service_dir.to_path_buf();
    std::thread::spawn(move || watch(watched, dir));
    let next_conn = AtomicU64::new(0);
    for stream in listener.incoming() {
        let stream = match stream {
            Ok(stream) => stream,
            Err(error) => {
                record("error", "accept", &error.to_string());
                continue;
            }
        };
        let conn = next_conn.fetch_add(1, Ordering::Relaxed) + 1;
        let writer = match stream.try_clone() {
            Ok(writer) => writer,
            Err(error) => {
                record("error", "accept", &error.to_string());
                continue;
            }
        };
        lock(&shared.writers).insert(conn, writer);
        let served = Arc::clone(&shared);
        std::thread::spawn(move || serve(served, conn, stream));
    }
    Ok(())
}

fn log_start(log: &EventLog, pid: u32) {
    log.event(Level::Info, Class::Lifecycle, "sidecar.rasterprobe.start", None, None, &[],
        json!({"pid": pid, "version": crate::VERSION, "boot": log.boot()}));
}
