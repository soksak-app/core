//! 사이드카 채널.
//!
//! 사용할 수 있는 사이드카는 프론트엔드에 배치된 설정 파일로 정한다. environment.json 의
//! plugins 에 있는 플러그인 패키지마다 modules/<패키지>/plugin.json 의 sidecars 를 읽고,
//! 사이드카 패키지마다 modules/<패키지>/sidecar.json 의 executable 과 protocol 을 읽는다.
//! 실행 파일은 애플리케이션 실행 파일과 같은 디렉터리에 basename(executable) 이름으로 있다.
//! 사이드카는 패키지 이름으로 구분한다.
//!
//! 선언된 사이드카를 처음 사용할 때 실행하고, 표면 페이지와 사이드카 사이에서 한 줄 JSON
//! 메시지를 전달한다. 메시지 본문은 해석하지 않는다. 형식은 docs/spec/sidecars.md 에 정의한다.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, RecvError, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use wait_timeout::ChildExt;

use crate::application_log::log_error;
use crate::platform::{current, PersistentStream};
use crate::windows::{emit_window, window_data};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tauri::Window;

/// 사이드카가 보낸 메시지를 페이지에 전달하는 이벤트 값.
#[derive(Clone, Serialize)]
pub struct Message {
    /// 메시지를 보낸 사이드카 패키지 이름.
    pub sidecar: String,
    /// 메시지를 받을 표면 id.
    pub surface: String,
    /// 해석하지 않은 메시지 본문.
    pub body: Box<RawValue>,
}

/// 사이드카 실패를 페이지에 알리는 이벤트 값(docs/spec/sidecars.md#failure).
#[derive(Clone, Debug, Serialize)]
pub struct Failure {
    /// 실패한 사이드카 패키지 이름.
    pub sidecar: String,
    /// 실패한 프로세스에 요청을 보낸 표면 id.
    pub surface: String,
    /// 실패 원인.
    pub reason: String,
}

/// 사이드카 outbox 채널의 메시지 유형.
enum Outgoing {
    /// 사이드카로 전송할 한 줄.
    Line(Vec<u8>),
    /// 사이드카 stdin 을 닫으라는 신호.
    Close,
}

/// 사이드카로 응답을 전송하는 인터페이스.
pub trait ResponseSender: Send {
    /// 응답 JSON 을 사이드카에 전송한다. 이미지 이름을 키로 사용한다.
    fn send(&self, surface: &str, image: &str, body: &RawValue) -> Result<(), String>;
}

/// 표면을 소유한 창. 사이드카 메시지의 root 를 제공하고 이벤트를 받는다.
pub trait Owner: Clone + Send + 'static {
    /// 소유 창을 구분하는 값.
    fn key(&self) -> String;
    /// 사이드카 요청의 root 로 보내는 프로젝트 디렉터리.
    fn root(&self) -> Result<String, String>;
    /// 사이드카가 보낸 메시지를 창의 페이지에 전달한다.
    fn deliver(&self, message: Message);
    /// 사이드카 실패를 창의 페이지에 전달한다.
    fn deliver_failure(&self, failure: Failure);
    /// 이미지 봉투를 결정하여 처리한다. 기본 구현은 없음.
    /// 반환값: 이미지 봉투를 처리했는지 여부.
    fn decide_image_envelope(
        &self,
        _sidecar_name: &str,
        _surface: &str,
        _body: &RawValue,
        _response_sender: &dyn ResponseSender,
    ) -> bool {
        false
    }
    /// 영속 사이드카의 연결이 끊긴 뒤 다시 맺히면 호출된다(V5-106). 창은 그 사이드카의
    /// 그림 configure 를 다시 보내야 한다 — 이전 연결이 확인한 configure 상태는 연결과
    /// 함께 죽었다. 기본 구현은 없음: 그림을 소유하지 않은 소유자는 다시 보낼 것이 없다.
    fn sidecar_reconnected(&self, _sidecar: &str) {}
}

#[derive(Serialize)]
struct Request<'a> {
    surface: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<&'a str>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    closed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    body: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct Event {
    surface: String,
    body: Box<RawValue>,
}

/// closed 를 담았는지 먼저 본다. closed 가 있으면 그 줄은 closed 에 대한 답이다(docs/spec/sidecars.md#messages).
#[derive(Deserialize)]
struct CloseProbe {
    closed: Option<bool>,
}

/// closed 에 대한 사이드카의 답. error 는 닫지 못한 까닭이다.
#[derive(Deserialize)]
struct CloseAnswer {
    surface: String,
    closed: bool,
    error: Option<String>,
}

/// 호스트가 closed 를 보냈고 사이드카가 아직 답하지 않은 표면(host.sidecars).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ClosingSurface {
    /// closed 를 받은 사이드카 패키지 이름.
    pub sidecar: String,
    /// 닫힌 표면 id.
    pub surface: String,
}

/// closing 이 바뀐 뒤 잠금 밖에서 부르는 알림.
type ClosingChanged = Arc<dyn Fn() + Send + Sync>;

/// line 이 closed 에 대한 답이면 처리한다. 답이 아니면 Ok(false), 처리했으면 Ok(true), 프로토콜을 어겼으면 그
/// 까닭을 반환한다. 닫지 못한 까닭은 로그에 쓴다.
fn close_answer<O: Owner>(
    state: &Arc<Mutex<State<O>>>,
    sidecar: &str,
    line: &[u8],
) -> Result<bool, String> {
    let probe: CloseProbe =
        serde_json::from_slice(line).map_err(|error| format!("invalid message: {error}"))?;
    if probe.closed.is_none() {
        return Ok(false);
    }
    let answer: CloseAnswer =
        serde_json::from_slice(line).map_err(|error| format!("invalid message: {error}"))?;
    if !answer.closed {
        return Err("invalid message: closed is not true".to_string());
    }
    let (pending, stopped, changed) = {
        let mut state = state.lock().expect("sidecar state");
        let pending = state
            .closing
            .get_mut(sidecar)
            .is_some_and(|surfaces| surfaces.remove(&answer.surface));
        let stopped = !pending
            && state
                .stopping
                .get_mut(sidecar)
                .is_some_and(|stopping| stopping.closing.remove(&answer.surface));
        if state
            .closing
            .get(sidecar)
            .is_some_and(|surfaces| surfaces.is_empty())
        {
            state.closing.remove(sidecar);
        }
        (pending, stopped, state.closing_changed.clone())
    };
    if !pending && !stopped {
        return Err(format!("unexpected close answer for {}", answer.surface));
    }
    if let Some(error) = answer.error {
        log_error(
            &format!("sidecar {sidecar}"),
            format!("close {}: {error}", answer.surface),
        );
    }
    if !pending {
        return Ok(true);
    }
    if let Some(changed) = changed {
        changed();
    }
    Ok(true)
}

/// 끝난 프로세스나 끊긴 연결의 사이드카가 답하지 않은 닫기를 지운다. 지웠으면 알림을 돌려준다.
fn forget_closing<O>(state: &mut State<O>, sidecar: &str) -> Option<ClosingChanged> {
    state.closing.remove(sidecar)?;
    state.closing_changed.clone()
}

/// 읽기 스레드의 응답 전송기. 사이드카 outbox 채널로 응답을 전송한다.
/// 채널이 가득 차면 응답을 State.pending_replies 에 버퍼링한다.
struct ReadThreadResponseSender<O: Owner> {
    sidecar_name: String,
    tx: SyncSender<Outgoing>,
    state: Arc<Mutex<State<O>>>,
}

impl<O: Owner> ResponseSender for ReadThreadResponseSender<O> {
    fn send(&self, surface: &str, image: &str, body: &RawValue) -> Result<(), String> {
        #[derive(Serialize)]
        struct Response<'a> {
            surface: &'a str,
            body: &'a RawValue,
        }

        let response = Response { surface, body };
        let mut line =
            serde_json::to_vec(&response).map_err(|e| format!("response serialization: {e}"))?;
        line.push(b'\n');

        match self.tx.try_send(Outgoing::Line(line.clone())) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                // 채널이 가득 차면 immutable 응답을 전송 순서대로 보관한다.
                let mut state = self.state.lock().expect("sidecar state");
                let key = format!("{}:{}:{}", surface, image, body.get());
                state
                    .pending_replies
                    .entry(self.sidecar_name.clone())
                    .or_default()
                    .push(line);
                eprintln!(
                    "sidecar {} response queue full: buffering {}",
                    self.sidecar_name, key
                );
                Ok(())
            }
            Err(TrySendError::Disconnected(_)) => Err(format!(
                "sidecar {} response channel is disconnected",
                self.sidecar_name
            )),
        }
    }
}

/// 기다리던 요청이 끝난 뒤에 도착한 서비스의 답을 남긴다. 실패한 답은 그 요청이 보고하지 않았으므로 오류 줄이다.
fn late_reply(sidecar: &str, operation: &str, result: Result<(), String>) {
    match result {
        Ok(()) => {
            eprintln!("sidecar {sidecar}: the {operation} reply arrived after its request ended")
        }
        Err(error) => log_error(
            &format!("sidecar {sidecar}"),
            format!("{operation}: {error}"),
        ),
    }
}

/// 영속 연결의 쓰기 스레드가 끝날 때 연결을 닫는다. 서비스가 먼저 연결을 끊었으면 소켓은 이미 연결되지 않은 상태
/// (ENOTCONN)이고 그 끊김은 읽기 스레드가 연결 상실로 남기므로, 그 경우는 관측이다.
fn shut_down_writer(name: &str, writer: &mut dyn PersistentStream) {
    match writer.shutdown() {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotConnected => {
            eprintln!("sidecar {name}: the connection closed before its writer shut down")
        }
        Err(error) => log_error(
            &format!("sidecar {name}"),
            format!("writer shutdown: {error}"),
        ),
    }
}

fn write_line(stdin: &mut ChildStdin, name: &str, line: &[u8]) -> bool {
    if let Err(e) = stdin.write_all(line) {
        log_error(&format!("sidecar {name}"), format!("write: {e}"));
        return false;
    }
    true
}

