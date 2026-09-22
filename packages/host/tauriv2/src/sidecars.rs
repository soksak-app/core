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

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, RecvError, SyncSender, TryRecvError, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use wait_timeout::ChildExt;

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
                    .or_insert_with(Vec::new)
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

fn write_line(stdin: &mut ChildStdin, name: &str, line: &[u8]) -> bool {
    if let Err(e) = stdin.write_all(line) {
        eprintln!("sidecar {name}: write: {e}");
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
            state.pending_replies.remove(name).unwrap_or_default(),
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
        eprintln!("sidecar {name}: write: {error}");
        return false;
    }
    true
}

/// 보관분을 한꺼번에 꺼내 반납 먼저, 닫힘 나중으로 쓴다. 보관분은 큐가 가득 찬 뒤에 생기므로 큐보다 뒤에 나간다.
fn write_pending<O: Owner>(state: &Mutex<State<O>>, name: &str, stdin: &mut ChildStdin) -> bool {
    let (replies, closes) = {
        let mut state = state.lock().expect("sidecar state");
        (
            state.pending_replies.remove(name).unwrap_or_default(),
            state.pending_closes.remove(name).unwrap_or_default(),
        )
    };
    replies
        .iter()
        .chain(closes.iter())
        .all(|line| write_line(stdin, name, line))
}

struct Process {
    child: Option<Child>,
    outbox: SyncSender<Outgoing>, // 용량 256인 채널
    persistent: Option<PersistentConnection>,
}

struct PersistentConnection {
    close_waiters: Arc<Mutex<HashMap<String, SyncSender<Result<(), String>>>>>,
    shutdown_waiters: Arc<Mutex<HashMap<String, SyncSender<Result<(), String>>>>>,
    connected: Arc<AtomicBool>,
}

struct State<O> {
    running: HashMap<String, Process>,
    owners: HashMap<String, O>,
    stopped: bool,
    // pending_replies: 각 사이드카별로 immutable 이미지 응답을 전송 순서대로 버퍼링한다.
    // pending_closes: 각 사이드카별로 표면의 닫힘 메시지를 버퍼링한다 (surface → close message)
    pending_replies: HashMap<String, Vec<Vec<u8>>>,
    pending_closes: HashMap<String, Vec<Vec<u8>>>,
}

/// 애플리케이션 하나의 사이드카 프로세스와 표면 소유 창을 관리한다.
pub struct Sidecars<O: Owner> {
    /// 사이드카 패키지 이름과 실행 파일 경로.
    declared: HashMap<String, PathBuf>,
    persistent: HashMap<String, bool>,
    config_directory: PathBuf,
    state: Arc<Mutex<State<O>>>,
    /// 테스트에서 주입 가능한 Stop() 기한. 기본값 5초.
    pub stop_timeout: Duration,
}

