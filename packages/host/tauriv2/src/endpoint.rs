//! 로컬 엔드포인트의 JSON-RPC 2.0 서버.
//!
//! 각 메시지는 4 바이트 빅엔디언 길이와 그 길이의 JSON 객체 하나이다. 길이 제한 초과, 잘못된 JSON,
//! JSON-RPC 2.0 객체가 아닌 값, 선언하지 않은 메서드를 받으면 응답하지 않고 연결을 닫는다. 요청은
//! 각자의 스레드에서 실행하고 `id` 로 응답을 구분한다. 창과 페이지에 대한 처리는 [`Service`] 가
//! 맡고, 이 파일은 전송, 매개변수의 `window`, 연결별 감시 목록, 알림을 처리한다. 전송은
//! `platform/<os>/endpoint.*` 가 제공한다. 형식은 docs/spec/endpoint.md 에 정의한다.

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

use crate::application_log::log_error;
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
/// AppKit이 눌린 마우스 버튼을 보고해 합성 누름이나 뗌을 전달하지 않았다.
pub const BUTTON_HELD: i64 = 1007;
/// 그 창에서 그 버튼의 합성 누름이 아직 열려 있어 누름을 전달하지 않았다.
pub const PRESS_OPEN: i64 = 1008;
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

/// 진단 기록을 켜고 끄는 구독 메서드. 진단 빌드에만 있다.
#[cfg(feature = "diagnostics")]
const TRANSCRIPT: &str = "diagnostics.transcript";

/// 진단 빌드만 선언하는 메서드.
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
    "diagnostics.notifications",
    "diagnostics.navigation.delay",
    "diagnostics.page.collect",
    "diagnostics.native.objects",
    "diagnostics.process.exit",
    "diagnostics.surface.hold",
    "diagnostics.surface.held",
    TRANSCRIPT,
];
#[cfg(not(feature = "diagnostics"))]
const DIAGNOSTICS: &[&str] = &[];

/// JSON-RPC 오류 응답의 code 와 message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Failure {
    pub code: i64,
    pub message: String,
}

/// 없는 창의 오류 1003.
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

    /// 잘못된 매개변수 오류.
    pub fn params(message: impl Into<String>) -> Self {
        Self::new(INVALID_PARAMS, message)
    }
}

/// host 가 만든 값을 응답 텍스트로 쓴다. 페이지가 보낸 값은 받은 텍스트 그대로 중계한다.
pub fn raw(value: &Value) -> Result<Box<RawValue>, Failure> {
    serde_json::value::to_raw_value(value).map_err(|error| Failure::new(-32603, error.to_string()))
}

/// 엔드포인트 요청을 창과 페이지에서 실행한다.
pub trait Service: Send + Sync + 'static {
    /// `windows.list` 의 결과를 반환한다.
    fn windows(&self) -> Result<Value, Failure>;
    /// 창 식별자 window 의 창이 있는지 반환한다.
    fn exists(&self, window: &str) -> bool;
    /// 창 window 에서 method 를 실행한다. params 에는 `window` 가 없다. 호출은 응답이 준비될
    /// 때까지 기다린다. 결과는 응답에 쓸 JSON 텍스트이며, 페이지가 보낸 값은 받은 텍스트 그대로다.
    fn call(
        &self,
        window: &str,
        method: &str,
        params: Map<String, Value>,
    ) -> Result<Box<RawValue>, Failure>;
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

/// 연결 하나의 쓰기 대상과 감시 목록. changes 는 구독마다 마지막으로 받은 변경의 순번이다.
struct Peer {
    writer: Arc<Mutex<Box<dyn Connection>>>,
    watches: HashSet<Watch>,
    #[cfg(feature = "diagnostics")]
    transcript: HashSet<String>,
    changes: HashMap<Topic, u64>,
}

/// 연결이 구독하는 대상. 페이지에 보내는 구독 변경은 대상마다 받은 순서로 실행한다.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Topic {
    Status(Watch),
    /// 창의 진단 기록. 진단 빌드에만 있다.
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

    /// 페이지에 보낼 시작 또는 종료 요청.
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

/// 요청에 대한 응답을 쓸 대상.
struct Answer {
    writer: Arc<Mutex<Box<dyn Connection>>>,
    id: Option<Value>,
}

