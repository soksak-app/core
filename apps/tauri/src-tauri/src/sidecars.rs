//! 사이드카 채널.
//!
//! environment.json 에 선언된 사이드카를 처음 사용할 때 실행하고, 표면 페이지와 사이드카
//! 사이에서 한 줄 JSON 메시지를 전달한다. 메시지 본문은 해석하지 않는다. 형식은
//! docs/spec/sidecars.md 에 정의한다.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
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
    directory: PathBuf,
    declared: HashSet<String>,
    state: Arc<Mutex<State<O>>>,
}

fn write_request(process: &mut Process, request: &Request) -> Result<(), String> {
    let mut line = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    line.push(b'\n');
    process.stdin.write_all(&line).map_err(|e| e.to_string())?;
    process.stdin.flush().map_err(|e| e.to_string())
}

impl<O: Owner> Sidecars<O> {
    /// environment.json 의 sidecars 목록으로 채널을 생성한다. 실행 파일은 directory 에서
    /// soksak-<이름> 으로 찾는다.
    pub fn new(environment: &[u8], directory: PathBuf) -> Result<Self, String> {
        #[derive(Deserialize)]
        struct Declared {
            #[serde(default)]
            sidecars: Vec<String>,
        }
        let declared: Declared =
            serde_json::from_slice(environment).map_err(|e| format!("environment.json: {e}"))?;
        Ok(Self {
            directory,
            declared: declared.sidecars.into_iter().collect(),
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
        if !self.declared.contains(name) {
            return Err(format!("sidecar {name} is not declared in environment.json"));
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
        let program = self.directory.join(format!("soksak-{name}"));
        let mut child = Command::new(&program)
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

    /// 받은 줄을 그대로 출력하고 요청 기록 파일에 남기는 fake 사이드카 "echo" 를 선언한다.
    fn echo_sidecars() -> (Sidecars<FakeOwner>, tempfile::TempDir) {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let record = directory.path().join("requests");
        let program = directory.path().join("soksak-echo");
        std::fs::write(&program, format!("#!/bin/sh\ntee {}\n", record.display())).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let sidecars = Sidecars::new(br#"{"sidecars":["echo"]}"#, directory.path().to_path_buf()).unwrap();
        (sidecars, directory)
    }

    #[test]
    fn messages_reach_the_owning_window_only() {
        let (sidecars, directory) = echo_sidecars();
        let (first, first_events) = owner("a", "/projects/a");
        let (second, second_events) = owner("b", "/projects/b");
        sidecars.send(&first, "echo", "s1", &raw(r#"{"op":"open"}"#)).unwrap();
        sidecars.send(&second, "echo", "s2", &raw(r#"{"op":"open"}"#)).unwrap();
        let event = first_events.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!((event.sidecar.as_str(), event.surface.as_str(), event.body.get()), ("echo", "s1", r#"{"op":"open"}"#));
        assert_eq!(second_events.recv_timeout(Duration::from_secs(10)).unwrap().surface, "s2");
        let error = sidecars.send(&second, "echo", "s1", &raw("{}")).unwrap_err();
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
        assert!(sidecars.send(&window, "echo", "s1", &raw("{}")).unwrap_err().contains("stopped"));
    }

    #[test]
    fn a_missing_executable_fails() {
        let directory = tempfile::tempdir().unwrap();
        let sidecars: Sidecars<FakeOwner> = Sidecars::new(br#"{"sidecars":["absent"]}"#, directory.path().to_path_buf()).unwrap();
        let (window, _events) = owner("a", "/");
        assert!(sidecars.send(&window, "absent", "s1", &raw("{}")).unwrap_err().contains("sidecar absent"));
    }
}
