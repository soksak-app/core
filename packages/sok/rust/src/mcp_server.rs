//! `sok mcp [window]`: the stdio MCP server that serves the endpoint of the application to an agent (docs/spec/cli.md#mcp-server).
//! It uses the MCP library rmcp for the protocol, lists the fixed tools of mcp.json with their input schemas as they are, and reads
//! the live exposure through the endpoint at each call. The Go implementation (packages/sok/go/src/mcp_server.go) gives the same
//! tools, results and error texts.
//!
//! The protocol runs on one thread of a tokio runtime. Each tool call runs its endpoint requests in a thread of its own, because
//! they wait on the endpoint; the calls share one endpoint connection, whose thread `mcp endpoint` passes each answer to its
//! request and each notification to the watches. Every line for the standard error goes through a channel to the thread of the
//! command, which writes it.
//!
//! A task of the runtime reads the standard input before the library: it judges each message line by the rules that the libraries
//! of Go and Rust apply differently (`refusal`), answers or reports a refused line itself and passes the others to the library,
//! and keeps the raw arguments of each tools/call, so the endpoint request holds the argument values as the agent wrote them.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll, ready};
use std::thread::JoinHandle;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ClientJsonRpcMessage, ClientRequest,
    ContentBlock, ErrorCode, Implementation, JsonRpcMessage, ListToolsResult,
    PaginatedRequestParams, ProtocolVersion, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt};
use serde::Serialize;
use serde::de::{Deserializer, MapAccess, Visitor};
use serde_json::Value;
use serde_json::value::RawValue;
use tokio::io::{
    AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader, SimplexStream,
    WriteHalf,
};
use tokio::sync::{mpsc, oneshot};

use crate::agent_window::{
    DESCRIBE_DEFAULT_LIMIT, DESCRIBE_MAX_LIMIT, SurfaceHome, agent_context, agent_home,
    compact_raw, describe_entry, describe_request, is_kind, key_window, lone_surrogate,
    project_window, read_exposure, read_windows, search_exposure,
};
use crate::endpoint::{Client, Failure, Reader, read_endpoint};
use crate::event_log::Level;
use crate::{Arguments, Error, Options, agents, config_dir_of, routine, setup, skill};

/// The revisions whose messages the contract cases state; the library also answers earlier ones unless it is given this list.
const PROTOCOL_VERSIONS: [ProtocolVersion; 2] =
    [ProtocolVersion::V_2026_07_28, ProtocolVersion::V_2025_11_25];

/// Takes a lock whose holder can only have stopped by a panic, which ends the process (routine.rs); the state stays readable.
fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // default: a panic of a holder ends the process, so a poisoned lock is never read by a running server.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The arguments of one call, checked against the input schema of its tool, in the order of their names: each value as the server
/// reads it, and its text as the agent wrote it, which the endpoint request holds (docs/spec/cli.md#mcp-server).
struct ToolArguments {
    values: BTreeMap<String, Value>,
    raw: BTreeMap<String, Box<RawValue>>,
}

impl ToolArguments {
    fn has(&self, name: &str) -> bool {
        self.values.contains_key(name)
    }

    fn text(&self, name: &str) -> &str {
        // default: an optional argument that the call does not give is the empty text, which the input schema allows.
        self.values.get(name).and_then(Value::as_str).unwrap_or("")
    }
}

/// Reads the arguments of a call from their text, the object that the input kept (`Server::keep_arguments`), or None when the call
/// has none or null. The check covers the names, the JSON types of the properties and the required arguments of the input schema;
/// the values are judged by the endpoint. It is written here and not taken from a schema library, because the error texts must be
/// the same in the Go and the Rust server, and the libraries of the two languages word them differently.
fn check_arguments(schema: &Value, text: Option<&RawValue>) -> Result<ToolArguments, String> {
    let properties = schema["properties"].as_object();
    // The input passes only arguments that are an object without a lone surrogate escape (refusal), so each value reads.
    let raw: BTreeMap<String, Box<RawValue>> = match text {
        None => BTreeMap::new(),
        Some(text) => serde_json::from_str(text.get())
            .map_err(|error| format!("arguments are not read: {error}"))?,
    };
    let mut args = BTreeMap::new();
    for (name, value) in &raw {
        let value: Value = serde_json::from_str(value.get())
            .map_err(|error| format!("{name} is not read: {error}"))?;
        args.insert(name.clone(), value);
    }
    for (name, value) in &args {
        let Some(property) = properties.and_then(|properties| properties.get(name)) else {
            return Err(format!("unknown argument {name}"));
        };
        if let Some(kind) = property["type"].as_str()
            && !json_type_is(value, kind)
        {
            let article = if matches!(kind, "integer" | "object" | "array") {
                "an"
            } else {
                "a"
            };
            return Err(format!("{name} must be {article} {kind}"));
        }
    }
    for name in schema["required"].as_array().into_iter().flatten() {
        if let Some(name) = name.as_str()
            && !args.contains_key(name)
        {
            return Err(format!("{name} is required"));
        }
    }
    Ok(ToolArguments { values: args, raw })
}

/// Tells whether value is of the JSON schema type kind. An integer is a number whose text is a 64-bit integer.
fn json_type_is(value: &Value, kind: &str) -> bool {
    match value {
        Value::String(_) => kind == "string",
        Value::Bool(_) => kind == "boolean",
        Value::Number(number) => {
            kind == "number" || (kind == "integer" && number.to_string().parse::<i64>().is_ok())
        }
        Value::Object(_) => kind == "object",
        Value::Array(_) => kind == "array",
        Value::Null => false,
    }
}

/// Compares two JSON values; numbers compare by their value.
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

/// Compares a status value with the value of equals as JSON values.
fn same_value(value: &str, equals: &Value) -> bool {
    serde_json::from_str::<Value>(value).is_ok_and(|value| same_json(&value, equals))
}

/// The answer of one endpoint request.
type Answer = Result<String, Failure>;

/// The part of an endpoint connection that the requests and its thread share.
struct ConnectionState {
    next_id: u64,
    pending: HashMap<u64, std::sync::mpsc::Sender<Answer>>,
    /// The reason the connection ended.
    ended: Option<String>,
    /// Set when the server closes the connection at its end, so the end is not reported.
    closing: bool,
}

/// One endpoint connection of the server. Requests of several calls share it: each request has its own id, and the thread of the
/// connection passes each answer to its request and each notification to the watches.
struct Connection {
    writer: Mutex<Option<Client>>,
    closer: Mutex<Box<dyn Fn() -> Result<(), String> + Send>>,
    state: Mutex<ConnectionState>,
}