fn write_pending_socket<O>(
    state: &Mutex<State<O>>,
    name: &str,
    stream: &mut dyn PersistentStream,
) -> bool {
    let (replies, closes) = {
        let mut state = state.lock().expect("sidecar state");
        (
            // 기본값: 보관분이 없는 사이드카에는 쓸 반납과 닫힘이 없다.
            state.pending_replies.remove(name).unwrap_or_default(),
            // 기본값: 보관분이 없는 사이드카에는 쓸 반납과 닫힘이 없다.
            state.pending_closes.remove(name).unwrap_or_default(),
        )
    };
    replies
        .iter()
        .chain(closes.iter())
        .all(|line| write_socket_line(stream, name, line))
}

fn write_socket_line(stream: &mut dyn PersistentStream, name: &str, line: &[u8]) -> bool {
    if let Err(error) = stream.write_all(line).and_then(|_| stream.flush()) {
        log_error(&format!("sidecar {name}"), format!("write: {error}"));
        return false;
    }
    true
}

/// 보관분을 한꺼번에 꺼내 반납 먼저, 닫힘 나중으로 쓴다. 보관분은 큐가 가득 찬 뒤에 생기므로 큐보다 뒤에 나간다.
fn write_pending<O: Owner>(state: &Mutex<State<O>>, name: &str, stdin: &mut ChildStdin) -> bool {
    let (replies, closes) = {
        let mut state = state.lock().expect("sidecar state");
        (
            // 기본값: 보관분이 없는 사이드카에는 쓸 반납과 닫힘이 없다.
            state.pending_replies.remove(name).unwrap_or_default(),
            // 기본값: 보관분이 없는 사이드카에는 쓸 반납과 닫힘이 없다.
            state.pending_closes.remove(name).unwrap_or_default(),
        )
    };
    replies
        .iter()
        .chain(closes.iter())
        .all(|line| write_line(stdin, name, line))
}

/// 서비스가 retain 에 답하기를 기다리는 시간. 세션을 닫는 데 걸리는 시간을 포함한다.
const RETAIN_TIMEOUT: Duration = Duration::from_secs(10);
static RETAIN_REQUESTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// 사이드카 메시지 한 줄의 줄바꿈 앞 최대 byte 수(docs/spec/sidecars.md#messages). 수 MB 의
/// schema snapshot 을 열 배 이상의 여유로 담고, 메시지 하나에 잡는 메모리를 이 크기로 제한한다.
const MESSAGE_LIMIT: usize = 64 << 20;

/// 등록한 뒤에 띄울 쓰기 또는 읽기 스레드.
type Thread = Box<dyn FnOnce() + Send>;

/// 시작한 사이드카와 그 스레드.
struct Started {
    process: Process,
    threads: Vec<Thread>,
}

struct Process {
    child: Option<Child>,
    outbox: SyncSender<Outgoing>, // 용량 256인 채널
    persistent: Option<PersistentConnection>,
    /// 이 프로세스에 요청을 보낸 표면. 실패를 알릴 표면이다.
    surfaces: HashSet<String>,
}

type RetainWaiters = Arc<Mutex<HashMap<String, SyncSender<Result<usize, String>>>>>;
/// close 와 shutdown 요청마다 서비스의 결과를 받는다.
type ReplyWaiters = Arc<Mutex<HashMap<String, SyncSender<Result<(), String>>>>>;

struct PersistentConnection {
    close_waiters: ReplyWaiters,
    /// retain 요청마다 서비스가 닫은 세션 수나 오류를 받는다.
    retain_waiters: RetainWaiters,
    shutdown_waiters: ReplyWaiters,
    connected: Arc<AtomicBool>,
}

struct State<O> {
    running: HashMap<String, Process>,
    /// 시작 중인 사이드카. 시작은 잠금 밖에서 하며, 끝나면 Core::started 로 알린다.
    starting: HashSet<String>,
    /// 사이드카마다 closed 를 보냈고 답을 받지 않은 표면.
    closing: std::collections::BTreeMap<String, std::collections::BTreeSet<String>>,
    /// closing 이 바뀐 뒤 잠금 밖에서 부르는 알림. 호스트가 host.sidecars 를 알린다.
    closing_changed: Option<ClosingChanged>,
    owners: HashMap<String, O>,
    // 표면을 처음 보낼 때의 프로젝트 디렉터리. 사이드카는 root 와 표면으로 세션을 찾으므로, 창의
    // 프로젝트가 바뀐 뒤에도 이미 열린 표면의 요청과 닫힘은 이 root 로 보낸다.
    roots: HashMap<String, String>,
    stopped: bool,
    // pending_replies: 각 사이드카별로 immutable 이미지 응답을 전송 순서대로 버퍼링한다.
    // pending_closes: 각 사이드카별로 표면의 닫힘 메시지를 버퍼링한다 (surface → close message)
    pending_replies: HashMap<String, Vec<Vec<u8>>>,
    pending_closes: HashMap<String, Vec<Vec<u8>>>,
    // 연결이 끊겼고 아직 소유 표면에 알리지 않은 영속 사이드카(V5-106). 끊김을 알린
    // 시작이 이 기록을 소진한다 — 첫 시작은 알림이 없다.
    unannounced_loss: std::collections::HashSet<String>,
    /// 멈추는 표준 입출력 사이드카마다 읽기 스레드가 출력의 끝까지 쓰는 기록이다(docs/spec/sidecars.md#messages).
    stopping: HashMap<String, Stopping>,
}

/// 멈추는 표준 입출력 사이드카의 기록. stop 이 실행 중인 목록을 비운 뒤에도 읽기 스레드는 출력을 끝까지 읽는다.
#[derive(Default)]
struct Stopping {
    /// 이 프로세스에 요청을 보낸 표면. 멈추는 동안 그 표면의 메시지는 위반이 아니다.
    surfaces: HashSet<String>,
    /// stop 이 closing 목록에서 뺀 닫기. 사이드카는 끝나면서 이 닫기에 답하므로 그 답은 위반이 아니다.
    closing: HashSet<String>,
    /// 멈추는 동안 프로토콜을 어겨 읽기를 멈췄다. 닫은 파이프가 일으킨 종료는 보고하지 않는다.
    violated: bool,
}

/// 사이드카 채널의 스레드 공유 부분. 읽기 스레드가 연결 끊김을 감지하면 같은 시작
/// 경로로 다시 시작해야 하므로(V5-106) 시작에 필요한 구성과 상태를 여기 둔다.
struct Core<O> {
    /// 사이드카 패키지 이름과 실행 파일 경로.
    declared: HashMap<String, PathBuf>,
    persistent: HashMap<String, bool>,
    config_directory: PathBuf,
    state: Arc<Mutex<State<O>>>,
    /// 시작이 끝날 때마다 알린다. 같은 사이드카의 요청과 stop 이 기다린다.
    started: Condvar,
    /// 새로 시작한 영속 service 가 endpoint 를 출력하기까지의 상한.
    ready_timeout: Duration,
}

/// 애플리케이션 하나의 사이드카 프로세스와 표면 소유 창을 관리한다.
pub struct Sidecars<O: Owner> {
    core: Arc<Core<O>>,
    /// 테스트에서 주입 가능한 Stop() 기한. 기본값 5초.
    pub stop_timeout: Duration,
}

/// 설치된 사이드카 하나. data 는 그 sidecar.json 의 내용이고 folder 는 그것을 담은 폴더다.
#[derive(Clone, Debug)]
pub struct SidecarDeclaration {
    pub name: String,
    pub folder: PathBuf,
    pub data: Vec<u8>,
}

impl<O: Owner> Sidecars<O> {
    /// 선언된 사이드카로 채널을 생성한다. 실행 파일은 각 folder 안의 executable 경로다.
    /// canonical application configuration directory로 sidecar channel을 생성한다.
    pub fn new(
        declarations: &[SidecarDeclaration],
        config_directory: PathBuf,
    ) -> Result<Self, String> {
        let config_directory = config_directory
            .canonicalize()
            .map_err(|e| format!("config directory: {e}"))?;
        #[derive(Deserialize)]
        struct Sidecar {
            executable: String,
            protocol: u64,
            #[serde(default)]
            transport: Option<String>,
        }
        let mut declared = HashMap::new();
        let mut persistent = HashMap::new();
        let mut persistent_basenames: HashMap<String, String> = HashMap::new();
        for item in declarations {
            let name = item.name.clone();
            if declared.contains_key(&name) {
                continue;
            }
            let path = item.folder.join("sidecar.json").display().to_string();
            let sidecar: Sidecar =
                serde_json::from_slice(&item.data).map_err(|e| format!("{path}: {e}"))?;
            if sidecar.protocol != 1 {
                return Err(format!(
                    "{path}: protocol {} is not supported",
                    sidecar.protocol
                ));
            }
            let is_persistent = match sidecar.transport.as_deref() {
                None => false,
                Some("persistent") => true,
                Some(value) => return Err(format!("{path}: transport {value} is not supported")),
            };
            let executable = Path::new(&sidecar.executable);
            let inside = executable
                .components()
                .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
            let file = executable.file_name().filter(|_| inside).ok_or_else(|| {
                format!(
                    "{path}: executable {} is not a path inside the package",
                    sidecar.executable
                )
            })?;
            if is_persistent {
                let basename = file.to_string_lossy().into_owned();
                if let Some(other) = persistent_basenames.insert(basename.clone(), name.clone()) {
                    return Err(format!(
                        "{path}: executable basename {basename} is already used by {other}"
                    ));
                }
            }
            declared.insert(name.clone(), item.folder.join(executable));
            persistent.insert(name, is_persistent);
        }
        Ok(Self {
            core: Arc::new(Core {
                declared,
                persistent,
                config_directory,
                state: Arc::new(Mutex::new(State {
                    running: HashMap::new(),
                    starting: HashSet::new(),
                    closing: std::collections::BTreeMap::new(),
                    closing_changed: None,
                    owners: HashMap::new(),
                    roots: HashMap::new(),
                    stopped: false,
                    pending_replies: HashMap::new(),
                    pending_closes: HashMap::new(),
                    unannounced_loss: std::collections::HashSet::new(),
                    stopping: HashMap::new(),
                })),
                started: Condvar::new(),
                ready_timeout: READY_TIMEOUT,
            }),
            stop_timeout: Duration::from_secs(5),
        })
    }

