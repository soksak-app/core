//! The page of an endpoint case and the player of the cases of docs/spec/cases/endpoint (docs/spec/cases/endpoint/README.md). The
//! Go host plays the same files with the same reader rules (packages/host/go/tests/endpoint_cases_test.go): a difference between
//! the two players is a defect of one of them.
//!
//! The page answers each request that the endpoint relays to it as the `page` steps of the case state, and records a request that
//! the case has no step for as a problem of the case. The request, the reply and the end of the connection run through the relay
//! of the host (`Relay`), so the end of the connection of a held request ends it as it does in the host.
//!
//! A test file includes this file as `mod endpoint_case`, with `mod folder`, `mod endpoint_client`, `mod child` and `mod records`
//! at its root.

#![allow(dead_code)]

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::value::RawValue;
use serde_json::{Map, Value, json};
use soksak_host::endpoint::{Endpoint, Failure, Notifier, ReplyScope, Service};
use soksak_host::event_log::EventLog;
use soksak_host::exposure::Relay;

use crate::endpoint_client::{self, Connection};
use crate::folder::Folder;
use crate::{child, records};

/// The largest frame of the framing (docs/spec/endpoint.md#framing).
const MAX_FRAME: usize = 16 * 1024 * 1024;

/// The longest wait for one frame of the host, for one call of the page and for one record of the log. What does not arrive in it
/// fails the case.
pub const READ_LIMIT: Duration = Duration::from_secs(10);

/// The environment variable that tells a child process the configuration folder of the case that it plays.
const CHILD: &str = "SOKSAK_ENDPOINT_CASE_CHILD";

/// The code of the error that the page answers for a request that the case has no step for.
const NO_PAGE: i64 = -32603;

/// The connection of a step that names none.
const DEFAULT_CONNECTION: &str = "client";

/// The reply of the page to a call: the result, or the code and the message of an error.
#[derive(Clone, Debug)]
pub enum PageReply {
    Result(Value),
    Error { code: i64, message: String },
}

/// One request that the endpoint relays to the page and the reply that the page gives: the page follows its exchanges in order,
/// as the `page` steps of a case do. The payload is absent when the endpoint sends no params.
#[derive(Clone, Debug)]
pub struct Exchange {
    name: String,
    payload: Option<Value>,
    reply: PageReply,
    held: bool,
}

/// An exchange of the call `name` with the params `payload` (`Value::Null` for no params) that the page answers with `result`.
pub fn exchange(name: &str, payload: Value, result: Value) -> Exchange {
    Exchange {
        name: name.into(),
        payload: (!payload.is_null()).then_some(payload),
        reply: PageReply::Result(result),
        held: false,
    }
}

/// An exchange that the page answers with the error `code` and `message`.
pub fn refused_exchange(name: &str, payload: Value, code: i64, message: &str) -> Exchange {
    Exchange {
        reply: PageReply::Error {
            code,
            message: message.into(),
        },
        ..exchange(name, payload, Value::Null)
    }
}

impl Exchange {
    /// The same exchange, whose reply the page gives only at the next release.
    pub fn held(mut self) -> Self {
        self.held = true;
        self
    }
}

/// A reply of the page that waits for a release step: the id of the relay request that it answers.
struct Held {
    id: u64,
    window: String,
    reply: PageReply,
}

struct PageState {
    next: usize,
    held: VecDeque<Held>,
    problems: Vec<String>,
    ended: bool,
}

/// The window owner of the endpoint for a case: the windows of the case and a page that follows the page steps of the case. A
/// request that the case has no step for is a problem of the case, and the endpoint receives an error for it.
pub struct CasePage {
    relay: Arc<Relay>,
    script: Vec<Exchange>,
    windows: Mutex<Vec<String>>,
    state: Mutex<PageState>,
    calls: Sender<()>,
    /// The receiver of the signals of the relayed calls and the number of signals that were taken.
    awaited: Mutex<(Receiver<()>, usize)>,
    /// The starts and ends of the watches of host statuses that the endpoint passed to the window owner, as `<window> <name> on`
    /// or `<window> <name> off`.
    host_watches: Mutex<Vec<String>>,
    /// Whether the window owner delivers the input that the endpoint passes to it with the result null. A page of exchanges states
    /// each input as an exchange of its own.
    delivers_input: bool,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    // default: a lock that a panicking test thread poisoned still holds the state of the page, which the check of the case
    // reads; the panic of that thread is reported by its own test.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl CasePage {
    /// A page with the windows and the exchanges.
    pub fn new(windows: &[&str], script: Vec<Exchange>) -> Arc<CasePage> {
        CasePage::with_input(windows, script, false)
    }

