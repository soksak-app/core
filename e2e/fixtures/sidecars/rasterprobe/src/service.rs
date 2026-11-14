// The protocol state of the persistent service (docs/spec/persistent-services.md, docs/spec/sidecars.md#messages and #image-envelope,
// docs/spec/native-surfaces.md#image-regions). It takes one line of one connection at a time and returns the lines to write; the
// socket is the one of server.rs; the transfer images are IOSurfaces (iosurface.rs) and each session has one child process.
//
// Requests of the page, by `operation`:
//   open {image?, color?, rows?, textSize?}  opens the session of the surface, which starts one child process, or reattaches to it;
//                                            the settings apply only when the session starts. Answer: the event session, which
//                                            names its image region as `region`.
//   rows {count}                             the number of row bands that the frames paint. Answer: the event rows.
//   color {color}                            the color `#rrggbb` of the frames. Answer: the event color.
//   textSize {factor}                        the text size factor that sizes the cells of the grid. Answer: the event textSize.
//   state                                    Answer: the event state, the session as the event session describes it.
//   input {sequence, ..}                     Answer: the event input with the body it received; the request event keeps its cids.
//                                            Each input makes a frame due, and the event frame of the frame that the service draws
//                                            next names the sequence of each input that it handled since the frame before in
//                                            `inputs`, so a page tells which frame presents the state after an input.
//   close                                    closes the session and its child process. Answer: the event closed.
//   kill                                     ends the service process at once with SIGKILL, without an answer.
// Each frame that the service sends is followed by the event frame with its identity, its raster, its grid and its rows.
// The host reads the member `image` of every body that the service sends as an image envelope (docs/spec/sidecars.md#image-envelope),
// so only a frame and a detach answer carry it.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{Map, Value, json};

use crate::events::EventLog;
use crate::iosurface::Surface as Transfer;
use crate::raster::{Grid, Rgb, Scene};

/// The name of the sidecar in its events, `sidecar.rasterprobe.*`.
pub const NAME: &str = "rasterprobe";
/// The color, the rows and the text size factor of a session that its open does not name.
pub const DEFAULT_COLOR: Rgb = Rgb(0, 80, 180);
pub const DEFAULT_ROWS: u32 = 0;
pub const DEFAULT_FACTOR: f64 = 1.0;
/// The number of input sequences that an image keeps for its next frame; an image that does not draw keeps the last ones.
pub const PENDING_INPUTS: usize = 256;

/// The levels of docs/spec/logging.md#event, whose numbers order them against the policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code, reason = "the service emits no event of the levels error and trace, which the policy still orders")]
pub enum Level {
    Error = 1,
    Warn = 2,
    Info = 3,
    Debug = 4,
    Trace = 5,
}

impl Level {
    pub fn name(self) -> &'static str {
        match self {
            Level::Error => "error",
            Level::Warn => "warn",
            Level::Info => "info",
            Level::Debug => "debug",
            Level::Trace => "trace",
        }
    }
}

/// The classes of docs/spec/logging.md#classes-and-policy, in the order of the policy file; the policy reader indexes all five.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code, reason = "the service emits no event of the classes input and call, which the policy still names")]
pub enum Class {
    Lifecycle = 0,
    Input = 1,
    Call = 2,
    Io = 3,
    Frame = 4,
}

/// The process of one session: it ends when its input ends.
pub struct Child(std::process::Child);

impl Child {
    fn start(executable: &Path, session: &str) -> Result<Child, String> {
        let child = Command::new(executable)
            .arg("--session")
            .arg(session)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("start session process {session}: {error}"))?;
        Ok(Child(child))
    }

    fn pid(&self) -> u32 {
        self.0.id()
    }

    /// Ends the process and reaps it.
    fn close(&mut self) -> Result<(), String> {
        drop(self.0.stdin.take());
        let status = self.0.wait().map_err(|error| format!("wait for session process {}: {error}", self.0.id()))?;
        if status.success() { Ok(()) } else { Err(format!("session process {} ended with {status}", self.0.id())) }
    }
}

/// A connection of the socket.
pub type Conn = u64;

/// A line to write to a connection.
#[derive(Debug, PartialEq)]
pub struct Out {
    pub conn: Conn,
    pub line: Value,
}

/// The result of one line or one connection end.
#[derive(Debug, Default)]
pub struct Handled {
    pub out: Vec<Out>,
    /// The connection is closed after its lines are written.
    pub close: bool,
    /// The process ends at once with SIGKILL.
    pub kill: bool,
    /// The service exits after its cleanup.
    pub exit: bool,
}

