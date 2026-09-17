//! 사이드카 채널 테스트. 가짜 창과 셸 스크립트 사이드카를 사용한다.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::Duration;

use serde_json::value::RawValue;
use soksak_host_tauriv2::sidecars::{Message, Owner, Sidecars};

#[derive(Clone)]
struct FakeOwner {
    key: String,
    root: String,
    sent: Sender<Message>,
}

impl Owner for FakeOwner {
    fn key(&self) -> String {
        self.key.clone()
    }
    fn root(&self) -> Result<String, String> {
        Ok(self.root.clone())
    }
    fn deliver(&self, message: Message) {
        let _ = self.sent.send(message);
    }
}

fn owner(key: &str, root: &str) -> (FakeOwner, Receiver<Message>) {
    let (sent, received) = channel();
    (FakeOwner { key: key.into(), root: root.into(), sent }, received)
}

fn raw(text: &str) -> Box<RawValue> {
    RawValue::from_string(text.into()).unwrap()
}

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
