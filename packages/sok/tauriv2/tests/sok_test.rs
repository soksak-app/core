//! sok 의 계약(docs/spec/cli.md)을 가짜 엔드포인트로 검사한다. 엔드포인트는 Unix socket 을 열고 endpoint.json 을
//! 쓰며, 받은 요청을 기록하고 정한 응답을 돌려준다.

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

/// method 와 params 에 대한 응답. result 는 원래 JSON 이고, code 가 0 이 아니면 오류 응답이다. after 는 응답 뒤에
/// 보낼 알림이고, close_after 가 참이면 응답(과 알림) 뒤에 연결을 닫는다.
#[derive(Default)]
struct Answer {
    result: String,
    code: i64,
    message: String,
    after: Vec<String>,
    close_after: bool,
}

/// 가짜 엔드포인트가 요청마다 부르는 응답 함수.
type Respond = Arc<dyn Fn(&str, &Value) -> Answer + Send + Sync>;

fn result(text: &str) -> Answer {
    Answer {
        result: text.into(),
        ..Answer::default()
    }
}

struct Fake {
    config_dir: tempfile_dir::Dir,
    requests: Arc<Mutex<Vec<Value>>>,
    _socket: tempfile_dir::Dir,
}

/// 테스트가 끝나면 지우는 임시 폴더. 외부 crate 없이 std 로 만든다.
mod tempfile_dir {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    pub struct Dir(PathBuf);