impl Connection {
    /// Sends method and waits for its answer or the end of the connection.
    fn request<P: Serialize>(&self, method: &str, params: Option<P>) -> Answer {
        let (sender, receiver) = std::sync::mpsc::channel();
        let id = {
            let mut state = locked(&self.state);
            if let Some(reason) = &state.ended {
                return Err(Failure::Other(reason.clone()));
            }
            let id = state.next_id;
            state.next_id += 1;
            state.pending.insert(id, sender);
            id
        };
        let written = match locked(&self.writer).as_mut() {
            Some(client) => client.send(id, method, params),
            None => Err("endpoint connection closed".to_string()),
        };
        if let Err(error) = written {
            locked(&self.state).pending.remove(&id);
            return Err(Failure::Other(error));
        }
        // The thread of the connection answers every pending request, also when the connection ends.
        receiver
            .recv()
            // default: a dropped sender means the connection ended, which the call reports as a closed connection.
            .unwrap_or_else(|_| Err(Failure::Other("endpoint connection closed".into())))
    }

    fn ended(&self) -> bool {
        locked(&self.state).ended.is_some()
    }
}

/// One call of status_watch_once.
struct Waiter {
    equals: Option<Value>,
    outcome: Option<oneshot::Sender<Answer>>,
}

impl Waiter {
    /// Ends the call with its result; a later result of the same call is not passed.
    fn settle(&mut self, answer: Answer) {
        // A call keeps its receiver until it has left the watch, which removes this waiter first (Handler::run), so the
        // receiver of a waiter is never gone.
        if let Some(outcome) = self.outcome.take()
            && outcome.send(answer).is_err()
        {
            unreachable!("a status_watch_once call dropped its receiver before it left the watch");
        }
    }
}

/// Names one endpoint watch: a window, a status and a surface (empty for none).
#[derive(Clone, PartialEq, Eq, Hash)]
struct WatchKey {
    window: String,
    name: String,
    surface: String,
}

struct WatchState {
    waiters: HashMap<u64, Waiter>,
    /// Whether value holds the current value: the reply of status.get, or a later change.
    known: bool,
    changed: bool,
    value: String,
    /// Whether the endpoint holds the watch no longer, so no status.unwatch is sent.
    ended: bool,
}

/// One endpoint watch that the waiting calls of status_watch_once share.
struct Watch {
    key: WatchKey,
    connection: Arc<Connection>,
    state: Mutex<WatchState>,
}

impl WatchState {
    /// Ends every waiting call with the answer.
    fn settle_all(&mut self, answer: &Answer) {
        for waiter in self.waiters.values_mut() {
            waiter.settle(answer.clone());
        }
    }
}

/// A call of status_watch_once that waits for its value.
struct PendingWatch {
    watch: Arc<Watch>,
    waiter: u64,
    outcome: oneshot::Receiver<Answer>,
    target: Value,
}

/// What the thread of a call returns: the text of a result, or a watch to wait on.
enum Prepared {
    Done(String),
    Watch(PendingWatch),
    /// The answer of the command of messages_read or messages_wait, which a thread of its own waits for.
    Command(oneshot::Receiver<Answer>),
}

struct ServerState {
    connection: Option<Arc<Connection>>,
    reader: Option<JoinHandle<()>>,
    watches: HashMap<WatchKey, Arc<Watch>>,
}

/// The state of one `sok mcp`.
struct Server {
    config_dir: String,
    /// The [window] of the start.
    window: Option<String>,
    project: Option<String>,
    stderr: mpsc::UnboundedSender<String>,
    next_waiter: AtomicU64,
    state: Mutex<ServerState>,
    /// The raw arguments of the tools/call requests that the input passed to the library, by the JSON text of their id; a call
    /// takes its own (Handler::call_tool). A later request with the same id replaces the entry.
    arguments: Mutex<HashMap<String, Option<Box<RawValue>>>>,
}

impl Server {
    /// Writes a line to the standard error through the thread of the command.
    fn report(&self, line: String) {
        // run reads the lines until the thread of the connection has ended (Server::close), and only that thread and the
        // command thread report, so the receiver is never gone.
        self.stderr.send(line).expect(
            "the command thread reads the standard error lines until the server has closed",
        );
    }

    /// Keeps the raw arguments of a tools/call request line that the input passes to the library, for the call of its id. The line
    /// is read as the library reads it, so a line that the library reads as no tools/call request keeps nothing.
    fn keep_arguments(&self, line: &[u8]) {
        /// The part of a tools/call line that holds the arguments.
        #[derive(serde::Deserialize)]
        struct CallLine {
            params: CallParams,
        }
        #[derive(serde::Deserialize)]
        struct CallParams {
            arguments: Option<Box<RawValue>>,
        }
        // The library reads a line without the byte order mark of UTF-8.
        // default: a line without the byte order mark is read as it is.
        let line = line.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(line);
        let Ok(JsonRpcMessage::Request(request)) =
            serde_json::from_slice::<ClientJsonRpcMessage>(line)
        else {
            return;
        };
        if !matches!(request.request, ClientRequest::CallToolRequest(_)) {
            return;
        }
        let id = serde_json::to_string(&request.id).expect("a request id is a number or a text");
        // A call whose arguments are not read finds no entry and fails with that text.
        if let Ok(call) = serde_json::from_slice::<CallLine>(line) {
            locked(&self.arguments).insert(id, call.params.arguments);
        }
    }

    /// Returns the open connection, or connects to the endpoint of the configuration directory.
    fn endpoint(self: &Arc<Self>) -> Result<Arc<Connection>, Failure> {
        let mut state = locked(&self.state);
        if let Some(connection) = &state.connection {
            if !connection.ended() {
                return Ok(connection.clone());
            }
            state.connection = None;
        }
        let endpoint = read_endpoint(Path::new(&self.config_dir))?;
        let client = Client::dial(&endpoint)?;
        let reader = client.reader()?;
        let closer = client.closer()?;
        let connection = Arc::new(Connection {
            writer: Mutex::new(Some(client)),
            closer: Mutex::new(closer),
            state: Mutex::new(ConnectionState {
                next_id: 1,
                pending: HashMap::new(),
                ended: None,
                closing: false,
            }),
        });
        state.connection = Some(connection.clone());
        let server = self.clone();
        let read = connection.clone();
        // The thread of the connection that ended before ends by itself; its handle is not kept.
        state.reader = Some(routine::spawn_named("mcp endpoint", move || {
            server.read(&read, reader)
        }));
        Ok(connection)
    }

