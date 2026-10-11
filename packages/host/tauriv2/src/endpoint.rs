//! The JSON-RPC 2.0 server of the local endpoint.
//!
//! Each message is a 4-byte big-endian length followed by one JSON object of that length. A message that exceeds the
//! length limit, malformed JSON, a value that is not a JSON-RPC 2.0 object, or an undeclared method closes the
//! connection without a response. Requests run on their own threads and responses are told apart by `id`. [`Service`]
//! handles windows and pages, and this file handles the transport, the `window` parameter, the watch list of each
//! connection and the notifications. The transport is provided by `platform/<os>/endpoint.*`. The format is defined in
//! docs/spec/endpoint.md.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{json, Map, Value};

use crate::application_log::{log_error, log_info};
use crate::endpoint_record::Call;
use crate::platform::{self, Listener};

pub use crate::platform::Connection;

/// The maximum length of a message body.
pub const MAX_FRAME: usize = 16 * 1024 * 1024;

/// Invalid parameters.
pub const INVALID_PARAMS: i64 = -32602;
/// An undeclared name.
pub const UNKNOWN_NAME: i64 = 1001;
/// A name that is declared but not registered.
pub const NOT_REGISTERED: i64 = 1002;
/// There is no window or owner document.
pub const MISSING_DOCUMENT: i64 = 1003;
/// Native input cannot be delivered on this platform.
pub const NO_INPUT: i64 = 1004;
/// The owner document did not respond within the time limit.
pub const TIMED_OUT: i64 = 1005;
/// The window is not active. A pointer move needs the key window.
pub const NOT_ACTIVE: i64 = 1006;
/// AppKit reports a pressed mouse button, so a synthetic press or release was not delivered.
pub const BUTTON_HELD: i64 = 1007;
/// A synthetic press of that button is still open in that window, so the press was not delivered.
pub const PRESS_OPEN: i64 = 1008;
/// A registered command or state handler failed.
pub const HANDLER_FAILED: i64 = -32000;

/// The methods that every build declares.
const METHODS: &[&str] = &[
    "windows.list",
    "exposure.list",
    "status.get",
    "status.watch",
    "status.unwatch",
    "command.run",
    "dom.rect",
    "dom.act",
    "input.pointer",
    "input.key",
];

/// The subscription methods that turn the diagnostic record on and off. They exist only in diagnostic builds.
#[cfg(feature = "diagnostics")]
const TRANSCRIPT: &str = "diagnostics.transcript";

/// The methods that only a diagnostic build declares.
#[cfg(feature = "diagnostics")]
const DIAGNOSTICS: &[&str] = &[
    "diagnostics.fixture",
    "diagnostics.drag",
    "diagnostics.capture.start",
    "diagnostics.capture.stop",
    "diagnostics.capture.still",
    "diagnostics.modal.hold",
    "diagnostics.modal.held",
    "diagnostics.presentation.failure",
    "diagnostics.input.source",
    "diagnostics.log.flush",
    "diagnostics.test.mark",
    "diagnostics.notifications",
    "diagnostics.navigation.delay",
    "diagnostics.page.collect",
    "diagnostics.native.objects",
    "diagnostics.process.exit",
    "diagnostics.page.request",
    "diagnostics.surface.hold",
    "diagnostics.surface.held",
    TRANSCRIPT,
];
#[cfg(not(feature = "diagnostics"))]
const DIAGNOSTICS: &[&str] = &[];

/// The code and message of a JSON-RPC error response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Failure {
    pub code: i64,
    pub message: String,
}

/// Error 1003 for a window that does not exist.
pub fn missing_window(window: &str) -> Failure {
    Failure::new(
        MISSING_DOCUMENT,
        format!("window {window:?} does not exist"),
    )
}

impl Failure {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// The invalid parameters error.
    pub fn params(message: impl Into<String>) -> Self {
        Self::new(INVALID_PARAMS, message)
    }
}

/// Uses a value that the host created as the response text. A value that the page sent is relayed as the received text.
pub fn raw(value: &Value) -> Result<Box<RawValue>, Failure> {
    serde_json::value::to_raw_value(value).map_err(|error| Failure::new(-32603, error.to_string()))
}