/// The facts of the service that hello and the session event report.
#[derive(Clone, Debug)]
pub struct Identity {
    pub version: String,
    pub pid: u32,
    pub token: String,
    pub directory: String,
}

struct Session {
    id: String,
    root: String,
    child: Child,
    color: Rgb,
    rows: u32,
    factor: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Config {
    raster: u64,
    width: u32,
    height: u32,
    scale: f64,
}

struct Image {
    name: String,
    generation: Option<u64>,
    config: Option<Config>,
    drawing: bool,
    /// A frame is due: the next answer or change that allows drawing draws it.
    dirty: bool,
    sequence: u64,
    frames: u64,
    error: Option<String>,
    /// The sequences of the inputs handled since the last frame, in order, which the next frame reports.
    inputs: Vec<u64>,
}

impl Image {
    fn new(name: &str) -> Image {
        Image {
            name: name.to_string(),
            generation: None,
            config: None,
            drawing: false,
            dirty: true,
            sequence: 0,
            frames: 0,
            error: None,
            inputs: Vec::new(),
        }
    }
}

/// The identity of a sent frame: name, generation, raster and sequence.
type Ident = (String, u64, u64, u64);

struct Surface {
    root: String,
    attachment: Conn,
    session: Option<Session>,
    image: Option<Image>,
    /// The image name and generation of the last detach.
    retired: Option<(String, u64)>,
    slots: HashMap<u64, Transfer>,
    next_slot: u64,
    /// The frame that waits for its answer, and the frames that the host holds by its leases.
    in_flight: Option<(Ident, u64)>,
    held: HashMap<Ident, u64>,
}

impl Surface {
    fn new(root: &str, attachment: Conn) -> Surface {
        Surface {
            root: root.to_string(),
            attachment,
            session: None,
            image: None,
            retired: None,
            slots: HashMap::new(),
            next_slot: 0,
            in_flight: None,
            held: HashMap::new(),
        }
    }

    fn busy(&self, slot: u64) -> bool {
        self.in_flight.as_ref().is_some_and(|(_, busy)| *busy == slot) || self.held.values().any(|held| *held == slot)
    }

    /// Drops the transfer images that neither the host nor the current raster needs.
    fn prune(&mut self) {
        let size = self.image.as_ref().and_then(|image| image.config).map(|config| (config.width, config.height));
        let unused: Vec<u64> = self
            .slots
            .iter()
            .filter(|(slot, transfer)| Some(transfer.size()) != size && !self.busy(**slot))
            .map(|(slot, _)| *slot)
            .collect();
        for slot in unused {
            self.slots.remove(&slot);
        }
    }

    fn mode(&self) -> &'static str {
        if self.image.is_some() { "image" } else { "headless" }
    }
}

/// A detach that the ledger keeps: its tuple and its result.
struct Detach {
    client: String,
    surface: String,
    name: String,
    generation: u64,
    result: Value,
}

pub struct Service {
    identity: Identity,
    /// The executable that each session process runs.
    executable: PathBuf,
    log: EventLog,
    /// The client (configuration directory) of each authenticated connection.
    clients: HashMap<Conn, String>,
    surfaces: HashMap<(String, String), Surface>,
    ledger: HashMap<String, Detach>,
    owner_closed: Vec<String>,
    shutdown: bool,
    next_session: u64,
}

fn text<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn integer(object: &Map<String, Value>, key: &str) -> Option<u64> {
    object.get(key).and_then(Value::as_u64)
}

fn reply(operation: &str, request: &str, result: Result<Map<String, Value>, String>) -> Value {
    let mut line = Map::new();
    line.insert("operation".into(), json!(operation));
    line.insert("request".into(), json!(request));
    match result {
        Ok(fields) => {
            line.insert("ok".into(), json!(true));
            line.extend(fields);
        }
        Err(error) => {
            line.insert("ok".into(), json!(false));
            line.insert("error".into(), json!(error));
        }
    }
    Value::Object(line)
}