/// 성공 응답. result 는 받은 텍스트 그대로 쓴다.
#[derive(Serialize)]
struct Success<'a> {
    jsonrpc: &'static str,
    id: &'a Value,
    result: &'a RawValue,
}

impl Answer {
    fn send(self, outcome: Result<Box<RawValue>, Failure>) {
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

/// 구독 변경 하나. last 는 종료 변경 뒤에 이 대상을 구독한 연결이 없는지 나타낸다.
struct Change {
    peer: u64,
    order: u64,
    on: bool,
    last: bool,
    answer: Option<Answer>,
}

/// 대상 하나의 대기 중인 변경. page 는 페이지가 이 대상을 따르고 있는지 나타낸다.
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
}

/// 연결에 알림을 보낸다. 엔드포인트가 멈춘 뒤에는 보낼 연결이 없다.
#[derive(Clone)]
pub struct Notifier(Arc<Shared>);

impl Notifier {
    /// 창 window 의 name 을 표면 지정 없이 감시하는 연결이 있는지 반환한다.
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

    /// 창에 매이지 않은 상태 name 을 표면 지정 없이 감시하는 연결에 창마다 `status.changed` 를 보낸다.
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

    /// 창 window 의 감시를 반환한다.
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

    /// 창 window 의 기록을 요청한 연결이 있는지 반환한다.
    #[cfg(feature = "diagnostics")]
    pub fn transcribed(&self, window: &str) -> bool {
        transcribed(&self.0, window)
    }

    /// 창 window 의 name 을 감시하는 연결에 `status.changed` 를 보낸다. surface 는 감시가 지정한 표면이다.
    /// value 는 받은 텍스트 그대로 보내므로 페이지 값의 키 순서가 바뀌지 않는다.
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