    /// Passes the answers and notifications of connection until it ends, then ends every request and watch of it.
    fn read(&self, connection: &Arc<Connection>, mut reader: Reader) {
        let reason = loop {
            let message = match reader.next_message() {
                Ok(message) => message,
                Err(error) => break error,
            };
            let Some(id) = message.id else {
                if let (Some(method), Some(params)) =
                    (message.method.as_deref(), message.params.as_deref())
                {
                    self.notified(connection, method, params.get());
                }
                continue;
            };
            let Some(answer) = locked(&connection.state).pending.remove(&id) else {
                break format!("endpoint sent an answer to request {id} that is not pending");
            };
            let result = match message.error {
                Some((code, message)) => Err(Failure::Endpoint { code, message }),
                // default: a response without a result is a command without a result, whose result is null (docs/spec/cli.md).
                None => Ok(message
                    .result
                    .map_or_else(|| "null".to_string(), |result| result.get().to_string())),
            };
            // A request stays in recv until its answer arrives (Connection::request), so its receiver is never gone.
            answer
                .send(result)
                .expect("a pending request waits for its answer");
        };
        let mut failures = Vec::new();
        if let Some(client) = locked(&connection.writer).take()
            && let Err(error) = client.close()
        {
            failures.push(error);
        }
        if let Err(error) = reader.close() {
            failures.push(error);
        }
        let (pending, closing) = {
            let mut state = locked(&connection.state);
            state.ended = Some(reason.clone());
            (std::mem::take(&mut state.pending), state.closing)
        };
        for answer in pending.into_values() {
            answer
                .send(Err(Failure::Other(reason.clone())))
                .expect("a pending request waits for its answer");
        }
        {
            let mut state = locked(&self.state);
            let ended: Vec<WatchKey> = state
                .watches
                .iter()
                .filter(|(_, watch)| Arc::ptr_eq(&watch.connection, connection))
                .map(|(key, _)| key.clone())
                .collect();
            for key in ended {
                let watch = state
                    .watches
                    .remove(&key)
                    .expect("the key was listed above");
                let mut watch_state = locked(&watch.state);
                watch_state.ended = true;
                watch_state.settle_all(&Err(Failure::Other(reason.clone())));
            }
        }
        if !closing {
            self.report(format!("sok: mcp: {reason}"));
        }
        for failure in failures {
            self.report(format!("sok: mcp: {failure}"));
        }
    }

    /// Passes status.changed and status.ended to the watch that they name.
    fn notified(&self, connection: &Arc<Connection>, method: &str, params: &str) {
        if method != "status.changed" && method != "status.ended" {
            return;
        }
        let read = || -> Result<(WatchKey, String, String), String> {
            let members: BTreeMap<String, Box<serde_json::value::RawValue>> =
                serde_json::from_str::<Option<_>>(params)
                    .map_err(|error| error.to_string())?
                    // default: null parameters have no members, so each required member is reported below as missing.
                    .unwrap_or_default();
            let text = |name: &str| -> Result<String, String> {
                match members.get(name) {
                    None => Ok(String::new()),
                    Some(value) => serde_json::from_str::<Option<String>>(value.get())
                        .map(Option::unwrap_or_default)
                        .map_err(|error| error.to_string()),
                }
            };
            let key = WatchKey {
                window: text("window")?,
                name: text("name")?,
                surface: text("surface")?,
            };
            let value = members
                .get("value")
                .map_or_else(|| "null".to_string(), |value| value.get().to_string());
            Ok((key, value, text("reason")?))
        };
        let (key, value, reason) = match read() {
            Ok(read) => read,
            Err(error) => {
                self.report(format!("sok: mcp: {method} has unexpected params: {error}"));
                return;
            }
        };
        let mut state = locked(&self.state);
        let Some(watch) = state.watches.get(&key).cloned() else {
            return;
        };
        if !Arc::ptr_eq(&watch.connection, connection) {
            return;
        }
        let mut watch_state = locked(&watch.state);
        if method == "status.ended" {
            watch_state.ended = true;
            state.watches.remove(&key);
            let answer = Err(Failure::Other(format!(
                "status {} ended: {reason}",
                key.name
            )));
            watch_state.settle_all(&answer);
            return;
        }
        watch_state.known = true;
        watch_state.changed = true;
        watch_state.value = value.clone();
        for waiter in watch_state.waiters.values_mut() {
            if waiter
                .equals
                .as_ref()
                .is_none_or(|equals| same_value(&value, equals))
            {
                waiter.settle(Ok(value.clone()));
            }
        }
    }

    /// The window of a call: its window argument, else the [window] of the start, else the window of the surface that
    /// `agent.surface` answers for the process of the server, else the key window of windows.list, else its first window
    /// (docs/spec/cli.md#mcp-server). It returns the home of the agent's surface too and whether it asked `agent.surface`, so a
    /// description does not ask twice.
    fn select_window(
        &self,
        connection: &Connection,
        args: &ToolArguments,
    ) -> Result<(String, Option<SurfaceHome>, bool), Failure> {
        let mut request = |method: &str, params: Option<Value>| connection.request(method, params);
        if args.has("window") {
            return Ok((args.text("window").to_string(), None, false));
        }
        if let Some(window) = &self.window {
            return Ok((window.clone(), None, false));
        }
        if let Some(project) = &self.project {
            let windows = read_windows(&mut request)?;
            return Ok((project_window(&windows, project)?, None, false));
        }
        if let Some(home) = agent_home(&mut request)? {
            return Ok((home.window.clone(), Some(home), true));
        }
        Ok((key_window(&mut request)?, None, true))
    }

