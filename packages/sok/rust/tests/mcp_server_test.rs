//! Checks the MCP server `sok mcp` (docs/spec/cli.md#mcp-server) over real pipes. Each test starts the built sok as `sok mcp` with a
//! test home and the environment of its case, plays the endpoint frames of an mcp-* case of docs/spec/cases/endpoint with the case
//! player, and runs the mcp steps of the case: the MCP messages, the tool calls with the results and errors that the case states,
//! and the waits on the endpoint and on the standard error of the server. The Go test (packages/sok/go/tests/mcp_server_test.go)
//! runs the same cases.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

#[path = "support/folder.rs"]
mod folder;

#[path = "support/case_player.rs"]
mod case_player;

use case_player::{CasePlayer, play_case_in};
use folder::Folder;

/// The bound of a wait for a message or a line of the server.
const WAIT_LIMIT: Duration = Duration::from_secs(30);

/// What the readers of the server have read.
#[derive(Default)]
struct Read {
    responses: HashMap<String, Value>,
    stderr: Vec<String>,
    /// Lines of the standard output that are no JSON message.
    invalid: Vec<String>,
    ended: bool,
}

/// One running `sok mcp` with its standard streams.
struct Session {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    next_id: u64,
    read: Arc<(Mutex<Read>, Condvar)>,
    readers: Vec<JoinHandle<()>>,
}

