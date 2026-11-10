//! Checks the contract of sok (docs/spec/cli.md) with a fake endpoint. The endpoint opens a Unix socket, writes endpoint.json,
//! records the requests it receives and returns the specified responses.

use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};

/// The response for a method and params. result is the original JSON, and the response is an error when code is not 0. after is a notification
/// sent after the response, and when close_after is true the endpoint closes the connection after the response (and notifications).
#[derive(Default)]
struct Answer {
    result: String,
    code: i64,
    message: String,
    after: Vec<String>,
    close_after: bool,
}

/// The response function that the fake endpoint calls for each request.
type Respond = Arc<dyn Fn(&str, &Value) -> Answer + Send + Sync>;

fn result(text: &str) -> Answer {
    Answer {
        result: text.into(),
        ..Answer::default()
    }
}

struct Fake {
    config_dir: Folder,
    requests: Arc<Mutex<Vec<Value>>>,
    _socket: Folder,
}

#[path = "support/folder.rs"]
mod folder;

use folder::Folder;

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
    // A Unix socket path is limited to 104 bytes, so the socket lives in a short temporary folder.
    let socket = Folder::new_in(Path::new("/tmp"), "socket");
    let address = socket.path().join("e.sock");
    let listener = UnixListener::bind(&address).expect("listen");
    let config_dir = Folder::new("sok");
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

/// The paths.d location that the path entry check changes.
static PATHS: Mutex<PathBuf> = Mutex::new(PathBuf::new());

fn run(args: &[&str]) -> (i32, String, String) {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let paths = PATHS.lock().expect("paths").clone();
    let options = soksak_sok::Options {
        identifier: "com.soksak.test",
        paths_dir: Ok(&paths),
        core_version: "0.0.2",
    };
    let code = soksak_sok::run(&args, &mut stdout, &mut stderr, &options);
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
    let dir = Folder::new("sok");
    let (code, stdout, stderr) =
        run(&["nothing", "--config-dir", &dir.path().display().to_string()]);
    assert_eq!((code, stdout.as_str()), (2, ""));
    assert!(
        stderr.starts_with("sok: unknown command: nothing\nusage: sok <command>"),
        "{stderr}"
    );
}

/// A standard error that always rejects writes.
struct Unwritable;