    fn with_input(windows: &[&str], script: Vec<Exchange>, delivers_input: bool) -> Arc<CasePage> {
        let (calls, awaited) = mpsc::channel();
        Arc::new(CasePage {
            relay: Arc::new(Relay::default()),
            script,
            windows: Mutex::new(windows.iter().map(|window| window.to_string()).collect()),
            state: Mutex::new(PageState {
                next: 0,
                held: VecDeque::new(),
                problems: Vec::new(),
                ended: false,
            }),
            calls,
            awaited: Mutex::new((awaited, 0)),
            host_watches: Mutex::new(Vec::new()),
            delivers_input,
        })
    }

    /// The watches of host statuses that the endpoint passed to the window owner, in order.
    pub fn host_watches(&self) -> Vec<String> {
        locked(&self.host_watches).clone()
    }

    /// A page without exchanges: each request for it is a problem of the case.
    pub fn without_steps(windows: &[&str]) -> Arc<CasePage> {
        CasePage::new(windows, Vec::new())
    }

    /// Reads the page steps of a case into the exchanges of its page: each call is followed at once by its reply.
    fn from_steps(windows: &[String], steps: &[Value]) -> Result<Arc<CasePage>, String> {
        let mut script = Vec::new();
        let mut pending: Option<(String, Option<Value>)> = None;
        for (index, step) in steps.iter().enumerate() {
            let Some(page) = step.get("page") else {
                if pending.is_some() {
                    return Err(format!(
                        "step {index}: the call of the page before it has no reply"
                    ));
                }
                continue;
            };
            if let Some(call) = page.get("call") {
                if pending.is_some() {
                    return Err(format!(
                        "step {index}: the call of the page before it has no reply"
                    ));
                }
                let name = call
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("step {index}: a call of the page has no name"))?;
                pending = Some((name.to_string(), call.get("payload").cloned()));
            } else if let Some(reply) = page.get("reply") {
                let (name, payload) = pending
                    .take()
                    .ok_or_else(|| format!("step {index}: a reply of the page follows no call"))?;
                let held = reply.get("held").and_then(Value::as_bool).unwrap_or(false);
                let reply = match (reply.get("result"), reply.get("error")) {
                    (Some(result), None) => PageReply::Result(result.clone()),
                    (None, Some(error)) => PageReply::Error {
                        code: error.get("code").and_then(Value::as_i64).ok_or_else(|| {
                            format!("step {index}: the error of the page has no code")
                        })?,
                        message: error
                            .get("message")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                format!("step {index}: the error of the page has no message")
                            })?
                            .to_string(),
                    },
                    _ => {
                        return Err(format!(
                            "step {index}: a reply of the page has exactly one of result and error"
                        ));
                    }
                };
                script.push(Exchange {
                    name,
                    payload,
                    reply,
                    held,
                });
            } else if pending.is_some() {
                return Err(format!(
                    "step {index}: the call of the page before it has no reply"
                ));
            }
        }
        if pending.is_some() {
            return Err("the last call of the page has no reply".into());
        }
        let windows: Vec<&str> = windows.iter().map(String::as_str).collect();
        Ok(CasePage::with_input(&windows, script, true))
    }

    /// Adds a window, as the registration of a window does.
    pub fn add_window(&self, window: &str) {
        locked(&self.windows).push(window.to_string());
    }

    fn problem(&self, text: String) {
        let mut state = locked(&self.state);
        // A deviation after the case ended is not recorded: the endpoint releases its watches when its connections close.
        if !state.ended {
            state.problems.push(text);
        }
    }

    /// Waits until the endpoint relayed the next request of the case to the page.
    pub fn await_call(&self) -> bool {
        let mut awaited = locked(&self.awaited);
        let signal = awaited.0.recv_timeout(READ_LIMIT).is_ok();
        awaited.1 += usize::from(signal);
        signal
    }

    /// Waits until the endpoint relayed `total` requests to the page since the page started, the ones that `await_call` took
    /// included. A request that does not come within READ_LIMIT ends the wait with false.
    pub fn await_total(&self, total: usize) -> bool {
        let mut awaited = locked(&self.awaited);
        while awaited.1 < total {
            if awaited.0.recv_timeout(READ_LIMIT).is_err() {
                return false;
            }
            awaited.1 += 1;
        }
        true
    }

    /// Whether the endpoint relayed every exchange of the page.
    pub fn exhausted(&self) -> bool {
        locked(&self.state).next >= self.script.len()
    }

    /// Answers the oldest held reply of the page through the relay.
    pub fn release(&self) -> Result<(), String> {
        let held = locked(&self.state)
            .held
            .pop_front()
            .ok_or("the page holds no reply to release")?;
        self.relay
            .reply(&held.window, &page_reply(held.id, &held.reply))
    }

    /// Ends the page and returns the problems of the case: the deviations that the endpoint made and the calls of the case that it
    /// did not send.
    pub fn finish(&self) -> Vec<String> {
        let mut state = locked(&self.state);
        state.ended = true;
        let mut problems = state.problems.clone();
        if state.next < self.script.len() {
            problems.push(format!(
                "the endpoint sent {} of the {} calls of the page that the case has",
                state.next,
                self.script.len()
            ));
        }
        if !state.held.is_empty() {
            problems.push(format!(
                "{} replies of the page were held and never released",
                state.held.len()
            ));
        }
        problems
    }
}