impl Session {
    /// Starts the built sok as `sok mcp` with args, the home of the test, PATH and the variables of the case; no other variable
    /// of the test process reaches it.
    fn start(args: &[String], home: &Path, environment: &[(String, String)]) -> Session {
        let mut command = Command::new(env!("CARGO_BIN_EXE_sok"));
        command
            .arg("mcp")
            .args(args)
            .env_clear()
            .env("HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(path) = std::env::var_os("PATH") {
            command.env("PATH", path);
        }
        for (name, value) in environment {
            command.env(name, value);
        }
        let mut child = command.spawn().expect("start sok mcp");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");
        let read: Arc<(Mutex<Read>, Condvar)> = Arc::default();
        let mut readers = Vec::new();
        let shared = read.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let line = line.expect("read the standard output of sok mcp");
                let (lock, signal) = &*shared;
                let mut read = lock.lock().expect("the read state");
                match serde_json::from_str::<Value>(&line) {
                    Ok(message) => {
                        let id = message["id"].to_string();
                        read.responses.insert(id, message);
                    }
                    Err(_) => read.invalid.push(line),
                }
                signal.notify_all();
            }
            let (lock, signal) = &*shared;
            lock.lock().expect("the read state").ended = true;
            signal.notify_all();
        }));
        let shared = read.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let line = line.expect("read the standard error of sok mcp");
                let (lock, signal) = &*shared;
                lock.lock().expect("the read state").stderr.push(line);
                signal.notify_all();
            }
        }));
        Session {
            child: Some(child),
            stdin,
            next_id: 1,
            read,
            readers,
        }
    }

    /// Writes one message.
    fn send(&mut self, message: &Value) {
        if let Some(id) = message["id"].as_u64()
            && id >= self.next_id
        {
            self.next_id = id + 1;
        }
        let mut line = message.to_string();
        line.push('\n');
        self.stdin
            .as_mut()
            .expect("the standard input is open")
            .write_all(line.as_bytes())
            .expect("write to sok mcp");
    }

    /// Writes one message line as it is. A numeric id of a line that reads moves the next id of the session past it. The id is
    /// read on its own, because a line of a case may hold a string that serde_json refuses, such as a lone surrogate escape.
    fn write_line(&mut self, line: &[u8]) {
        #[derive(serde::Deserialize)]
        struct LineId {
            id: Option<Box<serde_json::value::RawValue>>,
        }
        let id = serde_json::from_slice::<LineId>(line)
            .ok()
            .and_then(|read| read.id)
            .and_then(|id| serde_json::from_str::<Value>(id.get()).ok());
        if let Some(number) = id.as_ref().and_then(Value::as_u64)
            && number >= self.next_id
        {
            self.next_id = number + 1;
        }
        let stdin = self.stdin.as_mut().expect("the standard input is open");
        stdin.write_all(line).expect("write to sok mcp");
        stdin.write_all(b"\n").expect("write to sok mcp");
    }

    /// Removes the answer with the id key, so a later answer with the same id, such as the null id of a parse error, is waited
    /// for anew.
    fn forget(&self, key: &str) {
        self.read
            .0
            .lock()
            .expect("the read state")
            .responses
            .remove(key);
    }

    /// Sends a request with the next id and returns the id.
    fn request(&mut self, method: &str, params: Option<Value>) -> String {
        let id = self.next_id;
        let mut message = json!({"jsonrpc": "2.0", "id": id, "method": method});
        if let Some(params) = params {
            message["params"] = params;
        }
        self.send(&message);
        id.to_string()
    }

    /// Waits until the state holds what found returns.
    fn wait<T>(&self, what: &str, found: impl Fn(&Read) -> Option<T>) -> T {
        let (lock, signal) = &*self.read;
        let deadline = Instant::now() + WAIT_LIMIT;
        let mut read = lock.lock().expect("the read state");
        loop {
            if let Some(value) = found(&read) {
                return value;
            }
            let remaining = deadline.checked_duration_since(Instant::now());
            if read.ended || remaining.is_none() {
                let failure = format!(
                    "sok mcp did not give {what} (ended {}); standard error: {:?}",
                    read.ended, read.stderr
                );
                // The guard is released before the panic, so the mutex is not poisoned and the reader threads end normally.
                drop(read);
                panic!("{failure}");
            }
            read = signal
                .wait_timeout(read, remaining.expect("checked above"))
                .expect("the read state")
                .0;
        }
    }

    /// Waits for the response of id.
    fn response(&self, id: &str) -> Value {
        self.wait(&format!("a response to {id}"), |read| {
            read.responses.get(id).cloned()
        })
    }

    /// Opens a session of the revision 2025-11-25.
    fn initialize(&mut self) {
        let id = self.request(
            "initialize",
            Some(json!({"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}})),
        );
        let reply = self.response(&id);
        assert!(reply["result"].is_object(), "initialize answered {reply}");
        self.send(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
    }

    /// The text of a tool result and whether it is a tool error.
    fn tool_outcome(&self, id: &str) -> (String, bool) {
        let reply = self.response(id);
        let result = reply["result"]
            .as_object()
            .unwrap_or_else(|| panic!("tools/call {id} answered {reply}"));
        let content = result["content"]
            .as_array()
            .filter(|content| content.len() == 1);
        let content = content.unwrap_or_else(|| {
            panic!(
                "tools/call {id} answered the content {}, want one text",
                result["content"]
            )
        });
        let text = content[0]["text"].as_str().unwrap_or("").to_string();
        (text, result.get("isError") == Some(&Value::Bool(true)))
    }

    /// Waits until the server wrote line to its standard error.
    fn stderr_line(&self, line: &str) {
        self.wait(
            &format!("the line {line:?} on its standard error"),
            |read| {
                read.stderr
                    .iter()
                    .any(|written| written == line)
                    .then_some(())
            },
        );
    }

    fn answered(&self, id: &str) -> Option<Value> {
        self.read
            .0
            .lock()
            .expect("the read state")
            .responses
            .get(id)
            .cloned()
    }
}

impl Session {
    /// Closes the standard input, which ends the server, checks that it ended with status 0, and returns its standard error.
    fn end(&mut self) -> Vec<String> {
        drop(self.stdin.take());
        let status = self.child.take().expect("the server runs").wait();
        for reader in self.readers.drain(..) {
            reader.join().expect("a reader of sok mcp");
        }
        let read = self.read.0.lock().expect("the read state");
        let status = status.expect("wait for sok mcp");
        assert!(
            status.success(),
            "sok mcp ended with {status} after its standard input closed; standard error: {:?}",
            read.stderr
        );
        assert!(
            read.invalid.is_empty(),
            "sok mcp wrote lines that are no JSON message: {:?}",
            read.invalid
        );
        read.stderr.clone()
    }

    /// Closes the standard input and checks that the server ended with status 1 and wrote line to its standard error.
    fn end_failing(&mut self, line: &str) {
        drop(self.stdin.take());
        let status = self
            .child
            .take()
            .expect("the server runs")
            .wait()
            .expect("wait for sok mcp");
        for reader in self.readers.drain(..) {
            reader.join().expect("a reader of sok mcp");
        }
        let read = self.read.0.lock().expect("the read state");
        assert!(
            status.code() == Some(1) && read.stderr.iter().any(|written| written == line),
            "sok mcp ended with {status} and the standard error {:?}, want status 1 and the line {line:?}",
            read.stderr
        );
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if self.child.is_none() {
            return;
        }
        if std::thread::panicking() {
            drop(self.stdin.take());
            if let Some(mut child) = self.child.take() {
                let _ = child.wait();
            }
            return;
        }
        self.end();
    }
}

/// The texts that stand for a value of the run in the mcp steps of a case.
fn run_values(config_dir: &str) -> HashMap<String, Value> {
    let definition: Value = serde_json::from_str(soksak_sok::agents::MCP).expect("mcp.json");
    HashMap::from([
        ("$config".to_string(), Value::String(config_dir.to_string())),
        (
            "$version".to_string(),
            Value::String(soksak_sok::version::CORE_VERSION.to_string()),
        ),
        (
            "$instructions".to_string(),
            definition["instructions"].clone(),
        ),
        ("$tools".to_string(), definition["tools"].clone()),
    ])
}

/// Compares two JSON values as the decoded values of Go compare: numbers by their value.
fn same_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_json(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(name, value)| b.get(name).is_some_and(|other| same_json(value, other)))
        }
        _ => a == b,
    }
}