    /// Runs one tool up to its result, or up to the wait of a watch.
    fn call(self: &Arc<Self>, name: &str, args: &ToolArguments) -> Result<Prepared, Failure> {
        // The values that the server itself reads are checked before the first endpoint request.
        let mut limit = 0;
        match name {
            "exposure_search" | "exposure_describe" => {
                if args.has("kind") && !is_kind(args.text("kind")) {
                    return Err(Failure::Other(
                        "kind must be status, command or element".into(),
                    ));
                }
                if name == "exposure_search" {
                    limit = limit_argument(args, 50, 200)?;
                }
            }
            "window_describe" => {
                limit = limit_argument(args, DESCRIBE_DEFAULT_LIMIT, DESCRIBE_MAX_LIMIT)?;
            }
            _ => {}
        }
        let connection = self.endpoint()?;
        let mut request = |method: &str, params: Option<Value>| connection.request(method, params);
        let passed = |answer: Answer| -> Result<Prepared, Failure> {
            Ok(Prepared::Done(compact_raw(&answer?)?))
        };
        match name {
            "windows_list" => return passed(request("windows.list", None)),
            "agent_context" => {
                return Ok(Prepared::Done(agent_context(
                    &mut request,
                    &self.config_dir,
                )?));
            }
            _ => {}
        }
        if let Some(operation) = name.strip_prefix("messages_") {
            return messages_call(&connection, operation, args);
        }
        let (window, home, asked) = self.select_window(&connection, args)?;
        // The params of an endpoint request: the window and each named argument of the call that is present, with the text that
        // the agent wrote without the white space between its tokens.
        let with = |names: &[&str]| -> Result<BTreeMap<String, Box<RawValue>>, Failure> {
            let mut params = BTreeMap::new();
            params.insert(
                "window".to_string(),
                serde_json::value::to_raw_value(&window).map_err(unwritten)?,
            );
            for name in names {
                if let Some(value) = args.raw.get(*name) {
                    params.insert((*name).to_string(), compacted(value)?);
                }
            }
            Ok(params)
        };
        let send = |method: &str, params: BTreeMap<String, Box<RawValue>>| {
            connection.request(method, Some(params))
        };
        match name {
            "window_describe" => Ok(Prepared::Done(describe_request(
                &mut request,
                &window,
                home,
                asked,
                args.text("surface"),
                args.values.get("full") == Some(&Value::Bool(true)),
                args.text("after"),
                limit,
            )?)),
            "exposure_search" | "exposure_describe" => {
                let result = request(
                    "exposure.list",
                    Some(serde_json::json!({ "window": window })),
                )?;
                let read = read_exposure(&result)?;
                let kind = args.text("kind");
                if name == "exposure_describe" {
                    return Ok(Prepared::Done(describe_entry(
                        &read,
                        kind,
                        args.text("name"),
                    )?));
                }
                Ok(Prepared::Done(search_exposure(
                    &read,
                    kind,
                    args.text("query"),
                    args.text("after"),
                    limit,
                )?))
            }
            "command_run" => {
                let mut params = with(&["surface", "name"])?;
                let given = match args.raw.get("params") {
                    Some(value) => compacted(value)?,
                    None => RawValue::from_string("{}".to_string()).map_err(unwritten)?,
                };
                params.insert("params".to_string(), given);
                passed(send("command.run", params))
            }
            "status_get" => passed(send("status.get", with(&["name", "surface"])?)),
            "status_watch_once" => Ok(Prepared::Watch(self.start_watch(
                &connection,
                &window,
                args,
            ))),
            "element_rect" => passed(send("element.rect", with(&["name", "surface", "index"])?)),
            "element_act" => passed(send(
                "element.act",
                with(&["name", "surface", "index", "action", "value", "event"])?,
            )),
            "input_pointer" => passed(send(
                "input.pointer",
                with(&[
                    "x", "y", "phase", "button", "deltaX", "deltaY", "clicks", "activate",
                ])?,
            )),
            "input_key" => passed(send(
                "input.key",
                with(&["key", "text", "modifiers", "phase"])?,
            )),
            "input_text" => passed(send(
                "input.text",
                with(&["phase", "text", "selection", "replacement"])?,
            )),
            _ => Err(Failure::Other(format!("unknown tool {name}"))),
        }
    }

    /// Starts status_watch_once: the calls that wait on one status of a window and surface share one endpoint watch, and the
    /// first of them sends status.watch and then status.get.
    fn start_watch(
        &self,
        connection: &Arc<Connection>,
        window: &str,
        args: &ToolArguments,
    ) -> PendingWatch {
        let key = WatchKey {
            window: window.to_string(),
            name: args.text("name").to_string(),
            surface: args.text("surface").to_string(),
        };
        let equals = args.values.get("equals").cloned();
        let mut target = serde_json::json!({ "window": window, "name": key.name });
        if args.has("surface") {
            target["surface"] = Value::String(key.surface.clone());
        }
        let waiter = self.next_waiter.fetch_add(1, Ordering::Relaxed);
        let (sender, outcome) = oneshot::channel();
        let (watch, shared) = {
            let mut state = locked(&self.state);
            let shared = state
                .watches
                .get(&key)
                .filter(|watch| Arc::ptr_eq(&watch.connection, connection))
                .cloned();
            // default: a key without a watch of this connection starts a new watch.
            let watch = shared.clone().unwrap_or_else(|| {
                let watch = Arc::new(Watch {
                    key: key.clone(),
                    connection: connection.clone(),
                    state: Mutex::new(WatchState {
                        waiters: HashMap::new(),
                        known: false,
                        changed: false,
                        value: String::new(),
                        ended: false,
                    }),
                });
                state.watches.insert(key.clone(), watch.clone());
                watch
            });
            let mut watch_state = locked(&watch.state);
            let mut joined = Waiter {
                equals,
                outcome: Some(sender),
            };
            if shared.is_some()
                && watch_state.known
                && joined
                    .equals
                    .as_ref()
                    .is_some_and(|equals| same_value(&watch_state.value, equals))
            {
                joined.settle(Ok(watch_state.value.clone()));
            }
            watch_state.waiters.insert(waiter, joined);
            drop(watch_state);
            (watch, shared.is_some())
        };
        if !shared {
            match connection.request("status.watch", Some(target.clone())) {
                Err(failure) => self.end_watch(&watch, failure),
                Ok(_) => match connection.request("status.get", Some(target.clone())) {
                    // The waiters end with the failure; the last of them ends the watch with status.unwatch.
                    Err(failure) => {
                        let _state = locked(&self.state);
                        let mut watch_state = locked(&watch.state);
                        watch_state.settle_all(&Err(failure));
                    }
                    Ok(value) => {
                        let _state = locked(&self.state);
                        let mut watch_state = locked(&watch.state);
                        if !watch_state.changed && !watch_state.ended {
                            watch_state.known = true;
                            watch_state.value = value.clone();
                            for other in watch_state.waiters.values_mut() {
                                if other
                                    .equals
                                    .as_ref()
                                    .is_some_and(|equals| same_value(&value, equals))
                                {
                                    other.settle(Ok(value.clone()));
                                }
                            }
                        }
                    }
                },
            }
        }
        PendingWatch {
            watch,
            waiter,
            outcome,
            target,
        }
    }

    /// Ends the waiters of a watch that the endpoint did not start, so no status.unwatch follows.
    fn end_watch(&self, watch: &Arc<Watch>, failure: Failure) {
        let mut state = locked(&self.state);
        let mut watch_state = locked(&watch.state);
        watch_state.ended = true;
        if state
            .watches
            .get(&watch.key)
            .is_some_and(|current| Arc::ptr_eq(current, watch))
        {
            state.watches.remove(&watch.key);
        }
        watch_state.settle_all(&Err(failure));
    }

    /// Removes a waiter from its watch; the last waiter of a watch that the endpoint still holds sends status.unwatch.
    fn leave(&self, watch: &Arc<Watch>, waiter: u64, target: Value) -> Result<(), Failure> {
        let last = {
            let mut state = locked(&self.state);
            let mut watch_state = locked(&watch.state);
            watch_state.waiters.remove(&waiter);
            let last = watch_state.waiters.is_empty() && !watch_state.ended;
            if last {
                watch_state.ended = true;
                if state
                    .watches
                    .get(&watch.key)
                    .is_some_and(|current| Arc::ptr_eq(current, watch))
                {
                    state.watches.remove(&watch.key);
                }
            }
            last
        };
        if last {
            watch.connection.request("status.unwatch", Some(target))?;
        }
        Ok(())
    }