/// The reply of the page as the relay takes it: `{id, result}` or `{id, error}`.
fn page_reply(id: u64, reply: &PageReply) -> Box<RawValue> {
    let value = match reply {
        PageReply::Result(result) => json!({"id": id, "result": result}),
        PageReply::Error { code, message } => {
            json!({"id": id, "error": {"code": code, "message": message}})
        }
    };
    serde_json::value::to_raw_value(&value).expect("a reply of the page is JSON")
}

/// Whether the params that the endpoint sent are the payload of the call of the case. The endpoint of this host sends its params as
/// an object, so an absent payload and the payload `{}` both are the empty object.
/// The result of a request that the window owner answers itself: null.
fn null_result() -> Box<RawValue> {
    serde_json::value::to_raw_value(&Value::Null).expect("null is JSON")
}

fn same_params(sent: &Map<String, Value>, payload: &Option<Value>) -> bool {
    match payload {
        None => sent.is_empty(),
        Some(payload) => payload == &Value::Object(sent.clone()),
    }
}

impl Service for CasePage {
    fn windows(&self) -> Result<Value, Failure> {
        let entries: Vec<Value> = locked(&self.windows)
            .iter()
            .map(|window| {
                json!({"window": window, "title": "", "project": null, "key": false, "ready": false})
            })
            .collect();
        Ok(Value::Array(entries))
    }

    fn exists(&self, window: &str) -> bool {
        locked(&self.windows).iter().any(|name| name == window)
    }

    fn call(
        &self,
        window: &str,
        method: &str,
        params: Map<String, Value>,
        reply: Option<ReplyScope>,
    ) -> Result<Box<RawValue>, Failure> {
        if let Some(on) = match method {
            "status.watch" => Some(true),
            "status.unwatch" => Some(false),
            _ => None,
        } && params
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| name.starts_with("host."))
        {
            let name = params["name"].as_str().unwrap_or_default();
            locked(&self.host_watches)
                .push(format!("{window} {name} {}", if on { "on" } else { "off" }));
            return Ok(null_result());
        }
        // The window owner delivers the input that the endpoint passes to it: the result is null, as for the owner of a window that
        // accepts the input.
        if self.delivers_input && method.starts_with("input.") {
            return Ok(null_result());
        }
        let (index, ended) = {
            let mut state = locked(&self.state);
            let index = state.next;
            state.next += 1;
            (index, state.ended)
        };
        let Some(exchange) = self.script.get(index).filter(|_| !ended) else {
            self.problem(format!(
                "the endpoint sent {method} {} to the page, where the case has no further call",
                Value::Object(params)
            ));
            return Err(Failure::new(
                NO_PAGE,
                format!("{method}: the case has no page step for this request"),
            ));
        };
        if method != exchange.name || !same_params(&params, &exchange.payload) {
            self.problem(format!(
                "page call {index} is {method} {}, the case has {} {}",
                Value::Object(params),
                exchange.name,
                exchange
                    .payload
                    .as_ref()
                    .map_or(String::new(), Value::to_string)
            ));
        }
        self.relay.request(window, |id| {
            if let Some(scope) = &reply {
                let relay = Arc::clone(&self.relay);
                scope.after_connection_end(move || relay.end(id));
            }
            if exchange.held {
                locked(&self.state).held.push_back(Held {
                    id,
                    window: window.to_string(),
                    reply: exchange.reply.clone(),
                });
            } else {
                self.relay.reply(window, &page_reply(id, &exchange.reply))?;
            }
            // The receiver lives as long as the page, so the send fails only after the page was dropped.
            let _ = self.calls.send(());
            Ok(())
        })
    }

    /// The end of the last watch of a status is no request of the page, and the cases state the requests of the page.
    fn unwatched(&self, _window: &str, _name: &str) {}
}