    /// 창 window 의 기록을 요청한 연결에 `diagnostics.log` 를 보낸다.
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

/// 열린 로컬 엔드포인트와 그 endpoint.json.
pub struct Endpoint {
    shared: Arc<Shared>,
    listener: Arc<dyn Listener>,
    _process_lock: ProcessLock,
    address: String,
    directory: PathBuf,
    file: PathBuf,
    // 이 엔드포인트가 게시하는 endpoint.json 내용. 닫을 때 파일이 이 내용일 때만 지운다.
    record: Value,
    published: AtomicBool,
    stopped: Arc<AtomicBool>,
}

/// 하나의 application process가 하나의 configuration directory를 소유한다. file handle은
/// endpoint가 존재하는 동안 열린 상태로 유지된다. file 자체도 owner PID를 기록하므로
/// 강제 종료된 process를 명시적으로 교체할 수 있다.
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
    /// sockets 디렉터리에 application 이름의 엔드포인트를 연다. `<directory>/endpoint.json` 은
    /// 첫 창을 등록한 뒤 [`Endpoint::publish`] 가 쓴다.
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
        std::thread::spawn(move || loop {
            match listener.accept() {
                Ok(connection) => {
                    let shared = shared.clone();
                    std::thread::spawn(move || serve(shared, connection));
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

    /// 창 window 가 등록되어 있으면 endpoint.json 을 쓴다. 파일을 읽은 클라이언트가 그 창에 바로
    /// 요청할 수 있도록 첫 창을 등록한 뒤 한 번 호출한다.
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
        // 다른 프로세스가 대체한 endpoint.json 은 그 프로세스의 것이므로 지우지 않는다.
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

/// 애플리케이션이 소켓을 두는 디렉터리. 사용자별 임시 디렉터리 아래에 있다.
pub fn socket_directory() -> std::path::PathBuf {
    std::env::temp_dir().join("soksak")
}

/// 엔드포인트 주소 address 에 연결한다.
pub fn connect(address: &str) -> Result<Box<dyn Connection>, String> {
    platform::current()?.endpoint_connect(address)
}

/// 메시지 하나를 길이와 함께 쓴다.
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
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// 파일 이름을 바꿔 endpoint.json 을 한 번에 쓴다.
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

/// 시각을 초 단위 UTC ISO 8601 문자열로 바꾼다.
fn timestamp(time: SystemTime) -> Result<String, String> {
    let seconds = time
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|e| format!("the system clock is before 1970: {e}"))? as i64;
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
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest / 60 % 60,
        rest % 60
    ))
}

/// 검사를 통과한 요청.
struct Request {
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

/// JSON-RPC 2.0 요청 객체이면 반환한다.
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

/// 연결 하나의 요청을 읽고 실행한다. 구독 변경은 받은 순서로 적용하고, 나머지 요청은 각자의
/// 스레드에서 실행한다.
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
    while let Ok(Some(message)) = read_frame(&mut connection) {
        let Some(request) = parse(message) else { break };
        if !declared(&request.method) {
            break;
        }
        let answer = Answer {
            writer: writer.clone(),
            id: request.id,
        };
        if SUBSCRIPTIONS.contains(&request.method.as_str()) {
            match subscription(&shared, &request.method, request.params) {
                Ok((topic, on)) => change(&shared, peer, topic, on, Some(answer)),
                Err(failure) => answer.send(Err(failure)),
            }
            continue;
        }
        let shared = shared.clone();
        std::thread::spawn(move || answer.send(run(&shared, &request.method, request.params)));
    }
    if let Err(error) = connection.close() {
        log_error("endpoint connection close", error);
    }
    forget(&shared, peer);
}

/// 연결의 구독을 바꾸는 메서드.
#[cfg(feature = "diagnostics")]
const SUBSCRIPTIONS: &[&str] = &["status.watch", "status.unwatch", TRANSCRIPT];
#[cfg(not(feature = "diagnostics"))]
const SUBSCRIPTIONS: &[&str] = &["status.watch", "status.unwatch"];

/// params 를 검사하고 창의 이름을 꺼낸다.
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

/// 구독 변경 요청의 대상과 시작 여부를 반환한다.
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

/// 연결 peer 의 구독을 바로 바꾸고, 페이지에 보낼 변경을 대상의 줄에 넣는다. 두 작업을 연결 목록
/// 잠금 안에서 실행하므로 줄의 순서는 구독 변경을 적용한 순서와 같다.
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
        std::thread::spawn(move || drain(&shared, topic));
    }
}

/// 대상 topic 의 줄에 있는 변경을 순서대로 페이지에 보내고 응답한다.
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
                    // 이 연결이 그 뒤에 이 대상을 다시 바꾸지 않았으면 시작을 되돌린다.
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
            // 페이지가 종료 요청에 실패해도 이후 시작 요청은 페이지에 다시 보낸다.
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

/// 구독 변경이 아닌 요청 하나를 실행한다.
fn run(shared: &Shared, method: &str, params: Option<Value>) -> Result<Box<RawValue>, Failure> {
    if method == "windows.list" {
        return shared.service.windows().and_then(|list| raw(&list));
    }
    let (window, params) = target(shared, method, params)?;
    shared.service.call(&window, method, params)
}

/// params 의 name 을 반환한다.
fn name(params: &Map<String, Value>) -> Result<String, Failure> {
    match params.get("name") {
        Some(Value::String(name)) if valid_name(name) => Ok(name.clone()),
        _ => Err(Failure::params(
            "name is required and must have the form <owner>.<name>",
        )),
    }
}

/// 이름이 `<소유자>.<이름>` 형식인지 반환한다. 각 부분은 소문자, 숫자, 하이픈이다.
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

/// params 의 name 과 surface 로 감시 키를 만든다.
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

/// 감시 key 를 가진 연결이 있는지 반환한다.
fn watched(shared: &Shared, key: &Watch) -> bool {
    shared
        .peers
        .lock()
        .is_ok_and(|peers| peers.values().any(|peer| peer.watches.contains(key)))
}

/// 창 window 의 기록을 요청한 연결이 있는지 반환한다.
#[cfg(feature = "diagnostics")]
fn transcribed(shared: &Shared, window: &str) -> bool {
    shared
        .peers
        .lock()
        .is_ok_and(|peers| peers.values().any(|peer| peer.transcript.contains(window)))
}

/// 닫힌 연결의 구독을 받은 순서의 마지막 변경으로 끝낸다. 남은 구독자가 없는 대상은 페이지에
/// 종료를 요청한다.
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
