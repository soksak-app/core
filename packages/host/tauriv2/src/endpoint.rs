//! 로컬 엔드포인트의 JSON-RPC 2.0 서버.
//!
//! 각 메시지는 4 바이트 빅엔디언 길이와 그 길이의 JSON 객체 하나이다. 길이 제한 초과, 잘못된 JSON,
//! JSON-RPC 2.0 객체가 아닌 값, 선언하지 않은 메서드를 받으면 응답하지 않고 연결을 닫는다. 요청은
//! 각자의 스레드에서 실행하고 `id` 로 응답을 구분한다. 창과 페이지에 대한 처리는 [`Service`] 가
//! 맡고, 이 파일은 전송, 매개변수의 `window`, 연결별 감시 목록, 알림을 처리한다. 전송은
//! `platform/<os>/endpoint.*` 가 제공한다. 형식은 docs/spec/endpoint.md 에 정의한다.

use std::collections::{HashMap, HashSet};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::platform::{self, Listener};

pub use crate::platform::Connection;

/// 메시지 본문의 최대 길이.
pub const MAX_FRAME: usize = 16 * 1024 * 1024;

/// 잘못된 매개변수.
pub const INVALID_PARAMS: i64 = -32602;
/// 선언되지 않은 이름.
pub const UNKNOWN_NAME: i64 = 1001;
/// 선언되었지만 등록되지 않은 이름.
pub const NOT_REGISTERED: i64 = 1002;
/// 창이나 소유 문서가 없다.
pub const MISSING_DOCUMENT: i64 = 1003;
/// 이 플랫폼에서 네이티브 입력을 전달할 수 없다.
pub const NO_INPUT: i64 = 1004;
/// 소유 문서가 제한 시간 안에 응답하지 않았다.
pub const TIMED_OUT: i64 = 1005;
/// 창이 활성 상태가 아니다. 포인터 이동은 키 창이 필요하다.
pub const NOT_ACTIVE: i64 = 1006;
/// 등록된 명령이나 상태 처리 함수가 실패했다.
pub const HANDLER_FAILED: i64 = -32000;

/// 모든 빌드가 선언하는 메서드.
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

/// 진단 빌드만 선언하는 메서드.
#[cfg(feature = "diagnostics")]
const DIAGNOSTICS: &[&str] = &[
    "diagnostics.fixture",
    "diagnostics.drag",
    "diagnostics.capture.stop",
    "diagnostics.knob",
    "diagnostics.transcript",
];
#[cfg(not(feature = "diagnostics"))]
const DIAGNOSTICS: &[&str] = &[];

/// JSON-RPC 오류 응답의 code 와 message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Failure {
    pub code: i64,
    pub message: String,
}

impl Failure {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    /// 잘못된 매개변수 오류.
    pub fn params(message: impl Into<String>) -> Self {
        Self::new(INVALID_PARAMS, message)
    }
}

/// 엔드포인트 요청을 창과 페이지에서 실행한다.
pub trait Service: Send + Sync + 'static {
    /// `windows.list` 의 결과를 반환한다.
    fn windows(&self) -> Result<Value, Failure>;
    /// 창 식별자 window 의 창이 있는지 반환한다.
    fn exists(&self, window: &str) -> bool;
    /// 창 window 에서 method 를 실행한다. params 에는 `window` 가 없다. 호출은 응답이 준비될
    /// 때까지 기다린다.
    fn call(&self, window: &str, method: &str, params: Map<String, Value>) -> Result<Value, Failure>;
}

/// 감시 하나. surface 는 감시가 지정한 표면이며, 지정한 감시와 지정하지 않은 감시는 서로 다르다.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Watch {
    pub window: String,
    pub name: String,
    pub surface: Option<String>,
}

impl Watch {
    /// 페이지에 보낼 감시 요청의 params.
    pub fn params(&self) -> Map<String, Value> {
        let mut params = Map::new();
        params.insert("name".into(), Value::String(self.name.clone()));
        if let Some(surface) = &self.surface {
            params.insert("surface".into(), Value::String(surface.clone()));
        }
        params
    }
}

/// 연결 하나의 쓰기 대상과 감시 목록.
struct Peer {
    writer: Arc<Mutex<Box<dyn Connection>>>,
    watches: HashSet<Watch>,
    transcript: HashSet<String>,
}

struct Shared {
    service: Arc<dyn Service>,
    peers: Mutex<HashMap<u64, Peer>>,
    next: AtomicU64,
}

/// 연결에 알림을 보낸다. 엔드포인트가 멈춘 뒤에는 보낼 연결이 없다.
#[derive(Clone)]
pub struct Notifier(Arc<Shared>);