/// An endpoint with the window main whose page follows exchanges, in a folder of its own.
pub struct Served {
    pub endpoint: Endpoint,
    pub page: Arc<CasePage>,
    pub config: Folder,
}

/// Starts the endpoint for the application with the window main and publishes it. The page follows exchanges.
pub fn serve_page(application: &str, exchanges: Vec<Exchange>) -> Served {
    let config = Folder::new();
    let page = CasePage::new(&["main"], exchanges);
    let endpoint = Endpoint::start(
        &config.path().join("sockets"),
        config.path(),
        application,
        page.clone(),
    )
    .unwrap();
    endpoint.publish("main").unwrap();
    Served {
        endpoint,
        page,
        config,
    }
}

impl Served {
    pub fn open(&self) -> Connection {
        endpoint_client::connect(self.endpoint.address())
    }

    /// Waits for the requests of the page that a closed connection of the test may still send, such as the last `status.unwatch`,
    /// stops the endpoint and fails the test on a deviation of the endpoint from the exchanges, and on an exchange that it did
    /// not send.
    pub fn finish(&self) {
        while !self.page.exhausted() && self.page.await_call() {}
        let problems = self.page.finish();
        self.endpoint.stop();
        assert!(
            problems.is_empty(),
            "the page of the endpoint:\n{}",
            problems.join("\n")
        );
    }
}

/// The directory of the endpoint cases, found by walking up from the manifest directory of this package.
pub fn case_directory() -> PathBuf {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest
        .ancestors()
        .map(|dir| dir.join("docs/spec/cases/endpoint"))
        .find(|candidate| candidate.is_dir())
        .unwrap_or_else(|| panic!("no docs/spec/cases/endpoint above {}", manifest.display()))
}

/// One case file of docs/spec/cases/endpoint.
pub struct Case {
    pub name: String,
    pub replay: bool,
    pub scripted: bool,
    pub windows: Vec<String>,
    pub variables: Map<String, Value>,
    pub steps: Vec<Value>,
}

impl Case {
    fn has_log(&self) -> bool {
        self.steps.iter().any(|step| step.get("log").is_some())
    }
}