    impl Dir {
        pub fn new(base: &Path) -> Dir {
            let path = base.join(format!(
                "sok{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&path).expect("create temporary directory");
            Dir(path)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            // 테스트 뒤 정리다. 지우지 못한 폴더는 다음 테스트에 영향을 주지 않는 고유 이름이다.
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

fn write_frame(stream: &mut UnixStream, body: &[u8]) {
    let mut frame = (body.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(body);
    stream.write_all(&frame).expect("write frame");
}

fn serve(mut stream: UnixStream, requests: Arc<Mutex<Vec<Value>>>, respond: Respond) {
    loop {
        let mut header = [0u8; 4];
        if stream.read_exact(&mut header).is_err() {
            return;
        }
        let mut body = vec![0u8; u32::from_be_bytes(header) as usize];
        if stream.read_exact(&mut body).is_err() {
            return;
        }
        let request: Value = serde_json::from_slice(&body).expect("request JSON");
        requests.lock().expect("requests").push(request.clone());
        let answer = respond(
            request["method"].as_str().expect("method"),
            &request["params"],
        );
        let id = request["id"].clone();
        let reply = if answer.code != 0 {
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": answer.code, "message": answer.message}}).to_string()
        } else {
            format!(
                r#"{{"jsonrpc":"2.0","id":{id},"result":{}}}"#,
                answer.result
            )
        };
        write_frame(&mut stream, reply.as_bytes());
        for notification in &answer.after {
            write_frame(&mut stream, notification.as_bytes());
        }
        if answer.close_after {
            return;
        }
    }
}

fn start(respond: impl Fn(&str, &Value) -> Answer + Send + Sync + 'static) -> Fake {
    // Unix socket 경로는 104 바이트로 제한되므로 짧은 임시 폴더에 둔다.
    let socket = tempfile_dir::Dir::new(Path::new("/tmp"));
    let address = socket.path().join("e.sock");
    let listener = UnixListener::bind(&address).expect("listen");
    let config_dir = tempfile_dir::Dir::new(&std::env::temp_dir());
    let endpoint = json!({"transport": "unix", "address": address, "pid": std::process::id()});
    std::fs::write(
        config_dir.path().join("endpoint.json"),
        endpoint.to_string(),
    )
    .expect("endpoint.json");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let respond: Respond = Arc::new(respond);
    let recorded = requests.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            let (requests, respond) = (recorded.clone(), respond.clone());
            std::thread::spawn(move || serve(stream, requests, respond));
        }
    });
    Fake {
        config_dir,
        requests,
        _socket: socket,
    }
}

impl Fake {
    fn dir(&self) -> String {
        self.config_dir.path().display().to_string()
    }

    fn methods(&self) -> Vec<String> {
        self.requests
            .lock()
            .expect("requests")
            .iter()
            .map(|request| request["method"].as_str().expect("method").to_string())
            .collect()
    }

    fn last(&self) -> Value {
        self.requests
            .lock()
            .expect("requests")
            .last()
            .expect("a request")["params"]
            .clone()
    }
}

fn run(args: &[&str]) -> (i32, String, String) {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let code = soksak_sok::run(&args, &mut stdout, &mut stderr, "com.soksak.test");
    (
        code,
        String::from_utf8(stdout).expect("stdout"),
        String::from_utf8(stderr).expect("stderr"),
    )
}

const ONE_WINDOW: &str =
    r#"[{"window":"main","title":"t","project":null,"key":false,"ready":true}]"#;

// contract: cli.usage.unknown-command-exits-2
#[test]
fn unknown_command_exits_with_usage() {
    let dir = tempfile_dir::Dir::new(&std::env::temp_dir());
    let (code, stdout, stderr) =
        run(&["nothing", "--config-dir", &dir.path().display().to_string()]);
    assert_eq!((code, stdout.as_str()), (2, ""));
    assert!(
        stderr.starts_with("sok: unknown command: nothing\nusage: sok <command>"),
        "{stderr}"
    );
}

// contract: cli.endpoint.missing-file-reports-not-running
#[test]
fn missing_endpoint_reports_the_application_is_not_running() {
    let dir = tempfile_dir::Dir::new(&std::env::temp_dir());
    let (code, _, stderr) = run(&["windows", "--config-dir", &dir.path().display().to_string()]);
    assert_eq!(code, 1);
    assert_eq!(
        stderr,
        format!(
            "sok: {} does not exist; the application is not running\n",
            dir.path().join("endpoint.json").display()
        )
    );
}

// contract: cli.output.indents-result-keeping-key-order
#[test]
fn result_is_indented_in_the_endpoint_key_order() {
    let fake = start(|_, _| {
        result(r#"{"zeta":1,"alpha":[],"mid":{"b":true,"a":null},"list":[1,"x"],"empty":{}}"#)
    });
    let (code, stdout, stderr) = run(&["windows", "--config-dir", &fake.dir()]);
    let want = "{\n  \"zeta\": 1,\n  \"alpha\": [],\n  \"mid\": {\n    \"b\": true,\n    \"a\": null\n  },\n  \"list\": [\n    1,\n    \"x\"\n  ],\n  \"empty\": {}\n}\n";
    assert_eq!((code, stdout.as_str()), (0, want), "{stderr}");
}

// contract: cli.window.single-window-is-default, cli.requests.carry-command-parameters
#[test]
fn the_only_window_is_used_and_parameters_are_sent() {
    let fake = start(|method, _| {
        if method == "windows.list" {
            result(ONE_WINDOW)
        } else {
            result("null")
        }
    });
    let cases: [(&[&str], &str, &str); 8] = [
        (
            &["status", "core.screen", "--surface", "tab-1"],
            "status.get",
            r#"{"name":"core.screen","surface":"tab-1","window":"main"}"#,
        ),
        (&["exposures"], "exposure.list", r#"{"window":"main"}"#),
        (
            &["capture"],
            "diagnostics.capture.still",
            r#"{"window":"main"}"#,
        ),
        (
            &["dom", "rect", "core.card", "--index", "2"],
            "dom.rect",
            r#"{"index":2,"name":"core.card","window":"main"}"#,
        ),
        (
            &["dom", "input", "fixture.input", "--value", "ls"],
            "dom.act",
            r#"{"action":"input","name":"fixture.input","value":"ls","window":"main"}"#,
        ),
        (
            &[
                "dom",
                "dispatch",
                "x.y",
                "--event",
                r#"{"type":"keydown","key":"a"}"#,
            ],
            "dom.act",
            r#"{"action":"dispatch","event":{"key":"a","type":"keydown"},"name":"x.y","window":"main"}"#,
        ),
        (
            &[
                "input",
                "pointer",
                "--x",
                "1.5",
                "--y",
                "2",
                "--phase",
                "move",
                "--activate",
            ],
            "input.pointer",
            r#"{"activate":true,"phase":"move","window":"main","x":1.5,"y":2}"#,
        ),
        (
            &[
                "input",
                "key",
                "--key",
                "a",
                "--phase",
                "down",
                "--modifiers",
                "shift,,command",
            ],
            "input.key",
            r#"{"key":"a","modifiers":["shift","command"],"phase":"down","window":"main"}"#,
        ),
    ];
    for (args, method, params) in cases {
        let dir = fake.dir();
        let mut all: Vec<&str> = args.to_vec();
        all.extend(["--config-dir", &dir]);
        let (code, stdout, stderr) = run(&all);
        assert_eq!((code, stdout.as_str()), (0, "null\n"), "{args:?}: {stderr}");
        assert_eq!(fake.methods().last().expect("a method"), method, "{args:?}");
        assert_eq!(fake.last().to_string(), params, "{args:?}");
    }
}

// contract: cli.window.several-windows-need-selection, cli.window.project-selects-by-canonical-folder
#[test]
fn several_windows_need_selection() {
    let project = tempfile_dir::Dir::new(&std::env::temp_dir());
    let links = tempfile_dir::Dir::new(&std::env::temp_dir());
    let alias: PathBuf = links.path().join("alias");
    std::os::unix::fs::symlink(project.path(), &alias).expect("alias");
    let windows = json!([{"window": "main", "project": null}, {"window": "project-a", "project": project.path()}]).to_string();
    let fake = start(move |method, _| {
        if method == "windows.list" {
            result(&windows)
        } else {
            result(r#""ok""#)
        }
    });
    let (code, _, stderr) = run(&["status", "core.screen", "--config-dir", &fake.dir()]);
    assert_eq!(code, 2);
    assert!(stderr.starts_with("sok: the application has 2 windows (main, project-a); select one with --window or --project\n"), "{stderr}");
    let (code, stdout, stderr) = run(&[
        "status",
        "core.screen",
        "--project",
        &alias.display().to_string(),
        "--config-dir",
        &fake.dir(),
    ]);
    assert_eq!((code, stdout.as_str()), (0, "\"ok\"\n"), "{stderr}");
    assert_eq!(fake.last()["window"], "project-a");
    let (code, _, stderr) = run(&[
        "status",
        "core.screen",
        "--window",
        "main",
        "--project",
        &project.path().display().to_string(),
        "--config-dir",
        &fake.dir(),
    ]);
    assert_eq!(code, 2);
    assert!(
        stderr.starts_with("sok: --window and --project select the window in two ways; give one\n"),
        "{stderr}"
    );
}

// contract: cli.error.reports-endpoint-code
#[test]
fn endpoint_errors_carry_their_code() {
    let fake = start(|_, _| Answer {
        code: 1003,
        message: "page entries are not ready".into(),
        ..Answer::default()
    });
    let (code, stdout, stderr) = run(&[
        "status",
        "core.screen",
        "--window",
        "main",
        "--config-dir",
        &fake.dir(),
    ]);
    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (1, "", "sok: page entries are not ready (1003)\n")
    );
}

// contract: cli.status.watch-prints-value-and-changes
#[test]
fn watch_prints_the_value_and_each_change() {
    let changed = |name: &str, value: &str| {
        format!(
            r#"{{"jsonrpc":"2.0","method":"status.changed","params":{{"window":"main","name":"{name}","value":{value}}}}}"#
        )
    };
    let after = vec![
        changed("other", "1"),
        changed("core.screen", r#"{"screen": "workspace"}"#),
    ];
    let fake = start(move |method, _| match method {
        "status.watch" => result("null"),
        "status.get" => Answer {
            result: r#"{"screen": "library"}"#.into(),
            after: after.clone(),
            close_after: true,
            ..Answer::default()
        },
        _ => Answer {
            code: -32601,
            message: format!("unexpected {method}"),
            ..Answer::default()
        },
    });
    let (code, stdout, stderr) = run(&[
        "status",
        "core.screen",
        "--window",
        "main",
        "--watch",
        "--config-dir",
        &fake.dir(),
    ]);
    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (
            1,
            "{\"screen\":\"library\"}\n{\"screen\":\"workspace\"}\n",
            "sok: endpoint connection closed\n"
        )
    );
    assert_eq!(fake.methods(), ["status.watch", "status.get"]);
}

// contract: cli.config-dir.default-uses-application-identifier
#[test]
fn the_default_configuration_directory_is_the_applications() {
    let home = tempfile_dir::Dir::new(&std::env::temp_dir());
    // 이 테스트만 HOME 을 바꾼다. 다른 테스트는 --config-dir 을 주므로 HOME 을 읽지 않는다.
    std::env::set_var("HOME", home.path());
    std::env::remove_var("XDG_CONFIG_HOME");
    let base = if cfg!(target_os = "macos") {
        home.path().join("Library/Application Support")
    } else {
        home.path().join(".config")
    };
    let (code, _, stderr) = run(&["windows"]);
    assert_eq!(code, 1);
    assert_eq!(
        stderr,
        format!(
            "sok: {} does not exist; the application is not running\n",
            base.join("com.soksak.test/endpoint.json").display()
        )
    );
}