    /// 새로 시작한 영속 service 가 endpoint 를 출력하기까지의 상한을 바꾼다. 검사가 기본 30초 대신 짧은 상한을 준다.
    /// 다른 참조가 생기기 전, 만든 직후에만 부른다.
    pub fn with_ready_timeout(mut self, limit: Duration) -> Self {
        Arc::get_mut(&mut self.core)
            .expect("the ready timeout is set before the sidecars are shared")
            .ready_timeout = limit;
        self
    }

    /// owner 창의 표면 surface 에서 온 body 를 사이드카 name 에 전달한다.
    /// 뮤텍스 밖에서 직렬화하고 논블로킹 채널로 전송하므로, 사이드카가 느려도 다른 전송을 차단하지 않는다.
    pub fn send(
        &self,
        owner: &O,
        name: &str,
        surface: &str,
        body: &RawValue,
    ) -> Result<(), String> {
        let current = owner.root()?;
        let root = {
            let state = self.core.state.lock().map_err(|e| e.to_string())?;
            // 기본값: 디렉터리를 기록하지 않은 표면은 창의 현재 프로젝트 루트에서 시작한다.
            state.roots.get(surface).cloned().unwrap_or(current)
        };

        // JSON 직렬화는 뮤텍스 밖에서 한다.
        let mut line = serde_json::to_vec(&Request {
            surface,
            root: Some(&root),
            closed: false,
            body: Some(body),
        })
        .map_err(|e| e.to_string())?;
        line.push(b'\n');

        let mut state = self.core.state.lock().map_err(|e| e.to_string())?;
        if state.stopped {
            return Err("sidecars are stopped".into());
        }
        if !self.core.declared.contains_key(name) {
            return Err(format!("sidecar {name} is not declared by any plugin"));
        }
        if let Some(other) = state.owners.get(surface) {
            if other.key() != owner.key() {
                return Err(format!("surface {surface} belongs to another window"));
            }
        }
        let disconnected = state
            .running
            .get(name)
            .and_then(|process| process.persistent.as_ref())
            .is_some_and(|connection| !connection.connected.load(Ordering::Acquire));
        if disconnected {
            state.running.remove(name);
            eprintln!("sidecar {name}: discarding disconnected persistent connection");
        }
        // 끊김을 알린 적 없는 첫 시작은 알림이 없다. 시작이 앞선 연결 끊김의 기록을
        // 소진하면 이 호출이 연결 알림을 보낸다(V5-106). 시작에 실패하면 이 전송의
        // 오류가 그 실패를 호출자에게 전한다.
        let (mut state, started) = Core::ensure(&self.core, state, name)?;
        let restarted = started && state.unannounced_loss.remove(name);
        // 시작하는 동안 잠금을 놓았으므로 표면의 소유자를 다시 확인한다.
        if let Some(other) = state.owners.get(surface) {
            if other.key() != owner.key() {
                return Err(format!("surface {surface} belongs to another window"));
            }
        }
        state.owners.insert(surface.to_string(), owner.clone());
        state
            .roots
            .entry(surface.to_string())
            .or_insert_with(|| root.clone());
        let process = state.running.get_mut(name).expect("started above");
        process.surfaces.insert(surface.to_string());

        // 논블로킹으로 채널에 전송한다. 채널이 가득 차면 "is not keeping up" 오류를 반환한다.
        let delivered = process
            .outbox
            .try_send(Outgoing::Line(line))
            .map_err(|_| format!("sidecar {name} is not keeping up"));
        drop(state);
        if restarted {
            notify_connection(&self.core, name, Ok(()));
        }
        delivered
    }

    /// 이미 실행 중인 영속 사이드카를 반환한다.
    ///
    /// 페이지가 호스트에서 그림 등록을 먼저 제거한 경우에도 다시 읽기 복구는
    /// 영속 표면 작업을 초기화해야 한다.
    pub fn running_persistent_names(&self) -> Result<Vec<String>, String> {
        let state = self.core.state.lock().map_err(|e| e.to_string())?;
        let mut names: Vec<_> = state
            .running
            .iter()
            .filter(|(name, process)| {
                // 기본값: persistent 를 선언하지 않은 사이드카는 창마다 실행된다.
                self.core.persistent.get(*name).copied().unwrap_or(false)
                    && process
                        .persistent
                        .as_ref()
                        .is_some_and(|connection| connection.connected.load(Ordering::Acquire))
            })
            .map(|(name, _)| name.clone())
            .collect();
        names.sort();
        Ok(names)
    }

    /// owner 창의 표면 중 alive 에 없는 것을 실행 중인 모든 사이드카에 알린다.
    pub fn retain(&self, owner: &O, alive: &dyn Fn(&str) -> bool) -> Result<(), String> {
        let mut state = self.core.state.lock().map_err(|e| e.to_string())?;
        let key = owner.key();
        let gone: Vec<String> = state
            .owners
            .iter()
            .filter(|(surface, current)| current.key() == key && !alive(surface))
            .map(|(surface, _)| surface.clone())
            .collect();

        let mut closed_any = false;
        for surface in gone {
            state.owners.remove(&surface);
            let root = state.roots.remove(&surface);

            let mut line = serde_json::to_vec(&Request {
                surface: &surface,
                root: root.as_deref(),
                closed: true,
                body: None,
            })
            .map_err(|e| e.to_string())?;
            line.push(b'\n');

            let names: Vec<String> = state.running.keys().cloned().collect();
            for name in names {
                state
                    .closing
                    .entry(name)
                    .or_default()
                    .insert(surface.clone());
                closed_any = true;
            }
            // 채널 전송을 시도할 프로세스들을 먼저 수집한다 (borrow 충돌 방지).
            let processes: Vec<(String, Result<(), TrySendError<Outgoing>>)> = state
                .running
                .iter()
                .map(|(name, process)| {
                    let result = process.outbox.try_send(Outgoing::Line(line.clone()));
                    (name.clone(), result)
                })
                .collect();

            // 큐가 가득 찬 항목만 순서대로 버퍼링한다. 연결이 끊긴 항목은 실패를 보고한다.
            for (name, result) in processes {
                if let Err(error) = result {
                    if matches!(error, TrySendError::Full(_)) {
                        state
                            .pending_closes
                            .entry(name.clone())
                            .or_default()
                            .push(line.clone());
                        eprintln!("sidecar {name}: close {surface}: outbox full, buffered");
                    } else {
                        log_error(
                            &format!("sidecar {name}"),
                            format!("close {surface}: the outbox is disconnected"),
                        );
                    }
                }
            }
        }
        let changed = state.closing_changed.clone();
        drop(state);
        if let (true, Some(changed)) = (closed_any, changed) {
            changed();
        }
        Ok(())
    }

    /// closed 를 보냈고 답을 받지 않은 표면을 사이드카와 표면 순으로 반환한다(host.sidecars).
    pub fn closing(&self) -> Vec<ClosingSurface> {
        let state = self.core.state.lock().expect("sidecar state");
        state
            .closing
            .iter()
            .flat_map(|(sidecar, surfaces)| {
                surfaces.iter().map(move |surface| ClosingSurface {
                    sidecar: sidecar.clone(),
                    surface: surface.clone(),
                })
            })
            .collect()
    }

    /// closing 이 바뀔 때 잠금 밖에서 부를 알림을 정한다.
    pub fn on_closing_changed(&self, changed: impl Fn() + Send + Sync + 'static) {
        self.core
            .state
            .lock()
            .expect("sidecar state")
            .closing_changed = Some(Arc::new(changed));
    }

    /// 각 영속 서비스에서 surfaces(표면, 루트) 에 없는 이 애플리케이션의 세션을 닫고 닫은 세션 수를
    /// 반환한다(docs/spec/terminal-runtime.md). 이 프로세스가 이미 메시지를 보낸 표면은 목록에 없어도
    /// 남긴다. 서비스가 떠 있지 않고 엔드포인트도 없으면 세션이 없으므로 건너뛴다.
    pub fn retain_sessions(&self, surfaces: &[(String, String)]) -> Result<usize, String> {
        let mut total = 0;
        let mut names: Vec<String> = self
            .core
            .persistent
            .iter()
            .filter(|(_, persistent)| **persistent)
            .map(|(name, _)| name.clone())
            .collect();
        names.sort();
        for name in names {
            let request = format!(
                "retain-{}-{}",
                std::process::id(),
                RETAIN_REQUESTS.fetch_add(1, Ordering::Relaxed)
            );
            let (waiter, answer) = sync_channel(1);
            {
                let mut state = self.core.state.lock().map_err(|e| e.to_string())?;
                if state.stopped {
                    return Err("sidecars are stopped".into());
                }
                let mut keep: Vec<serde_json::Value> = surfaces
                    .iter()
                    .map(|(surface, root)| serde_json::json!({"surface": surface, "root": root}))
                    .collect();
                keep.extend(
                    state.roots.iter().map(
                        |(surface, root)| serde_json::json!({"surface": surface, "root": root}),
                    ),
                );
                if !state.running.contains_key(&name) {
                    let program = self
                        .core
                        .declared
                        .get(&name)
                        .ok_or_else(|| format!("sidecar {name} is not declared"))?;
                    let basename = program
                        .file_name()
                        .and_then(|value| value.to_str())
                        .ok_or_else(|| {
                            format!("sidecar {name}: executable has no valid basename")
                        })?;
                    let endpoint = self
                        .core
                        .config_directory
                        .join("services")
                        .join(basename)
                        .join("endpoint.json");
                    match std::fs::metadata(&endpoint) {
                        Ok(_) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(error) => {
                            return Err(format!("sidecar {name}: read endpoint: {error}"))
                        }
                    }
                    state = Core::ensure(&self.core, state, &name)?.0;
                }
                let process = state.running.get(&name).expect("started above");
                let connection = process
                    .persistent
                    .as_ref()
                    .ok_or_else(|| format!("sidecar {name} is not a persistent service"))?;
                connection
                    .retain_waiters
                    .lock()
                    .expect("retain waiters")
                    .insert(request.clone(), waiter);
                let mut line = serde_json::to_vec(&serde_json::json!({
                    "operation": "retain",
                    "request": request,
                    "surfaces": keep,
                }))
                .map_err(|e| e.to_string())?;
                line.push(b'\n');
                process
                    .outbox
                    .try_send(Outgoing::Line(line))
                    .map_err(|_| format!("sidecar {name} is not keeping up"))?;
            }
            total += answer
                .recv_timeout(RETAIN_TIMEOUT)
                .map_err(|_| {
                    format!("sidecar {name}: retain was not answered within {RETAIN_TIMEOUT:?}")
                })?
                .map_err(|error| format!("sidecar {name}: retain: {error}"))?;
        }
        Ok(total)
    }