/// Reads one case file. The name of the case is the name of its file.
pub fn read_case(path: &Path) -> Result<Case, String> {
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let case: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not a readable case: {error}", path.display()))?;
    let stem = path.file_stem().and_then(|stem| stem.to_str());
    let name = case["name"].as_str();
    if name != stem {
        return Err(format!(
            "{}: name {name:?} does not match the file name",
            path.display()
        ));
    }
    let scripted = match case.get("page") {
        None => false,
        Some(page) if page == "scripted" => true,
        Some(page) => {
            return Err(format!(
                "{}: page must be \"scripted\", is {page}",
                path.display()
            ));
        }
    };
    let replay = case["replay"]
        .as_bool()
        .ok_or_else(|| format!("{}: replay must be true or false", path.display()))?;
    if !replay && case["reason"].as_str().is_none_or(str::is_empty) {
        return Err(format!(
            "{}: a case with replay false must give its reason",
            path.display()
        ));
    }
    let windows = case
        .get("windows")
        .and_then(Value::as_array)
        .map(|windows| {
            windows
                .iter()
                .filter_map(|window| window.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Ok(Case {
        name: name.unwrap_or_default().to_string(),
        replay,
        scripted,
        windows,
        variables: case
            .get("variables")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
        steps: case
            .get("steps")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| format!("{}: a case has a list of steps", path.display()))?,
    })
}

/// Reads every case of the directory.
pub fn read_cases() -> Result<Vec<Case>, String> {
    let directory = case_directory();
    let mut cases = Vec::new();
    for entry in std::fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().and_then(|extension| extension.to_str()) == Some("json") {
            cases.push(read_case(&path)?);
        }
    }
    cases.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(cases)
}

/// Plays the scripted case of the name on the endpoint with the windows of the case and fails the test on each problem that the
/// replay finds. A case with a `log` step needs the application log of its own process, so it runs in a child process that runs
/// the test `test` alone. The cases that the endpoint answers without a page are played by endpoint_cases_test.rs.
pub fn play(test: &str, name: &str) {
    let case = read_case(&case_directory().join(format!("{name}.json")))
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(
        case.scripted,
        "{name} is played by this runner but its case has no scripted page"
    );
    let windows = case.windows.clone();
    if let Some(config) = std::env::var_os(CHILD) {
        run(&case, &windows, Path::new(&config), true);
        return;
    }
    let config = Folder::new();
    if !case.has_log() {
        run(&case, &windows, config.path(), false);
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture", "--test-threads=1"])
        .env(CHILD, config.path())
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    child::require_success(&output, config.path());
}

/// Serves the endpoint with the page of the case in the folder `config`, replays the case and panics on each problem.
fn run(case: &Case, windows: &[String], config: &Path, with_log: bool) {
    let log = with_log.then(|| {
        soksak_host::application_log::start_standard_error(config, "com.soksak.test").unwrap();
        records::start_writer(config)
    });
    let page = CasePage::from_steps(windows, &case.steps)
        .unwrap_or_else(|error| panic!("{}: {error}", case.name));
    let endpoint = Endpoint::start(
        &config.join("sockets"),
        config,
        "endpoint-case",
        page.clone(),
    )
    .unwrap();
    if page.exists("main") {
        endpoint.publish("main").unwrap();
    }
    let mut run = Run {
        address: endpoint.address().to_string(),
        notifier: endpoint.notifier(),
        page: &page,
        log: log.as_ref().map(|writer| (&**writer, config)),
        connections: HashMap::new(),
    };
    let replayed = run.replay(case);
    let mut problems = match replayed {
        Ok(problems) => problems,
        Err(error) => panic!("{}: {error}", case.name),
    };
    problems.extend(page.finish());
    run.connections.clear();
    endpoint.stop();
    if let Some(writer) = &log {
        writer.flush().unwrap();
    }
    assert!(
        problems.is_empty(),
        "{}:\n{}",
        case.name,
        problems.join("\n")
    );
}

/// The replay of one case on a running endpoint.
struct Run<'a> {
    address: String,
    notifier: Notifier,
    page: &'a CasePage,
    /// The writer of the application log and the configuration folder that holds its files, for a case with a `log` step.
    log: Option<(&'a EventLog, &'a Path)>,
    /// The connections of the client that the steps opened, by name.
    connections: HashMap<String, Connection>,
}

/// The kind of a step: send, reply, notify, close, page, log, watching or watched.
fn step_kind(step: &Value) -> Result<&'static str, String> {
    let kinds: Vec<&'static str> = [
        "send", "reply", "notify", "close", "page", "log", "watching", "watched",
    ]
    .into_iter()
    .filter(|kind| step.get(kind).is_some())
    .collect();
    match kinds.as_slice() {
        [kind] => Ok(kind),
        _ => Err(format!(
            "a step must have exactly one of send, reply, notify, close, page, log, watching and watched, has {}",
            kinds.len()
        )),
    }
}

/// The bytes that the client writes for a send step: the raw bytes of raw_hex, or the length prefix and the JSON body of the step.
fn send_frame(send: &Value) -> Result<Vec<u8>, String> {
    if let Some(hex) = send.get("raw_hex").and_then(Value::as_str) {
        return hex::decode(hex).map_err(|error| format!("raw_hex {hex:?}: {error}"));
    }
    let body = serde_json::to_vec(send).map_err(|error| error.to_string())?;
    let length = u32::try_from(body.len()).map_err(|error| error.to_string())?;
    let mut frame = length.to_be_bytes().to_vec();
    frame.extend_from_slice(&body);
    Ok(frame)
}