impl std::io::Write for Unwritable {
    fn write(&mut self, _bytes: &[u8]) -> std::io::Result<usize> {
        Err(std::io::Error::other("standard error is closed"))
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

// contract: cli.error.unwritable-stderr-exits-3
#[test]
fn an_error_that_cannot_be_written_exits_with_status_3() {
    let dir = Folder::new("sok");
    let args: Vec<String> = ["nothing", "--config-dir", &dir.path().display().to_string()]
        .iter()
        .map(|arg| arg.to_string())
        .collect();
    let paths = PATHS.lock().expect("paths").clone();
    let options = soksak_sok::Options {
        identifier: "com.soksak.test",
        paths_dir: Ok(&paths),
        core_version: "0.0.2",
    };
    let mut stdout = Vec::new();
    assert_eq!(
        soksak_sok::run(&args, &mut stdout, &mut Unwritable, &options),
        3
    );
}

// contract: cli.endpoint.missing-file-reports-not-running
#[test]
fn missing_endpoint_reports_the_application_is_not_running() {
    let dir = Folder::new("sok");
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
    let cases: [(&[&str], &str, &str); 9] = [
        (
            &["status", "core.screen", "--surface", "tab-1"],
            "status.get",
            r#"{"name":"core.screen","surface":"tab-1","window":"main"}"#,
        ),
        (&["exposures"], "exposure.list", r#"{"window":"main"}"#),
        (
            &["element", "rect", "core.card", "--index", "2"],
            "element.rect",
            r#"{"index":2,"name":"core.card","window":"main"}"#,
        ),
        (
            &["element", "input", "fixture.input", "--value", "ls"],
            "element.act",
            r#"{"action":"input","name":"fixture.input","value":"ls","window":"main"}"#,
        ),
        (
            &[
                "element",
                "dispatch",
                "x.y",
                "--event",
                r#"{"type":"keydown","key":"a"}"#,
            ],
            "element.act",
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
                "input", "pointer", "--x", "1", "--y", "2", "--phase", "down", "--clicks", "2",
            ],
            "input.pointer",
            r#"{"clicks":2,"phase":"down","window":"main","x":1,"y":2}"#,
        ),
        (
            &[
                "input",
                "pointer",
                "--pointer",
                "second",
                "--x",
                "3",
                "--y",
                "4",
                "--phase",
                "drag",
            ],
            "input.pointer",
            r#"{"phase":"drag","pointer":"second","window":"main","x":3,"y":4}"#,
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

// contract: cli.diagnostics.capture-only-in-diagnostic-builds
#[cfg(feature = "diagnostics")]
#[test]
fn capture_requests_a_still_image_in_a_diagnostic_build() {
    let fake = start(|method, _| {
        if method == "windows.list" {
            result(ONE_WINDOW)
        } else {
            result("null")
        }
    });
    let dir = fake.dir();
    let (code, stdout, stderr) = run(&["capture", "--config-dir", &dir]);
    assert_eq!((code, stdout.as_str()), (0, "null\n"), "{stderr}");
    assert_eq!(
        fake.methods().last().expect("a method"),
        "diagnostics.capture.still"
    );
    assert_eq!(fake.last().to_string(), r#"{"window":"main"}"#);
}

// contract: cli.diagnostics.capture-only-in-diagnostic-builds
#[cfg(not(feature = "diagnostics"))]
#[test]
fn capture_needs_a_diagnostic_build() {
    let dir = Folder::new("sok");
    let (code, stdout, stderr) =
        run(&["capture", "--config-dir", &dir.path().display().to_string()]);
    assert_eq!((code, stdout.as_str()), (2, ""));
    assert!(
        stderr.starts_with("sok: capture needs a diagnostic build of sok\n"),
        "{stderr}"
    );
}

// contract: cli.window.several-windows-need-selection, cli.window.project-selects-by-canonical-folder
#[test]
fn several_windows_need_selection() {
    let project = Folder::new("sok");
    let links = Folder::new("sok");
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
    // The test reads the configuration folder of the environment and changes no variable of the process, whose tests run
    // in parallel threads; the identifier of the test has no endpoint in that folder.
    let base = soksak_sok::platform::current()
        .expect("platform")
        .config_dir()
        .expect("configuration directory");
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

/// A fake endpoint that reports one declared command. exposure.list returns that command, and command.run returns the parameters it received.
fn declared() -> Fake {
    let exposures = concat!(
        r#"{"status":[],"commands":[{"name":"fixture.do","description":"d","params":{"type":"object","properties":{"#,
        r#""text":{"type":"string"},"count":{"type":"number"},"whole":{"type":"integer"},"flag":{"type":"boolean"},"#,
        r#""choice":{"enum":["one","two"]},"maybe":{"type":["string","null"]},"object":{"type":"object"},"list":{"type":"array"}}},"#,
        r#""result":{"type":"object"}},{"name":"fixture.none","description":"n","params":{"type":"object","properties":{}}}],"element":[]}"#
    );
    start(move |method, params| match method {
        "windows.list" => result(ONE_WINDOW),
        "exposure.list" => result(exposures),
        "command.run" => result(&params.to_string()),
        _ => Answer {
            code: -32601,
            message: format!("unexpected {method}"),
            ..Answer::default()
        },
    })
}

// contract: cli.command.host-command-without-page
#[test]
fn a_host_command_is_checked_against_the_host_entries_without_the_page() {
    let host = r#"{"status":[],"commands":[{"name":"host.quit","description":"q","params":{"type":"object","properties":{}},"registered":true}],"element":[]}"#;
    let fake = start(move |method, params| match method {
        "windows.list" => result(ONE_WINDOW),
        "exposure.list" if params["owner"] == "host" => result(host),
        "exposure.list" => Answer {
            code: 1003,
            message: "the main page is not ready".into(),
            ..Answer::default()
        },
        "command.run" => result("null"),
        _ => Answer {
            code: -32601,
            message: format!("unexpected {method}"),
            ..Answer::default()
        },
    });
    let dir = fake.dir();
    let (code, _, stderr) = run(&["host.quit", "--config-dir", &dir]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(
        fake.last().to_string(),
        r#"{"name":"host.quit","params":{},"window":"main"}"#
    );
}

// contract: cli.command.flags-from-schema
#[test]
fn declared_command_flags_follow_the_schema() {
    let fake = declared();
    let dir = fake.dir();
    let (code, stdout, stderr) = run(&[
        "fixture.do",
        "--text=--x",
        "--count=1.5",
        "--whole",
        "3",
        "--flag",
        "--choice",
        "two",
        "--maybe",
        "null",
        "--object",
        r#"{"a":1}"#,
        "--list",
        "[1]",
        "--surface",
        "tab-1",
        "--config-dir",
        &dir,
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(
        fake.last().to_string(),
        r#"{"name":"fixture.do","params":{"choice":"two","count":1.5,"flag":true,"list":[1],"maybe":null,"object":{"a":1},"text":"--x","whole":3},"surface":"tab-1","window":"main"}"#
    );
    assert!(
        stdout.starts_with("{\n  \"name\": \"fixture.do\""),
        "{stdout}"
    );
    let (code, _, stderr) = run(&[
        "fixture.do",
        "--params",
        r#"{"text":"x"}"#,
        "--config-dir",
        &dir,
    ]);
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(
        fake.last().to_string(),
        r#"{"name":"fixture.do","params":{"text":"x"},"window":"main"}"#
    );
}

// contract: cli.command.rejects-undeclared-or-invalid-values
#[test]
fn declared_command_rejects_bad_flags_before_sending() {
    let fake = declared();
    let dir = fake.dir();
    let cases: [(&str, &[&str]); 9] = [
        (
            "sok: --nope is not a parameter of fixture.do; its parameters are choice, count, flag, list, maybe, object, text, whole\n",
            &["fixture.do", "--nope", "1"],
        ),
        (
            "sok: --choice must be one of one, two\n",
            &["fixture.do", "--choice", "three"],
        ),
        (
            "sok: --whole must be integer\n",
            &["fixture.do", "--whole", "1.5"],
        ),
        (
            "sok: --count must be number\n",
            &["fixture.do", "--count", "x"],
        ),
        (
            "sok: --object must be object\n",
            &["fixture.do", "--object", "[1]"],
        ),
        (
            "sok: unexpected argument yes\n",
            &["fixture.do", "--flag", "yes"],
        ),
        ("sok: --text needs a value\n", &["fixture.do", "--text"]),
        (
            "sok: --params gives the whole parameter object and cannot be combined with parameter flags\n",
            &["fixture.do", "--params", "{}", "--text", "x"],
        ),
        (
            "sok: fixture.gone is not a declared command of window main; sok commands lists them\n",
            &["fixture.gone"],
        ),
    ];
    for (want, args) in cases {
        let mut all = args.to_vec();
        all.extend(["--config-dir", &dir]);
        let (code, stdout, stderr) = run(&all);
        assert_eq!((code, stdout.as_str()), (2, ""), "{args:?}: {stderr}");
        assert!(stderr.starts_with(want), "{args:?}: {stderr}");
    }
    assert!(
        !fake.methods().iter().any(|method| method == "command.run"),
        "a rejected command was sent: {:?}",
        fake.methods()
    );
}

// contract: cli.commands.lists-declared-commands
#[test]
fn commands_lists_the_declared_commands_in_order() {
    let fake = declared();
    let (code, stdout, stderr) = run(&["commands", "--config-dir", &fake.dir()]);
    assert_eq!(code, 0, "{stderr}");
    let commands: Vec<Value> = serde_json::from_str(&stdout).expect("a JSON list");
    let names: Vec<&str> = commands
        .iter()
        .map(|command| command["name"].as_str().expect("name"))
        .collect();
    assert_eq!(names, ["fixture.do", "fixture.none"]);
}

// contract: cli.path.writes-and-removes-the-entry
#[test]
fn path_install_writes_the_executable_directory_and_remove_deletes_it() {
    let paths = Folder::new("sok");
    *PATHS.lock().expect("paths") = paths.path().to_path_buf();
    let directory = std::env::current_exe()
        .expect("exe")
        .canonicalize()
        .expect("canonical")
        .parent()
        .expect("dir")
        .display()
        .to_string();
    let entry = paths.path().join("com.soksak.test");
    for _ in 0..2 {
        let (code, stdout, stderr) = run(&["path", "install"]);
        let want = format!(
            "{{\n  \"directory\": {:?},\n  \"path\": {:?}\n}}\n",
            directory,
            entry.display().to_string()
        );
        assert_eq!((code, stdout.as_str()), (0, want.as_str()), "{stderr}");
        assert_eq!(
            std::fs::read_to_string(&entry).expect("entry"),
            format!("{directory}\n")
        );
    }
    for _ in 0..2 {
        let (code, stdout, stderr) = run(&["path", "remove"]);
        assert_eq!((code, stdout.as_str()), (0, "null\n"), "{stderr}");
    }
    assert!(!entry.exists(), "the entry remains");
    let missing = paths.path().join("missing");
    *PATHS.lock().expect("paths") = missing.clone();
    let (code, _, stderr) = run(&["path", "install"]);
    assert_eq!(code, 1);
    assert!(
        stderr.starts_with(&format!(
            "sok: cannot write {}: ",
            missing.join("com.soksak.test").display()
        )),
        "{stderr}"
    );
    assert!(
        stderr.ends_with("; run sudo sok path install\n"),
        "{stderr}"
    );
    *PATHS.lock().expect("paths") = PathBuf::new();
}

// contract: cli.path.fails-without-a-path-entry-folder
#[test]
fn path_entries_fail_where_the_operating_system_has_no_folder() {
    let args = vec!["path".to_string(), "install".to_string()];
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let options = soksak_sok::Options {
        identifier: "com.soksak.test",
        paths_dir: Err("path entries are not implemented on linux".to_string()),
        core_version: "0.0.2",
    };
    let code = soksak_sok::run(&args, &mut stdout, &mut stderr, &options);
    assert_eq!(
        (
            code,
            String::from_utf8(stdout).expect("stdout"),
            String::from_utf8(stderr).expect("stderr")
        ),
        (
            1,
            String::new(),
            "sok: path entries are not implemented on linux\n".to_string()
        )
    );
}

// contract: cli.identity.build-identifier
#[test]
fn the_build_identifier_follows_the_dev_feature() {
    // A debug build sets dev and runs beside the installed application; a diagnostic release without dev reads the
    // configuration folder of the installed application.
    if cfg!(feature = "dev") {
        assert_eq!(soksak_sok::identity::identity(), "app.soksak.tauri.dev");
    } else {
        assert_eq!(soksak_sok::identity::identity(), "app.soksak.tauri");
    }
}

// The producer of a watch that ends sends status.ended, and the watch ends with exit status 1 and the error that names the
// status and the reason (docs/spec/exposure.md#methods).
// contract: endpoint.status.ended-ends-a-watch
#[test]
fn a_watch_ends_at_status_ended() {
    let changed = r#"{"jsonrpc":"2.0","method":"status.changed","params":{"window":"main","name":"core.screen","surface":"tab-1","value":2}}"#;
    let other = r#"{"jsonrpc":"2.0","method":"status.ended","params":{"window":"main","name":"core.other","surface":"tab-1","reason":"surface-closed"}}"#;
    let ended = r#"{"jsonrpc":"2.0","method":"status.ended","params":{"window":"main","name":"core.screen","surface":"tab-1","reason":"surface-closed"}}"#;
    let fake = start(move |method, _| match method {
        "status.watch" => result("null"),
        "status.get" => Answer {
            result: "1".into(),
            after: vec![changed.into(), other.into(), ended.into()],
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
        "--surface",
        "tab-1",
        "--watch",
        "--config-dir",
        &fake.dir(),
    ]);
    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (1, "1\n2\n", "sok: status core.screen ended: surface-closed\n")
    );
}

// A gesture sends down at the first point, a drag to each later point and up at the last point on one connection, and one
// point is a click (docs/spec/cli.md).
#[test]
fn a_gesture_sends_one_press_on_one_connection() {
    let fake = start(|method, _| {
        if method == "windows.list" {
            result(ONE_WINDOW)
        } else {
            result("null")
        }
    });
    let dir = fake.dir();
    let (code, stdout, stderr) = run(&[
        "input",
        "gesture",
        "--pointer",
        "second",
        "--button",
        "right",
        "--points",
        "1,2;3.5,4;5,6",
        "--config-dir",
        &dir,
    ]);
    assert_eq!((code, stdout.as_str()), (0, ""), "{stderr}");
    let requests = fake.requests.lock().expect("requests").clone();
    let steps: Vec<String> = requests
        .iter()
        .filter(|request| request["method"] == "input.pointer")
        .map(|request| request["params"].to_string())
        .collect();
    assert_eq!(
        steps,
        [
            r#"{"button":"right","phase":"down","pointer":"second","window":"main","x":1,"y":2}"#,
            r#"{"button":"right","phase":"drag","pointer":"second","window":"main","x":3.5,"y":4}"#,
            r#"{"button":"right","phase":"drag","pointer":"second","window":"main","x":5,"y":6}"#,
            r#"{"button":"right","phase":"up","pointer":"second","window":"main","x":5,"y":6}"#,
        ]
    );
    // windows.list chose the window on the same connection, so every step has the id that follows the one before.
    let ids: Vec<u64> = requests
        .iter()
        .map(|request| request["id"].as_u64().expect("id"))
        .collect();
    assert_eq!(ids, [1, 2, 3, 4, 5], "the gesture used more than one connection");

    let (code, _, stderr) = run(&[
        "input", "gesture", "--clicks", "2", "--points", "7,8", "--config-dir", &dir,
    ]);
    assert_eq!(code, 0, "{stderr}");
    let requests = fake.requests.lock().expect("requests").clone();
    let click: Vec<String> = requests[requests.len() - 2..]
        .iter()
        .map(|request| request["params"].to_string())
        .collect();
    assert_eq!(
        click,
        [
            r#"{"clicks":2,"phase":"down","window":"main","x":7,"y":8}"#,
            r#"{"clicks":2,"phase":"up","window":"main","x":7,"y":8}"#,
        ]
    );

    let (code, _, stderr) = run(&["input", "gesture", "--points", "1;2", "--config-dir", &dir]);
    assert_eq!(code, 2, "{stderr}");
    assert!(
        stderr.starts_with("sok: --points must be x,y pairs separated by ;\n"),
        "{stderr}"
    );
}

// A step of a gesture that fails ends the command with its number and its error, and no later step is sent.
#[test]
fn a_failed_gesture_step_ends_the_command() {
    let fake = start(|method, params| match method {
        "windows.list" => result(ONE_WINDOW),
        "input.pointer" if params["phase"] == "drag" => Answer {
            code: 1007,
            message: "a mouse button is pressed".into(),
            ..Answer::default()
        },
        _ => result("null"),
    });
    let (code, stdout, stderr) = run(&[
        "input",
        "gesture",
        "--points",
        "1,2;3,4",
        "--config-dir",
        &fake.dir(),
    ]);
    assert_eq!(
        (code, stdout.as_str(), stderr.as_str()),
        (1, "", "sok: gesture step 2: a mouse button is pressed (1007)\n")
    );
    assert_eq!(
        fake.methods(),
        ["windows.list", "input.pointer", "input.pointer"]
    );
}

/// The child of the interrupt check: the executable sok with its standard output on a pipe.
struct Watching {
    pid: String,
    ended: bool,
}

impl Drop for Watching {
    fn drop(&mut self) {
        // A child that did not end by itself is ended, so a failed check leaves no process.
        if self.ended {
            return;
        }
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &self.pid])
            .stderr(std::process::Stdio::null())
            .status();
    }
}

// SIGTERM ends a watch while the command waits in a write to its standard output: the routine of the signal closes the
// connection, stores the command and ends the process with status 0 (docs/spec/cli.md).
#[test]
fn an_interrupt_ends_a_watch_that_waits_in_a_write() {
    // The value is larger than any pipe buffer, so its write waits for a reader that never reads it all.
    let big = format!(
        r#"{{"jsonrpc":"2.0","method":"status.changed","params":{{"window":"main","name":"core.screen","value":"{}"}}}}"#,
        "x".repeat(4 << 20)
    );
    let fake = start(move |method, _| match method {
        "status.watch" => result("null"),
        "status.get" => Answer {
            result: "1".into(),
            after: vec![big.clone()],
            ..Answer::default()
        },
        _ => Answer {
            code: -32601,
            message: format!("unexpected {method}"),
            ..Answer::default()
        },
    });
    std::fs::write(
        fake.config_dir.path().join("log-policy.json"),
        r#"{"schema":1,"classes":{"lifecycle":"debug","input":"debug","call":"debug","io":"debug","frame":"debug"}}"#,
    )
    .expect("log-policy.json");
    let child = std::process::Command::new(env!("CARGO_BIN_EXE_sok"))
        .args([
            "status",
            "core.screen",
            "--window",
            "main",
            "--watch",
            "--config-dir",
            &fake.dir(),
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("sok starts");
    let mut child = child;
    let mut watching = Watching {
        pid: child.id().to_string(),
        ended: false,
    };
    let mut stdout = child.stdout.take().expect("stdout");
    // The first line is the value, and the first byte after it is the start of the write of the large value, which
    // cannot end before the pipe is read.
    let mut seen = Vec::new();
    let mut byte = [0u8; 1];
    while seen.len() < 3 {
        stdout.read_exact(&mut byte).expect("the watch printed");
        seen.push(byte[0]);
    }
    assert_eq!(seen, b"1\n\"");
    let pid = watching.pid.clone();
    let signal = std::process::Command::new("kill")
        .args(["-TERM", &pid])
        .status()
        .expect("kill runs");
    assert!(signal.success(), "kill -TERM {pid} failed");
    // The pipe stays unread while sok ends, so its write still waits. A sok that does not end leaves the test to the limit of
    // its runner, which reports the stall.
    let status = child.wait().expect("wait");
    watching.ended = true;
    drop(stdout);
    assert_eq!(status.code(), Some(0), "sok ended with {status:?}");
    let logs = fake.config_dir.path().join("logs");
    let stored = std::fs::read_dir(&logs)
        .expect("logs")
        .map(|entry| entry.expect("entry").path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "jsonl"))
        .map(|path| std::fs::read_to_string(path).expect("log file"))
        .any(|text| {
            text.lines().any(|line| {
                let event: Value = serde_json::from_str(line).expect("event line");
                event["event"] == "sok.command" && event["fields"]["status"] == 0
            })
        });
    assert!(stored, "no sok.command with status 0 in {}", logs.display());
}