/// Runs endpoint requests in windows and pages.
pub trait Service: Send + Sync + 'static {
    /// Returns the result of `windows.list`.
    fn windows(&self) -> Result<Value, Failure>;
    /// Returns whether the window with the window identifier window exists.
    fn exists(&self, window: &str) -> bool;
    /// Runs method in the window window. params does not hold `window`. The call waits until the response is ready. The
    /// result is the JSON text for the response, and a value that the page sent is the received text.
    fn call(
        &self,
        window: &str,
        method: &str,
        params: Map<String, Value>,
    ) -> Result<Box<RawValue>, Failure>;
}

/// One watch. surface is the surface that the watch specified, and a watch that specified one differs from a watch that
/// did not.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Watch {
    pub window: String,
    pub name: String,
    pub surface: Option<String>,
}

impl Watch {
    /// The params of the watch request to send to the page.
    pub fn params(&self) -> Map<String, Value> {
        let mut params = Map::new();
        params.insert("name".into(), Value::String(self.name.clone()));
        if let Some(surface) = &self.surface {
            params.insert("surface".into(), Value::String(surface.clone()));
        }
        params
    }
}

/// The write target and the watch list of one connection. changes is the sequence number of the change that was last
/// received for each subscription.
struct Peer {
    writer: Arc<Mutex<Box<dyn Connection>>>,
    watches: HashSet<Watch>,
    #[cfg(feature = "diagnostics")]
    transcript: HashSet<String>,
    changes: HashMap<Topic, u64>,
}

/// The target that a connection subscribes to. The subscription changes sent to the page run in the order received for
/// each target.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Topic {
    Status(Watch),
    /// The diagnostic record of a window. It exists only in diagnostic builds.
    #[cfg(feature = "diagnostics")]
    Transcript(String),
}

impl Topic {
    fn window(&self) -> &str {
        match self {
            Topic::Status(watch) => &watch.window,
            #[cfg(feature = "diagnostics")]
            Topic::Transcript(window) => window,
        }
    }

    /// The start or stop request to send to the page.
    fn request(&self, on: bool) -> (&'static str, Map<String, Value>) {
        match self {
            Topic::Status(watch) => (
                if on { "status.watch" } else { "status.unwatch" },
                watch.params(),
            ),
            #[cfg(feature = "diagnostics")]
            Topic::Transcript(_) => {
                let mut params = Map::new();
                params.insert("on".into(), Value::Bool(on));
                (TRANSCRIPT, params)
            }
        }
    }

    fn held(&self, peer: &Peer) -> bool {
        match self {
            Topic::Status(watch) => peer.watches.contains(watch),
            #[cfg(feature = "diagnostics")]
            Topic::Transcript(window) => peer.transcript.contains(window),
        }
    }

    fn set(&self, peer: &mut Peer, on: bool) {
        match (self, on) {
            (Topic::Status(watch), true) => {
                peer.watches.insert(watch.clone());
            }
            (Topic::Status(watch), false) => {
                peer.watches.remove(watch);
            }
            #[cfg(feature = "diagnostics")]
            (Topic::Transcript(window), true) => {
                peer.transcript.insert(window.clone());
            }
            #[cfg(feature = "diagnostics")]
            (Topic::Transcript(window), false) => {
                peer.transcript.remove(window);
            }
        }
    }
}

/// The target to which the response of a request is written.
struct Answer {
    writer: Arc<Mutex<Box<dyn Connection>>>,
    id: Option<Value>,
    call: Call,
}

/// A success response. result is written as the received text.
#[derive(Serialize)]
struct Success<'a> {
    jsonrpc: &'static str,
    id: &'a Value,
    result: &'a RawValue,
}

impl Answer {
    fn send(self, outcome: Result<Box<RawValue>, Failure>) {
        // The event is stored before the reply is written, so a client that has its reply finds the event after a flush.
        self.call.record(&outcome);
        let Some(id) = self.id else { return };
        let written = match self.writer.lock() {
            Ok(mut writer) => match outcome {
                Ok(result) => write_frame(
                    &mut *writer,
                    &Success {
                        jsonrpc: "2.0",
                        id: &id,
                        result: &result,
                    },
                ),
                Err(failure) => write_frame(
                    &mut *writer,
                    &json!({"jsonrpc": "2.0", "id": id,
                        "error": {"code": failure.code, "message": failure.message}}),
                ),
            },
            Err(error) => Err(error.to_string()),
        };
        if let Err(error) = written {
            log_error("endpoint reply", error);
        }
    }
}