    /// Closes the connection at the end of the server and waits for its thread.
    fn close(&self) {
        let (connection, reader) = {
            let mut state = locked(&self.state);
            (state.connection.take(), state.reader.take())
        };
        if let Some(connection) = connection {
            locked(&connection.state).closing = true;
            if let Err(error) = (locked(&connection.closer))() {
                self.report(format!("sok: mcp: {error}"));
            }
        }
        if let Some(reader) = reader {
            // A panic of the thread ends the process (routine.rs); a join that returns one passes it on.
            if let Err(panic) = reader.join() {
                std::panic::resume_unwind(panic);
            }
        }
    }
}

/// The text of a value of an agent without the white space between its tokens; numbers and strings keep their text.
fn compacted(value: &RawValue) -> Result<Box<RawValue>, Failure> {
    RawValue::from_string(compact_raw(value.get())?).map_err(unwritten)
}

/// The failure to write a value of an endpoint request.
fn unwritten(error: serde_json::Error) -> Failure {
    Failure::Other(format!("a value of the request is not written: {error}"))
}

/// Reads limit, an integer from 1 to max with the default fallback when it is absent. The text of the agent is read, so 1e1 and
/// 10.0 are no integer, as in the Go server.
fn limit_argument(args: &ToolArguments, fallback: usize, max: usize) -> Result<usize, Failure> {
    let Some(limit) = args.raw.get("limit") else {
        return Ok(fallback);
    };
    limit
        .get()
        .parse::<i64>()
        // default: a limit that is no integer is reported below with the range of the limit.
        .ok()
        .filter(|limit| (1..=max as i64).contains(limit))
        .map(|limit| limit as usize)
        .ok_or_else(|| Failure::Other(format!("limit must be an integer from 1 to {max}")))
}

/// A group of exposure.snapshot, with the members that messages_call reads.
#[derive(serde::Deserialize)]
struct SnapshotGroup {
    #[serde(default)]
    owner: String,
    #[serde(default)]
    surface: String,
    #[serde(default)]
    plugin: String,
    #[serde(default)]
    commands: Vec<SnapshotCommand>,
}

#[derive(serde::Deserialize)]
struct SnapshotCommand {
    #[serde(default)]
    name: String,
}

#[derive(serde::Deserialize)]
struct Snapshot {
    #[serde(default)]
    groups: Vec<SnapshotGroup>,
}

#[derive(serde::Deserialize)]
struct Home {
    #[serde(default)]
    window: String,
}

/// Prepares messages_read or messages_wait (docs/spec/messaging.md#path-of-the-reads): the window of the terminal from
/// surface.window, its plugin from the group of the surface in exposure.snapshot, and command.run of
/// <plugin>.messages.<operation> on the surface in a thread of its own. The call has no time limit; a cancelled call ends without a
/// result and leaves its endpoint request open, whose later answer the thread drops.
fn messages_call(
    connection: &Arc<Connection>,
    operation: &str,
    args: &ToolArguments,
) -> Result<Prepared, Failure> {
    let terminal = args.text("terminal").to_string();
    let result = match connection.request(
        "surface.window",
        Some(serde_json::json!({ "surface": terminal })),
    ) {
        Err(Failure::Endpoint { code: 1012, .. }) => {
            return Err(Failure::Other(format!(
                "unknown-terminal: surface {terminal} is in no window"
            )));
        }
        other => other?,
    };
    let window = serde_json::from_str::<Home>(&result)
        .map_err(|error| {
            Failure::Other(format!(
                "surface.window returned an unexpected value: {error}: {result}"
            ))
        })?
        .window;
    if window.is_empty() {
        return Err(Failure::Other(format!(
            "surface.window returned an unexpected value: {result}"
        )));
    }
    let result = connection.request(
        "exposure.snapshot",
        Some(serde_json::json!({ "window": window, "surface": terminal })),
    )?;
    let snapshot = serde_json::from_str::<Snapshot>(&result).map_err(|_| {
        Failure::Other(format!(
            "exposure.snapshot returned an unexpected value: {result}"
        ))
    })?;
    let Some(group) = snapshot
        .groups
        .iter()
        .find(|group| group.owner == "surface" && group.surface == terminal)
    else {
        return Err(Failure::Other(format!(
            "exposure.snapshot of window {window} holds no group of surface {terminal}"
        )));
    };
    let command = format!("{}.messages.{operation}", group.plugin);
    if !group.commands.iter().any(|entry| entry.name == command) {
        return Err(Failure::Other(format!(
            "unknown-terminal: surface {terminal} of plugin {} registers no command {command}",
            group.plugin
        )));
    }
    let mut params = BTreeMap::new();
    for member in ["after", "registration"] {
        if let Some(value) = args.raw.get(member) {
            params.insert(member.to_string(), compacted(value)?);
        }
    }
    let mut request = BTreeMap::new();
    for (member, value) in [
        ("window", &window),
        ("surface", &terminal),
        ("name", &command),
    ] {
        request.insert(
            member.to_string(),
            serde_json::value::to_raw_value(value).map_err(unwritten)?,
        );
    }
    request.insert(
        "params".to_string(),
        serde_json::value::to_raw_value(&params).map_err(unwritten)?,
    );
    let (sender, receiver) = oneshot::channel();
    let connection = connection.clone();
    routine::spawn_named("mcp messages", move || {
        // A call that the client cancelled has dropped its receiver, so the later answer has no call to go to.
        if let Err(unsent) = sender.send(connection.request("command.run", Some(request))) {
            drop(unsent);
        }
    });
    Ok(Prepared::Command(receiver))
}

/// Runs a body in a thread of its own and returns its result to the protocol thread.
async fn in_thread<T: Send + 'static>(name: &str, body: impl FnOnce() -> T + Send + 'static) -> T {
    let (sender, receiver) = oneshot::channel();
    routine::spawn_named(name, move || {
        // The protocol thread waits for the result until it receives it, unless the server stopped serving when standard input
        // ended: the runtime then drops the call, and its result has no client to go to.
        if let Err(unsent) = sender.send(body()) {
            drop(unsent);
        }
    });
    // A thread that ends without a result has panicked, which ends the process (routine.rs).
    receiver
        .await
        .expect("the thread of a call returns its result")
}

/// The MCP handler of rmcp.
struct Handler {
    server: Arc<Server>,
    tools: Vec<Tool>,
    schemas: HashMap<String, Value>,
    instructions: String,
    version: String,
}

