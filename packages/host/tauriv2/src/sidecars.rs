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
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tauri::Window;

use crate::windows::{emit_window, window_data};

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

/// 표면을 소유한 창. 사이드카 메시지의 root 를 제공하고 이벤트를 받는다.
pub trait Owner: Clone + Send + 'static {
    /// 소유 창을 구분하는 값.
    fn key(&self) -> String;
    /// 사이드카 요청의 root 로 보내는 프로젝트 디렉터리.
    fn root(&self) -> Result<String, String>;
    /// 사이드카가 보낸 메시지를 창의 페이지에 전달한다.
    fn deliver(&self, message: Message);
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

struct Process {
    child: Child,
    stdin: ChildStdin,
}

struct State<O> {
    running: HashMap<String, Process>,
    owners: HashMap<String, O>,
    stopped: bool,
}

/// 애플리케이션 하나의 사이드카 프로세스와 표면 소유 창을 관리한다.
pub struct Sidecars<O: Owner> {
    /// 사이드카 패키지 이름과 실행 파일 경로.
    declared: HashMap<String, PathBuf>,
    state: Arc<Mutex<State<O>>>,
}

fn write_request(process: &mut Process, request: &Request) -> Result<(), String> {
    let mut line = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    line.push(b'\n');
    process.stdin.write_all(&line).map_err(|e| e.to_string())?;
    process.stdin.flush().map_err(|e| e.to_string())
}

impl<O: Owner> Sidecars<O> {
    /// 플러그인이 선언한 사이드카로 채널을 생성한다. read 는 프론트엔드 경로의 파일 내용을
    /// 반환한다. 실행 파일은 directory 에서 basename(executable) 으로 찾는다.
    pub fn new(read: &dyn Fn(&str) -> Option<Vec<u8>>, directory: PathBuf) -> Result<Self, String> {
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
        }
        fn load<T: serde::de::DeserializeOwned>(read: &dyn Fn(&str) -> Option<Vec<u8>>, path: &str) -> Result<T, String> {
            let bytes = read(path).ok_or_else(|| format!("{path} is missing from the frontend"))?;
            serde_json::from_slice(&bytes).map_err(|e| format!("{path}: {e}"))
        }
        let environment: Environment = load(read, "environment.json")?;
        let mut declared = HashMap::new();
        for plugin in &environment.plugins {
            let plugin: Plugin = load(read, &format!("modules/{plugin}/plugin.json"))?;
            for name in plugin.sidecars {
                if declared.contains_key(&name) {
                    continue;
                }
                let path = format!("modules/{name}/sidecar.json");
                let sidecar: Sidecar = load(read, &path)?;
                if sidecar.protocol != 1 {
                    return Err(format!("{path}: protocol {} is not supported", sidecar.protocol));
                }
                let executable = Path::new(&sidecar.executable);
                let inside = executable.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
                let file = executable.file_name().filter(|_| inside)
                    .ok_or_else(|| format!("{path}: executable {} is not a path inside the package", sidecar.executable))?;
                declared.insert(name, directory.join(file));
            }
        }
        Ok(Self {
            declared,
            state: Arc::new(Mutex::new(State { running: HashMap::new(), owners: HashMap::new(), stopped: false })),
        })
    }

    /// owner 창의 표면 surface 에서 온 body 를 사이드카 name 에 전달한다.
    pub fn send(&self, owner: &O, name: &str, surface: &str, body: &RawValue) -> Result<(), String> {
        let root = owner.root()?;
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
        if !state.running.contains_key(name) {
            let process = self.start(name)?;
            state.running.insert(name.to_string(), process);
        }
        state.owners.insert(surface.to_string(), owner.clone());
        let process = state.running.get_mut(name).expect("started above");
        write_request(process, &Request { surface, root: Some(&root), closed: false, body: Some(body) })
    }

    /// owner 창의 표면 중 alive 에 없는 것을 실행 중인 모든 사이드카에 알린다.
    pub fn retain(&self, owner: &O, alive: &dyn Fn(&str) -> bool) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        let key = owner.key();
        let gone: Vec<String> = state.owners.iter()
            .filter(|(surface, current)| current.key() == key && !alive(surface))
            .map(|(surface, _)| surface.clone())
            .collect();
        for surface in gone {
            state.owners.remove(&surface);
            for (name, process) in state.running.iter_mut() {
                if let Err(error) = write_request(process, &Request { surface: &surface, root: None, closed: true, body: None }) {
                    eprintln!("sidecar {name}: close {surface}: {error}");
                }
            }
        }
        Ok(())
    }

    /// 모든 사이드카의 표준 입력을 닫고 종료를 기다린다.
    pub fn stop(&self) {
        let processes: Vec<(String, Process)> = {
            let mut state = self.state.lock().expect("sidecar state");
            state.stopped = true;
            state.running.drain().collect()
        };
        for (name, process) in processes {
            let Process { mut child, stdin } = process;
            drop(stdin);
            if let Err(error) = child.wait() {
                eprintln!("sidecar {name}: {error}");
            }
        }
    }

    fn start(&self, name: &str) -> Result<Process, String> {
        let program = self.declared.get(name).ok_or_else(|| format!("sidecar {name} is not declared by any plugin"))?;
        let mut child = Command::new(program)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("sidecar {name}: {}: {e}", program.display()))?;
        let stdin = child.stdin.take().ok_or("sidecar stdin is missing")?;
        let stdout = child.stdout.take().ok_or("sidecar stdout is missing")?;
        let state = Arc::clone(&self.state);
        let sidecar = name.to_string();
        std::thread::spawn(move || {
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
                let owner = state.lock().ok().and_then(|state| state.owners.get(&event.surface).cloned());
                if let Some(owner) = owner {
                    owner.deliver(Message { sidecar: sidecar.clone(), surface: event.surface, body: event.body });
                }
            }
            if let Ok(mut state) = state.lock() {
                if !state.stopped {
                    eprintln!("sidecar {sidecar} closed its output");
                    if let Some(mut process) = state.running.remove(&sidecar) {
                        let _ = process.child.wait();
                    }
                }
            }
        });
        Ok(Process { child, stdin })
    }
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
}