/// One subscription change. last shows that no connection subscribes to this target after a stop change.
struct Change {
    peer: u64,
    order: u64,
    on: bool,
    last: bool,
    answer: Option<Answer>,
}

/// The pending changes of one target. page shows whether the page follows this target.
#[derive(Default)]
struct Line {
    changes: VecDeque<Change>,
    running: bool,
    page: bool,
}

struct Shared {
    service: Arc<dyn Service>,
    peers: Mutex<HashMap<u64, Peer>>,
    lines: Mutex<HashMap<Topic, Line>>,
    next: AtomicU64,
    orders: AtomicU64,
    /// Whether the endpoint stopped and started to close the connections. It distinguishes the reason for closing a
    /// connection.
    stopping: AtomicBool,
}

/// Sends a notification to the connections. After the endpoint stops there is no connection to send to.
#[derive(Clone)]
pub struct Notifier(Arc<Shared>);

impl Notifier {
    /// Returns whether a connection watches name of the window window without a surface specification.
    pub fn watched(&self, window: &str, name: &str) -> bool {
        watched(
            &self.0,
            &Watch {
                window: window.into(),
                name: name.into(),
                surface: None,
            },
        )
    }

    /// Sends `status.changed` for each window to the connections that watch the state name, which is not bound to a
    /// window, without a surface specification.
    pub fn notify_watchers(&self, name: &str, value: &RawValue) {
        let mut windows: Vec<String> = match self.0.peers.lock() {
            Ok(peers) => peers
                .values()
                .flat_map(|peer| peer.watches.iter())
                .filter(|watch| watch.name == name && watch.surface.is_none())
                .map(|watch| watch.window.clone())
                .collect(),
            Err(_) => {
                log_error("endpoint notification", "the peer list is poisoned");
                return;
            }
        };
        windows.sort();
        windows.dedup();
        for window in windows {
            self.changed(&window, name, None, value);
        }
    }

    /// Returns the watches of the window window.
    pub fn watches(&self, window: &str) -> Vec<Watch> {
        let mut watches: Vec<Watch> = match self.0.peers.lock() {
            Ok(peers) => peers
                .values()
                .flat_map(|peer| peer.watches.iter())
                .filter(|watch| watch.window == window)
                .cloned()
                .collect(),
            Err(_) => Vec::new(),
        };
        watches.sort();
        watches.dedup();
        watches
    }

    /// Returns whether a connection requested the record of the window window.
    #[cfg(feature = "diagnostics")]
    pub fn transcribed(&self, window: &str) -> bool {
        transcribed(&self.0, window)
    }

    /// Sends `status.changed` to the connections that watch name of the window window. surface is the surface that the
    /// watch specified. value is sent as the received text, so the key order of the page value does not change.
    pub fn changed(&self, window: &str, name: &str, surface: Option<&str>, value: &RawValue) {
        #[derive(Serialize)]
        struct Params<'a> {
            window: &'a str,
            name: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            surface: Option<&'a str>,
            value: &'a RawValue,
        }
        #[derive(Serialize)]
        struct Notification<'a> {
            jsonrpc: &'static str,
            method: &'static str,
            params: Params<'a>,
        }
        let key = Watch {
            window: window.into(),
            name: name.into(),
            surface: surface.map(str::to_string),
        };
        let message = Notification {
            jsonrpc: "2.0",
            method: "status.changed",
            params: Params {
                window,
                name,
                surface,
                value,
            },
        };
        self.send(|peer| peer.watches.contains(&key), &message);
    }

    /// Sends `diagnostics.log` to the connections that requested the record of the window window.
    #[cfg(feature = "diagnostics")]
    pub fn log(&self, window: &str, line: &str) {
        let message = json!({"jsonrpc": "2.0", "method": "diagnostics.log",
            "params": {"window": window, "line": line}});
        self.send(|peer| peer.transcript.contains(window), &message);
    }

    fn send<T: Serialize + ?Sized>(&self, wanted: impl Fn(&Peer) -> bool, message: &T) {
        let writers: Vec<_> = match self.0.peers.lock() {
            Ok(peers) => peers
                .values()
                .filter(|peer| wanted(peer))
                .map(|peer| peer.writer.clone())
                .collect(),
            Err(_) => return,
        };
        for writer in writers {
            if let Ok(mut writer) = writer.lock() {
                if let Err(error) = write_frame(&mut *writer, message) {
                    log_error("endpoint notification", error);
                }
            }
        }
    }
}