    /// 사이드카에 응답(이미지 반납 등)을 전달한다. ResponseSender와 동일한 역할을 한다.
    /// 채널이 가득 차면 응답을 surface:image 별로 버퍼링했다가 쓰기 스레드가 전송한다.
    pub fn send_response(
        &self,
        name: &str,
        surface: &str,
        image: &str,
        body: &RawValue,
    ) -> Result<(), String> {
        #[derive(Serialize)]
        struct Response<'a> {
            surface: &'a str,
            body: &'a RawValue,
        }

        let response = Response { surface, body };
        let mut line = serde_json::to_vec(&response)
            .map_err(|e| format!("sidecar {name}: response serialize: {e}"))?;
        line.push(b'\n');

        let mut state = self.core.state.lock().expect("sidecar state");
        if state.stopped {
            return Err("sidecars are stopped".into());
        }
        let process = state
            .running
            .get(name)
            .ok_or_else(|| format!("sidecar {name} is not running"))?;

        // 논블로킹으로 채널에 전송한다. 채널이 가득 차면 버퍼링한다.
        match process.outbox.try_send(Outgoing::Line(line.clone())) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                // 채널이 가득 찼으므로 immutable 응답을 전송 순서대로 보관한다.
                let key = format!("{}:{}:{}", surface, image, body.get());
                state
                    .pending_replies
                    .entry(name.to_string())
                    .or_default()
                    .push(line);
                eprintln!("sidecar {name}: response queue full, buffering {key}");
                Ok(())
            }
            Err(TrySendError::Disconnected(_)) => {
                Err(format!("sidecar {name} response channel is disconnected"))
            }
        }
    }

    /// 모든 사이드카를 종료한다. 채널에 Close 신호를 보내 쓰기 스레드를 종료하고 stdin을 닫은 후
    /// 프로세스 종료를 대기하고, 기한 초과 시 강제 종료한다.
    pub fn stop(&self) {
        let (processes, changed): (Vec<(String, Process)>, Option<ClosingChanged>) = {
            let mut state = self.core.state.lock().expect("sidecar state");
            state.stopped = true;
            // 시작 중인 사이드카는 끝나면 등록되므로, 그 시작을 기다린 뒤 실행 중인 목록을 비운다.
            while !state.starting.is_empty() {
                state = self.core.started.wait(state).expect("sidecar state");
            }
            // 표준 입출력 사이드카는 끝나므로 닫기에 답하지 않는다. 지속 service 는 중지 전에 보낸 닫기에
            // close-owner 응답보다 먼저 답하므로 그 표면은 답이나 연결의 끝까지 둔다(docs/spec/sidecars.md#messages).
            let stdio: Vec<String> = state
                .running
                .iter()
                .filter(|(_, process)| process.persistent.is_none())
                .map(|(name, _)| name.clone())
                .collect();
            let mut changed = None;
            for name in stdio {
                let surfaces = state.running[&name].surfaces.iter().cloned().collect();
                let closing = state
                    .closing
                    .get(&name)
                    .map(|surfaces| surfaces.iter().cloned().collect())
                    // 기본값: closing 에 이 사이드카가 없으면 답을 기다리는 닫기가 없으므로 뺀 닫기도 없다.
                    .unwrap_or_default();
                state.stopping.insert(
                    name.clone(),
                    Stopping {
                        surfaces,
                        closing,
                        violated: false,
                    },
                );
                changed = forget_closing(&mut state, &name).or(changed);
            }
            (state.running.drain().collect(), changed)
        };
        if let Some(changed) = changed {
            changed();
        }

        // 모든 프로세스를 병렬로 기다린다.
        let deadline = std::time::Instant::now() + self.stop_timeout;
        let mut handles = Vec::new();
        for (name, process) in processes {
            let state = Arc::clone(&self.core.state);
            let handle = thread::spawn(move || {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if process.child.is_none() {
                    if let Some(persistent) = process.persistent {
                        let request = format!("{}-close", std::process::id());
                        let line = serde_json::json!({
                            "operation": "close-owner",
                            "request": request,
                        });
                        let mut bytes = match serde_json::to_vec(&line) {
                            Ok(bytes) => bytes,
                            Err(error) => {
                                log_error(
                                    &format!("sidecar {name}"),
                                    format!("close-owner serialization: {error}"),
                                );
                                return;
                            }
                        };
                        bytes.push(b'\n');
                        let (tx, rx) = sync_channel(1);
                        persistent
                            .close_waiters
                            .lock()
                            .expect("close waiters")
                            .insert(request, tx);
                        if let Err(error) = process.outbox.send(Outgoing::Line(bytes)) {
                            log_error(
                                &format!("sidecar {name}"),
                                format!("send close-owner: {error}"),
                            );
                            return;
                        }
                        let result = rx.recv_timeout(remaining);
                        match result {
                            Ok(Ok(())) => {
                                let shutdown_request = format!("{}-shutdown", std::process::id());
                                let shutdown_line = serde_json::json!({
                                    "operation": "shutdown",
                                    "request": shutdown_request,
                                });
                                let mut shutdown_bytes = serde_json::to_vec(&shutdown_line)
                                    .expect("shutdown request serialization cannot fail");
                                shutdown_bytes.push(b'\n');
                                let (shutdown_tx, shutdown_rx) = sync_channel(1);
                                persistent
                                    .shutdown_waiters
                                    .lock()
                                    .expect("shutdown waiters")
                                    .insert(shutdown_request, shutdown_tx);
                                if let Err(error) =
                                    process.outbox.send(Outgoing::Line(shutdown_bytes))
                                {
                                    log_error(
                                        &format!("sidecar {name}"),
                                        format!("send shutdown: {error}"),
                                    );
                                } else {
                                    let shutdown_remaining = deadline
                                        .saturating_duration_since(std::time::Instant::now());
                                    match shutdown_rx.recv_timeout(shutdown_remaining) {
                                        Ok(Ok(())) => {}
                                        Ok(Err(error)) => {
                                            log_error(
                                                &format!("sidecar {name}"),
                                                format!("shutdown: {error}"),
                                            );
                                        }
                                        Err(error) => {
                                            log_error(
                                                &format!("sidecar {name}"),
                                                format!("shutdown wait: {error}"),
                                            );
                                        }
                                    }
                                }
                            }
                            Ok(Err(error)) => log_error(
                                &format!("sidecar {name}"),
                                format!("close owner: {error}"),
                            ),
                            Err(error) => log_error(
                                &format!("sidecar {name}"),
                                format!("close owner wait: {error}"),
                            ),
                        }
                        if let Err(error) = process.outbox.send(Outgoing::Close) {
                            log_error(
                                &format!("sidecar {name}"),
                                format!("close persistent transport: {error}"),
                            );
                        }
                    }
                    return;
                }
                // Close 신호를 보낸다. 쓰기 스레드가 이를 받으면 블로킹 루프를 빠져나가고 stdin을 close한다.
                match process.outbox.try_send(Outgoing::Close) {
                    Ok(()) => {}
                    Err(TrySendError::Full(close)) => {
                        // 채널이 가득 참: 별도 스레드에서 블로킹 send를 시도한다.
                        // 이 스레드는 stop()을 막지 않는다.
                        let tx = process.outbox.clone();
                        let close_name = name.clone();
                        thread::spawn(move || {
                            if let Err(e) = tx.send(close) {
                                log_error(
                                    &format!("sidecar {close_name}"),
                                    format!("send close: {e}"),
                                );
                            }
                        });
                    }
                    Err(TrySendError::Disconnected(_)) => {
                        // 채널이 닫혔다. 쓰기 스레드가 이미 끝난 것이니 아무것도 보내지 않는다.
                    }
                }

                let Some(mut child) = process.child else {
                    return;
                };

                // wait-timeout 크레이트를 사용하여 SIGCHLD 기반 대기 (폴링 없음).
                // 크레이트는 남은 시간을 ms 로 내려 poll 에 넘기므로 기한보다 1ms 안쪽 먼저 돌아올 수 있다.
                // 기한에 닿을 때까지 남은 시간만큼 다시 기다려 기한 전에 kill 하지 않는다.
                let waited = loop {
                    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                    match child.wait_timeout(remaining) {
                        Ok(None) if !remaining.is_zero() => continue,
                        other => break other,
                    }
                };
                // 종료의 보고는 위반 뒤 닫은 파이프가 일으킨 종료를 빼고 쓴다(docs/spec/sidecars.md#declaration-and-startup).
                let violated = |state: &Arc<Mutex<State<O>>>| {
                    state
                        .lock()
                        .expect("sidecar state")
                        .stopping
                        .get(&name)
                        .is_some_and(|stopping| stopping.violated)
                };
                match waited {
                    Ok(Some(status)) => {
                        if !status.success() && !violated(&state) {
                            log_error(
                                &format!("sidecar {name}"),
                                format!("exited while stopping: {}", exit_text(status)),
                            );
                        }
                    }
                    Ok(None) => {
                        // 기한 초과. 강제 종료.
                        match child.kill() {
                            Ok(()) => log_error(
                                &format!("sidecar {name}"),
                                "did not end within the stop timeout and was killed",
                            ),
                            Err(e) => log_error(&format!("sidecar {name}"), format!("kill: {e}")),
                        }
                        if let Err(e) = child.wait() {
                            log_error(&format!("sidecar {name}"), format!("wait after kill: {e}"));
                        }
                    }
                    Err(e) => {
                        // wait() 오류. 이미 종료되었거나 이미 waited.
                        log_error(&format!("sidecar {name}"), format!("wait: {e}"));
                    }
                }
            });
            handles.push(handle);
        }

        // 모든 스레드가 완료될 때까지 기다린다.
        for handle in handles {
            if let Err(e) = handle.join() {
                log_error("sidecar stop", format!("thread join: {e:?}"));
            }
        }
    }
}