impl Notifier {
    /// 창 window 의 name 을 표면 지정 없이 감시하는 연결이 있는지 반환한다.
    pub fn watched(&self, window: &str, name: &str) -> bool {
        watched(&self.0, &Watch { window: window.into(), name: name.into(), surface: None })
    }

    /// 창 window 의 감시를 반환한다.
    pub fn watches(&self, window: &str) -> Vec<Watch> {
        let mut watches: Vec<Watch> = match self.0.peers.lock() {
            Ok(peers) => peers.values()
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

    /// 창 window 의 기록을 요청한 연결이 있는지 반환한다.
    pub fn transcribed(&self, window: &str) -> bool {
        transcribed(&self.0, window)
    }

    /// 창 window 의 name 을 감시하는 연결에 `status.changed` 를 보낸다. surface 는 감시가 지정한 표면이다.
    pub fn changed(&self, window: &str, name: &str, surface: Option<&str>, value: Value) {
        let key = Watch { window: window.into(), name: name.into(), surface: surface.map(str::to_string) };
        let mut params = json!({"window": window, "name": name, "value": value});
        if let Some(surface) = surface {
            params["surface"] = Value::String(surface.to_string());
        }
        let message = json!({"jsonrpc": "2.0", "method": "status.changed", "params": params});
        self.send(|peer| peer.watches.contains(&key), &message);
    }

    /// 창 window 의 기록을 요청한 연결에 `diagnostics.log` 를 보낸다.
    pub fn log(&self, window: &str, line: &str) {
        let message = json!({"jsonrpc": "2.0", "method": "diagnostics.log",
            "params": {"window": window, "line": line}});
        self.send(|peer| peer.transcript.contains(window), &message);
    }

    fn send(&self, wanted: impl Fn(&Peer) -> bool, message: &Value) {
        let writers: Vec<_> = match self.0.peers.lock() {
            Ok(peers) => peers.values().filter(|peer| wanted(peer)).map(|peer| peer.writer.clone()).collect(),
            Err(_) => return,
        };
        for writer in writers {
            if let Ok(mut writer) = writer.lock() {
                let _ = write_frame(&mut *writer, message);
            }
        }
    }
}

/// 열린 로컬 엔드포인트와 그 endpoint.json.
pub struct Endpoint {
    shared: Arc<Shared>,
    listener: Arc<dyn Listener>,
    address: String,
    file: PathBuf,
    stopped: Arc<AtomicBool>,
}

impl Endpoint {
    /// application 이름의 엔드포인트를 열고 `<directory>/endpoint.json` 을 쓴다.
    pub fn start(directory: &Path, application: &str, service: Arc<dyn Service>) -> Result<Endpoint, String> {
        let listener: Arc<dyn Listener> = platform::current()?.endpoint_listen(application)?.into();
        let address = listener.address();
        let file = directory.join("endpoint.json");
        let shared = Arc::new(Shared { service, peers: Mutex::new(HashMap::new()), next: AtomicU64::new(1) });
        let endpoint = Endpoint { shared, listener, address, file, stopped: Arc::new(AtomicBool::new(false)) };
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
            "started": timestamp(SystemTime::now()),
        });
        if let Err(error) = write_record(directory, &endpoint.file, &record) {
            endpoint.listener.remove();
            return Err(error);
        }
        let listener = endpoint.listener.clone();
        let shared = endpoint.shared.clone();
        let stopped = endpoint.stopped.clone();
        std::thread::spawn(move || loop {
            match listener.accept() {
                Ok(connection) => {
                    let shared = shared.clone();
                    std::thread::spawn(move || serve(shared, connection));
                }
                Err(error) => {
                    if !stopped.load(Ordering::Relaxed) {
                        eprintln!("endpoint: {error}");
                    }
                    return;
                }
            }
        });
        Ok(endpoint)
    }

    /// 소켓 경로 또는 파이프 이름.
    pub fn address(&self) -> &str {
        &self.address
    }

    /// 이 엔드포인트의 연결에 알림을 보내는 값.
    pub fn notifier(&self) -> Notifier {
        Notifier(self.shared.clone())
    }

    /// 새 연결을 받지 않고 주소 파일과 endpoint.json 을 제거한다. 여러 번 호출할 수 있다.
    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::Relaxed) {
            return;
        }
        self.listener.remove();
        if let Err(error) = std::fs::remove_file(&self.file) {
            if error.kind() != ErrorKind::NotFound {
                eprintln!("{}: {error}", self.file.display());
            }
        }
        if let Ok(peers) = self.shared.peers.lock() {
            for peer in peers.values() {
                if let Ok(writer) = peer.writer.lock() {
                    writer.close();
                }
            }
        }
    }
}