impl Handler {
    /// Runs a call to its text, or to the text of its tool error; None when the client cancelled it.
    async fn run(
        &self,
        name: String,
        args: ToolArguments,
        context: &RequestContext<RoleServer>,
    ) -> Option<Result<String, String>> {
        let server = self.server.clone();
        let prepared = in_thread("mcp call", move || server.call(&name, &args)).await;
        let pending = match prepared {
            Err(failure) => return Some(Err(failure.to_string())),
            Ok(Prepared::Done(text)) => return Some(Ok(text)),
            Ok(Prepared::Watch(pending)) => pending,
            Ok(Prepared::Command(answer)) => {
                return tokio::select! {
                    answer = answer => Some(
                        answer
                            // default: a dropped sender means the thread of the command ended without an answer, which the call reports.
                            .unwrap_or_else(|_| Err(Failure::Other("the command ended without an answer".into())))
                            .and_then(|value| compact_raw(&value))
                            .map_err(|failure| failure.to_string()),
                    ),
                    () = context.ct.cancelled() => None,
                };
            }
        };
        let PendingWatch {
            watch,
            waiter,
            outcome,
            target,
        } = pending;
        // The call keeps its receiver until it has left the watch, so a value that arrives after a cancel finds it.
        let mut outcome = outcome;
        let answer = tokio::select! {
            // default: a dropped sender means the watch ended, which the call reports as an error.
            answer = &mut outcome => Some(answer.unwrap_or_else(|_| Err(Failure::Other("the watch ended without a result".into())))),
            () = context.ct.cancelled() => None,
        };
        let server = self.server.clone();
        let left = in_thread("mcp leave", move || server.leave(&watch, waiter, target)).await;
        drop(outcome);
        let outcome = answer?;
        Some(match (outcome, left) {
            (Err(failure), _) => Err(failure.to_string()),
            (Ok(_), Err(failure)) => Err(failure.to_string()),
            (Ok(value), Ok(())) => compact_raw(&value).map_err(|failure| failure.to_string()),
        })
    }
}

impl ServerHandler for Handler {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(self.instructions.clone())
            .with_server_info(Implementation::new("soksak", self.version.clone()))
            .with_protocol_version(ProtocolVersion::V_2025_11_25)
    }

    fn supported_protocol_versions(&self) -> Cow<'static, [ProtocolVersion]> {
        Cow::Borrowed(&PROTOCOL_VERSIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(self.tools.clone()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        // The arguments are read from the text that the input kept, not from the values of the library, which hold a number as a
        // 64-bit value and lose its text.
        let id = serde_json::to_string(&context.id).expect("a request id is a number or a text");
        let Some(arguments) = locked(&self.server.arguments).remove(&id) else {
            return Err(ErrorData::internal_error(
                "the arguments of the call were not read",
                None,
            ));
        };
        let name = request.name.to_string();
        let Some(schema) = self.schemas.get(&name) else {
            return Err(ErrorData::invalid_params(
                format!("unknown tool {name}"),
                None,
            ));
        };
        let outcome = match check_arguments(schema, arguments.as_deref()) {
            Err(text) => Err(text),
            Ok(args) => match self.run(name, args, &context).await {
                Some(outcome) => outcome,
                // The library sends no response to a cancelled request.
                None => {
                    return Err(ErrorData::internal_error(
                        "the client cancelled the call",
                        None,
                    ));
                }
            },
        };
        Ok(CallToolResponse::from(match outcome {
            Ok(text) => CallToolResult::success(vec![ContentBlock::text(text)]),
            Err(text) => CallToolResult::error(vec![ContentBlock::text(text)]),
        }))
    }
}

/// The greatest length of one message line, the bound of the stdio transports of both libraries.
const MCP_LINE_LIMIT: usize = 16 * 1024 * 1024;

/// The standard output, which the library and the input write whole lines to.
type Output = Arc<tokio::sync::Mutex<tokio::io::Stdout>>;

/// The answer to a line that is not valid UTF-8 or not valid JSON: the JSON-RPC parse error, whose id is null because no id of
/// the line can be read.
const PARSE_ERROR: &[u8] =
    b"{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32700,\"message\":\"Parse error\"}}\n";

/// The deepest nesting of arrays and objects that a message line may have. serde_json, which rmcp reads each line with, refuses a
/// value that enters its 128th level, while encoding/json reads 10000 levels, so both servers refuse a deeper line as a parse
/// error before the library reads it. The check of validity above reads a value without this bound, so the depth is counted here.
const DEPTH_LIMIT: usize = 127;

/// The deepest nesting of arrays and objects of a valid JSON text: the brackets and braces outside strings.
fn nesting_depth(text: &str) -> usize {
    let (mut depth, mut deepest) = (0usize, 0usize);
    let (mut in_string, mut escaped) = (false, false);
    for byte in text.bytes() {
        if in_string {
            match byte {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'[' | b'{' => {
                depth += 1;
                deepest = deepest.max(depth);
            }
            b']' | b'}' => depth -= 1,
            _ => {}
        }
    }
    deepest
}

/// What the input does with one message line.
enum Refusal {
    /// The library reads the line.
    Pass,
    /// The line is refused with this answer, a whole line.
    Answer(Vec<u8>),
    /// The line is refused without an answer, because it has no id to answer; the server reports the reason.
    Report(String),
}

/// The members of a JSON object in their order, each name and value with its text as written. A name is read as written, because
/// a name with a lone surrogate escape is no Rust string.
struct RawMembers(Vec<(Box<RawValue>, Box<RawValue>)>);

impl<'de> serde::Deserialize<'de> for RawMembers {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Members;
        impl<'de> Visitor<'de> for Members {
            type Value = RawMembers;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<RawMembers, A::Error> {
                let mut members = Vec::new();
                while let Some(member) = map.next_entry::<Box<RawValue>, Box<RawValue>>()? {
                    members.push(member);
                }
                Ok(RawMembers(members))
            }
        }
        deserializer.deserialize_map(Members)
    }
}

impl RawMembers {
    /// The value of the last member whose decoded name is name, as a later member of the same name replaces an earlier one.
    fn get(&self, name: &str) -> Option<&RawValue> {
        self.0
            .iter()
            .rev()
            .find(|(written, _)| {
                serde_json::from_str::<String>(written.get()).is_ok_and(|read| read == name)
            })
            .map(|(_, value)| value.as_ref())
    }
}

/// Tells whether the text of a JSON value is of the JSON schema type kind.
fn raw_type_is(value: Option<&RawValue>, kind: &str) -> bool {
    value.is_some_and(|value| {
        serde_json::from_str::<Value>(value.get()).is_ok_and(|value| json_type_is(&value, kind))
    })
}

