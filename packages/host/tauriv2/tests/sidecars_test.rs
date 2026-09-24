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
    (
        FakeOwner {
            key: key.into(),
            root: root.into(),
            sent,
        },
        received,
    )
}

fn raw(text: &str) -> Box<RawValue> {
    RawValue::from_string(text.into()).unwrap()
}

type Files = HashMap<&'static str, String>;

fn files(sidecar: &str) -> Files {
    HashMap::from([
        (
            "environment.json",
            r#"{"plugins":["@fixture/plugin"]}"#.to_string(),
        ),
        (
            "modules/@fixture/plugin/plugin.json",
            r#"{"sidecars":["@fixture/sidecar-echo"]}"#.to_string(),
        ),
        (
            "modules/@fixture/sidecar-echo/sidecar.json",
            sidecar.to_string(),
        ),
    ])
}

fn create(files: &Files, directory: &Path) -> Result<Sidecars<FakeOwner>, String> {
    let read = |path: &str| files.get(path).map(|text| text.as_bytes().to_vec());
    Sidecars::new(&read, directory.to_path_buf(), directory.to_path_buf())
}

const ECHO: &str = "@fixture/sidecar-echo";

/// 받은 줄을 그대로 출력하고 요청 기록 파일에 남기는 fake 사이드카 @fixture/sidecar-echo 를 선언한다.
fn echo_sidecars() -> (Sidecars<FakeOwner>, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let record = directory.path().join("requests");
    let program = directory.path().join("echo");
    std::fs::write(&program, format!("#!/bin/sh\ntee {}\n", record.display())).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let sidecars = create(
        &files(r#"{"executable":"build/echo","protocol":1}"#),
        directory.path(),
    )
    .unwrap();
    (sidecars, directory)
}

// contract: sidecars.send.delivers-only-to-owning-window, sidecars.send.rejects-surface-owned-by-another-window, sidecars.protocol.request-lines-carry-surface-root-body, sidecars.close-owner.sends-closed-per-surface
#[test]
fn messages_reach_the_owning_window_only() {
    let (sidecars, directory) = echo_sidecars();
    let (first, first_events) = owner("a", "/projects/a");
    let (second, second_events) = owner("b", "/projects/b");
    sidecars
        .send(&first, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    sidecars
        .send(&second, ECHO, "s2", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    let event = first_events.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(
        (
            event.sidecar.as_str(),
            event.surface.as_str(),
            event.body.get()
        ),
        (ECHO, "s1", r#"{"operation":"open"}"#)
    );
    assert_eq!(
        second_events
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .surface,
        "s2"
    );
    let error = sidecars.send(&second, ECHO, "s1", &raw("{}")).unwrap_err();
    assert!(error.contains("another window"), "{error}");
    sidecars.retain(&first, &|_| false).unwrap();
    sidecars.stop();
    let requests = std::fs::read_to_string(directory.path().join("requests")).unwrap();
    assert_eq!(
        requests,
        concat!(
            r#"{"surface":"s1","root":"/projects/a","body":{"operation":"open"}}"#,
            "\n",
            r#"{"surface":"s2","root":"/projects/b","body":{"operation":"open"}}"#,
            "\n",
            r#"{"surface":"s1","root":"/projects/a","closed":true}"#,
            "\n",
        )
    );
}

// contract: sidecars.protocol.surface-keeps-its-first-root
#[test]
fn a_surface_keeps_the_root_it_was_opened_with() {
    let (sidecars, directory) = echo_sidecars();
    let (before, _before_events) = owner("a", "/projects/a");
    // 같은 창이 다른 프로젝트로 바뀐 뒤에도 이미 열린 표면은 처음 root 로 보낸다.
    let (after, _after_events) = owner("a", "/projects/b");
    sidecars
        .send(&before, ECHO, "s1", &raw(r#"{"operation":"open"}"#))
        .unwrap();
    sidecars
        .send(&after, ECHO, "s1", &raw(r#"{"operation":"input"}"#))
        .unwrap();
    sidecars.retain(&after, &|_| false).unwrap();
    sidecars.stop();
    let requests = std::fs::read_to_string(directory.path().join("requests")).unwrap();
    assert_eq!(
        requests,
        concat!(
            r#"{"surface":"s1","root":"/projects/a","body":{"operation":"open"}}"#,
            "\n",
            r#"{"surface":"s1","root":"/projects/a","body":{"operation":"input"}}"#,
            "\n",
            r#"{"surface":"s1","root":"/projects/a","closed":true}"#,
            "\n",
        )
    );
}

// contract: sidecars.send.rejects-undeclared-sidecar, sidecars.send.rejects-after-stop
#[test]
fn undeclared_and_stopped_sidecars_are_rejected() {
    let (sidecars, _directory) = echo_sidecars();
    let (window, _events) = owner("a", "/projects/a");
    assert!(sidecars
        .send(&window, "other", "s1", &raw("{}"))
        .unwrap_err()
        .contains("not declared"));
    sidecars.stop();
    assert!(sidecars
        .send(&window, ECHO, "s1", &raw("{}"))
        .unwrap_err()
        .contains("stopped"));
}

// contract: sidecars.start.fails-on-missing-executable
#[test]
fn a_missing_executable_fails() {
    let directory = tempfile::tempdir().unwrap();
    let sidecars = create(
        &files(r#"{"executable":"build/echo","protocol":1}"#),
        directory.path(),
    )
    .unwrap();
    let (window, _events) = owner("a", "/");
    let error = sidecars.send(&window, ECHO, "s1", &raw("{}")).unwrap_err();
    assert!(error.contains(&format!("sidecar {ECHO}")), "{error}");
}

// contract: sidecars.declaration.fails-on-missing-sidecar-json
#[test]
fn a_sidecar_without_sidecar_json_fails() {
    let directory = tempfile::tempdir().unwrap();
    let mut files = files(r#"{"executable":"build/echo","protocol":1}"#);
    files.insert(
        "modules/@fixture/plugin/plugin.json",
        r#"{"sidecars":["@fixture/sidecar-missing"]}"#.into(),
    );
    let error = create(&files, directory.path()).err().unwrap();
    assert!(
        error.contains("modules/@fixture/sidecar-missing/sidecar.json"),
        "{error}"
    );
}

// contract: sidecars.declaration.rejects-executable-escaping-package
#[test]
fn an_executable_outside_the_package_fails() {
    let directory = tempfile::tempdir().unwrap();
    let error = create(
        &files(r#"{"executable":"../escape","protocol":1}"#),
        directory.path(),
    )
    .err()
    .unwrap();
    assert!(
        error.contains("modules/@fixture/sidecar-echo/sidecar.json"),
        "{error}"
    );
}

// contract: sidecars.declaration.rejects-absolute-executable
#[test]
fn an_absolute_executable_fails() {
    let directory = tempfile::tempdir().unwrap();
    let error = create(
        &files(r#"{"executable":"/bin/sh","protocol":1}"#),
        directory.path(),
    )
    .err()
    .unwrap();
    assert!(
        error.contains("is not a path inside the package"),
        "{error}"
    );
}

// contract: sidecars.declaration.persistent-requires-config-directory
#[test]
fn persistent_transport_requires_a_config_directory() {
    let directory = tempfile::tempdir().unwrap();
    let fixture = files(r#"{"executable":"build/echo","protocol":1,"transport":"persistent"}"#);
    let error = Sidecars::<FakeOwner>::new(
        &|path| fixture.get(path).map(|value| value.as_bytes().to_vec()),
        directory.path().to_path_buf(),
        std::path::PathBuf::new(),
    )
    .err()
    .unwrap();
    assert!(error.contains("config directory"), "{error}");
}

// contract: sidecars.declaration.fails-on-missing-environment
#[test]
fn a_frontend_without_environment_json_fails() {
    let directory = tempfile::tempdir().unwrap();
    let error = create(&Files::new(), directory.path()).err().unwrap();
    assert!(error.contains("environment.json"), "{error}");
}

// contract: sidecars.declaration.rejects-unsupported-protocol
#[test]
fn an_unsupported_protocol_fails() {
    let directory = tempfile::tempdir().unwrap();
    let error = create(
        &files(r#"{"executable":"build/echo","protocol":2}"#),
        directory.path(),
    )
    .err()
    .unwrap();
    assert!(
        error.contains("modules/@fixture/sidecar-echo/sidecar.json"),
        "{error}"
    );
}

// contract: sidecars.declaration.rejects-unknown-transport
#[test]
fn persistent_transport_rejects_unknown_transport() {
    let directory = tempfile::tempdir().unwrap();
    let error = create(
        &files(r#"{"executable":"build/echo","protocol":1,"transport":"ptyd"}"#),
        directory.path(),
    )
    .err()
    .unwrap();
    assert!(error.contains("transport ptyd is not supported"), "{error}");
}

// contract: sidecars.persistent.accepts-non-canonical-config-directory
#[test]
fn persistent_transport_accepts_a_non_canonical_config_directory() {
    let executable_directory = tempfile::tempdir().unwrap();
    let config_directory = tempfile::tempdir().unwrap();
    let fixture = files(r#"{"executable":"build/echo","protocol":1,"transport":"persistent"}"#);
    let sidecars = Sidecars::new(
        &|path| fixture.get(path).map(|value| value.as_bytes().to_vec()),
        executable_directory.path().to_path_buf(),
        config_directory.path().join("."),
    )
    .unwrap();
    let (window, _events) = owner("a", "/projects/test");
    // 실행 파일이 없으므로 서비스 시작에서 실패하고, 그 전에 설정 디렉터리 아래에 서비스 디렉터리를 만든다.
    let error = sidecars.send(&window, ECHO, "s1", &raw("{}"));
    assert!(error.unwrap_err().contains("sidecar"));
    assert!(
        config_directory
            .path()
            .join("services")
            .join("echo")
            .is_dir(),
        "the service directory is not under the config directory"
    );
}

// contract: sidecars.send.rejects-when-no-plugin-declares-sidecars
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

// contract: sidecars.send.fails-fast-when-sidecar-not-keeping-up, sidecars.send.slow-sidecar-does-not-block-others, sidecars.stop.honors-stop-timeout
#[test]
fn slow_sidecar_does_not_block_other_sends() {
    // 느린 사이드카는 stdin을 읽지 않고, 다른 사이드카는 정상적으로 동작한다.
    // 느린 사이드카에 256번 이상 보내면 언젠가는 "is not keeping up" 오류로 실패한다.
    // 이 테스트는 두 가지 성질을 확인한다:
    // 1. 느린 사이드카 채널이 가득 찼을 때도, 빠른 사이드카로의 send() 는 블로킹되지 않는다.
    // 2. stop() 이 stop_timeout 을 지키고 있다.

    let directory = tempfile::tempdir().unwrap();

    // 느린 사이드카: stdin을 읽지 않지만 stdin EOF에 정상 종료한다.
    let slow_program = directory.path().join("slow");
    std::fs::write(&slow_program, "#!/bin/sh\nexec cat >/dev/null\n").unwrap();
    std::fs::set_permissions(&slow_program, std::fs::Permissions::from_mode(0o755)).unwrap();

    // 빠른 사이드카: 받은 줄을 그대로 출력한다.
    let fast_program = directory.path().join("fast");
    std::fs::write(&fast_program, "#!/bin/sh\ntee /dev/null\n").unwrap();
    std::fs::set_permissions(&fast_program, std::fs::Permissions::from_mode(0o755)).unwrap();

    // 두 사이드카를 선언한 프런트엔드
    let mut files = HashMap::new();
    files.insert(
        "environment.json",
        r#"{"plugins":["@fixture/plugin"]}"#.to_string(),
    );
    files.insert(
        "modules/@fixture/plugin/plugin.json",
        r#"{"sidecars":["@fixture/sidecar-slow","@fixture/sidecar-fast"]}"#.to_string(),
    );
    files.insert(
        "modules/@fixture/sidecar-slow/sidecar.json",
        r#"{"executable":"build/slow","protocol":1}"#.to_string(),
    );
    files.insert(
        "modules/@fixture/sidecar-fast/sidecar.json",
        r#"{"executable":"build/fast","protocol":1}"#.to_string(),
    );

    let mut sidecars = create(&files, directory.path()).unwrap();
    // 테스트를 위해 기한을 100ms로 설정한다.
    sidecars.stop_timeout = Duration::from_millis(100);
    let (owner, _events) = owner("a", "/projects/test");

    // 느린 사이드카에 채널이 가득 찰 때까지 보낸다.
    let large_body = raw(&format!(r#"{{"data":"{}"}}"#, "x".repeat(20 * 1024)));
    let mut last_err = None;
    for i in 0..500 {
        match sidecars.send(&owner, "@fixture/sidecar-slow", "s1", &large_body) {
            Err(e) => {
                last_err = Some(e.clone());
                if e.contains("is not keeping up") {
                    break; // 채널이 가득 찬 것을 확인했다
                }
                panic!("send {}: unexpected error: {}", i, e);
            }
            Ok(()) => {}
        }
    }

    // 마침내 "is not keeping up" 오류를 받았는지 확인한다.
    assert!(
        last_err.is_some() && last_err.as_ref().unwrap().contains("is not keeping up"),
        "want 'is not keeping up', got {:?}",
        last_err
    );

    // 성질 1: 느린 사이드카 채널이 가득 찼을 때도 빠른 사이드카 send() 는 블로킹되지 않는다.
    // send() 는 채널에 넣고 즉시 돌아올 뿐이므로 50ms 미만이어야 한다.
    // (첫 send 는 프로세스 기동을 포함할 수 있으므로, 미리 한 번 보내 프로세스를 띄운 후,
    // 두 번째 send 를 시간 측정한다.)
    let start = std::time::Instant::now();
    sidecars
        .send(
            &owner,
            "@fixture/sidecar-fast",
            "s2",
            &raw(r#"{"data":"test"}"#),
        )
        .unwrap();
    let send_elapsed = start.elapsed();
    assert!(
        send_elapsed < Duration::from_millis(50),
        "fast send took {:?}, want < 50ms",
        send_elapsed
    );

    // 성질 2: stop() 이 stop_timeout(100ms) 을 지키고 있다.
    // 200ms 기한으로 단언하면, 기본 5초와 명확히 구별된다.
    // 이전 코드는 send 와 stop 을 함께 재서 110ms 단언했는데, 이는
    // "OS 가 프로세스를 죽이고 수거하는 데 10ms 이하" 라는 불합리한 주장이었다.
    let start = std::time::Instant::now();
    sidecars.stop();
    let stop_elapsed = start.elapsed();
    assert!(
        stop_elapsed < Duration::from_millis(200),
        "stop() took {:?}, want < 200ms (2 × stop_timeout)",
        stop_elapsed
    );
}

// contract: sidecars.stop.graceful-on-stdin-eof
#[test]
fn stop_graceful_shutdown() {
    // 사이드카가 실제로 stdin 을 읽고 있을 때 stop() 이 stdin EOF 에 의해 정상 종료되는지 검증한다.
    // 측정은 사이드카가 send 의 에코를 받은 뒤 시작해서, 기한(1초)까지 기다리지 않고 즉시 종료되는지 확인한다.

    let directory = tempfile::tempdir().unwrap();

    // 사이드카: 받은 줄을 그대로 에코하고 stdin EOF에 정상 종료한다.
    let graceful_program = directory.path().join("graceful");
    std::fs::write(
        &graceful_program,
        "#!/bin/sh\nwhile read line; do echo \"$line\"; done\nexit 0\n",
    )
    .unwrap();
    std::fs::set_permissions(&graceful_program, std::fs::Permissions::from_mode(0o755)).unwrap();

    let files = HashMap::from([
        (
            "environment.json",
            r#"{"plugins":["@fixture/plugin"]}"#.to_string(),
        ),
        (
            "modules/@fixture/plugin/plugin.json",
            r#"{"sidecars":["@fixture/sidecar-graceful"]}"#.to_string(),
        ),
        (
            "modules/@fixture/sidecar-graceful/sidecar.json",
            r#"{"executable":"build/graceful","protocol":1}"#.to_string(),
        ),
    ]);

    let mut sidecars = create(&files, directory.path()).unwrap();
    // 테스트를 위해 기한을 1초로 설정한다.
    sidecars.stop_timeout = Duration::from_secs(1);
    let (owner, events) = owner("a", "/projects/test");

    // 사이드카를 시작한다.
    sidecars
        .send(
            &owner,
            "@fixture/sidecar-graceful",
            "s1",
            &raw(r#"{"test":"data"}"#),
        )
        .unwrap();

    // 사이드카가 실제로 stdin 을 읽고 있음을 확인한다: 에코 이벤트를 기다린다.
    // 이렇게 하면 shell 프로세스 기동 시간이 측정에 포함되지 않는다.
    let event = events
        .recv_timeout(Duration::from_secs(5))
        .expect("no echo event within 5s");
    assert_eq!(
        (event.sidecar.as_str(), event.surface.as_str()),
        ("@fixture/sidecar-graceful", "s1")
    );

    // 이제 stop() 호출을 시간 측정한다. stdin EOF에 정상 종료되어야 한다.
    let start = std::time::Instant::now();
    sidecars.stop();
    let elapsed = start.elapsed();

    // 정상 종료는 250ms 안에 일어나야 한다 (기한까지 기다리지 않음).
    assert!(
        elapsed < Duration::from_millis(250),
        "graceful stop took {:?}, want < 250ms",
        elapsed
    );
}

// contract: sidecars.stop.kills-after-timeout
#[test]
fn stop_forced_kill() {
    // 기한을 초과해도 종료하지 않는 사이드카를 kill 하는지 검증한다.

    let directory = tempfile::tempdir().unwrap();

    // 사이드카: stdin EOF를 무시하고 계속 실행한다.
    let stubborn_program = directory.path().join("stubborn");
    std::fs::write(&stubborn_program, "#!/bin/sh\ncat >/dev/null &\nwait\n").unwrap();
    std::fs::set_permissions(&stubborn_program, std::fs::Permissions::from_mode(0o755)).unwrap();

    let files = HashMap::from([
        (
            "environment.json",
            r#"{"plugins":["@fixture/plugin"]}"#.to_string(),
        ),
        (
            "modules/@fixture/plugin/plugin.json",
            r#"{"sidecars":["@fixture/sidecar-stubborn"]}"#.to_string(),
        ),
        (
            "modules/@fixture/sidecar-stubborn/sidecar.json",
            r#"{"executable":"build/stubborn","protocol":1}"#.to_string(),
        ),
    ]);

    let mut sidecars = create(&files, directory.path()).unwrap();
    // 테스트를 위해 기한을 100ms로 설정한다.
    sidecars.stop_timeout = Duration::from_millis(100);
    let (owner, _events) = owner("a", "/projects/test");

    // 사이드카를 시작한다.
    sidecars
        .send(
            &owner,
            "@fixture/sidecar-stubborn",
            "s1",
            &raw(r#"{"test":"data"}"#),
        )
        .unwrap();

    // stop() 호출. 기한 후 kill 되어야 한다.
    let start = std::time::Instant::now();
    sidecars.stop();
    let elapsed = start.elapsed();

    // stop()은 기한만큼 기다렸다가 kill 해야 하므로 약 100ms 정도 걸려야 한다.
    // 범위: 80ms ~ 150ms (정확한 시간 측정에 여유를 둠).
    assert!(
        elapsed >= Duration::from_millis(80) && elapsed <= Duration::from_millis(150),
        "forced kill stop took {:?}, want ~100ms",
        elapsed
    );
}