/// service 가 hello 에 답하기까지의 상한(docs/spec/terminal-runtime.md).
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

/// 새로 시작한 영속 service 가 endpoint 를 출력하기까지의 기본 상한(docs/spec/terminal-runtime.md).
const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// 새로 시작한 service 가 stdout 에 출력하는 첫 줄을 읽는다. limit 안에 줄이 오지 않으면 그 service 를
/// 끝내고 회수한 뒤 실패하고, 그 정리의 실패를 오류 뒤에 붙인다.
fn service_endpoint_line(
    name: &str,
    child: &mut Child,
    stdout: std::process::ChildStdout,
    limit: Duration,
) -> Result<String, String> {
    let (sender, receiver) = sync_channel(1);
    let reader_name = name.to_string();
    thread::spawn(move || {
        let mut line = String::new();
        let read = BufReader::new(stdout).read_line(&mut line).map(|_| line);
        // 받는 쪽은 상한이 지나면 끝나고, 그 시간 초과는 시작의 오류로 보고된다.
        if sender.send(read).is_err() {
            eprintln!("sidecar {reader_name}: the service output ended after the ready bound");
        }
    });
    match receiver.recv_timeout(limit) {
        Ok(read) => read.map_err(|e| format!("sidecar {name}: service startup: {e}")),
        Err(_) => {
            let message = format!(
                "sidecar {name}: the service did not print its endpoint within {}s",
                limit.as_secs()
            );
            // service 가 끝나면 stdout 이 닫혀 읽기 스레드도 끝난다.
            if let Err(error) = child.kill() {
                return Err(format!("{message}; ending the service failed: {error}"));
            }
            if let Err(error) = child.wait() {
                return Err(format!("{message}; reaping the service failed: {error}"));
            }
            Err(message)
        }
    }
}