/// An open local endpoint and its endpoint.json.
pub struct Endpoint {
    shared: Arc<Shared>,
    listener: Arc<dyn Listener>,
    _process_lock: ProcessLock,
    address: String,
    directory: PathBuf,
    file: PathBuf,
    // The content of the endpoint.json that this endpoint publishes. At close, the file is deleted only when it has
    // this content.
    record: Value,
    published: AtomicBool,
    stopped: Arc<AtomicBool>,
}

/// One application process owns one configuration directory. The file handle stays open while the endpoint exists. The
/// file itself also records the owner PID, so a process that was terminated by force can be replaced explicitly.
struct ProcessLock {
    path: PathBuf,
    _file: File,
}

impl ProcessLock {
    fn acquire(directory: &Path) -> Result<Self, String> {
        let platform = platform::current()?;
        platform.create_private_directories(directory)?;
        let path = directory.join("process.lock");
        for attempt in 0..2 {
            match platform.create_private_file(&path) {
                Ok(mut file) => {
                    file.write_all(std::process::id().to_string().as_bytes())
                        .map_err(|error| format!("{}: {error}", path.display()))?;
                    file.sync_all()
                        .map_err(|error| format!("{}: {error}", path.display()))?;
                    return Ok(Self { path, _file: file });
                }
                Err(error) if error.kind() == ErrorKind::AlreadyExists && attempt == 0 => {
                    let contents = std::fs::read_to_string(&path)
                        .map_err(|read| format!("{}: {read}", path.display()))?;
                    let pid = contents
                        .trim()
                        .parse::<u32>()
                        // default: a lock file without a process number becomes the error "invalid process lock" below.
                        .ok()
                        .filter(|pid| *pid > 0)
                        .ok_or_else(|| format!("{}: invalid process lock", path.display()))?;
                    if platform.service_process_exists(pid)? {
                        return Err(format!(
                            "configuration directory {} is already owned by process {pid}",
                            directory.display()
                        ));
                    }
                    std::fs::remove_file(&path)
                        .map_err(|remove| format!("{}: {remove}", path.display()))?;
                }
                Err(error) => return Err(format!("{}: {error}", path.display())),
            }
        }
        unreachable!("process lock acquisition has at most two attempts")
    }

    fn release(&self) -> Result<(), String> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("{}: {error}", self.path.display())),
        }
    }
}

impl Drop for ProcessLock {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.path) {
            if error.kind() != ErrorKind::NotFound {
                log_error(&self.path.display().to_string(), error);
            }
        }
    }
}

impl Endpoint {
    /// Opens the endpoint of the application name in the sockets directory. `<directory>/endpoint.json` is written by
    /// [`Endpoint::publish`] after the first window is registered.
    pub fn start(
        sockets: &Path,
        directory: &Path,
        application: &str,
        service: Arc<dyn Service>,
    ) -> Result<Endpoint, String> {
        let process_lock = ProcessLock::acquire(directory)?;
        let listener: Arc<dyn Listener> = platform::current()?
            .endpoint_listen(sockets, application)?
            .into();
        let address = listener.address();
        let file = directory.join("endpoint.json");
        let shared = Arc::new(Shared {
            service,
            peers: Mutex::new(HashMap::new()),
            lines: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            orders: AtomicU64::new(1),
            stopping: AtomicBool::new(false),
        });
        let mut endpoint = Endpoint {
            shared,
            listener,
            _process_lock: process_lock,
            address,
            directory: directory.to_path_buf(),
            file,
            record: Value::Null,
            published: AtomicBool::new(false),
            stopped: Arc::new(AtomicBool::new(false)),
        };
        let executable = std::env::current_exe()
            .and_then(std::fs::canonicalize)
            .map_err(|error| format!("executable path: {error}"))?;
        let record = json!({
            "transport": endpoint.listener.transport(),
            "address": endpoint.address,
            "pid": std::process::id(),
            "application": application,
            "version": env!("CARGO_PKG_VERSION"),
            "executable": executable.to_string_lossy(),
            "started": timestamp(SystemTime::now())?,
        });
        endpoint.record = record;
        let listener = endpoint.listener.clone();
        let shared = endpoint.shared.clone();
        let stopped = endpoint.stopped.clone();
        crate::routine::spawn_named("endpoint-accept", move || loop {
            match listener.accept() {
                Ok(connection) => {
                    let shared = shared.clone();
                    crate::routine::spawn_named("endpoint-serve", move || {
                        serve(shared, connection)
                    });
                }
                Err(error) => {
                    if !stopped.load(Ordering::Relaxed) {
                        log_error("endpoint accept", error);
                    }
                    return;
                }
            }
        });
        Ok(endpoint)
    }