impl Drop for Endpoint {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 엔드포인트 주소 address 에 연결한다.
pub fn connect(address: &str) -> Result<Box<dyn Connection>, String> {
    platform::current()?.endpoint_connect(address)
}

/// 메시지 하나를 길이와 함께 쓴다.
pub fn write_frame<W: Write + ?Sized>(writer: &mut W, message: &Value) -> Result<(), String> {
    let body = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    if body.len() > MAX_FRAME {
        return Err(format!("message of {} bytes exceeds {MAX_FRAME}", body.len()));
    }
    let mut frame = Vec::with_capacity(body.len() + 4);
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    writer.write_all(&frame).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

/// 메시지 하나를 읽는다. 메시지 경계에서 연결이 닫히면 None 을 반환한다.
pub fn read_frame<R: Read + ?Sized>(reader: &mut R) -> Result<Option<Value>, String> {
    let mut prefix = [0u8; 4];
    let mut filled = 0;
    while filled < prefix.len() {
        match reader.read(&mut prefix[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => return Err("connection closed inside a length prefix".into()),
            Ok(n) => filled += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) if filled == 0 && e.kind() == ErrorKind::ConnectionReset => return Ok(None),
            Err(e) => return Err(e.to_string()),
        }
    }
    let length = u32::from_be_bytes(prefix) as usize;
    if length > MAX_FRAME {
        return Err(format!("message of {length} bytes exceeds {MAX_FRAME}"));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    serde_json::from_slice(&body).map(Some).map_err(|e| e.to_string())
}

/// 파일 이름을 바꿔 endpoint.json 을 한 번에 쓴다.
fn write_record(directory: &Path, file: &Path, record: &Value) -> Result<(), String> {
    std::fs::create_dir_all(directory).map_err(|e| format!("{}: {e}", directory.display()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(&mut temporary, record).map_err(|e| e.to_string())?;
    temporary.write_all(b"\n").map_err(|e| e.to_string())?;
    temporary.persist(file).map_err(|e| format!("{}: {e}", file.display()))?;
    Ok(())
}

/// 시각을 초 단위 UTC ISO 8601 문자열로 바꾼다.
fn timestamp(time: SystemTime) -> String {
    let seconds = time.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // 1970-01-01 기준 일 수를 그레고리력 날짜로 바꾼다(Howard Hinnant 의 civil_from_days).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rest / 3600, rest / 60 % 60, rest % 60)
}

/// 검사를 통과한 요청.
struct Request {
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

/// JSON-RPC 2.0 요청 객체이면 반환한다.
fn parse(message: Value) -> Option<Request> {
    let Value::Object(mut object) = message else { return None };
    if object.get("jsonrpc") != Some(&Value::String("2.0".into())) {
        return None;
    }
    let Some(Value::String(method)) = object.remove("method") else { return None };
    let id = object.remove("id");
    if !matches!(id, None | Some(Value::String(_) | Value::Number(_) | Value::Null)) {
        return None;
    }
    Some(Request { id, method, params: object.remove("params") })
}

fn declared(method: &str) -> bool {
    METHODS.contains(&method) || DIAGNOSTICS.contains(&method)
}

/// 연결 하나의 요청을 읽고 실행한다.
fn serve(shared: Arc<Shared>, mut connection: Box<dyn Connection>) {
    let writer = match connection.try_clone() {
        Ok(writer) => Arc::new(Mutex::new(writer)),
        Err(error) => {
            eprintln!("endpoint: {error}");
            return;
        }
    };
    let peer = shared.next.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut peers) = shared.peers.lock() {
        peers.insert(peer, Peer { writer: writer.clone(), watches: HashSet::new(), transcript: HashSet::new() });
    }
    loop {
        let Ok(Some(message)) = read_frame(&mut connection) else { break };
        let Some(request) = parse(message) else { break };
        if !declared(&request.method) {
            break;
        }
        let shared = shared.clone();
        let writer = writer.clone();
        std::thread::spawn(move || {
            let outcome = run(&shared, peer, &request.method, request.params);
            let Some(id) = request.id else { return };
            let reply = match outcome {
                Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                Err(failure) => json!({"jsonrpc": "2.0", "id": id,
                    "error": {"code": failure.code, "message": failure.message}}),
            };
            if let Ok(mut writer) = writer.lock() {
                let _ = write_frame(&mut *writer, &reply);
            }
        });
    }
    connection.close();
    forget(&shared, peer);
}

/// 요청 하나를 실행한다.
fn run(shared: &Shared, peer: u64, method: &str, params: Option<Value>) -> Result<Value, Failure> {
    let mut params = match params {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(params)) => params,
        Some(_) => return Err(Failure::params("params must be an object")),
    };
    if method == "windows.list" {
        return shared.service.windows();
    }
    let window = match params.remove("window") {
        Some(Value::String(window)) => window,
        _ => return Err(Failure::params("window must be a string")),
    };
    if matches!(method, "status.get" | "status.watch" | "status.unwatch" | "command.run" | "dom.rect" | "dom.act") {
        name(&params)?;
    }
    if !shared.service.exists(&window) {
        return Err(Failure::new(MISSING_DOCUMENT, format!("window {window} does not exist")));
    }
    match method {
        "status.watch" => {
            let key = watch_key(&window, &params)?;
            let result = shared.service.call(&window, method, params)?;
            with_peer(shared, peer, |state| {
                state.watches.insert(key);
            });
            Ok(result)
        }
        "status.unwatch" => {
            let key = watch_key(&window, &params)?;
            with_peer(shared, peer, |state| {
                state.watches.remove(&key);
            });
            if watched(shared, &key) {
                return Ok(Value::Null);
            }
            shared.service.call(&window, method, params)
        }
        #[cfg(feature = "diagnostics")]
        "diagnostics.transcript" => {
            let Some(on) = params.get("on").and_then(Value::as_bool) else {
                return Err(Failure::params("on must be a boolean"));
            };
            with_peer(shared, peer, |state| {
                if on {
                    state.transcript.insert(window.clone());
                } else {
                    state.transcript.remove(&window);
                }
            });
            if !on && transcribed(shared, &window) {
                return Ok(Value::Null);
            }
            shared.service.call(&window, method, params)
        }
        _ => shared.service.call(&window, method, params),
    }
}

/// params 의 name 을 반환한다.
fn name(params: &Map<String, Value>) -> Result<String, Failure> {
    match params.get("name") {
        Some(Value::String(name)) if valid_name(name) => Ok(name.clone()),
        _ => Err(Failure::params("name is required and must have the form <owner>.<name>")),
    }
}

/// 이름이 `<소유자>.<이름>` 형식인지 반환한다. 각 부분은 소문자, 숫자, 하이픈이다.
pub fn valid_name(name: &str) -> bool {
    let parts: Vec<&str> = name.split('.').collect();
    parts.len() >= 2
        && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'))
}

/// params 의 name 과 surface 로 감시 키를 만든다.
fn watch_key(window: &str, params: &Map<String, Value>) -> Result<Watch, Failure> {
    let surface = match params.get("surface") {
        None => None,
        Some(Value::String(surface)) if !surface.is_empty() => Some(surface.clone()),
        Some(_) => return Err(Failure::params("surface must be a non-empty string")),
    };
    Ok(Watch { window: window.into(), name: name(params)?, surface })
}

fn with_peer(shared: &Shared, peer: u64, change: impl FnOnce(&mut Peer)) {
    if let Ok(mut peers) = shared.peers.lock() {
        if let Some(state) = peers.get_mut(&peer) {
            change(state);
        }
    }
}

/// 감시 key 를 가진 연결이 있는지 반환한다.
fn watched(shared: &Shared, key: &Watch) -> bool {
    shared.peers.lock().is_ok_and(|peers| peers.values().any(|peer| peer.watches.contains(key)))
}

/// 창 window 의 기록을 요청한 연결이 있는지 반환한다.
fn transcribed(shared: &Shared, window: &str) -> bool {
    shared.peers.lock().is_ok_and(|peers| peers.values().any(|peer| peer.transcript.contains(window)))
}

/// 닫힌 연결의 감시를 제거하고, 남은 감시자가 없는 값의 감시 해제를 페이지에 요청한다.
fn forget(shared: &Shared, peer: u64) {
    let Some(state) = shared.peers.lock().ok().and_then(|mut peers| peers.remove(&peer)) else { return };
    for watch in state.watches {
        if watched(shared, &watch) || !shared.service.exists(&watch.window) {
            continue;
        }
        let _ = shared.service.call(&watch.window, "status.unwatch", watch.params());
    }
    for window in state.transcript {
        if transcribed(shared, &window) || !shared.service.exists(&window) {
            continue;
        }
        let mut params = Map::new();
        params.insert("on".into(), Value::Bool(false));
        let _ = shared.service.call(&window, "diagnostics.transcript", params);
    }
}