/// Judges one message line before the library reads it, for the rules that the libraries of Go and Rust apply differently or not
/// at all (docs/spec/cli.md#mcp-server): a string of the message with a lone surrogate escape, which serde_json refuses with the
/// whole line and encoding/json decodes to U+FFFD, and a tools/call without a string name or with arguments that are present, not
/// null and no object, which rmcp reads as a custom request and the Go library refuses with its decoding error. A request is
/// answered with the JSON-RPC error -32602 and its id; a message that has no id to answer is refused with the reason, which the
/// server reports. A line that is not valid UTF-8, not valid JSON or nested deeper than DEPTH_LIMIT is answered with the parse
/// error, which rmcp would ignore and go-sdk would answer by ending the session. A JSON value that is no object passes, and the
/// library judges it. The Go server judges each line the same way (packages/sok/go/src/mcp_server.go).
fn refusal(line: &[u8]) -> Refusal {
    let Ok(text) = std::str::from_utf8(line) else {
        return Refusal::Answer(PARSE_ERROR.to_vec());
    };
    if serde_json::from_str::<serde::de::IgnoredAny>(text).is_err()
        || nesting_depth(text) > DEPTH_LIMIT
    {
        return Refusal::Answer(PARSE_ERROR.to_vec());
    }
    let Ok(members) = serde_json::from_str::<RawMembers>(text) else {
        return Refusal::Pass;
    };
    let refuse = |reason: String| -> Refusal {
        let id = members.get("id");
        let answerable = members.get("method").is_some()
            && (raw_type_is(id, "string") || raw_type_is(id, "number"))
            && !id.is_some_and(|id| lone_surrogate(id.get()));
        let Some(id) = id.filter(|_| answerable) else {
            return Refusal::Report(reason);
        };
        /// The answer of a refused request; its members are written in the order of their names.
        #[derive(Serialize)]
        struct Refused<'a> {
            error: RefusedError<'a>,
            id: &'a RawValue,
            jsonrpc: &'static str,
        }
        #[derive(Serialize)]
        struct RefusedError<'a> {
            code: i32,
            message: &'a str,
        }
        let answer = Refused {
            error: RefusedError {
                code: ErrorCode::INVALID_PARAMS.0,
                message: &reason,
            },
            id,
            jsonrpc: "2.0",
        };
        match serde_json::to_vec(&answer) {
            Ok(mut answer) => {
                answer.push(b'\n');
                Refusal::Answer(answer)
            }
            Err(error) => Refusal::Report(format!("{reason}; {error}")),
        }
    };
    if let Some(path) = surrogate_path(text, "") {
        return refuse(format!("{path} holds a lone surrogate escape"));
    }
    let method = members
        .get("method")
        // default: a method that is no string is no tools/call, and the library answers that message.
        .and_then(|method| serde_json::from_str::<String>(method.get()).ok());
    if method.as_deref() != Some("tools/call") || members.get("id").is_none() {
        return Refusal::Pass;
    }
    let params = members
        .get("params")
        // default: parameters that are no object are refused below with "name must be a string".
        .and_then(|params| serde_json::from_str::<RawMembers>(params.get()).ok());
    let Some(params) = params.filter(|params| raw_type_is(params.get("name"), "string")) else {
        return refuse("name must be a string".into());
    };
    if let Some(arguments) = params.get("arguments")
        && arguments.get() != "null"
        && !raw_type_is(Some(arguments), "object")
    {
        return refuse("arguments must be an object".into());
    }
    Refusal::Pass
}

/// Finds the first string of a JSON text, a member name or a value, that holds a lone surrogate escape and returns its path: the
/// member names as written, joined by dots, and [n] for the item n of an array. No JSON library reports the path of such a string:
/// serde_json refuses the escape with the whole text, so the walk reads each name and value as written.
fn surrogate_path(text: &str, path: &str) -> Option<String> {
    let text = text.trim_matches([' ', '\t', '\n', '\r']);
    match text.as_bytes().first()? {
        b'"' => lone_surrogate(text).then(|| path.to_string()),
        b'{' => {
            // default: text that does not parse holds no lone surrogate path, and the library reports it as invalid JSON.
            let members: RawMembers = serde_json::from_str(text).ok()?;
            for (name, value) in &members.0 {
                let written = name.get();
                let written = &written[1..written.len() - 1];
                let inner = if path.is_empty() {
                    written.to_string()
                } else {
                    format!("{path}.{written}")
                };
                if lone_surrogate(name.get()) {
                    return Some(inner);
                }
                if let Some(found) = surrogate_path(value.get(), &inner) {
                    return Some(found);
                }
            }
            None
        }
        b'[' => {
            // default: text that does not parse holds no lone surrogate path, and the library reports it as invalid JSON.
            let items: Vec<Box<RawValue>> = serde_json::from_str(text).ok()?;
            items
                .iter()
                .enumerate()
                .find_map(|(n, item)| surrogate_path(item.get(), &format!("{path}[{n}]")))
        }
        _ => None,
    }
}

/// Reads the message lines of input until it ends and then shuts pass down, which ends the library at the end of its input
/// (docs/spec/cli.md#mcp-server). The shutdown is required: the write half of a simplex stream shares the stream with the read
/// half, so dropping it leaves the stream open, and the library would wait for a next line after the standard input ended. The
/// error of the lines comes before the error of the shutdown.
async fn filter_input(
    server: Arc<Server>,
    input: impl AsyncRead + Unpin,
    mut pass: WriteHalf<SimplexStream>,
    output: Output,
) -> Result<(), String> {
    let passed = pass_lines(&server, input, &mut pass, &output).await;
    let shut = pass.shutdown().await.map_err(|error| error.to_string());
    passed.and(shut)
}

/// Reads the message lines of input until it ends: a line that `refusal` refuses is answered on output or reported, and the
/// other lines go to pass, which the library reads. A line longer than MCP_LINE_LIMIT ends the input with an error, and so does a
/// failed read or write.
async fn pass_lines(
    server: &Server,
    input: impl AsyncRead + Unpin,
    pass: &mut WriteHalf<SimplexStream>,
    output: &Output,
) -> Result<(), String> {
    let mut input = BufReader::new(input);
    loop {
        let mut line = Vec::new();
        let read = (&mut input)
            .take(MCP_LINE_LIMIT as u64)
            .read_until(b'\n', &mut line)
            .await
            .map_err(|error| error.to_string())?;
        if read == 0 {
            return Ok(());
        }
        if line.last() == Some(&b'\n') {
            line.pop();
        } else if line.len() >= MCP_LINE_LIMIT {
            return Err(format!("mcp message exceeds {MCP_LINE_LIMIT} bytes"));
        }
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        match refusal(&line) {
            Refusal::Answer(answer) => {
                let mut output = output.lock().await;
                output
                    .write_all(&answer)
                    .await
                    .map_err(|error| error.to_string())?;
                output.flush().await.map_err(|error| error.to_string())?;
            }
            Refusal::Report(reason) => server.report(format!("sok: mcp: {reason}")),
            Refusal::Pass => {
                server.keep_arguments(&line);
                line.push(b'\n');
                pass.write_all(&line)
                    .await
                    .map_err(|error| error.to_string())?;
            }
        }
    }
}