    /// Writes endpoint.json when the window window is registered. It is called once after the first window is
    /// registered, so that a client that read the file can send requests to that window at once.
    pub fn publish(&self, window: &str) -> Result<(), String> {
        if !self.shared.service.exists(window) {
            return Err(format!(
                "endpoint.json is not written: window {window} does not exist"
            ));
        }
        if self.published.swap(true, Ordering::SeqCst) {
            return Err("endpoint.json is already written".into());
        }
        write_record(&self.directory, &self.file, &self.record)
    }

    /// The socket path or the pipe name.
    pub fn address(&self) -> &str {
        &self.address
    }

    /// The value that sends notifications to the connections of this endpoint.
    pub fn notifier(&self) -> Notifier {
        Notifier(self.shared.clone())
    }

    /// Stops accepting new connections and removes the address file and endpoint.json. It can be called several times.
    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::Relaxed) {
            return;
        }
        self.listener.remove();
        // An endpoint.json that another process replaced belongs to that process, so it is not deleted.
        match std::fs::read(&self.file) {
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => log_error(&self.file.display().to_string(), error),
            Ok(data) => match serde_json::from_slice::<Value>(&data) {
                Err(error) => log_error(
                    &self.file.display().to_string(),
                    format!("endpoint file is not valid JSON: {error}"),
                ),
                Ok(current) if current == self.record => {
                    if let Err(error) = std::fs::remove_file(&self.file) {
                        if error.kind() != ErrorKind::NotFound {
                            log_error(&self.file.display().to_string(), error);
                        }
                    }
                }
                Ok(_) => {}
            },
        }
        self.shared.stopping.store(true, Ordering::Relaxed);
        if let Ok(peers) = self.shared.peers.lock() {
            for peer in peers.values() {
                if let Ok(writer) = peer.writer.lock() {
                    if let Err(error) = writer.close() {
                        log_error("endpoint connection close", error);
                    }
                }
            }
        }
        if let Err(error) = self._process_lock.release() {
            log_error("process lock release", error);
        }
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The directory in which the application places its sockets. It is under the temporary directory of the user.
pub fn socket_directory() -> std::path::PathBuf {
    std::env::temp_dir().join("soksak")
}

/// Connects to the endpoint address address.
pub fn connect(address: &str) -> Result<Box<dyn Connection>, String> {
    platform::current()?.endpoint_connect(address)
}