/// Tells whether actual holds every member that want states with the same value; arrays have the same length.
fn stated(want: &Value, actual: &Value) -> bool {
    match (want, actual) {
        (Value::Object(want), Value::Object(actual)) => want
            .iter()
            .all(|(name, member)| actual.get(name).is_some_and(|value| stated(member, value))),
        (Value::Object(_), _) => false,
        (Value::Array(want), Value::Array(actual)) => {
            want.len() == actual.len() && want.iter().zip(actual).all(|(w, a)| stated(w, a))
        }
        (Value::Array(_), _) => false,
        _ => same_json(want, actual),
    }
}

/// The run of one case: the server, the player and the calls that run without a wait.
struct Run {
    name: String,
    session: Session,
    player: Option<CasePlayer>,
    config_dir: Folder,
    _home: Folder,
    values: HashMap<String, Value>,
    started: HashMap<String, String>,
    cancelled: Vec<(String, String)>,
    /// The texts of the tool results of the run, in order, for the checks that a case does not state.
    results: Vec<String>,
}

impl Drop for Run {
    /// A cancelled call has no response.
    fn drop(&mut self) {
        if std::thread::panicking() {
            return;
        }
        for (where_, id) in &self.cancelled {
            if let Some(reply) = self.session.answered(id) {
                panic!("{where_}: the cancelled call {id} was answered with {reply}");
            }
        }
    }
}