/// A write of complete lines to the standard output.
type Writing = Pin<Box<dyn Future<Output = std::io::Result<()>> + Send>>;

/// The writer of the library: it writes each complete line to the standard output in one write under the lock of the output, so
/// an answer of the input never falls inside a message of the library.
struct LineOutput {
    output: Output,
    /// The bytes after the last complete line.
    partial: Vec<u8>,
    /// The write of complete lines that has not ended; the next write or flush waits for it.
    writing: Option<Writing>,
}

impl LineOutput {
    fn poll_writing(&mut self, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        let Some(writing) = self.writing.as_mut() else {
            return Poll::Ready(Ok(()));
        };
        let result = ready!(writing.as_mut().poll(cx));
        self.writing = None;
        Poll::Ready(result)
    }
}

impl AsyncWrite for LineOutput {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let this = self.get_mut();
        ready!(this.poll_writing(cx))?;
        this.partial.extend_from_slice(buf);
        if let Some(end) = this.partial.iter().rposition(|byte| *byte == b'\n') {
            let lines: Vec<u8> = this.partial.drain(..=end).collect();
            let output = this.output.clone();
            this.writing = Some(Box::pin(async move {
                let mut output = output.lock().await;
                output.write_all(&lines).await?;
                output.flush().await
            }));
        }
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.get_mut().poll_writing(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.get_mut().poll_writing(cx)
    }
}

/// mcp.json: the instructions and the tools.
#[derive(serde::Deserialize)]
struct Definition {
    instructions: String,
    tools: Vec<Value>,
}

/// Brings the skill current before the server reads the first message (docs/spec/cli.md#mcp-server). No agent folder is no error
/// here; a failure is written to the standard error and stored as `sok.skill`, and the server starts in each case.
fn bring_skill_current(stderr: &mut dyn Write) -> Result<(), Error> {
    let failures = setup::Environment::current()
        .and_then(|environment| skill::bring_skill_current(&environment));
    let failures: Vec<(Option<String>, String, String)> = match failures {
        Ok(failures) => failures
            .into_iter()
            .map(|failure| {
                let text = failure.to_string();
                (
                    Some(failure.file.display().to_string()),
                    failure.reason,
                    text,
                )
            })
            .collect(),
        Err(error) => vec![(None, error.clone(), error)],
    };
    for (file, reason, text) in failures {
        let fields = match file {
            Some(file) => serde_json::json!({ "file": file, "reason": reason }),
            None => serde_json::json!({ "reason": reason }),
        };
        crate::replay::emit_run_event(Level::Error, "sok.skill", &fields);
        writeln!(stderr, "sok: skill: {text}").map_err(|error| Error::Failed(error.to_string()))?;
    }
    Ok(())
}

/// Serves MCP on standard input and output until standard input ends.
pub(crate) fn run(a: &Arguments, stderr: &mut dyn Write, options: &Options) -> Result<(), Error> {
    if a.positionals.len() > 1 {
        return Err(Error::Usage(
            "mcp takes no argument besides --window <name> or --project <directory>".into(),
        ));
    }
    let config_dir = config_dir_of(&a.values, options)?;
    let window = a.values.get("window").cloned();
    let project = a.values.get("project").cloned();
    if window.is_some() && project.is_some() {
        return Err(Error::Usage(
            "--window and --project select the window in two ways; give one".into(),
        ));
    }
    bring_skill_current(stderr)?;
    let definition: Definition = serde_json::from_str(agents::MCP).map_err(|error| {
        Error::Failed(if error.classify() == serde_json::error::Category::Data {
            "mcp.json is not a JSON object".to_string()
        } else {
            format!(
                "mcp.json is not valid JSON at line {} column {}",
                error.line(),
                error.column()
            )
        })
    })?;
    let mut tools = Vec::new();
    let mut schemas = HashMap::new();
    for tool in definition.tools {
        let schema = tool["inputSchema"].clone();
        let tool = serde_json::from_value::<Tool>(tool).map_err(|error| {
            Error::Failed(format!("mcp.json has a tool that is not one: {error}"))
        })?;
        schemas.insert(tool.name.to_string(), schema);
        tools.push(tool);
    }
    let (lines, mut written) = mpsc::unbounded_channel();
    let server = Arc::new(Server {
        config_dir: config_dir.display().to_string(),
        window,
        project,
        stderr: lines,
        next_waiter: AtomicU64::new(0),
        state: Mutex::new(ServerState {
            connection: None,
            reader: None,
            watches: HashMap::new(),
        }),
        arguments: Mutex::new(HashMap::new()),
    });
    let handler = Handler {
        server: server.clone(),
        tools,
        schemas,
        instructions: definition.instructions,
        version: options.core_version.to_string(),
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| Error::Failed(format!("mcp: {error}")))?;
    let mut write_line =
        |line: String| writeln!(stderr, "{line}").map_err(|error| Error::Failed(error.to_string()));
    let served: Result<(), Error> = runtime.block_on(async {
        let output: Output = Arc::new(tokio::sync::Mutex::new(tokio::io::stdout()));
        // The input passes its lines to the library through the simplex stream; a full stream holds the input back.
        let (library_input, pass) = tokio::io::simplex(64 * 1024);
        let input = tokio::spawn(filter_input(
            server.clone(),
            tokio::io::stdin(),
            pass,
            output.clone(),
        ));
        let library_output = LineOutput {
            output,
            partial: Vec::new(),
            writing: None,
        };
        let served: Result<(), Error> = async {
            let service = handler
                .serve((library_input, library_output))
                .await
                .map_err(|error| Error::Failed(format!("mcp: {error}")))?;
            let waiting = service.waiting();
            tokio::pin!(waiting);
            loop {
                tokio::select! {
                    quit = &mut waiting => {
                        quit.map_err(|error| Error::Failed(format!("mcp: {error}")))?;
                        return Ok::<(), Error>(());
                    }
                    Some(line) = written.recv() => write_line(line)?,
                }
            }
        }
        .await;
        // The input that ended with an error, a line longer than MCP_LINE_LIMIT or a failed read, ended the library with it, and
        // the server ends with that error. An input that has not ended reads no further message.
        if !input.is_finished() {
            input.abort();
            return served;
        }
        match input.await {
            Ok(Err(text)) => Err(Error::Failed(text)),
            Ok(Ok(())) => served,
            Err(failure) => std::panic::resume_unwind(failure.into_panic()),
        }
    });
    server.close();
    // The lines of the calls and of the connection that ended with the server.
    while let Ok(line) = written.try_recv() {
        write_line(line)?;
    }
    served
}