/// Writes one message with its length.
pub fn write_frame<W: Write + ?Sized, T: Serialize + ?Sized>(
    writer: &mut W,
    message: &T,
) -> Result<(), String> {
    let body = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    if body.len() > MAX_FRAME {
        return Err(format!(
            "message of {} bytes exceeds {MAX_FRAME}",
            body.len()
        ));
    }
    let mut frame = Vec::with_capacity(body.len() + 4);
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    writer.write_all(&frame).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

/// The reason for a failure to read a message body.
enum BodyError {
    /// The body length exceeds the limit.
    TooLarge(usize),
    /// The connection cannot be read.
    Io(String),
}

/// Reads the body of one message. It returns None when the connection is closed at a message boundary.
fn read_body<R: Read + ?Sized>(reader: &mut R) -> Result<Option<Vec<u8>>, BodyError> {
    let mut prefix = [0u8; 4];
    let mut filled = 0;
    while filled < prefix.len() {
        match reader.read(&mut prefix[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => {
                return Err(BodyError::Io(
                    "connection closed inside a length prefix".into(),
                ))
            }
            Ok(n) => filled += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) if filled == 0 && e.kind() == ErrorKind::ConnectionReset => return Ok(None),
            Err(e) => return Err(BodyError::Io(e.to_string())),
        }
    }
    let length = u32::from_be_bytes(prefix) as usize;
    if length > MAX_FRAME {
        return Err(BodyError::TooLarge(length));
    }
    let mut body = vec![0u8; length];
    reader
        .read_exact(&mut body)
        .map_err(|e| BodyError::Io(e.to_string()))?;
    Ok(Some(body))
}

/// Reads one message. It returns None when the connection is closed at a message boundary.
pub fn read_frame<R: Read + ?Sized>(reader: &mut R) -> Result<Option<Value>, String> {
    match read_body(reader) {
        Ok(None) => Ok(None),
        Ok(Some(body)) => serde_json::from_slice(&body)
            .map(Some)
            .map_err(|e| e.to_string()),
        Err(BodyError::TooLarge(length)) => {
            Err(format!("message of {length} bytes exceeds {MAX_FRAME}"))
        }
        Err(BodyError::Io(error)) => Err(error),
    }
}

/// Writes endpoint.json at once by renaming a file.
fn write_record(directory: &Path, file: &Path, record: &Value) -> Result<(), String> {
    platform::current()?.create_private_directories(directory)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut temporary, record).map_err(|e| e.to_string())?;
    temporary.write_all(b"\n").map_err(|e| e.to_string())?;
    temporary
        .persist(file)
        .map_err(|e| format!("{}: {e}", file.display()))?;
    Ok(())
}

/// Converts a time to an ISO 8601 UTC string in seconds.
fn timestamp(time: SystemTime) -> Result<String, String> {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|e| format!("the system clock is before 1970: {e}"))? as i64;
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Converts the number of days since 1970-01-01 to a Gregorian date (civil_from_days by Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    ))
}

/// A request that passed the check.
struct Request {
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

/// Returns the request when it is a JSON-RPC 2.0 request object.
fn parse(message: Value) -> Option<Request> {
    let Value::Object(mut object) = message else {
        return None;
    };
    if object.get("jsonrpc") != Some(&Value::String("2.0".into())) {
        return None;
    }
    let Some(Value::String(method)) = object.remove("method") else {
        return None;
    };
    let id = object.remove("id");
    if !matches!(
        id,
        None | Some(Value::String(_) | Value::Number(_) | Value::Null)
    ) {
        return None;
    }
    Some(Request {
        id,
        method,
        params: object.remove("params"),
    })
}

fn declared(method: &str) -> bool {
    METHODS.contains(&method) || DIAGNOSTICS.contains(&method)
}

/// Reads and runs the requests of one connection. Subscription changes are applied in the order received, and the other
/// requests run on their own threads.
fn serve(shared: Arc<Shared>, mut connection: Box<dyn Connection>) {
    let writer = match connection.try_clone() {
        Ok(writer) => Arc::new(Mutex::new(writer)),
        Err(error) => {
            log_error("endpoint connection", error);
            return;
        }
    };
    let peer = shared.next.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut peers) = shared.peers.lock() {
        peers.insert(
            peer,
            Peer {
                writer: writer.clone(),
                watches: HashSet::new(),
                #[cfg(feature = "diagnostics")]
                transcript: HashSet::new(),
                changes: HashMap::new(),
            },
        );
    }
    let mut reason = String::from("peer closed");
    loop {
        let body = match read_body(&mut connection) {
            Ok(Some(body)) => body,
            Ok(None) | Err(BodyError::Io(_)) => break,
            Err(BodyError::TooLarge(length)) => {
                reason = format!("frame of {length} bytes exceeds the limit of {MAX_FRAME}");
                break;
            }
        };
        // default: a frame that is not JSON-RPC becomes the close reason below, which carries the frame text.
        let Some(request) = serde_json::from_slice(&body).ok().and_then(parse) else {
            reason = format!(
                "frame is not a JSON-RPC 2.0 request: {}",
                String::from_utf8_lossy(&body)
            );
            break;
        };
        if !declared(&request.method) {
            reason = format!("method {:?} is not declared", request.method);
            break;
        }
        let answer = Answer {
            writer: writer.clone(),
            id: request.id,
            call: Call::begin(&request.method, &body),
        };
        if SUBSCRIPTIONS.contains(&request.method.as_str()) {
            match subscription(&shared, &request.method, request.params) {
                Ok((topic, on)) => change(&shared, peer, topic, on, Some(answer)),
                Err(failure) => answer.send(Err(failure)),
            }
            continue;
        }
        let shared = shared.clone();
        crate::routine::spawn_named("endpoint-run", move || {
            let outcome = run(&shared, &request.method, request.params);
            // A timeout is an error that the requesting side receives, but only this record keeps which method and what
            // it waited for.
            if let Err(failure) = &outcome {
                if failure.code == TIMED_OUT {
                    log_error(
                        "endpoint timeout",
                        format!("{}: {}", request.method, failure.message),
                    );
                }
            }
            answer.send(outcome)
        });
    }
    if shared.stopping.load(Ordering::Relaxed) {
        reason = String::from("the endpoint closed");
    }
    log_info("endpoint", format!("connection closed: {reason}"));
    if let Err(error) = connection.close() {
        log_error("endpoint connection close", error);
    }
    forget(&shared, peer);
}