impl<O: Owner> Core<O> {
    /// 실행 중인 사이드카를 확인하고, 없으면 시작해 등록한다. state 를 쥔 채 부르고 쥔 채 돌려받는다. 시작은
    /// 프로세스 기동과 영속 service 의 연결과 인증을 기다리므로 잠금을 놓은 채 한다. 그동안 다른 사이드카의 요청은
    /// 기다리지 않고, 같은 사이드카의 요청은 그 시작이 끝나기를 기다린다. 두 번째 값은 이 호출이 시작했는지다.
    fn ensure<'a>(
        core: &'a Arc<Self>,
        mut state: MutexGuard<'a, State<O>>,
        name: &str,
    ) -> Result<(MutexGuard<'a, State<O>>, bool), String> {
        loop {
            if state.running.contains_key(name) {
                return Ok((state, false));
            }
            if state.stopped {
                return Err("sidecars are stopped".into());
            }
            if !state.starting.contains(name) {
                break;
            }
            state = core.started.wait(state).map_err(|e| e.to_string())?;
        }
        state.starting.insert(name.to_string());
        drop(state);
        let started = Self::start(core, name);
        let mut state = core.state.lock().map_err(|e| e.to_string())?;
        state.starting.remove(name);
        core.started.notify_all();
        let Started { process, threads } = started?;
        // stop 은 시작이 끝나기를 기다린 뒤 실행 중인 목록을 비우므로, 멈추는 중에 끝난 시작도 등록해 stop 이 정리한다.
        state.running.insert(name.to_string(), process);
        for thread in threads {
            thread::spawn(thread);
        }
        if state.stopped {
            return Err("sidecars are stopped".into());
        }
        Ok((state, true))
    }

    /// 사이드카를 시작한다. 영속 선언이면 서비스에 붙고, 아니면 창의 자식 프로세스로 띄운다. 쓰기와 읽기 스레드는
    /// 등록한 뒤에 띄우도록 돌려준다.
    fn start(core: &Arc<Self>, name: &str) -> Result<Started, String> {
        let program = core
            .declared
            .get(name)
            .ok_or_else(|| format!("sidecar {name} is not declared by any plugin"))?;
        // 기본값: persistent 를 선언하지 않은 사이드카는 창마다 실행된다.
        if *core.persistent.get(name).unwrap_or(&false) {
            return Self::start_persistent(core, name, program);
        }
        let mut threads: Vec<Thread> = Vec::new();
        let mut child = Command::new(program)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("sidecar {name}: {}: {e}", program.display()))?;
        // 프로세스 등록부의 계기(V5-104): 뜨는 사이드카의 pid 와 역할을 남긴다.
        crate::performance::observe(&core.config_directory, "host", || {
            serde_json::json!({"event": "process", "role": "sidecar", "name": name,
                        "pid": child.id()})
        });
        let mut stdin = child.stdin.take().ok_or("sidecar stdin is missing")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout is missing")?;

        // 용량 256인 동기 채널 생성
        let (tx, rx) = sync_channel::<Outgoing>(256);

        // 쓰기 스레드: outbox 채널에서 읽어 stdin에 쓴다
        // 순서는 ① 큐에 있는 모든 것을 비블로킹으로 쓴다 ② 큐가 비었으면 보관분을 모두 쓴다 ③ 그다음 채널에서 블록 수신한다.
        // 이렇게 하면 보관분(큐가 가득 찼을 때만 생김)이 큐에 먼저 있던 메시지보다 뒤에 나가므로 순서가 맞다.
        // 채널이 닫혀 종료할 때도 보관분을 전부 쓴 뒤 stdin을 닫는다.
        let write_name = name.to_string();
        let state_clone = Arc::clone(&core.state);

        threads.push(Box::new(move || loop {
            loop {
                match rx.try_recv() {
                    Ok(Outgoing::Line(line)) => {
                        if !write_line(&mut stdin, &write_name, &line) {
                            return;
                        }
                    }
                    Ok(Outgoing::Close) | Err(TryRecvError::Disconnected) => {
                        write_pending(&state_clone, &write_name, &mut stdin);
                        return;
                    }
                    Err(TryRecvError::Empty) => break,
                }
            }
            if !write_pending(&state_clone, &write_name, &mut stdin) {
                return;
            }
            match rx.recv() {
                Ok(Outgoing::Line(line)) => {
                    if !write_line(&mut stdin, &write_name, &line) {
                        return;
                    }
                }
                Ok(Outgoing::Close) | Err(RecvError) => {
                    write_pending(&state_clone, &write_name, &mut stdin);
                    return;
                }
            }
        }));

        // 읽기 스레드: stdout에서 읽어 이벤트를 전달하고, 출력이 끝나거나 프로토콜을 어기면 실패를 처리한다
        let state = Arc::clone(&core.state);
        let sidecar = name.to_string();
        let tx_clone = tx.clone();
        threads.push(Box::new(move || {
            let mut reader = BufReader::new(stdout);
            let violation = relay(&mut reader, &state, &sidecar, &tx_clone);
            // 읽기 끝을 닫아 아직 쓰는 프로세스가 쓰기에서 막히지 않게 한다.
            drop(reader);
            drop(tx_clone);
            fail(&state, &sidecar, violation);
        }));

        Ok(Started {
            process: Process {
                child: Some(child),
                outbox: tx,
                persistent: None,
                surfaces: HashSet::new(),
            },
            threads,
        })
    }

    fn start_persistent(core: &Arc<Self>, name: &str, program: &Path) -> Result<Started, String> {
        #[derive(Deserialize)]
        struct Endpoint {
            protocol: u64,
            pid: u32,
            socket: String,
            token: String,
        }

        let config = &core.config_directory;
        let basename = program
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty() && *value != "." && *value != "..")
            .ok_or_else(|| format!("sidecar {name}: executable has no valid basename"))?;
        let service_dir = config.join("services").join(basename);
        current()?
            .create_private_directories(&service_dir)
            .map_err(|e| format!("sidecar {name}: create service directory: {e}"))?;
        // 성능 트레이스가 켜져 있으면 나중에 뜨는 사이드카에도 플래그를 쓴다(V5-104).
        crate::performance::sync_services(config)?;
        current()?
            .secure_service_directory(&service_dir)
            .map_err(|e| format!("sidecar {name}: service directory permissions: {e}"))?;
        let endpoint_path = service_dir.join("endpoint.json");

        let mut child = None;
        let endpoint: Endpoint = match std::fs::read(&endpoint_path) {
            Ok(bytes) => {
                let endpoint: Endpoint = serde_json::from_slice(&bytes)
                    .map_err(|e| format!("sidecar {name}: invalid endpoint: {e}"))?;
                if !current()?.service_process_exists(endpoint.pid)? {
                    std::fs::remove_file(&endpoint_path)
                        .map_err(|e| format!("sidecar {name}: remove stale endpoint: {e}"))?;
                    // 하나뿐인 생성 경로에 다시 진입한다. stale endpoint는
                    // 명시적인 crash 복구 경우이며 fallback transport가 아니다.
                    return Self::start_persistent(core, name, program);
                }
                endpoint
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // 서비스는 이 호스트보다 오래 살므로 호스트의 표준 오류가 아니라 자기 로그 파일에 쓴다
                // (docs/spec/hosts.md#application-log). endpoint 가 없으므로 그 파일에 쓰는 서비스가 없다.
                let service_log = crate::application_log::open_log(
                    &crate::application_log::service_log_path(config, basename),
                )
                .map_err(|error| format!("sidecar {name}: service log: {error}"))?;
                let mut command = Command::new(program);
                command
                    .arg("--service-dir")
                    .arg(&service_dir)
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::from(service_log));
                // 영구 service 는 이 애플리케이션 프로세스의 수명이 아니라 설정 디렉터리에 속한다. 애플리케이션이
                // 비정상 종료해도 service 가 함께 종료되지 않도록 새 session 을 시작한다.
                current()?
                    .new_session(&mut command)
                    .map_err(|e| format!("sidecar {name}: new session: {e}"))?;
                let mut spawned = command
                    .spawn()
                    .map_err(|e| format!("sidecar {name}: {}: {e}", program.display()))?;
                let stdout = spawned
                    .stdout
                    .take()
                    .ok_or("persistent service stdout is missing")?;
                let line = service_endpoint_line(name, &mut spawned, stdout, core.ready_timeout)?;
                if line.is_empty() {
                    return Err(format!("sidecar {name}: service exited before endpoint"));
                }
                let endpoint: Endpoint = serde_json::from_str(&line)
                    .map_err(|e| format!("sidecar {name}: service endpoint: {e}"))?;
                child = Some(spawned);
                endpoint
            }
            Err(error) => {
                return Err(format!("sidecar {name}: read endpoint: {error}"));
            }
        };
        if endpoint.protocol != 1 {
            return Err(format!(
                "sidecar {name}: service protocol {} is not supported",
                endpoint.protocol
            ));
        }
        if endpoint.socket.is_empty() || endpoint.token.is_empty() || endpoint.pid == 0 {
            return Err(format!("sidecar {name}: service endpoint is incomplete"));
        }
        let mut stream = current()?
            .connect_service(&endpoint.socket)
            .map_err(|e| format!("sidecar {name}: connect authenticated service: {e}"))?;
        // 인사 왕복에만 읽기 기한을 둔다(V5-106). 같은 사이드카의 요청과 stop 은 이 시작을 기다리므로,
        // 소켓을 받아 놓고 답하지 않는 서비스가 그 요청을 멈추게 해서는 안 된다. 기한이
        // 지나면 연결은 실패이고, 끊김 기록이 다음 시작에게 같은 경로를 다시 시도하게 한다.
        // 왕복이 끝나면 이어지는 읽기 스레드를 위해 무한 대기로 돌린다.
        // macOS 는 SO_RCVTIMEO 에 0(해제)을 EINVAL 로 거부하므로, 해제는 하루 기한으로
        // 대신한다. 이어지는 읽기 스레드는 하루에 한 번 WouldBlock 으로 깨어나 다시
        // 기다린다.
        const NO_READ_DEADLINE: Duration = Duration::from_secs(24 * 60 * 60);
        stream
            .set_read_deadline(Some(HELLO_TIMEOUT))
            .map_err(|e| format!("sidecar {name}: hello deadline: {e}"))?;
        let hello = serde_json::json!({
            "operation": "hello",
            "protocol": 1,
            "token": endpoint.token.clone(),
            "client": service_dir.to_string_lossy(),
        });
        let mut line = serde_json::to_vec(&hello).map_err(|e| e.to_string())?;
        line.push(b'\n');
        stream
            .write_all(&line)
            .map_err(|e| format!("sidecar {name}: hello: {e}"))?;
        stream
            .flush()
            .map_err(|e| format!("sidecar {name}: hello flush: {e}"))?;
        let mut response = String::new();
        let response_stream = stream.try_clone().map_err(|e| e.to_string())?;
        let mut response_reader = BufReader::new(response_stream);
        response_reader
            .read_line(&mut response)
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut => format!(
                    "sidecar {name}: the service did not answer hello within {}s",
                    HELLO_TIMEOUT.as_secs()
                ),
                _ => format!("sidecar {name}: hello response: {e}"),
            })?;
        let response: serde_json::Value = serde_json::from_str(&response)
            .map_err(|e| format!("sidecar {name}: hello response: {e}"))?;
        if response.get("operation").and_then(|v| v.as_str()) != Some("hello") {
            return Err(format!(
                "sidecar {name}: authentication handshake failed: invalid hello response"
            ));
        }
        if response.get("ok").and_then(|v| v.as_bool()) != Some(true) {
            let reason = response
                .get("error")
                .and_then(|v| v.as_str())
                // 기본값: 사이드카 오류에 문장이 없으면 일반 문장으로 같은 실패를 알린다.
                .unwrap_or("invalid hello response");
            return Err(format!(
                "sidecar {name}: authentication handshake failed: {reason}"
            ));
        }
        if response.get("protocol").and_then(|v| v.as_u64()) != Some(1) {
            return Err(format!(
                "sidecar {name}: service protocol mismatch in hello response"
            ));
        }
        // 인사가 성공했으니 읽기 기한을 하루로 늘린다. macOS 는 상대가 닫은 소켓의
        // SO_RCVTIMEO 설정을 EINVAL 으로 거부하므로 이 단계의 실패는 닫힌 연결이다 —
        // 인사에 답하고 곧 닫는 서비스는 살아 있는 연결이 아니다.
        stream
            .set_read_deadline(Some(NO_READ_DEADLINE))
            .map_err(|e| format!("sidecar {name}: hello deadline extend: {e}"))?;

        let reader_stream = response_reader.into_inner();
        let (tx, rx) = sync_channel::<Outgoing>(256);
        let mut threads: Vec<Thread> = Vec::new();
        let close_waiters: ReplyWaiters = Arc::new(Mutex::new(HashMap::new()));
        let shutdown_waiters: ReplyWaiters = Arc::new(Mutex::new(HashMap::new()));
        let retain_waiters: RetainWaiters = Arc::new(Mutex::new(HashMap::new()));
        let connected = Arc::new(AtomicBool::new(true));
        let write_name = name.to_string();
        let write_state = Arc::clone(&core.state);
        let writer = stream;
        let writer_connected = Arc::clone(&connected);
        threads.push(Box::new(move || {
            struct ConnectionGuard(Arc<AtomicBool>);
            impl Drop for ConnectionGuard {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::Release);
                }
            }
            let _connection_guard = ConnectionGuard(writer_connected);
            let mut writer = writer;
            loop {
                loop {
                    match rx.try_recv() {
                        Ok(Outgoing::Line(line)) => {
                            if !write_socket_line(&mut *writer, &write_name, &line) {
                                return;
                            }
                        }
                        Ok(Outgoing::Close) | Err(TryRecvError::Disconnected) => {
                            if !write_pending_socket(&write_state, &write_name, &mut *writer) {
                                log_error(
                                    &format!("sidecar {write_name}"),
                                    "the pending lines were not written before close",
                                );
                            }
                            shut_down_writer(&write_name, &mut *writer);
                            return;
                        }
                        Err(TryRecvError::Empty) => break,
                    }
                }
                if !write_pending_socket(&write_state, &write_name, &mut *writer) {
                    return;
                }
                match rx.recv() {
                    Ok(Outgoing::Line(line)) => {
                        if !write_socket_line(&mut *writer, &write_name, &line) {
                            return;
                        }
                    }
                    Ok(Outgoing::Close) | Err(RecvError) => {
                        if !write_pending_socket(&write_state, &write_name, &mut *writer) {
                            log_error(
                                &format!("sidecar {write_name}"),
                                "the pending lines were not written before disconnect",
                            );
                        }
                        shut_down_writer(&write_name, &mut *writer);
                        return;
                    }
                }
            }
        }));

        let state = Arc::clone(&core.state);
        let reader_core = Arc::clone(core);
        let sidecar = name.to_string();
        let waiters = Arc::clone(&close_waiters);
        let shutdown_waiters_for_reader = Arc::clone(&shutdown_waiters);
        let retain_waiters_for_reader = Arc::clone(&retain_waiters);
        let tx_clone = tx.clone();
        let reader_connected = Arc::clone(&connected);
        threads.push(Box::new(move || {
            struct ConnectionGuard(Arc<AtomicBool>);
            impl Drop for ConnectionGuard {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::Release);
                }
            }
            let _connection_guard = ConnectionGuard(Arc::clone(&reader_connected));
            let mut reader = BufReader::new(reader_stream);
            // 연결이 끝나면 None, 서비스가 프로토콜을 어기면 그 까닭이다
            // (docs/spec/terminal-runtime.md#service-transport).
            let violation = (|| -> Option<String> {
                let mut line = Vec::new();
                loop {
                    line.clear();
                    // 한도와 줄바꿈 하나까지만 읽는다.
                    let read = match reader
                        .by_ref()
                        .take(MESSAGE_LIMIT as u64 + 1)
                        .read_until(b'\n', &mut line)
                    {
                        Ok(read) => read,
                        Err(error) => {
                            log_error(&format!("sidecar {sidecar}"), format!("persistent read: {error}"));
                            return None;
                        }
                    };
                    if read == 0 {
                        return None;
                    }
                    if line.last() != Some(&b'\n') && read > MESSAGE_LIMIT {
                        return Some(format!("message exceeds {MESSAGE_LIMIT} bytes"));
                    }
                    let value: serde_json::Value = match serde_json::from_slice(&line) {
                        Ok(value) => value,
                        Err(error) => return Some(format!("invalid message: {error}")),
                    };
                    let Some(object) = value.as_object() else {
                        return Some("invalid message: not a JSON object".to_string());
                    };
                    let operation = match object.get("operation") {
                        None => None,
                        Some(serde_json::Value::String(operation)) => Some(operation.as_str()),
                        Some(_) => {
                            return Some("invalid message: operation: not a string".to_string())
                        }
                    };
                    if let Some(operation @ ("retained" | "closed-owner" | "shutdown")) = operation
                    {
                        let reply = match reply_of(operation, object) {
                            Ok(reply) => reply,
                            Err(reason) => return Some(reason),
                        };
                        let request = reply.request;
                        match operation {
                            "retained" => {
                                if let Some(sender) = retain_waiters_for_reader
                                    .lock()
                                    .expect("retain waiters")
                                    .remove(&request)
                                {
                                    let result = match reply.result {
                                        Ok(()) => Ok(reply.closed),
                                        Err(error) => Err(error),
                                    };
                                    if let Err(std::sync::mpsc::SendError(result)) = sender.send(result) {
                                        late_reply(&sidecar, "retain", result.map(|_| ()));
                                    }
                                }
                            }
                            "closed-owner" => {
                                if let Some(sender) =
                                    waiters.lock().expect("close waiters").remove(&request)
                                {
                                    if let Err(std::sync::mpsc::SendError(result)) = sender.send(reply.result) {
                                        late_reply(&sidecar, "close-owner", result);
                                    }
                                }
                            }
                            _ => {
                                if let Some(sender) = shutdown_waiters_for_reader
                                    .lock()
                                    .expect("shutdown waiters")
                                    .remove(&request)
                                {
                                    if let Err(std::sync::mpsc::SendError(result)) = sender.send(reply.result) {
                                        late_reply(&sidecar, "shutdown", result);
                                    }
                                }
                            }
                        }
                        continue;
                    }
                    match close_answer(&state, &sidecar, &line) {
                        Ok(true) => continue,
                        Ok(false) => {}
                        Err(violation) => return Some(violation),
                    }
                    let event: Event = match serde_json::from_slice(&line) {
                        Ok(event) => event,
                        Err(error) => return Some(format!("invalid message: {error}")),
                    };
                    let owner = state
                        .lock()
                        .ok()
                        .and_then(|state| state.owners.get(&event.surface).cloned());
                    if let Some(owner) = owner {
                        let response_sender = ReadThreadResponseSender {
                            sidecar_name: sidecar.clone(),
                            tx: tx_clone.clone(),
                            state: Arc::clone(&state),
                        };
                        if try_handle_image_envelope(
                            &owner,
                            &sidecar,
                            &event.surface,
                            &event.body,
                            &response_sender,
                        ) {
                            continue;
                        }
                        owner.deliver(Message {
                            sidecar: sidecar.clone(),
                            surface: event.surface,
                            body: event.body,
                        });
                    }
                }
            })();
            let mut was_current = false;
            let mut owned = Vec::new();
            let mut changed = None;
            if let Ok(mut state) = state.lock() {
                let is_current = state
                    .running
                    .get(&sidecar)
                    .and_then(|process| process.persistent.as_ref())
                    .is_some_and(|connection| {
                        Arc::ptr_eq(&connection.connected, &reader_connected)
                    });
                if is_current {
                    if let Some(process) = state.running.remove(&sidecar) {
                        if violation.is_some() {
                            owned = process
                                .surfaces
                                .iter()
                                .filter_map(|surface| {
                                    state
                                        .owners
                                        .get(surface)
                                        .map(|owner| (surface.clone(), owner.clone()))
                                })
                                .collect();
                        }
                    }
                    state.unannounced_loss.insert(sidecar.clone());
                    changed = forget_closing(&mut state, &sidecar);
                    was_current = true;
                } else if state.stopped {
                    // 중지가 실행 목록에서 뺀 연결이다. 답하지 않은 닫기는 service 가 스스로 마친다.
                    changed = forget_closing(&mut state, &sidecar);
                }
            }
            if let Some(changed) = changed {
                changed();
            }
            let close_error =
                Err("persistent service disconnected before close-owner ack".to_string());
            for (_, sender) in waiters.lock().expect("close waiters").drain() {
                if sender.send(close_error.clone()).is_err() {
                    eprintln!("sidecar {sidecar}: the close-owner failure arrived after its request ended");
                }
            }
            let error = Err("persistent service disconnected before shutdown ack".to_string());
            for (_, sender) in shutdown_waiters_for_reader
                .lock()
                .expect("shutdown waiters")
                .drain()
            {
                if sender.send(error.clone()).is_err() {
                    eprintln!("sidecar {sidecar}: the shutdown failure arrived after its request ended");
                }
            }
            if let Some(reason) = violation {
                // 서비스가 프로토콜을 어겼다. 같은 메시지가 다음 연결도 끝내므로 곧바로 다시 맺지 않고, 다음
                // 전송이 생성 경로로 다시 맺는다(docs/spec/terminal-runtime.md#service-transport).
                log_error(&format!("sidecar {sidecar}"), format!("failed: {reason}"));
                for (surface, owner) in owned {
                    owner.deliver_failure(Failure {
                        sidecar: sidecar.clone(),
                        surface,
                        reason: reason.clone(),
                    });
                }
                return;
            }
            // 연결이 끊겼다. 다음 전송을 기다리지 않고 즉시 다시 맺는다 — 서비스가 살아 있으면
            // 다시 붙고, 죽었으면 start_persistent 의 낡은 endpoint 정리가 재스폰한다(V5-106).
            if was_current {
                revive_persistent(&reader_core, &sidecar);
            }
        }));
        // application 종료는 bootstrap child를 기다리거나 kill하지 않아야 한다.
        drop(child);
        Ok(Started {
            process: Process {
                child: None,
                outbox: tx,
                surfaces: HashSet::new(),
                persistent: Some(PersistentConnection {
                    close_waiters,
                    retain_waiters,
                    shutdown_waiters,
                    connected,
                }),
            },
            threads,
        })
    }
}