/// Reads one frame of the host. The end of the connection at a frame boundary is Ok(None), and so is a reset at a frame boundary.
fn read_host_frame(connection: &mut Connection) -> Result<Option<Value>, String> {
    connection
        .set_read_timeout(Some(READ_LIMIT))
        .map_err(|error| error.to_string())?;
    let mut prefix = [0u8; 4];
    let mut filled = 0;
    while filled < prefix.len() {
        match connection.read(&mut prefix[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => return Err("connection closed inside a length prefix".into()),
            Ok(count) => filled += count,
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) if filled == 0 && error.kind() == ErrorKind::ConnectionReset => {
                return Ok(None);
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let length = u32::from_be_bytes(prefix) as usize;
    if length > MAX_FRAME {
        return Err(format!(
            "host frame of {length} bytes exceeds the limit of {MAX_FRAME}"
        ));
    }
    let mut body = vec![0u8; length];
    connection
        .read_exact(&mut body)
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|error| format!("host frame is not JSON: {error}"))
}

/// Whether the application log text holds the record `line`: a record whose text after the time is `line`.
fn log_has(records: &str, line: &str) -> bool {
    records
        .lines()
        .any(|record| record.split_once(' ').is_some_and(|(_, text)| text == line))
}

impl Run<'_> {
    /// The connection that a step uses, opened at its first use.
    fn connection(&mut self, step: &Value) -> &mut Connection {
        let name = step
            .get("connection")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_CONNECTION)
            .to_string();
        let address = &self.address;
        self.connections
            .entry(name)
            .or_insert_with(|| endpoint_client::connect(address))
    }

    /// Removes the connection of a step after its close.
    fn forget(&mut self, step: &Value) {
        let name = step
            .get("connection")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_CONNECTION);
        self.connections.remove(name);
    }

    /// The records that the application log holds now, one line each.
    fn records(&self) -> Result<String, String> {
        let (writer, config) = self.log.ok_or("a log step needs the application log")?;
        writer.flush()?;
        Ok(records::text_of(&records::read_events(
            &records::event_log_path(config),
        )))
    }

    /// Waits until the application log holds the record `line`, which the writer announces with each batch that it writes, and
    /// returns false when the record does not come within READ_LIMIT.
    fn await_line(&self, line: &str) -> Result<bool, String> {
        let (writer, _) = self.log.ok_or("a log step needs the application log")?;
        let (wrote, written) = mpsc::sync_channel::<()>(1);
        writer.set_on_write(Box::new(move |_, _| {
            let _ = wrote.try_send(());
        }));
        let limit = Instant::now() + READ_LIMIT;
        loop {
            if log_has(&self.records()?, line) {
                return Ok(true);
            }
            let left = limit.saturating_duration_since(Instant::now());
            if written.recv_timeout(left).is_err() {
                return Ok(false);
            }
        }
    }

    /// Plays the steps of the case in order and returns the problems found, or the error of a case that is not valid.
    fn replay(&mut self, case: &Case) -> Result<Vec<String>, String> {
        let mut problems = Vec::new();
        let mut bound = Map::new();
        for (index, step) in case.steps.iter().enumerate() {
            let at = format!("step {index}");
            let invalid = |error: String| format!("{at}: {error}");
            match step_kind(step).map_err(invalid)? {
                "send" => {
                    let frame = send_frame(&step["send"]).map_err(invalid)?;
                    if let Err(error) = self.connection(step).write_all(&frame) {
                        problems.push(format!("{at}: the client cannot send: {error}"));
                        return Ok(problems);
                    }
                }
                kind @ ("reply" | "notify") => {
                    let expected = &step[kind];
                    match read_host_frame(self.connection(step)) {
                        Ok(Some(message)) => match_value(
                            expected,
                            &message,
                            &case.variables,
                            &mut bound,
                            &at,
                            &mut problems,
                        )
                        .map_err(invalid)?,
                        Ok(None) => {
                            problems.push(format!(
                                "{at}: the connection closed where the case has {expected}"
                            ));
                            return Ok(problems);
                        }
                        Err(error) => {
                            problems.push(format!(
                                "{at}: no frame of the host ({error}) where the case has {expected}"
                            ));
                            return Ok(problems);
                        }
                    }
                }
                "close" => match step["close"].as_str() {
                    Some("client") => {
                        self.connection(step);
                        self.forget(step);
                    }
                    Some("host") => {
                        match read_host_frame(self.connection(step)) {
                            Ok(None) => {}
                            Ok(Some(message)) => {
                                problems.push(format!(
                                    "{at}: the host sent {message} where the case has its close"
                                ));
                                return Ok(problems);
                            }
                            Err(error) => {
                                problems.push(format!(
                                    "{at}: the host did not close the connection: {error}"
                                ));
                                return Ok(problems);
                            }
                        }
                        self.forget(step);
                    }
                    _ => {
                        return Err(invalid(format!(
                            "close must be host or client, is {}",
                            step["close"]
                        )));
                    }
                },
                "page" => problems.extend(self.play_page(&at, &step["page"])),
                "log" => {
                    let entry = &step["log"];
                    match (entry.get("line"), entry.get("absent")) {
                        (Some(line), None) => {
                            let line = line
                                .as_str()
                                .ok_or_else(|| invalid("line must be text".into()))?;
                            if !self.await_line(line).map_err(invalid)? {
                                problems.push(format!(
                                    "{at}: the application log has no record {line:?}"
                                ));
                            }
                        }
                        (None, Some(absent)) => {
                            let absent = absent
                                .as_str()
                                .ok_or_else(|| invalid("absent must be text".into()))?;
                            let records = self.records().map_err(invalid)?;
                            if records.contains(absent) {
                                problems.push(format!(
                                    "{at}: the application log holds {absent:?}:\n{records}"
                                ));
                            }
                        }
                        _ => {
                            return Err(invalid(
                                "a log step has exactly one of line and absent".into(),
                            ));
                        }
                    }
                }
                "watching" => {
                    let entry = &step["watching"];
                    let window = entry["window"].as_str().unwrap_or_default();
                    let name = entry["name"].as_str().unwrap_or_default();
                    let want = entry["value"]
                        .as_bool()
                        .ok_or_else(|| invalid("value must be true or false".into()))?;
                    let got = self.notifier.watched(window, name);
                    if got != want {
                        problems.push(format!(
                            "{at}: the registry has the watch of {name} of {window} as {got}, the case has {want}"
                        ));
                    }
                }
                _ => {
                    let expected: Vec<String> = serde_json::from_value(step["watched"].clone())
                        .map_err(|error| {
                            invalid(format!("watched must be a list of text: {error}"))
                        })?;
                    let got = self.page.host_watches();
                    if got != expected {
                        problems.push(format!(
                            "{at}: the host was told {got:?}, the case has {expected:?}"
                        ));
                    }
                }
            }
        }
        Ok(problems)
    }

    /// Plays one page step: a call waits until the endpoint has relayed it, a reply was read with its call, a release answers the
    /// oldest held reply, and a notice announces a status change of the page.
    fn play_page(&self, at: &str, page: &Value) -> Vec<String> {
        if let Some(call) = page.get("call") {
            if !self.page.await_call() {
                return vec![format!(
                    "{at}: the endpoint did not send {} to the page within {READ_LIMIT:?}",
                    call["name"]
                )];
            }
        } else if page.get("release").is_some() {
            if let Err(error) = self.page.release() {
                return vec![format!("{at}: {error}")];
            }
        } else if let Some(notice) = page.get("notice") {
            let payload = &notice["payload"];
            let value = serde_json::value::to_raw_value(&payload["value"]).unwrap();
            self.notifier.changed(
                payload["window"].as_str().unwrap_or_default(),
                payload["name"].as_str().unwrap_or_default(),
                payload["surface"].as_str(),
                &value,
            );
        }
        Vec::new()
    }
}