/// The methods that change the subscriptions of a connection.
#[cfg(feature = "diagnostics")]
const SUBSCRIPTIONS: &[&str] = &["status.watch", "status.unwatch", TRANSCRIPT];
#[cfg(not(feature = "diagnostics"))]
const SUBSCRIPTIONS: &[&str] = &["status.watch", "status.unwatch"];

/// Checks params and takes out the window name.
fn target(
    shared: &Shared,
    method: &str,
    params: Option<Value>,
) -> Result<(String, Map<String, Value>), Failure> {
    let mut params = match params {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(params)) => params,
        Some(_) => return Err(Failure::params("params must be an object")),
    };
    let window = match params.remove("window") {
        Some(Value::String(window)) => window,
        _ => return Err(Failure::params("window must be a string")),
    };
    if matches!(
        method,
        "status.get" | "status.watch" | "status.unwatch" | "command.run" | "dom.rect" | "dom.act"
    ) {
        name(&params)?;
    }
    if !shared.service.exists(&window) {
        return Err(missing_window(&window));
    }
    Ok((window, params))
}

/// Returns the target of a subscription change request and whether it starts.
fn subscription(
    shared: &Shared,
    method: &str,
    params: Option<Value>,
) -> Result<(Topic, bool), Failure> {
    let (window, params) = target(shared, method, params)?;
    match method {
        "status.watch" => Ok((Topic::Status(watch_key(&window, &params)?), true)),
        "status.unwatch" => Ok((Topic::Status(watch_key(&window, &params)?), false)),
        #[cfg(feature = "diagnostics")]
        TRANSCRIPT => match params.get("on") {
            Some(Value::Bool(on)) => Ok((Topic::Transcript(window), *on)),
            _ => Err(Failure::params("on must be a boolean")),
        },
        other => Err(Failure::new(
            -32601,
            format!("{other} is not a subscription"),
        )),
    }
}

/// Changes the subscription of the connection peer at once and puts the change to send to the page into the queue of
/// the target. Both operations run inside the lock of the connection list, so the order of the queue equals the order
/// in which the subscription changes were applied.
fn change(shared: &Arc<Shared>, peer: u64, topic: Topic, on: bool, answer: Option<Answer>) {
    let start = {
        let Ok(mut peers) = shared.peers.lock() else {
            return;
        };
        let order = shared.orders.fetch_add(1, Ordering::Relaxed);
        if let Some(state) = peers.get_mut(&peer) {
            topic.set(state, on);
            state.changes.insert(topic.clone(), order);
        }
        let last = !on && !peers.values().any(|other| topic.held(other));
        let Ok(mut lines) = shared.lines.lock() else {
            return;
        };
        let line = lines.entry(topic.clone()).or_default();
        line.changes.push_back(Change {
            peer,
            order,
            on,
            last,
            answer,
        });
        !std::mem::replace(&mut line.running, true)
    };
    if start {
        let shared = shared.clone();
        crate::routine::spawn_named("endpoint-drain", move || drain(&shared, topic));
    }
}