/// 끊긴 영속 연결을 다시 맺고 결과를 소유 표면에 알린다(V5-106). 이미 다른 경로가 다시
/// 시작했거나 종료 중이면 아무 일도 하지 않는다. 한 번의 연결 끊김에 한 번만 시도한다 —
/// 실패는 알림으로 보고하고, 다음 전송이 같은 경로를 다시 지나간다.
/// 끊긴 영속 연결을 다시 맺고 결과를 소유 표면에 알린다(V5-106). 이미 다른 경로가 다시
/// 시작했거나 종료 중이면 아무 일도 하지 않는다. 한 번의 연결 끊김에 한 번만 시도한다 —
/// 실패는 알림으로 보고하고, 다음 전송이 같은 경로를 다시 지나간다. 단, 연결이 거부된
/// 첫 시도는 endpoint 가 더는 듣지 않는다는 증거다(재활용된 pid 가 kill(pid, 0) 을 통과시켜도
/// 소켓은 죽었다). 끊김 기록이 있는 재시작에서만 endpoint 를 버리고 한 번 더 시도한다.
/// 전송 경로의 계약은 그대로다: 차가운 전송의 live-unreachable 보고는 endpoint 를 바꾸지
/// 않는다.
fn revive_persistent<O: Owner>(core: &Arc<Core<O>>, name: &str) {
    let mut outcome = revive_attempt(core, name);
    if let Err(reason) = &outcome {
        if refused_connect(reason, name) {
            let endpoint = core
                .declared
                .get(name)
                .and_then(|program| program.file_name())
                .and_then(|value| value.to_str())
                .map(|basename| {
                    core.config_directory
                        .join("services")
                        .join(basename)
                        .join("endpoint.json")
                });
            if let Some(endpoint) = endpoint {
                if let Err(error) = std::fs::remove_file(&endpoint) {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        log_error(
                            &format!("sidecar {name}"),
                            format!("remove refused endpoint: {error}"),
                        );
                    }
                }
            }
            outcome = revive_attempt(core, name);
        }
    }
    match &outcome {
        Ok(true) => eprintln!("sidecar {name}: connection lost; restarted"),
        Ok(false) => {}
        Err(reason) => log_error(
            &format!("sidecar {name}"),
            format!("connection lost; restart failed: {reason}"),
        ),
    }
    notify_connection(core, name, outcome.map(|_| ()));
}

/// 재시작 한 번. 이미 다른 경로가 다시 시작했으면 Ok(false), 시작에 실패하면 Err.
fn revive_attempt<O: Owner>(core: &Arc<Core<O>>, name: &str) -> Result<bool, String> {
    let state = core.state.lock().expect("sidecar state");
    if state.stopped || state.running.contains_key(name) {
        return Ok(false);
    }
    let (mut state, started) = Core::ensure(core, state, name)?;
    Ok(started && state.unannounced_loss.remove(name))
}

/// start_persistent 의 연결 실패 문장인가. 문장은 이 파일의 connect_service 오류에서
/// 만들어진다.
fn refused_connect(reason: &str, name: &str) -> bool {
    reason.starts_with(&format!("sidecar {name}: connect authenticated service:"))
}

/// 다시 맺긴 영속 연결을 소유 표면에 알린다(V5-106). 창은 그 사이드카의 그림 configure 를
/// 다시 보내고([Owner::sidecar_reconnected]), 표면은 연결 이벤트를 받아 자기 세션을 다시
/// 연다. 시작에 실패했으면 연결 끊김과 그 까닭을 알린다.
fn notify_connection<O: Owner>(core: &Arc<Core<O>>, name: &str, outcome: Result<(), String>) {
    let surfaces: Vec<(String, O)> = {
        let state = core.state.lock().expect("sidecar state");
        state
            .owners
            .iter()
            .map(|(surface, owner)| (surface.clone(), owner.clone()))
            .collect()
    };
    let value = match &outcome {
        Ok(()) => serde_json::json!({"event": "connection", "connected": true}),
        Err(reason) => {
            serde_json::json!({"event": "connection", "connected": false, "reason": reason})
        }
    };
    let body = match RawValue::from_string(value.to_string()) {
        Ok(body) => body,
        Err(error) => {
            log_error(
                &format!("sidecar {name}"),
                format!("connection notice serialization: {error}"),
            );
            return;
        }
    };
    let mut reconfigured: Vec<String> = Vec::new();
    for (surface, owner) in surfaces {
        if outcome.is_ok() && !reconfigured.contains(&owner.key()) {
            reconfigured.push(owner.key());
            owner.sidecar_reconnected(name);
        }
        owner.deliver(Message {
            sidecar: name.to_string(),
            surface,
            body: body.clone(),
        });
    }
}

/// 영속 연결의 답 하나(closed-owner, shutdown, retained).
struct Reply {
    request: String,
    result: Result<(), String>,
    closed: usize,
}