impl Run {
    /// A value of a step with the values of the run and the variables of the case: a string `$<name>` is the value of the run of
    /// that name, else the text that the test gave the variable or its example, and `$config` inside a string is the
    /// configuration directory.
    fn resolve(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => {
                if let Some(replaced) = self.values.get(text) {
                    return replaced.clone();
                }
                if let Some(variable) = self
                    .player
                    .as_ref()
                    .and_then(|player| player.variable(text))
                {
                    return variable;
                }
                let config = self.values["$config"].as_str().expect("$config is a text");
                Value::String(text.replace("$config", config))
            }
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| self.resolve(item)).collect())
            }
            Value::Object(members) => Value::Object(
                members
                    .iter()
                    .map(|(name, member)| (name.clone(), self.resolve(member)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    /// Compares the outcome of a tool call with the result or the error that the step states.
    fn check(&mut self, where_: &str, id: &str, step: &Value) {
        let (text, is_error) = self.session.tool_outcome(id);
        self.results.push(text.clone());
        if let Some(error) = step.get("error") {
            let want = self.resolve(error);
            assert!(
                is_error && Some(text.as_str()) == want.as_str(),
                "{where_}: the call answered {text:?} (error {is_error}), the case states the error {want}"
            );
        } else if let Some(result) = step.get("result") {
            let want = self.resolve(result);
            let got: Value = serde_json::from_str(&text).unwrap_or_else(|error| {
                panic!("{where_}: the call answered {text:?}, which is no JSON: {error}")
            });
            assert!(
                !is_error && same_json(&got, &want),
                "{where_}: the call answered {text} (error {is_error}), the case states {want}"
            );
        } else {
            assert!(!is_error, "{where_}: the call answered the error {text:?}");
        }
    }
}

/// Plays the case of name against `sok mcp` and runs its mcp steps. texts give variables of the case the text that the test
/// chooses.
fn run_case(name: &str, texts: &[(&str, &str)]) -> Run {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .map(|folder| folder.join("docs/spec/cases/endpoint"))
        .find(|folder| folder.is_dir())
        .expect("docs/spec/cases/endpoint of the repository");
    let text =
        std::fs::read_to_string(directory.join(format!("{name}.json"))).expect("read the case");
    let case: Value = serde_json::from_str(&text).expect("the case is JSON");
    let mcp = case["mcp"]
        .as_object()
        .unwrap_or_else(|| panic!("{name} has no mcp member"));
    let config_dir = Folder::new("mcp");
    let home = Folder::new("home");
    let player = (mcp.get("endpoint").and_then(Value::as_str) != Some("later"))
        .then(|| play_case_in(name, config_dir.path(), texts));
    let mut args = vec!["--config-dir".to_string(), config_dir.text().to_string()];
    for argument in mcp
        .get("arguments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        args.push(
            argument
                .as_str()
                .expect("an argument is a text")
                .to_string(),
        );
    }
    let environment: Vec<(String, String)> = mcp
        .get("environment")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(name, value)| {
            (
                name.clone(),
                value.as_str().expect("a variable is a text").to_string(),
            )
        })
        .collect();
    let session = Session::start(&args, home.path(), &environment);
    let values = run_values(config_dir.text());
    let mut run = Run {
        name: name.to_string(),
        session,
        player,
        config_dir,
        _home: home,
        values,
        started: HashMap::new(),
        cancelled: Vec::new(),
        results: Vec::new(),
    };
    let steps = mcp
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if steps
        .first()
        .is_some_and(|step| step.get("client").is_none())
    {
        run.session.initialize();
    }
    for (n, step) in steps.iter().enumerate() {
        let where_ = format!("{}: mcp step {n}", run.name);
        if let Some(client) = step.get("client") {
            let message = run.resolve(client);
            run.session.send(&message);
            let Some(server) = step.get("server") else {
                continue;
            };
            let want = run.resolve(server);
            let got = run.session.response(&message["id"].to_string());
            assert!(
                stated(&want, &got),
                "{where_}: the server answered {got}, the case states {want}"
            );
        } else if step.get("line").is_some() || step.get("hex").is_some() {
            let line = match step.get("hex").and_then(Value::as_str) {
                Some(text) => {
                    hex::decode(text).unwrap_or_else(|error| panic!("{where_}: hex: {error}"))
                }
                None => step["line"]
                    .as_str()
                    .expect("a line is a text")
                    .as_bytes()
                    .to_vec(),
            };
            let Some(server) = step.get("server") else {
                run.session.write_line(&line);
                continue;
            };
            // The answer is keyed by the id that the case states, because the server answers a line that it cannot read with the
            // id null.
            let want = run.resolve(server);
            let key = want["id"].to_string();
            run.session.forget(&key);
            run.session.write_line(&line);
            let got = run.session.response(&key);
            assert!(
                stated(&want, &got),
                "{where_}: the server answered {got}, the case states {want}"
            );
        } else if let Some(tool) = step.get("tool") {
            let arguments = step
                .get("arguments")
                .map_or_else(|| json!({}), |arguments| run.resolve(arguments));
            let id = run.session.request(
                "tools/call",
                Some(json!({"name": tool, "arguments": arguments})),
            );
            if let Some(name) = step.get("as").and_then(Value::as_str) {
                run.started.insert(name.to_string(), id);
                continue;
            }
            run.check(&where_, &id, step);
        } else if let Some(name) = step.get("await").and_then(Value::as_str) {
            let id = run.started[name].clone();
            run.check(&where_, &id, step);
        } else if let Some(name) = step.get("cancel").and_then(Value::as_str) {
            let id = run.started[name].clone();
            let request_id: u64 = id.parse().expect("a request id is a number");
            run.session.send(&json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": request_id, "reason": "the case cancels the call"}}));
            run.cancelled.push((where_, id));
        } else if let Some(method) = step.get("received").and_then(Value::as_str) {
            let count = steps[..=n]
                .iter()
                .filter(|earlier| earlier.get("received").and_then(Value::as_str) == Some(method))
                .count();
            let player = run
                .player
                .as_ref()
                .expect("a received step follows the start of the player");
            player.wait_for_method(method, count);
            let contains = step.get("contains").and_then(Value::as_str).unwrap_or("");
            let text = player.last_text(method);
            assert!(
                text.contains(contains),
                "{where_}: the last request of {method} is {text}, which does not hold {contains}"
            );
        } else if let Some(line) = step.get("stderr").and_then(Value::as_str) {
            run.session.stderr_line(line);
        } else if step.get("start") == Some(&Value::Bool(true)) {
            run.player = Some(play_case_in(name, run.config_dir.path(), texts));
        } else {
            panic!("{where_} has no kind");
        }
    }
    run
}

// contract: cli.mcp.replays-the-endpoint-cases
#[test]
fn the_mcp_server_replays_the_endpoint_cases() {
    for name in [
        "mcp-exposure-search",
        "mcp-exposure-without-element",
        "mcp-exposure-without-params",
        "mcp-input-pointer-inactive",
        "mcp-tools-call",
        "mcp-watch-connection-closed",
        "mcp-watch-current-value",
        "mcp-watch-next-change",
        "mcp-agent-context",
        "mcp-window-describe",
        "mcp-tools-call-rejected",
        "mcp-messages",
    ] {
        run_case(name, &[]);
    }
}

// contract: cli.mcp.lists-the-fixed-tools
#[test]
fn the_mcp_server_lists_the_fixed_tools() {
    // The only endpoint request of the case is agent.surface of its call of agent_context; tools/list sends none.
    let mut run = run_case("mcp-protocol-2025-11-25", &[]);
    let methods = run.player.as_ref().expect("the player").methods();
    assert_eq!(
        methods,
        ["agent.surface"],
        "the case sent the endpoint requests"
    );
    let id = run.session.request("tools/list", None);
    let reply = run.session.response(&id);
    let methods = run.player.as_ref().expect("the player").methods();
    assert_eq!(
        methods,
        ["agent.surface"],
        "tools/list sent endpoint requests"
    );
    let tools = &reply["result"]["tools"];
    assert!(
        same_json(tools, &run.values["$tools"]),
        "tools/list answered {tools}, want the tools of mcp.json"
    );
    assert!(
        reply["result"].get("nextCursor").is_none(),
        "tools/list answered a second page: {reply}"
    );
}

// contract: cli.mcp.answers-the-protocol-revisions
#[test]
fn the_mcp_server_answers_the_protocol_revisions() {
    for name in [
        "mcp-protocol-2026-07-28",
        "mcp-protocol-2025-11-25",
        "mcp-protocol-unsupported",
    ] {
        run_case(name, &[]);
    }
}

// contract: cli.mcp.discovery-reads-the-exposure-at-each-call, cli.mcp.search-lists-the-whole-exposure
#[test]
fn each_search_reads_the_exposure_of_that_call() {
    run_case("mcp-exposure-pages", &[]);
}

// contract: cli.mcp.serves-without-an-application
#[test]
fn the_mcp_server_serves_without_an_application() {
    run_case("mcp-reconnect", &[]);
}

// contract: cli.mcp.watch-calls-share-and-cancel
#[test]
fn watch_calls_share_one_watch_and_a_cancelled_call_ends() {
    run_case("mcp-watch-shared", &[]);
}

// contract: cli.describe.oversized-row-is-a-page, cli.describe.pages-follow-a-changing-window
#[test]
fn an_oversized_row_is_a_page_and_pages_follow_a_changing_window() {
    let big = "x".repeat(50000);
    let run = run_case("mcp-window-describe-pages", &[("big", &big)]);
    let first: Value = serde_json::from_str(&run.results[0]).expect("the first page is JSON");
    let rows = first["rows"].as_array().expect("rows");
    assert!(
        run.results[0].len() <= 40000
            && rows.len() == 1
            && first["total"] == 4
            && first["next"] == "core status core.big",
        "the first page has {} bytes, {} rows, total {} and next {}; want at most 40000 bytes and the one row core.big",
        run.results[0].len(),
        rows.len(),
        first["total"],
        first["next"]
    );
    let row = &rows[0];
    let value = row["value"].as_str().unwrap_or("");
    assert!(
        row["key"] == "core status core.big"
            && row["cut"] == true
            && !value.is_empty()
            && format!("\"{big}\"").starts_with(value),
        "the oversized row is {}, want core.big with a cut prefix of its value",
        row["key"]
    );
    let compact: Value = serde_json::from_str(&run.results[2]).expect("the compact page is JSON");
    let rows = compact["rows"].as_array().expect("rows");
    assert!(
        rows.len() == 4 && compact["next"].is_null(),
        "the compact page has {} rows and next {}, want 4 rows and no next",
        rows.len(),
        compact["next"]
    );
    let text = rows[0]["value"].as_str().expect("a value text");
    assert!(
        text.chars().count() == 200 && rows[0]["cut"] == true,
        "the compact value has {} characters and cut {}, want 200 and true",
        text.chars().count(),
        rows[0]["cut"]
    );
    let many = &rows[3];
    let items = many["items"].as_array().expect("items");
    assert!(
        items.len() == 20 && many["cut"] == true && many["itemsTotal"] == 25,
        "the compact element has {} items, cut {} and itemsTotal {}, want 20, true and 25",
        items.len(),
        many["cut"],
        many["itemsTotal"]
    );
}

/// A home of the test whose path is canonical, so the paths that the server writes equal the paths of the test.
fn agent_home() -> (Folder, std::path::PathBuf) {
    let folder = Folder::new("home");
    let home = std::fs::canonicalize(folder.path()).expect("canonical home");
    (folder, home)
}

/// The events of the name in the event files of the configuration directory, as their fields.
fn stored_events(config: &Path, name: &str) -> Vec<Value> {
    let mut events = Vec::new();
    for entry in std::fs::read_dir(config.join("logs")).expect("the logs folder") {
        let file = entry.expect("an entry of the logs folder").path();
        let named = file
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if !(named.starts_with("sok-") && named.ends_with(".jsonl")) {
            continue;
        }
        for line in std::fs::read_to_string(&file)
            .expect("an event file")
            .lines()
        {
            let event: Value = serde_json::from_str(line)
                .unwrap_or_else(|error| panic!("{}: {error}", file.display()));
            if event["event"] == name {
                events.push(event["fields"].clone());
            }
        }
    }
    events
}

// contract: cli.mcp.ends-at-a-line-over-the-limit
#[test]
fn a_line_over_the_limit_ends_the_mcp_server() {
    let (_folder, home) = agent_home();
    let config = Folder::new("mcp");
    let mut session = Session::start(&["--config-dir".into(), config.text().into()], &home, &[]);
    session.initialize();
    // A line of 16777216 bytes before its line feed is over the limit, which the server reads in full before it ends.
    session
        .stdin
        .as_mut()
        .expect("the standard input is open")
        .write_all(&vec![b'x'; 16 * 1024 * 1024])
        .expect("write to sok mcp");
    session.end_failing("sok: mcp message exceeds 16777216 bytes");
}

// contract: cli.mcp.brings-the-skill-current-at-start
#[test]
fn the_mcp_server_brings_the_skill_current_at_start() {
    let skill = soksak_sok::agents::SKILL;
    // A differing file and a missing file of existing agent folders hold the skill before the answer to initialize.
    let (_folder, home) = agent_home();
    let differing = home.join(".claude/skills/soksak/SKILL.md");
    let missing = home.join(".agents/skills/soksak/SKILL.md");
    std::fs::create_dir_all(differing.parent().expect("folder")).expect("create the skill folder");
    std::fs::write(&differing, "an earlier skill\n").expect("write the earlier skill");
    std::fs::create_dir_all(home.join(".agents")).expect("create .agents");
    let config = Folder::new("mcp");
    let mut session = Session::start(&["--config-dir".into(), config.text().into()], &home, &[]);
    session.initialize();
    let read = |file: &Path| std::fs::read_to_string(file).unwrap_or_default();
    assert!(
        read(&differing) == skill && read(&missing) == skill,
        "after initialize the skill files hold {:?} and {:?}",
        read(&differing),
        read(&missing)
    );
    let stderr = session.end();
    assert!(stderr.is_empty(), "standard error {stderr:?}");
    // Without an agent folder the server writes nothing and serves.
    let (_folder, home) = agent_home();
    let config = Folder::new("mcp");
    let mut session = Session::start(&["--config-dir".into(), config.text().into()], &home, &[]);
    session.initialize();
    let stderr = session.end();
    let names: Vec<_> = std::fs::read_dir(&home).expect("the home").collect();
    assert!(
        names.is_empty() && stderr.is_empty(),
        "the home holds {names:?}; standard error {stderr:?}"
    );
    // Each skill folder that cannot be written is reported on standard error and as sok.skill in the order of the agent folders,
    // and the server still serves.
    let (_folder, home) = agent_home();
    let mut files = Vec::new();
    let mut locked = Vec::new();
    for folder in [".claude", ".agents"] {
        let skill_folder = home.join(folder).join("skills/soksak");
        std::fs::create_dir_all(&skill_folder).expect("create the skill folder");
        std::fs::set_permissions(
            &skill_folder,
            std::os::unix::fs::PermissionsExt::from_mode(0o555),
        )
        .expect("lock the skill folder");
        files.push(skill_folder.join("SKILL.md").display().to_string());
        locked.push(skill_folder);
    }
    let config = Folder::new("mcp");
    let mut session = Session::start(&["--config-dir".into(), config.text().into()], &home, &[]);
    session.initialize();
    let stderr = session.end();
    for folder in &locked {
        std::fs::set_permissions(folder, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .expect("unlock the skill folder");
    }
    for file in &files {
        let line = format!("sok: skill: {file}: permission denied");
        assert!(
            stderr.contains(&line),
            "standard error {stderr:?} lacks {line:?}"
        );
    }
    let events = stored_events(config.path(), "sok.skill");
    assert_eq!(
        events,
        files
            .iter()
            .map(|file| json!({"file": file, "reason": "permission denied"}))
            .collect::<Vec<_>>(),
        "sok.skill events"
    );
}
