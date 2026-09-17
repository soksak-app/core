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

/// 사이드카가 보낸 메시지를 페이지에 전달하는 이벤트 값.
#[derive(Clone, Serialize)]
pub struct Message {
    pub sidecar: String,
    pub surface: String,
    pub body: Box<RawValue>,
}

/// 표면을 소유한 창. 사이드카 메시지의 root 를 제공하고 이벤트를 받는다.
pub trait Owner: Clone + Send + 'static {
    fn key(&self) -> String;
    fn root(&self) -> Result<String, String>;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::time::Duration;

    #[derive(Clone)]
    struct FakeOwner {
        key: String,
        root: String,
        sent: Sender<Message>,
    }

    impl Owner for FakeOwner {
        fn key(&self) -> String { self.key.clone() }
        fn root(&self) -> Result<String, String> { Ok(self.root.clone()) }
        fn deliver(&self, message: Message) { let _ = self.sent.send(message); }
    }

    fn owner(key: &str, root: &str) -> (FakeOwner, Receiver<Message>) {
        let (sent, received) = channel();
        (FakeOwner { key: key.into(), root: root.into(), sent }, received)
    }

    fn raw(text: &str) -> Box<RawValue> { RawValue::from_string(text.into()).unwrap() }

    type Files = HashMap<&'static str, String>;

    fn files(sidecar: &str) -> Files {
        HashMap::from([
            ("environment.json", r#"{"plugins":["@fixture/plugin"]}"#.to_string()),
            ("modules/@fixture/plugin/plugin.json", r#"{"sidecars":["@fixture/sidecar-echo"]}"#.to_string()),
            ("modules/@fixture/sidecar-echo/sidecar.json", sidecar.to_string()),
        ])
    }

    fn create(files: &Files, directory: &Path) -> Result<Sidecars<FakeOwner>, String> {
        let read = |path: &str| files.get(path).map(|text| text.as_bytes().to_vec());
        Sidecars::new(&read, directory.to_path_buf())
    }

    const ECHO: &str = "@fixture/sidecar-echo";

    /// 받은 줄을 그대로 출력하고 요청 기록 파일에 남기는 fake 사이드카 @fixture/sidecar-echo 를 선언한다.
    fn echo_sidecars() -> (Sidecars<FakeOwner>, tempfile::TempDir) {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let record = directory.path().join("requests");
        let program = directory.path().join("echo");
        std::fs::write(&program, format!("#!/bin/sh\ntee {}\n", record.display())).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let sidecars = create(&files(r#"{"executable":"build/echo","protocol":1}"#), directory.path()).unwrap();
        (sidecars, directory)
    }

    #[test]
    fn messages_reach_the_owning_window_only() {
        let (sidecars, directory) = echo_sidecars();
        let (first, first_events) = owner("a", "/projects/a");
        let (second, second_events) = owner("b", "/projects/b");
        sidecars.send(&first, ECHO, "s1", &raw(r#"{"op":"open"}"#)).unwrap();
        sidecars.send(&second, ECHO, "s2", &raw(r#"{"op":"open"}"#)).unwrap();
        let event = first_events.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!((event.sidecar.as_str(), event.surface.as_str(), event.body.get()), (ECHO, "s1", r#"{"op":"open"}"#));
        assert_eq!(second_events.recv_timeout(Duration::from_secs(10)).unwrap().surface, "s2");
        let error = sidecars.send(&second, ECHO, "s1", &raw("{}")).unwrap_err();
        assert!(error.contains("another window"), "{error}");
        sidecars.retain(&first, &|_| false).unwrap();
        sidecars.stop();
        let requests = std::fs::read_to_string(directory.path().join("requests")).unwrap();
        assert_eq!(requests, concat!(
            r#"{"surface":"s1","root":"/projects/a","body":{"op":"open"}}"#, "\n",
            r#"{"surface":"s2","root":"/projects/b","body":{"op":"open"}}"#, "\n",
            r#"{"surface":"s1","closed":true}"#, "\n",
        ));
    }

    #[test]
    fn undeclared_and_stopped_sidecars_are_rejected() {
        let (sidecars, _directory) = echo_sidecars();
        let (window, _events) = owner("a", "/projects/a");
        assert!(sidecars.send(&window, "other", "s1", &raw("{}")).unwrap_err().contains("not declared"));
        sidecars.stop();
        assert!(sidecars.send(&window, ECHO, "s1", &raw("{}")).unwrap_err().contains("stopped"));
    }

    #[test]
    fn a_missing_executable_fails() {
        let directory = tempfile::tempdir().unwrap();
        let sidecars = create(&files(r#"{"executable":"build/echo","protocol":1}"#), directory.path()).unwrap();
        let (window, _events) = owner("a", "/");
        let error = sidecars.send(&window, ECHO, "s1", &raw("{}")).unwrap_err();
        assert!(error.contains(&format!("sidecar {ECHO}")), "{error}");
    }

    #[test]
    fn a_sidecar_without_sidecar_json_fails() {
        let directory = tempfile::tempdir().unwrap();
        let mut files = files(r#"{"executable":"build/echo","protocol":1}"#);
        files.insert("modules/@fixture/plugin/plugin.json", r#"{"sidecars":["@fixture/sidecar-missing"]}"#.into());
        let error = create(&files, directory.path()).err().unwrap();
        assert!(error.contains("modules/@fixture/sidecar-missing/sidecar.json"), "{error}");
    }

    #[test]
    fn an_executable_outside_the_package_fails() {
        let directory = tempfile::tempdir().unwrap();
        let error = create(&files(r#"{"executable":"../escape","protocol":1}"#), directory.path()).err().unwrap();
        assert!(error.contains("modules/@fixture/sidecar-echo/sidecar.json"), "{error}");
    }

    #[test]
    fn an_unsupported_protocol_fails() {
        let directory = tempfile::tempdir().unwrap();
        let error = create(&files(r#"{"executable":"build/echo","protocol":2}"#), directory.path()).err().unwrap();
        assert!(error.contains("modules/@fixture/sidecar-echo/sidecar.json"), "{error}");
    }

    #[test]
    fn plugins_without_sidecars_declare_none() {
        let directory = tempfile::tempdir().unwrap();
        let mut files = files("");
        files.insert("modules/@fixture/plugin/plugin.json", "{}".into());
        files.remove("modules/@fixture/sidecar-echo/sidecar.json");
        let sidecars = create(&files, directory.path()).unwrap();
        let (window, _events) = owner("a", "/");
        let error = sidecars.send(&window, ECHO, "s1", &raw("{}")).unwrap_err();
        assert!(error.contains("is not declared by any plugin"), "{error}");
    }
}