/// Sends the changes in the queue of the target topic to the page in order and answers.
fn drain(shared: &Shared, topic: Topic) {
    loop {
        let (next, page) = {
            let Ok(mut lines) = shared.lines.lock() else {
                return;
            };
            let Some(line) = lines.get_mut(&topic) else {
                return;
            };
            match line.changes.pop_front() {
                Some(next) => (next, line.page),
                None => {
                    line.running = false;
                    if !line.page {
                        lines.remove(&topic);
                    }
                    return;
                }
            }
        };
        let (method, params) = topic.request(next.on);
        let (outcome, following) = if next.on && !page {
            match shared.service.call(topic.window(), method, params) {
                Ok(result) => (Ok(result), true),
                Err(failure) => {
                    // If this connection did not change this target again after that, the start is reverted.
                    if let Ok(mut peers) = shared.peers.lock() {
                        if let Some(state) = peers.get_mut(&next.peer) {
                            if state.changes.get(&topic) == Some(&next.order) {
                                topic.set(state, false);
                            }
                        }
                    }
                    (Err(failure), false)
                }
            }
        } else if !next.on && next.last && page {
            // Even if the page fails a stop request, a later start request is sent to the page again.
            (shared.service.call(topic.window(), method, params), false)
        } else {
            (raw(&Value::Null), page)
        };
        if let Ok(mut lines) = shared.lines.lock() {
            if let Some(line) = lines.get_mut(&topic) {
                line.page = following;
            }
        }
        if let Some(answer) = next.answer {
            answer.send(outcome);
        }
    }
}

/// Runs one request that is not a subscription change.
fn run(shared: &Shared, method: &str, params: Option<Value>) -> Result<Box<RawValue>, Failure> {
    if method == "windows.list" {
        return shared.service.windows().and_then(|list| raw(&list));
    }
    let (window, params) = target(shared, method, params)?;
    shared.service.call(&window, method, params)
}

/// Returns name of params.
fn name(params: &Map<String, Value>) -> Result<String, Failure> {
    match params.get("name") {
        Some(Value::String(name)) if valid_name(name) => Ok(name.clone()),
        _ => Err(Failure::params(
            "name is required and must have the form <owner>.<name>",
        )),
    }
}

/// Returns whether the name has the form `<owner>.<name>`. Each part is lowercase letters, digits and hyphens.
pub fn valid_name(name: &str) -> bool {
    let parts: Vec<&str> = name.split('.').collect();
    parts.len() >= 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        })
}

/// Builds the watch key from name and surface of params.
fn watch_key(window: &str, params: &Map<String, Value>) -> Result<Watch, Failure> {
    let surface = match params.get("surface") {
        None => None,
        Some(Value::String(surface)) if !surface.is_empty() => Some(surface.clone()),
        Some(_) => return Err(Failure::params("surface must be a non-empty string")),
    };
    Ok(Watch {
        window: window.into(),
        name: name(params)?,
        surface,
    })
}

/// Returns whether a connection has the watch key key.
fn watched(shared: &Shared, key: &Watch) -> bool {
    shared
        .peers
        .lock()
        .is_ok_and(|peers| peers.values().any(|peer| peer.watches.contains(key)))
}

/// Returns whether a connection requested the record of the window window.
#[cfg(feature = "diagnostics")]
fn transcribed(shared: &Shared, window: &str) -> bool {
    shared
        .peers
        .lock()
        .is_ok_and(|peers| peers.values().any(|peer| peer.transcript.contains(window)))
}

/// Ends the subscriptions of a closed connection with the last change in the order received. A target that has no
/// remaining subscriber is asked to stop in the page.
fn forget(shared: &Arc<Shared>, peer: u64) {
    let topics: Vec<Topic> = match shared.peers.lock() {
        Ok(peers) => match peers.get(&peer) {
            Some(state) => {
                let topics = state.watches.iter().cloned().map(Topic::Status);
                #[cfg(feature = "diagnostics")]
                let topics = topics.chain(state.transcript.iter().cloned().map(Topic::Transcript));
                topics.collect()
            }
            None => return,
        },
        Err(_) => return,
    };
    for topic in topics {
        change(shared, peer, topic, false, None);
    }
    if let Ok(mut peers) = shared.peers.lock() {
        peers.remove(&peer);
    }
}