/// 답의 field 형을 검사한다. 형이 틀리면 연결을 끝낼 까닭을 돌려준다
/// (docs/spec/terminal-runtime.md#service-transport).
fn reply_of(
    operation: &str,
    object: &serde_json::Map<String, serde_json::Value>,
) -> Result<Reply, String> {
    let request = match object.get("request") {
        Some(serde_json::Value::String(request)) if !request.is_empty() => request.clone(),
        _ => {
            return Err(format!(
                "invalid message: {operation} request is not a non-empty string"
            ))
        }
    };
    let ok = match object.get("ok") {
        Some(serde_json::Value::Bool(ok)) => *ok,
        _ => return Err(format!("invalid message: {operation} ok is not a boolean")),
    };
    let reason = match object.get("error") {
        None => None,
        Some(serde_json::Value::String(reason)) => Some(reason.clone()),
        Some(_) => {
            return Err(format!(
                "invalid message: {operation} error is not a string"
            ))
        }
    };
    let closed = if operation == "retained" && ok {
        match object.get("closed").and_then(serde_json::Value::as_u64) {
            Some(closed) => closed as usize,
            None => return Err("invalid message: retained closed is not a count".to_string()),
        }
    } else {
        0
    };
    let result = if ok {
        Ok(())
    } else {
        // 기본값: 서비스 오류에 문장이 없으면 작업 이름으로 같은 실패를 알린다.
        Err(reason.unwrap_or_else(|| format!("{operation} failed")))
    };
    Ok(Reply {
        request,
        result,
        closed,
    })
}

/// 표준 출력의 메시지를 소유 창에 전달한다. 출력이 끝나면 None 을, 프로토콜을 어기거나 읽기가
/// 실패하면 그 까닭을 반환한다. 한 줄은 줄바꿈 앞이 MESSAGE_LIMIT byte 를 넘으면 그 이상 버퍼링하지
/// 않고 실패한다(docs/spec/sidecars.md#failure).
fn relay<O: Owner>(
    reader: &mut impl BufRead,
    state: &Arc<Mutex<State<O>>>,
    sidecar: &str,
    tx: &SyncSender<Outgoing>,
) -> Option<String> {
    let mut line = Vec::new();
    loop {
        line.clear();
        // 한도와 줄바꿈 하나까지만 읽는다.
        let read = match reader
            .by_ref()
            .take(MESSAGE_LIMIT as u64 + 1)
            .read_until(b'\n', &mut line)
        {
            Ok(read) => read,
            Err(error) => return Some(format!("read: {error}")),
        };
        if read == 0 {
            return None;
        }
        if line.last() != Some(&b'\n') && read > MESSAGE_LIMIT {
            return Some(format!("message exceeds {MESSAGE_LIMIT} bytes"));
        }
        match close_answer(state, sidecar, &line) {
            Ok(true) => continue,
            Ok(false) => {}
            Err(violation) => return Some(violation),
        }
        let event: Event = match serde_json::from_slice(&line) {
            Ok(event) => event,
            Err(error) => return Some(format!("invalid message: {error}")),
        };
        // state lock은 절대 poison 되면 안 된다. 다른 스레드의 panic은 치명적.
        let (owner, addressed) = {
            let state = state.lock().expect("sidecar state");
            let addressed = state
                .running
                .get(sidecar)
                .is_some_and(|process| process.surfaces.contains(&event.surface))
                || state
                    .stopping
                    .get(sidecar)
                    .is_some_and(|stopping| stopping.surfaces.contains(&event.surface));
            (state.owners.get(&event.surface).cloned(), addressed)
        };
        // 이 프로세스에 보낸 적 없는 표면의 메시지는 프로토콜 위반이다. 보낸 적이 있고 소유 창이 없으면 표면이
        // 닫힌 뒤 사이드카가 보낸 메시지이므로 버린다(docs/spec/sidecars.md#messages).
        if !addressed {
            return Some(format!("unknown surface {}", event.surface));
        }
        let Some(owner) = owner else {
            continue;
        };
        let response_sender = ReadThreadResponseSender {
            sidecar_name: sidecar.to_string(),
            tx: tx.clone(),
            state: Arc::clone(state),
        };
        // 이미지 봉투 여부 확인 및 처리
        if try_handle_image_envelope(
            &owner,
            sidecar,
            &event.surface,
            &event.body,
            &response_sender,
        ) {
            continue;
        }
        owner.deliver(Message {
            sidecar: sidecar.to_string(),
            surface: event.surface,
            body: event.body,
        });
    }
}

/// 끝난 사이드카의 종료를 `exit status <code>` 나 `signal <number>` 로 쓴다(docs/spec/sidecars.md#declaration-and-startup).
/// 종료를 읽지 못하면 그 까닭을 같은 자리에 쓴다.
fn exit_text(status: std::process::ExitStatus) -> String {
    match crate::platform::current().and_then(|platform| platform.exit_status(status)) {
        Ok(text) => text,
        Err(error) => format!("exit status unreadable: {error}"),
    }
}

/// 출력이 끝났거나 프로토콜을 어긴 표준 입출력 사이드카를 처리한다. 종료 중이면 stop 이 프로세스를
/// 기다린다. 아니면 프로세스를 실행 중인 사이드카에서 빼고 끝낸 뒤, 그 프로세스에 보낸 표면의 소유
/// 창마다 실패를 알린다. 실패 뒤의 프로토콜 상태는 정의되지 않으므로 프로세스를 끝낸다.
fn fail<O: Owner>(state: &Arc<Mutex<State<O>>>, sidecar: &str, violation: Option<String>) {
    let (process, owned, changed) = {
        let mut state = state.lock().expect("sidecar state");
        if state.stopped {
            // 멈추는 중이다. 위반은 로그에 쓰고 실패 이벤트는 보내지 않는다. 종료의 보고는 stop 이 정한다.
            if let Some(violation) = violation {
                if let Some(stopping) = state.stopping.get_mut(sidecar) {
                    stopping.violated = true;
                }
                log_error(
                    &format!("sidecar {sidecar}"),
                    format!("failed: {violation}"),
                );
            }
            return;
        }
        // 표준 입출력 사이드카는 읽기 스레드가 끝나기 전에는 다시 시작되지 않으므로 이 이름의 프로세스가 이 프로세스다.
        let Some(process) = state.running.remove(sidecar) else {
            return;
        };
        let changed = forget_closing(&mut state, sidecar);
        let owned: Vec<(String, O)> = process
            .surfaces
            .iter()
            .filter_map(|surface| {
                state
                    .owners
                    .get(surface)
                    .map(|owner| (surface.clone(), owner.clone()))
            })
            .collect();
        (process, owned, changed)
    };
    if let Some(changed) = changed {
        changed();
    }
    let Process { child, outbox, .. } = process;
    let mut failures = Vec::new();
    let exit = match child {
        Some(mut child) => {
            if let Err(error) = child.kill() {
                failures.push(format!("kill: {error}"));
            }
            match child.wait() {
                Ok(status) => exit_text(status),
                Err(error) => {
                    failures.push(format!("wait: {error}"));
                    "unknown exit status".to_string()
                }
            }
        }
        None => "no child process".to_string(),
    };
    // 쓰기 스레드는 모든 송신자가 사라지면 보관분을 쓰고 끝난다.
    drop(outbox);
    // 기본값: 프로토콜 위반이 없으면 출력이 끝난 것이 실패 원인이다(docs/spec/sidecars.md#failure).
    let mut reason = violation.unwrap_or_else(|| format!("output closed: {exit}"));
    for failure in failures {
        reason = format!("{reason}; {failure}");
    }
    log_error(&format!("sidecar {sidecar}"), format!("failed: {reason}"));
    for (surface, owner) in owned {
        owner.deliver_failure(Failure {
            sidecar: sidecar.to_string(),
            surface,
            reason: reason.clone(),
        });
    }
}

/// 이벤트가 이미지 봉투인지 확인하고 처리한다. 봉투면 true 를 반환한다.
fn try_handle_image_envelope<O: Owner>(
    owner: &O,
    sidecar_name: &str,
    surface: &str,
    body: &RawValue,
    response_sender: &dyn ResponseSender,
) -> bool {
    // 이미지 봉투 여부 확인 및 결정을 요청한다.
    owner.decide_image_envelope(sidecar_name, surface, body, response_sender)
}

/// 사이드카 채널에서 사용하는 창. 창 레이블로 구분하고 창의 프로젝트 디렉터리를 root 로 사용한다.
pub(crate) type WindowSidecars = Sidecars<Window>;

impl Owner for Window {
    fn key(&self) -> String {
        self.label().to_string()
    }
    fn root(&self) -> Result<String, String> {
        let context = window_data(self)?;
        let root = context.root.lock().map_err(|e| e.to_string())?.clone();
        Ok(root)
    }
    fn sidecar_reconnected(&self, sidecar: &str) {
        if let Err(error) = crate::composition::refresh_sidecar_rasters(self, sidecar) {
            log_error(
                &format!("sidecar {sidecar} reconnection reconfigure"),
                error,
            );
        }
    }
    fn deliver(&self, message: Message) {
        if let Err(error) = emit_window(self, "sidecar-message", message) {
            log_error("sidecar-message", error);
        }
    }
    fn deliver_failure(&self, failure: Failure) {
        if let Err(error) = emit_window(self, "sidecar-failure", failure) {
            log_error("sidecar-failure", error);
        }
    }
    fn decide_image_envelope(
        &self,
        sidecar_name: &str,
        surface: &str,
        body: &RawValue,
        response_sender: &dyn ResponseSender,
    ) -> bool {
        let data = match window_data(self) {
            Ok(data) => data,
            Err(e) => {
                log_error(
                    &format!("sidecar {sidecar_name}"),
                    format!("image envelope for {surface}: {e}"),
                );
                return false;
            }
        };
        let window = self.clone();
        crate::images::handle_envelope_with_recovery(
            body.get(),
            sidecar_name,
            surface,
            &data.images,
            |work: Box<dyn Fn() -> Result<(), String> + Send>| {
                crate::exposure::on_main(&window, work)
            },
            |image, response| {
                let text = serde_json::to_string(&response).map_err(|e| e.to_string())?;
                let body = RawValue::from_string(text).map_err(|e| e.to_string())?;
                response_sender.send(surface, image, &body)
            },
            |reason| {
                if reason != "notFound" {
                    return Ok(());
                }
                crate::composition::refresh_image_rasters(&window)
            },
        )
    }
}