/// The name of a variable of a case: `$` and a name that starts with a lowercase letter and continues with lowercase letters, digits
/// and hyphens.
fn variable_name(text: &str) -> Option<&str> {
    let name = text.strip_prefix('$')?;
    let mut chars = name.chars();
    let first = chars.next()?;
    (first.is_ascii_lowercase()
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
    .then_some(name)
}

/// The type names of a variable, which are one name or a list of names.
fn type_names(value: &Value) -> Result<Vec<String>, String> {
    if let Some(name) = value.as_str() {
        return Ok(vec![name.to_string()]);
    }
    let names = value
        .as_array()
        .ok_or_else(|| format!("type {value} is neither a name nor a list of names"))?;
    names
        .iter()
        .map(|name| {
            name.as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("type {name} is not a name"))
        })
        .collect()
}

/// Whether actual has one of the types. An unknown type name is an error of the case.
fn has_type(types: &[String], actual: &Value) -> Result<bool, String> {
    for name in types {
        let matched = match name.as_str() {
            "any" => true,
            "null" => actual.is_null(),
            "string" => actual.is_string(),
            "boolean" => actual.is_boolean(),
            "number" => actual.is_number(),
            "integer" => actual.as_f64().is_some_and(|number| number.fract() == 0.0),
            "array" => actual.is_array(),
            "object" => actual.is_object(),
            other => return Err(format!("type {other:?} is not a JSON type")),
        };
        if matched {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether actual is an object that has every declared key.
fn has_keys(actual: &Value, keys: &[Value]) -> bool {
    actual.as_object().is_some_and(|object| {
        keys.iter()
            .all(|key| key.as_str().is_some_and(|key| object.contains_key(key)))
    })
}

/// Compares a part of a host frame with the same part of the case. A variable binds the first value that it meets and must equal
/// that value wherever it appears again; the first value must have the declared type, and the declared keys when the variable names
/// them. Numbers are equal when their values are, as the numbers of the Go player are. A difference is a problem; a case that is
/// not valid is an error.
fn match_value(
    expected: &Value,
    actual: &Value,
    variables: &Map<String, Value>,
    bound: &mut Map<String, Value>,
    path: &str,
    problems: &mut Vec<String>,
) -> Result<(), String> {
    if let Some(name) = expected.as_str().and_then(variable_name) {
        let Some(spec) = variables.get(name) else {
            problems.push(format!("{path}: variable ${name} is not declared"));
            return Ok(());
        };
        if let Some(value) = bound.get(name) {
            if value != actual {
                problems.push(format!(
                    "{path}: {name} is {actual}, bound earlier to {value}"
                ));
            }
            return Ok(());
        }
        let type_value = spec
            .get("type")
            .ok_or_else(|| format!("variable ${name} has no type"))?;
        let types = type_names(type_value)?;
        if !has_type(&types, actual)? {
            problems.push(format!(
                "{path}: {actual} is not of type {}",
                types.join(" or ")
            ));
        } else if let Some(keys) = spec.get("keys") {
            let keys = keys
                .as_array()
                .ok_or_else(|| format!("variable ${name} has keys that are not a list"))?;
            if !has_keys(actual, keys) {
                problems.push(format!("{path}: {actual} does not have the keys {keys:?}"));
            }
        }
        bound.insert(name.to_string(), actual.clone());
        return Ok(());
    }
    match expected {
        Value::Array(want) => {
            let Some(got) = actual.as_array().filter(|got| got.len() == want.len()) else {
                problems.push(format!(
                    "{path}: expected an array of {}, got {actual}",
                    want.len()
                ));
                return Ok(());
            };
            for (index, (want, got)) in want.iter().zip(got).enumerate() {
                match_value(
                    want,
                    got,
                    variables,
                    bound,
                    &format!("{path}[{index}]"),
                    problems,
                )?;
            }
        }
        Value::Object(want) => {
            let Some(got) = actual.as_object() else {
                problems.push(format!("{path}: expected an object, got {actual}"));
                return Ok(());
            };
            let keys: BTreeSet<&str> = want.keys().map(String::as_str).collect();
            let actual_keys: BTreeSet<&str> = got.keys().map(String::as_str).collect();
            if keys != actual_keys {
                problems.push(format!("{path}: keys {actual_keys:?} are not {keys:?}"));
                return Ok(());
            }
            for (key, want) in want {
                match_value(
                    want,
                    &got[key.as_str()],
                    variables,
                    bound,
                    &format!("{path}.{key}"),
                    problems,
                )?;
            }
        }
        Value::Number(want) => {
            if actual.as_f64() != want.as_f64() || !actual.is_number() {
                problems.push(format!("{path}: {actual} is not {expected}"));
            }
        }
        _ => {
            if expected != actual {
                problems.push(format!("{path}: {actual} is not {expected}"));
            }
        }
    }
    Ok(())
}