impl<O: Owner> Sidecars<O> {
    /// 플러그인이 선언한 사이드카로 채널을 생성한다. read 는 프론트엔드 경로의 파일 내용을
    /// 반환한다. 실행 파일은 directory 에서 basename(executable) 으로 찾는다.
    /// Creates a sidecar channel with the canonical application configuration directory.
    pub fn new(
        read: &dyn Fn(&str) -> Option<Vec<u8>>,
        directory: PathBuf,
        config_directory: PathBuf,
    ) -> Result<Self, String> {
        let config_directory = config_directory
            .canonicalize()
            .map_err(|e| format!("config directory: {e}"))?;
        #[derive(Deserialize)]
        struct Environment {
            #[serde(default)]
            plugins: Vec<String>,
        }
        #[derive(Deserialize)]
        struct Plugin {
            #[serde(default)]
            sidecars: Vec<String>,
        }
        #[derive(Deserialize)]
        struct Sidecar {
            executable: String,
            protocol: u64,
            #[serde(default)]
            transport: Option<String>,
        }
        fn load<T: serde::de::DeserializeOwned>(
            read: &dyn Fn(&str) -> Option<Vec<u8>>,
            path: &str,
        ) -> Result<T, String> {
            let bytes = read(path).ok_or_else(|| format!("{path} is missing from the frontend"))?;
            serde_json::from_slice(&bytes).map_err(|e| format!("{path}: {e}"))
        }
        let environment: Environment = load(read, "environment.json")?;
        let mut declared = HashMap::new();
        let mut persistent = HashMap::new();
        let mut persistent_basenames: HashMap<String, String> = HashMap::new();
        for plugin in &environment.plugins {
            let plugin: Plugin = load(read, &format!("modules/{plugin}/plugin.json"))?;
            for name in plugin.sidecars {
                if declared.contains_key(&name) {
                    continue;
                }
                let path = format!("modules/{name}/sidecar.json");
                let sidecar: Sidecar = load(read, &path)?;
                if sidecar.protocol != 1 {
                    return Err(format!(
                        "{path}: protocol {} is not supported",
                        sidecar.protocol
                    ));
                }
                let is_persistent = match sidecar.transport.as_deref() {
                    None => false,
                    Some("persistent") => true,
                    Some(value) => {
                        return Err(format!("{path}: transport {value} is not supported"))
                    }
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
                    if let Some(other) = persistent_basenames.insert(basename.clone(), name.clone())
                    {
                        return Err(format!(
                            "{path}: executable basename {basename} is already used by {other}"
                        ));
                    }
                }
                declared.insert(name.clone(), directory.join(file));
                persistent.insert(name, is_persistent);
            }
        }
        Ok(Self {
            declared,
            persistent,
            config_directory,
            state: Arc::new(Mutex::new(State {
                running: HashMap::new(),
                owners: HashMap::new(),
                stopped: false,
                pending_replies: HashMap::new(),
                pending_closes: HashMap::new(),
            })),
            stop_timeout: Duration::from_secs(5),
        })
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
        let root = owner.root()?;

        // 먼저 뮤텍스 밖에서 JSON 직렬화한다.
        let mut line = serde_json::to_vec(&Request {
            surface,
            root: Some(&root),
            closed: false,
            body: Some(body),
        })
        .map_err(|e| e.to_string())?;
        line.push(b'\n');

        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        if state.stopped {
            return Err("sidecars are stopped".into());
        }
        if !self.declared.contains_key(name) {
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
        if !state.running.contains_key(name) {
            let process = self.start(name)?;
            state.running.insert(name.to_string(), process);
        }
        state.owners.insert(surface.to_string(), owner.clone());
        let process = state.running.get(name).expect("started above");

        // 논블로킹으로 채널에 전송한다. 채널이 가득 차면 "is not keeping up" 오류를 반환한다.
        process
            .outbox
            .try_send(Outgoing::Line(line))
            .map_err(|_| format!("sidecar {name} is not keeping up"))
    }

    /// owner 창의 표면 중 alive 에 없는 것을 실행 중인 모든 사이드카에 알린다.
    pub fn retain(&self, owner: &O, alive: &dyn Fn(&str) -> bool) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        let key = owner.key();
        let gone: Vec<String> = state
            .owners
            .iter()
            .filter(|(surface, current)| current.key() == key && !alive(surface))
            .map(|(surface, _)| surface.clone())
            .collect();

        for surface in gone {
            state.owners.remove(&surface);

            // 뮤텍스 밖에서 직렬화한다.
            let mut line = serde_json::to_vec(&Request {
                surface: &surface,
                root: None,
                closed: true,
                body: None,
            })
            .map_err(|e| e.to_string())?;
            line.push(b'\n');

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
                            .or_insert_with(Vec::new)
                            .push(line.clone());
                        eprintln!("sidecar {name}: close {surface}: outbox full, buffered");
                    } else {
                        eprintln!("sidecar {name}: close {surface}: outbox disconnected");
                    }
                }
            }
        }
        Ok(())
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

        let mut state = self.state.lock().expect("sidecar state");
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
                    .or_insert_with(Vec::new)
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
        let processes: Vec<(String, Process)> = {
            let mut state = self.state.lock().expect("sidecar state");
            state.stopped = true;
            state.running.drain().collect()
        };

        // 모든 프로세스를 병렬로 기다린다.
        let deadline = std::time::Instant::now() + self.stop_timeout;
        let mut handles = Vec::new();
        for (_name, process) in processes {
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
                                eprintln!("sidecar: close-owner serialization failed: {error}");
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
                            eprintln!("sidecar: send close-owner: {error}");
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
                                    eprintln!("sidecar: send shutdown: {error}");
                                } else {
                                    let shutdown_remaining = deadline
                                        .saturating_duration_since(std::time::Instant::now());
                                    match shutdown_rx.recv_timeout(shutdown_remaining) {
                                        Ok(Ok(())) => {}
                                        Ok(Err(error)) => {
                                            eprintln!("sidecar: shutdown: {error}");
                                        }
                                        Err(error) => {
                                            eprintln!("sidecar: shutdown wait: {error}");
                                        }
                                    }
                                }
                            }
                            Ok(Err(error)) => eprintln!("sidecar: close owner: {error}"),
                            Err(error) => eprintln!("sidecar: close owner wait: {error}"),
                        }
                        if let Err(error) = process.outbox.send(Outgoing::Close) {
                            eprintln!("sidecar: close persistent transport: {error}");
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
                        thread::spawn(move || {
                            if let Err(e) = tx.send(close) {
                                eprintln!("sidecar: send close: {e}");
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

                // wait-timeout 크레이트를 사용하여 SIGCHLD 기반 대기 (폴링 없음)
                match child.wait_timeout(remaining) {
                    Ok(Some(_status)) => {
                        // 정상 종료됨.
                    }
                    Ok(None) => {
                        // 기한 초과. 강제 종료.
                        if let Err(e) = child.kill() {
                            eprintln!("sidecar: kill: {e}");
                        }
                        if let Err(e) = child.wait() {
                            eprintln!("sidecar: wait after kill: {e}");
                        }
                    }
                    Err(e) => {
                        // wait() 오류. 이미 종료되었거나 이미 waited.
                        eprintln!("sidecar: wait_timeout: {e}");
                    }
                }
            });
            handles.push(handle);
        }

        // 모든 스레드가 완료될 때까지 기다린다.
        for handle in handles {
            if let Err(e) = handle.join() {
                eprintln!("sidecar: thread join: {:?}", e);
            }
        }
    }

    /// 이벤트가 이미지 봉투인지 확인하고 처리한다. 봉투면 true 를 반환한다.
    fn start(&self, name: &str) -> Result<Process, String> {
        let program = self
            .declared
            .get(name)
            .ok_or_else(|| format!("sidecar {name} is not declared by any plugin"))?;
        if *self.persistent.get(name).unwrap_or(&false) {
            return self.start_persistent(name, program);
        }
        let mut child = Command::new(program)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("sidecar {name}: {}: {e}", program.display()))?;
        let mut stdin = child.stdin.take().ok_or("sidecar stdin is missing")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout is missing")?;

        // 용량 256인 동기 채널 생성
        let (tx, rx) = sync_channel::<Outgoing>(256);

        // 쓰기 스레드: outbox 채널에서 읽어 stdin에 쓴다
        // 순서는 ① 큐에 있는 모든 것을 비블로킹으로 쓴다 ② 큐가 비었으면 보관분을 모두 쓴다 ③ 그다음 채널에서 블록 수신한다.
        // 이렇게 하면 보관분(큐가 가득 찼을 때만 생김)이 큐에 먼저 있던 메시지보다 뒤에 나가므로 순서가 맞다.
        // 채널이 닫혀 종료할 때도 보관분을 전부 쓴 뒤 stdin을 닫는다.
        let write_name = name.to_string();
        let state_clone = Arc::clone(&self.state);

        thread::spawn(move || loop {
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
        });

        // 읽기 스레드: stdout에서 읽어 이벤트를 전달한다
        let state = Arc::clone(&self.state);
        let sidecar = name.to_string();
        let tx_clone = tx.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error) => {
                        eprintln!("sidecar {sidecar}: {error}");
                        break;
                    }
                }
                let event: Event = match serde_json::from_slice(&line) {
                    Ok(event) => event,
                    Err(error) => {
                        eprintln!("sidecar {sidecar}: invalid event: {error}");
                        continue;
                    }
                };
                // state lock은 절대 poison 되면 안 된다. 다른 스레드의 panic은 치명적.
                let owner = {
                    let state = state.lock().expect("sidecar state");
                    state.owners.get(&event.surface).cloned()
                };
                if let Some(owner) = owner {
                    let response_sender = ReadThreadResponseSender {
                        sidecar_name: sidecar.clone(),
                        tx: tx_clone.clone(),
                        state: Arc::clone(&state),
                    };
                    // 이미지 봉투 여부 확인 및 처리
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
            if let Ok(mut state) = state.lock() {
                if !state.stopped {
                    eprintln!("sidecar {sidecar} closed its output");
                    if let Some(process) = state.running.remove(&sidecar) {
                        // process를 drop 하지만 child 를 wait 하지는 않는다
                        drop(process);
                    }
                }
            }
        });

        Ok(Process {
            child: Some(child),
            outbox: tx,
            persistent: None,
        })
    }

    fn start_persistent(&self, name: &str, program: &Path) -> Result<Process, String> {
        #[derive(Deserialize)]
        struct Endpoint {
            protocol: u64,
            pid: u32,
            socket: String,
            token: String,
        }

        let config = &self.config_directory;
        let basename = program
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty() && *value != "." && *value != "..")
            .ok_or_else(|| format!("sidecar {name}: executable has no valid basename"))?;
        let service_dir = config.join("services").join(basename);
        std::fs::create_dir_all(&service_dir)
            .map_err(|e| format!("sidecar {name}: create service directory: {e}"))?;
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
                    // Re-enter the one creation path. A stale endpoint is an
                    // explicit crash-recovery case, not a fallback transport.
                    return self.start_persistent(name, program);
                }
                endpoint
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut command = Command::new(program);
                command
                    .arg("--service-dir")
                    .arg(&service_dir)
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::inherit());
                let mut spawned = command
                    .spawn()
                    .map_err(|e| format!("sidecar {name}: {}: {e}", program.display()))?;
                let stdout = spawned
                    .stdout
                    .take()
                    .ok_or("persistent service stdout is missing")?;
                let mut reader = BufReader::new(stdout);
                let mut line = String::new();
                reader
                    .read_line(&mut line)
                    .map_err(|e| format!("sidecar {name}: service startup: {e}"))?;
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
            .map_err(|e| format!("sidecar {name}: hello response: {e}"))?;
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

        let reader_stream = response_reader.into_inner();
        let (tx, rx) = sync_channel::<Outgoing>(256);
        let close_waiters: Arc<Mutex<HashMap<String, SyncSender<Result<(), String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let shutdown_waiters: Arc<Mutex<HashMap<String, SyncSender<Result<(), String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let connected = Arc::new(AtomicBool::new(true));
        let write_name = name.to_string();
        let write_state = Arc::clone(&self.state);
        let writer = stream;
        let writer_connected = Arc::clone(&connected);
        thread::spawn(move || {
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
                                eprintln!("sidecar: flush pending socket failed during close");
                            }
                            if let Err(error) = writer.shutdown() {
                                eprintln!("sidecar: writer shutdown failed: {error}");
                            }
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
                            eprintln!("sidecar: flush pending socket failed during disconnect");
                        }
                        if let Err(error) = writer.shutdown() {
                            eprintln!("sidecar: writer shutdown failed: {error}");
                        }
                        return;
                    }
                }
            }
        });

        let state = Arc::clone(&self.state);
        let sidecar = name.to_string();
        let waiters = Arc::clone(&close_waiters);
        let shutdown_waiters_for_reader = Arc::clone(&shutdown_waiters);
        let tx_clone = tx.clone();
        let reader_connected = Arc::clone(&connected);
        thread::spawn(move || {
            struct ConnectionGuard(Arc<AtomicBool>);
            impl Drop for ConnectionGuard {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::Release);
                }
            }
            let _connection_guard = ConnectionGuard(Arc::clone(&reader_connected));
            let mut reader = BufReader::new(reader_stream);
            let mut line = String::new();
            loop {
                let read = match reader.read_line(&mut line) {
                    Ok(read) => read,
                    Err(error) => {
                        if error.kind() == std::io::ErrorKind::WouldBlock {
                            eprintln!("sidecar: response read would block; retrying");
                            line.clear();
                            continue;
                        }
                        eprintln!("sidecar: read response failed: {error}");
                        break;
                    }
                };
                if read == 0 {
                    break;
                }
                let value: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(error) => {
                        eprintln!("sidecar: invalid response JSON: {error}");
                        break;
                    }
                };
                if value.get("operation").and_then(|v| v.as_str()) == Some("closed-owner") {
                    if let Some(request) = value.get("request").and_then(|v| v.as_str()) {
                        if let Some(sender) = waiters.lock().expect("close waiters").remove(request)
                        {
                            let result = if value.get("ok").and_then(|v| v.as_bool()) == Some(true)
                            {
                                Ok(())
                            } else {
                                Err(value
                                    .get("error")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("close-owner failed")
                                    .to_string())
                            };
                            if sender.send(result).is_err() {
                                eprintln!("sidecar: close-owner response had no waiter");
                            }
                        }
                    }
                    line.clear();
                    continue;
                }
                if value.get("operation").and_then(|v| v.as_str()) == Some("shutdown") {
                    if let Some(request) = value.get("request").and_then(|v| v.as_str()) {
                        if let Some(sender) = shutdown_waiters_for_reader
                            .lock()
                            .expect("shutdown waiters")
                            .remove(request)
                        {
                            let result = if value.get("ok").and_then(|v| v.as_bool()) == Some(true)
                            {
                                Ok(())
                            } else {
                                Err(value
                                    .get("error")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("shutdown failed")
                                    .to_string())
                            };
                            if sender.send(result).is_err() {
                                eprintln!("sidecar: shutdown response had no waiter");
                            }
                        }
                    }
                    line.clear();
                    continue;
                }
                let event: Event = match serde_json::from_value(value) {
                    Ok(event) => event,
                    Err(error) => {
                        eprintln!("sidecar: invalid event response: {error}");
                        break;
                    }
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
                        line.clear();
                        continue;
                    }
                    owner.deliver(Message {
                        sidecar: sidecar.clone(),
                        surface: event.surface,
                        body: event.body,
                    });
                }
                line.clear();
            }
            if let Ok(mut state) = state.lock() {
                let is_current = state
                    .running
                    .get(&sidecar)
                    .and_then(|process| process.persistent.as_ref())
                    .is_some_and(|connection| {
                        Arc::ptr_eq(&connection.connected, &reader_connected)
                    });
                if is_current {
                    state.running.remove(&sidecar);
                }
            }
            let close_error =
                Err("persistent service disconnected before close-owner ack".to_string());
            for (_, sender) in waiters.lock().expect("close waiters").drain() {
                if sender.send(close_error.clone()).is_err() {
                    eprintln!("sidecar {sidecar}: close waiter disconnected");
                }
            }
            let error = Err("persistent service disconnected before shutdown ack".to_string());
            for (_, sender) in shutdown_waiters_for_reader
                .lock()
                .expect("shutdown waiters")
                .drain()
            {
                if sender.send(error.clone()).is_err() {
                    eprintln!("sidecar {sidecar}: shutdown waiter disconnected");
                }
            }
        });
        // The bootstrap child must not be waited on or killed by application shutdown.
        drop(child);
        Ok(Process {
            child: None,
            outbox: tx,
            persistent: Some(PersistentConnection {
                close_waiters,
                shutdown_waiters,
                connected,
            }),
        })
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
    fn deliver(&self, message: Message) {
        if let Err(error) = emit_window(self, "sidecar-message", message) {
            eprintln!("sidecar message: {error}");
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
                eprintln!("sidecar {sidecar_name}: image envelope for {surface}: {e}");
                return false;
            }
        };
        let window = self.clone();
        crate::images::handle_envelope(
            body.get(),
            sidecar_name,
            surface,
            &data.images,
            |work: Box<dyn Fn() -> Result<(), String> + Send>| {
                crate::exposure::on_main(&window, move || work())
            },
            |image, response| {
                let text = serde_json::to_string(&response).map_err(|e| e.to_string())?;
                let body = RawValue::from_string(text).map_err(|e| e.to_string())?;
                response_sender.send(surface, image, &body)
            },
        )
    }
}