fn envelope(surface: &str, cids: &[String], body: Value) -> Value {
    let mut line = Map::new();
    line.insert("surface".into(), json!(surface));
    if !cids.is_empty() {
        line.insert("cids".into(), json!(cids));
    }
    line.insert("body".into(), body);
    Value::Object(line)
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let word = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(ALPHABET[(word >> (18 - 6 * index) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

impl Service {
    pub fn new(identity: Identity, executable: PathBuf, log: EventLog) -> Service {
        Service {
            identity,
            executable,
            log,
            clients: HashMap::new(),
            surfaces: HashMap::new(),
            ledger: HashMap::new(),
            owner_closed: Vec::new(),
            shutdown: false,
            next_session: 0,
        }
    }

    pub fn log(&self) -> &EventLog {
        &self.log
    }

    fn event(&self, level: Level, class: Class, name: &str, surface: Option<&str>, session: Option<&str>, cids: &[String], fields: Value) {
        self.log.event(level, class, &format!("sidecar.{NAME}.{name}"), surface, session, cids, fields);
    }

    /// Handles one line that the connection sent.
    pub fn line(&mut self, conn: Conn, line: &str) -> Handled {
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => return self.refuse(conn, format!("invalid message: {error}")),
        };
        let Some(object) = value.as_object() else { return self.refuse(conn, "invalid message: not a JSON object".into()) };
        let Some(client) = self.clients.get(&conn).cloned() else {
            return self.hello(conn, object);
        };
        match text(object, "operation") {
            Some("close-owner") => self.close_owner(conn, &client, object),
            Some("shutdown") => self.shutdown(conn, &client, object),
            Some("retain") => self.retain(conn, &client, object),
            Some(other) => self.refuse(conn, format!("operation {other} is not a service operation")),
            None => self.surface_message(conn, &client, object, line.len()),
        }
    }

    fn refuse(&self, conn: Conn, error: String) -> Handled {
        crate::events::record("error", "connection", &error);
        Handled { out: vec![Out { conn, line: json!({"operation": "error", "ok": false, "error": error}) }], close: true, ..Handled::default() }
    }

    fn hello(&mut self, conn: Conn, object: &Map<String, Value>) -> Handled {
        let refused = |error: &str| Handled {
            out: vec![Out { conn, line: json!({"operation": "hello", "ok": false, "error": error}) }],
            close: true,
            ..Handled::default()
        };
        if text(object, "operation") != Some("hello") {
            return refused("the first message is hello");
        }
        if integer(object, "protocol") != Some(1) {
            return refused("protocol must be 1");
        }
        if text(object, "token") != Some(self.identity.token.as_str()) {
            return refused("authentication failed");
        }
        let Some(client) = text(object, "client") else { return refused("hello names no client") };
        self.clients.insert(conn, client.to_string());
        // A new client process of the configuration directory owns sessions again until its own owner close.
        self.owner_closed.retain(|closed| closed != client);
        self.event(Level::Info, Class::Lifecycle, "connection", None, None, &[], json!({"client": client, "connected": true}));
        Handled {
            out: vec![Out { conn, line: json!({"operation": "hello", "protocol": 1, "version": self.identity.version, "ok": true}) }],
            ..Handled::default()
        }
    }

    /// The end of a connection detaches it: its sessions stay, and the images that it configured end with it.
    pub fn connection_closed(&mut self, conn: Conn) -> Handled {
        let Some(client) = self.clients.remove(&conn) else { return Handled { exit: self.exit_due(), ..Handled::default() } };
        self.event(Level::Info, Class::Lifecycle, "connection", None, None, &[], json!({"client": client, "connected": false}));
        let keys: Vec<(String, String)> =
            self.surfaces.iter().filter(|(_, state)| state.attachment == conn).map(|(key, _)| key.clone()).collect();
        for key in keys {
            let mut ended = false;
            if let Some(state) = self.surfaces.get_mut(&key) {
                ended = state.image.take().is_some();
                state.in_flight = None;
                state.held.clear();
                state.slots.clear();
            }
            if ended {
                self.surface_mode(&key, "connection");
            }
        }
        Handled { exit: self.exit_due(), ..Handled::default() }
    }

    fn exit_due(&self) -> bool {
        self.shutdown && self.clients.is_empty()
    }

    fn surface_mode(&self, key: &(String, String), cause: &str) {
        let Some(state) = self.surfaces.get(key) else { return };
        let session = state.session.as_ref().map(|session| session.id.as_str());
        self.event(Level::Info, Class::Lifecycle, "surface_mode", Some(&key.1), session, &[], json!({"mode": state.mode(), "cause": cause}));
    }

    fn close_session(&mut self, key: &(String, String), cause: &str) -> Result<bool, String> {
        let Some(mut state) = self.surfaces.remove(key) else { return Ok(false) };
        let Some(mut session) = state.session.take() else { return Ok(false) };
        let result = session.child.close();
        self.event(Level::Info, Class::Lifecycle, "session", Some(&key.1), Some(&session.id), &[],
            json!({"action": "close", "cause": cause, "child": session.child.pid(), "error": result.as_ref().err()}));
        result.map(|()| true)
    }

    /// Closes every session of a client that keep does not keep, and returns the number closed and the failures.
    fn close_sessions(&mut self, client: &str, cause: &str, keep: impl Fn(&str, &str) -> bool) -> (usize, Vec<String>) {
        let keys: Vec<(String, String)> = self
            .surfaces
            .iter()
            .filter(|((owner, surface), state)| owner == client && !keep(surface, &state.root))
            .map(|(key, _)| key.clone())
            .collect();
        let mut closed = 0;
        let mut failures = Vec::new();
        // Every selected session is closed even when another fails, and each failure is reported.
        for key in keys {
            match self.close_session(&key, cause) {
                Ok(true) => closed += 1,
                Ok(false) => {}
                Err(error) => failures.push(format!("{}: {error}", key.1)),
            }
        }
        (closed, failures)
    }

    fn close_owner(&mut self, conn: Conn, client: &str, object: &Map<String, Value>) -> Handled {
        let request = text(object, "request").unwrap_or_default().to_string();
        let (_, failures) = self.close_sessions(client, "close-owner", |_, _| false);
        if !self.owner_closed.iter().any(|closed| closed == client) {
            self.owner_closed.push(client.to_string());
        }
        let result = if failures.is_empty() { Ok(Map::new()) } else { Err(failures.join("; ")) };
        Handled { out: vec![Out { conn, line: reply("closed-owner", &request, result) }], ..Handled::default() }
    }

    fn shutdown(&mut self, conn: Conn, client: &str, object: &Map<String, Value>) -> Handled {
        let request = text(object, "request").unwrap_or_default().to_string();
        if !self.owner_closed.iter().any(|closed| closed == client) {
            let result = Err("shutdown is accepted only after close-owner".to_string());
            return Handled { out: vec![Out { conn, line: reply("shutdown", &request, result) }], ..Handled::default() };
        }
        self.shutdown = true;
        Handled { out: vec![Out { conn, line: reply("shutdown", &request, Ok(Map::new())) }], ..Handled::default() }
    }

    fn retain(&mut self, conn: Conn, client: &str, object: &Map<String, Value>) -> Handled {
        let request = text(object, "request").unwrap_or_default().to_string();
        let entries = object.get("surfaces").and_then(Value::as_array);
        let mut listed = Vec::new();
        let mut refused = None;
        for entry in entries.into_iter().flatten() {
            match (entry.get("surface").and_then(Value::as_str), entry.get("root").and_then(Value::as_str)) {
                (Some(surface), Some(root)) => listed.push((surface.to_string(), root.to_string())),
                _ => refused = Some(format!("retain entry {entry} has no surface and root")),
            }
        }
        let result = match (entries, refused) {
            (None, _) => Err("retain has no surfaces".to_string()),
            (_, Some(error)) => Err(error),
            _ => {
                let (closed, failures) =
                    self.close_sessions(client, "retain", |surface, root| listed.iter().any(|(s, r)| s == surface && r == root));
                if failures.is_empty() {
                    let mut fields = Map::new();
                    fields.insert("closed".into(), json!(closed));
                    Ok(fields)
                } else {
                    Err(failures.join("; "))
                }
            }
        };
        Handled { out: vec![Out { conn, line: reply("retained", &request, result) }], ..Handled::default() }
    }

    /// Closes every session at the exit of the service and returns the failures.
    pub fn close_all(&mut self, cause: &str) -> Vec<String> {
        let clients: Vec<String> = self.surfaces.keys().map(|(client, _)| client.clone()).collect();
        let mut failures = Vec::new();
        for client in clients {
            failures.extend(self.close_sessions(&client, cause, |_, _| false).1);
        }
        failures
    }

    fn surface_message(&mut self, conn: Conn, client: &str, object: &Map<String, Value>, bytes: usize) -> Handled {
        let Some(surface) = text(object, "surface").map(str::to_string) else {
            return self.refuse(conn, "a surface message has no string surface".into());
        };
        let cids: Vec<String> =
            object.get("cids").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
        let key = (client.to_string(), surface.clone());
        let body = object.get("body").cloned().unwrap_or(Value::Null);
        let operation = if object.get("closed") == Some(&Value::Bool(true)) {
            "closed".to_string()
        } else if let Some(operation) = body.get("operation").and_then(Value::as_str) {
            operation.to_string()
        } else if let Some(image) = body.get("image").and_then(Value::as_object) {
            // default: an image message without a member is named by its object alone.
            format!("image.{}", image.keys().next().map(String::as_str).unwrap_or(""))
        } else {
            "unknown".to_string()
        };
        let session = self.surfaces.get(&key).and_then(|state| state.session.as_ref()).map(|session| session.id.clone());
        self.event(Level::Debug, Class::Io, "request", Some(&surface), session.as_deref(), &cids, json!({"operation": operation, "bytes": bytes}));

        if operation == "closed" {
            let line = match self.close_session(&key, "closed") {
                Ok(_) => json!({"surface": surface, "closed": true}),
                Err(error) => json!({"surface": surface, "closed": true, "error": error}),
            };
            self.surfaces.remove(&key);
            return Handled { out: vec![Out { conn, line }], ..Handled::default() };
        }
        // default: the root of a host send that carries none, such as an image detach, is kept from the first request.
        let root = text(object, "root").unwrap_or_default();
        let state = self.surfaces.entry(key.clone()).or_insert_with(|| Surface::new(root, conn));
        state.attachment = conn;
        if state.session.is_none() && !root.is_empty() {
            state.root = root.to_string();
        }
        let mut out = Vec::new();
        if let Some(image) = body.get("image").and_then(Value::as_object) {
            self.image_message(conn, &key, image, &mut out);
        } else if let Some(fields) = body.as_object() {
            match self.page_request(conn, &key, &operation, fields, &cids, &mut out) {
                Ok(Some(kill)) if kill => return Handled { out, kill: true, ..Handled::default() },
                Ok(_) => {}
                Err(error) => out.push(Out { conn, line: envelope(&surface, &cids, json!({"error": error})) }),
            }
        } else {
            out.push(Out { conn, line: envelope(&surface, &cids, json!({"error": "the body is not an object"})) });
        }
        self.draw(&key, &mut out);
        Handled { out, ..Handled::default() }
    }

    fn session_body(&self, key: &(String, String), event: &str, created: bool) -> Value {
        let Some(state) = self.surfaces.get(key) else { return json!({"event": event, "session": null}) };
        let Some(session) = &state.session else { return json!({"event": event, "session": null}) };
        json!({
            "event": event,
            "session": session.id,
            "created": created,
            "root": session.root,
            "child": session.child.pid(),
            "service": {"pid": self.identity.pid, "version": self.identity.version, "directory": self.identity.directory},
            "mode": state.mode(),
            "region": state.image.as_ref().map(|image| image.name.clone()),
            "color": session.color.text(),
            "rows": session.rows,
            "textSize": session.factor,
            "frames": state.image.as_ref().map_or(0, |image| image.frames),
            "error": state.image.as_ref().and_then(|image| image.error.clone()),
        })
    }

    /// Runs one request of the page. The value is Some(true) when the service must end at once.
    fn page_request(
        &mut self,
        conn: Conn,
        key: &(String, String),
        operation: &str,
        fields: &Map<String, Value>,
        cids: &[String],
        out: &mut Vec<Out>,
    ) -> Result<Option<bool>, String> {
        let surface = key.1.clone();
        let answer = |out: &mut Vec<Out>, body: Value| out.push(Out { conn, line: envelope(&surface, cids, body) });
        if operation == "open" {
            return self.open(conn, key, fields, cids, out).map(|()| None);
        }
        if operation == "kill" {
            self.event(Level::Warn, Class::Lifecycle, "kill", Some(&surface), None, cids, json!({"pid": self.identity.pid}));
            return Ok(Some(true));
        }
        let state = self.surfaces.get_mut(key).ok_or_else(|| format!("no session for surface {surface}"))?;
        let session = state.session.as_mut().ok_or_else(|| format!("no session for surface {surface}"))?;
        match operation {
            "rows" => {
                let count = fields.get("count").and_then(Value::as_u64).ok_or("rows requires a non-negative integer count")?;
                session.rows = u32::try_from(count).map_err(|_| "rows count is too large".to_string())?;
                state.image.iter_mut().for_each(|image| image.dirty = true);
                answer(out, json!({"event": "rows", "count": count}));
            }
            "color" => {
                let color = fields.get("color").and_then(Value::as_str).and_then(Rgb::parse).ok_or("color requires #rrggbb")?;
                session.color = color;
                state.image.iter_mut().for_each(|image| image.dirty = true);
                answer(out, json!({"event": "color", "color": color.text()}));
            }
            "textSize" => {
                let factor = fields.get("factor").and_then(Value::as_f64).filter(|f| *f > 0.0).ok_or("textSize requires a positive factor")?;
                session.factor = factor;
                state.image.iter_mut().for_each(|image| image.dirty = true);
                answer(out, json!({"event": "textSize", "factor": factor}));
            }
            "input" => {
                let sequence = fields.get("sequence").and_then(Value::as_u64).ok_or("input requires a non-negative integer sequence")?;
                if let Some(image) = &mut state.image {
                    if image.inputs.len() == PENDING_INPUTS {
                        image.inputs.remove(0);
                    }
                    image.inputs.push(sequence);
                    image.dirty = true;
                }
                answer(out, json!({"event": "input", "received": Value::Object(fields.clone())}));
            }
            "state" => {
                let body = self.session_body(key, "state", false);
                answer(out, body);
            }
            "close" => {
                let id = session.id.clone();
                self.close_session(key, "close")?;
                answer(out, json!({"event": "closed", "session": id}));
            }
            other => return Err(format!("unknown operation {other}")),
        }
        Ok(None)
    }

    fn open(&mut self, conn: Conn, key: &(String, String), fields: &Map<String, Value>, cids: &[String], out: &mut Vec<Out>) -> Result<(), String> {
        let image = match fields.get("image") {
            None | Some(Value::Null) => None,
            Some(Value::String(name)) if !name.is_empty() => Some(name.clone()),
            Some(other) => return Err(format!("open image must be a region name, found {other}")),
        };
        let color = match fields.get("color") {
            None => DEFAULT_COLOR,
            Some(value) => value.as_str().and_then(Rgb::parse).ok_or("open color must be #rrggbb")?,
        };
        let rows = match fields.get("rows") {
            None => DEFAULT_ROWS,
            Some(value) => value.as_u64().and_then(|rows| u32::try_from(rows).ok()).ok_or("open rows must be a non-negative integer")?,
        };
        let factor = match fields.get("textSize") {
            None => DEFAULT_FACTOR,
            Some(value) => value.as_f64().filter(|factor| *factor > 0.0).ok_or("open textSize must be a positive factor")?,
        };
        let state = self.surfaces.get(key).expect("the surface message entered the surface");
        if image.is_none()
            && let Some(attached) = &state.image
        {
            let reason = format!("surface {} holds image {}; an open without image would make it headless", key.1, attached.name);
            out.push(Out { conn, line: envelope(&key.1, cids, json!({"error": "imageAttached", "reason": reason})) });
            return Ok(());
        }
        let created = state.session.is_none();
        if created {
            self.next_session += 1;
            let id = format!("s{}", self.next_session);
            let child = Child::start(&self.executable, &id)?;
            let state = self.surfaces.get_mut(key).expect("the surface message entered the surface");
            let root = state.root.clone();
            state.session = Some(Session { id, root, child, color, rows, factor });
        }
        let state = self.surfaces.get_mut(key).expect("the surface message entered the surface");
        if let Some(name) = image {
            match &mut state.image {
                Some(current) if current.name == name => current.dirty = true,
                Some(current) => {
                    let error = format!("surface {} holds image {}, not {name}", key.1, current.name);
                    return Err(error);
                }
                None => state.image = Some(Image::new(&name)),
            }
        }
        let session = state.session.as_ref().expect("the open made the session");
        let (id, child) = (session.id.clone(), session.child.pid());
        self.event(Level::Info, Class::Lifecycle, "session", Some(&key.1), Some(&id), cids,
            json!({"action": if created { "open" } else { "reattach" }, "cause": "open", "child": child}));
        self.surface_mode(key, "open");
        let body = self.session_body(key, "session", created);
        out.push(Out { conn, line: envelope(&key.1, cids, body) });
        Ok(())
    }

    fn image_message(&mut self, conn: Conn, key: &(String, String), image: &Map<String, Value>, out: &mut Vec<Out>) {
        // The refusal of a frame is the one image message without a member object: its member error is the reason, beside the
        // identity of the frame (docs/spec/sidecars.md#image-envelope).
        let (kind, fields) = if image.get("error").is_some_and(Value::is_string) {
            ("error", image)
        } else {
            let Some((kind, value)) = image.iter().next() else { return };
            let Some(fields) = value.as_object() else {
                out.push(Out { conn, line: envelope(&key.1, &[], json!({"error": format!("image message {kind} is not an object")})) });
                return;
            };
            (kind.as_str(), fields)
        };
        let name = text(fields, "name").unwrap_or_default().to_string();
        let generation = integer(fields, "generation").unwrap_or(0);
        let state = self.surfaces.get_mut(key).expect("the surface message entered the surface");
        let retired = state.retired.as_ref().is_some_and(|(retired, at)| *retired == name && generation <= *at);
        match kind {
            "configure" => {
                if retired || state.image.as_ref().is_some_and(|image| image.generation.is_some_and(|current| current > generation)) {
                    return;
                }
                let config = Config {
                    raster: integer(fields, "raster").unwrap_or(0),
                    width: integer(fields, "width").unwrap_or(0) as u32,
                    height: integer(fields, "height").unwrap_or(0) as u32,
                    scale: fields.get("scale").and_then(Value::as_f64).unwrap_or(1.0),
                };
                let image = state.image.get_or_insert_with(|| Image::new(&name));
                image.name = name;
                if image.generation != Some(generation) {
                    image.generation = Some(generation);
                    image.drawing = false;
                    image.sequence = 0;
                }
                if image.config.is_none_or(|current| current.raster != config.raster) {
                    image.sequence = 0;
                }
                image.config = Some(config);
                image.dirty = true;
                state.prune();
                self.surface_mode(key, "configure");
            }
            "drawing" => {
                if retired || state.image.as_ref().is_some_and(|image| image.generation.is_some_and(|current| current > generation)) {
                    return;
                }
                let image = state.image.get_or_insert_with(|| Image::new(&name));
                image.name = name;
                if image.generation != Some(generation) {
                    image.generation = Some(generation);
                    image.config = None;
                    image.sequence = 0;
                }
                image.drawing = fields.get("drawing").and_then(Value::as_bool).unwrap_or(false);
                if image.drawing {
                    image.dirty = true;
                }
            }
            "detach" => {
                let request = text(fields, "request").unwrap_or_default().to_string();
                let mut result = self.detach(key, &request, &name, generation);
                let detached = result.remove("changed") == Some(Value::Bool(true));
                let mut answer = Map::new();
                answer.insert("request".into(), json!(request));
                answer.insert("name".into(), json!(name));
                answer.insert("generation".into(), json!(generation));
                answer.extend(result);
                out.push(Out { conn, line: envelope(&key.1, &[], json!({"image": {"detached": answer}})) });
                if detached {
                    self.surface_mode(key, "detach");
                }
            }
            "leased" | "consumed" | "released" | "error" => {
                let ident: Ident = (name, generation, integer(fields, "raster").unwrap_or(0), integer(fields, "sequence").unwrap_or(0));
                match kind {
                    "released" => {
                        state.held.remove(&ident);
                    }
                    answered => {
                        if let Some((sent, slot)) = state.in_flight.take() {
                            if sent != ident {
                                state.in_flight = Some((sent, slot));
                            } else if answered == "leased" {
                                state.held.insert(ident, slot);
                            }
                        }
                        if answered == "error" {
                            let reason = text(fields, "error").unwrap_or_default().to_string();
                            // A stale frame was replaced by a newer raster before the host presented it, which is no failure of
                            // the region (docs/spec/sidecars.md#image-envelope); the due frame of the newer raster follows.
                            if reason != "stale"
                                && let Some(image) = &mut state.image
                            {
                                image.error = Some(reason);
                            }
                        } else if let Some(image) = &mut state.image {
                            image.error = None;
                        }
                    }
                }
                state.prune();
            }
            other => {
                out.push(Out { conn, line: envelope(&key.1, &[], json!({"error": format!("unknown image message {other}")})) });
            }
        }
    }

    /// The result of a detach (docs/spec/sidecars.md#image-envelope); its member changed is true when it removed the image.
    fn detach(&mut self, key: &(String, String), request: &str, name: &str, generation: u64) -> Map<String, Value> {
        let state = self.surfaces.get_mut(key).expect("the surface message entered the surface");
        let current = state.image.as_ref().and_then(|image| image.generation);
        let refusal = |error: &str, current: Option<u64>| {
            let mut result = Map::new();
            result.insert("ok".into(), json!(false));
            result.insert("error".into(), json!(error));
            if let Some(current) = current {
                result.insert("currentGeneration".into(), json!(current));
            }
            result
        };
        if let Some(entry) = self.ledger.get(request) {
            if entry.client != key.0 || entry.surface != key.1 || entry.name != name || entry.generation != generation {
                return refusal("requestMismatch", None);
            }
            if current.is_none_or(|current| current <= generation) {
                let mut result = entry.result.as_object().cloned().unwrap_or_default();
                result.insert("changed".into(), json!(false));
                return result;
            }
            return refusal("staleGeneration", current);
        }
        let known = current.max(state.retired.as_ref().map(|(_, at)| *at));
        let result = match &state.image {
            Some(image) if image.name != name => refusal("imageNameMismatch", None),
            Some(image) => match image.generation {
                Some(current) if generation < current => refusal("staleGeneration", Some(current)),
                Some(current) if generation > current && image.config.is_some() => refusal("futureGeneration", Some(current)),
                _ => {
                    state.image = None;
                    state.retired = Some((name.to_string(), generation));
                    let mut result = Map::new();
                    result.insert("ok".into(), json!(true));
                    result.insert("result".into(), json!("detached"));
                    result.insert("changed".into(), json!(true));
                    result
                }
            },
            None if state.retired.as_ref().is_some_and(|(retired, at)| retired == name && *at == generation) => {
                let mut result = Map::new();
                result.insert("ok".into(), json!(true));
                result.insert("result".into(), json!("alreadyDetached"));
                result
            }
            None if known.is_some_and(|known| generation < known) => refusal("staleGeneration", known),
            None => {
                let mut result = Map::new();
                result.insert("ok".into(), json!(true));
                result.insert("result".into(), json!("alreadyAbsent"));
                result
            }
        };
        let mut stored = result.clone();
        stored.remove("changed");
        self.ledger.insert(request.to_string(), Detach {
            client: key.0.clone(),
            surface: key.1.clone(),
            name: name.to_string(),
            generation,
            result: Value::Object(stored),
        });
        result
    }

    /// Draws the due frame of the surface when its region draws, its raster is configured and no frame waits for its answer.
    fn draw(&mut self, key: &(String, String), out: &mut Vec<Out>) {
        let Some(state) = self.surfaces.get_mut(key) else { return };
        let Some(session) = &state.session else { return };
        let Some(image) = &mut state.image else { return };
        let Some(config) = image.config else { return };
        let Some(generation) = image.generation else { return };
        if !image.drawing || !image.dirty || state.in_flight.is_some() {
            return;
        }
        let grid = Grid::of(config.width, config.height, config.scale, session.factor);
        let sequence = image.sequence + 1;
        let scene = Scene {
            width: config.width,
            height: config.height,
            grid,
            color: session.color,
            rows: session.rows.min(grid.rows),
            generation,
            sequence,
        };
        let free = state
            .slots
            .iter()
            .filter(|(_, transfer)| transfer.size() == (config.width, config.height) && !transfer.in_use())
            .map(|(slot, _)| *slot)
            .filter(|slot| !(state.in_flight.as_ref().is_some_and(|(_, busy)| busy == slot) || state.held.values().any(|held| held == slot)))
            // The oldest free image, so that the choice does not depend on the order of the map.
            .min();
        let slot = match free {
            Some(slot) => slot,
            None => match Transfer::create(config.width, config.height) {
                Ok(transfer) => {
                    state.next_slot += 1;
                    state.slots.insert(state.next_slot, transfer);
                    state.next_slot
                }
                Err(error) => {
                    image.error = Some(error.clone());
                    image.dirty = false;
                    crate::events::record("error", "frame", &error);
                    out.push(Out { conn: state.attachment, line: envelope(&key.1, &[], json!({"event": "error", "error": error})) });
                    return;
                }
            },
        };
        let transfer = state.slots.get_mut(&slot).expect("the slot was chosen from the slots");
        let painting = std::time::Instant::now();
        let painted = transfer.paint(&scene);
        // The paint time of the frame in microseconds, which the frame event reports as the draw time of the supplier.
        let draw_us = u64::try_from(painting.elapsed().as_micros()).unwrap_or(u64::MAX);
        if let Err(error) = painted {
            image.error = Some(error.clone());
            image.dirty = false;
            out.push(Out { conn: state.attachment, line: envelope(&key.1, &[], json!({"event": "error", "error": error})) });
            return;
        }
        image.sequence = sequence;
        image.dirty = false;
        image.frames += 1;
        let inputs = std::mem::take(&mut image.inputs);
        state.in_flight = Some(((image.name.clone(), generation, config.raster, sequence), slot));
        let session_id = session.id.clone();
        let frame = json!({
            "name": image.name,
            "generation": generation,
            "raster": config.raster,
            "token": {"kind": "iosurface-global", "id": transfer.id(), "nonce": base64(&transfer.nonce())},
            "width": config.width,
            "height": config.height,
            "scale": config.scale,
            "format": "bgra8",
            "sequence": sequence,
        });
        let report = json!({
            "event": "frame",
            "name": image.name,
            "generation": generation,
            "raster": config.raster,
            "sequence": sequence,
            "width": config.width,
            "height": config.height,
            "scale": config.scale,
            "grid": {"rows": grid.rows, "cols": grid.cols, "cellWidth": grid.cell_width, "cellHeight": grid.cell_height},
            "rows": scene.rows,
            "color": scene.color.text(),
            "marker": scene.marker().text(),
            "surface": transfer.id(),
            "draw_us": draw_us,
            "inputs": inputs,
        });
        let conn = state.attachment;
        out.push(Out { conn, line: envelope(&key.1, &[], json!({"image": frame})) });
        out.push(Out { conn, line: envelope(&key.1, &[], report.clone()) });
        self.event(Level::Debug, Class::Frame, "frame", Some(&key.1), Some(&session_id), &[], report);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_encodes_with_padding() {
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(&[0xff; 16]), "/////////////////////w==");
    }
}
