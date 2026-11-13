//! Plays one endpoint contract case (docs/spec/endpoint.md#checks, docs/spec/cases/endpoint) for the tests of sok. The player writes
//! endpoint.json of its configuration directory, listens on the Unix socket that the file names, sends the host frames of the case in
//! their order and checks each frame of the client against the next step. It answers no frame that the case does not contain at its
//! place. A frame of the client that differs from the case, a step that was not played and a connection that the client closed before
//! its step are failures; the player reports them when the test ends and the player is dropped. The Go player of
//! packages/sok/go/tests and the case player of packages/client/testing/case-player.js have the same rules and the same case format.

#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Display;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde_json::value::RawValue;
use serde_json::{Value, json};

use super::folder::Folder;

/// The bound of a wait for a client to close its connection, and of a wait for a connection that precedes a new one.
const CASE_LIMIT: Duration = Duration::from_secs(10);

/// The largest frame body that the player accepts from the client (docs/spec/endpoint.md#framing).
const MAX_FRAME: u32 = 16 * 1024 * 1024;

/// The members of a JSON object, each kept as the raw text of its value so that the order of the members of a reply is preserved.
type Members = BTreeMap<String, Box<RawValue>>;

/// The state of one connection that the accept loop shares with the thread of the connection: false until the thread ends.
type Ended = Arc<(Mutex<bool>, Condvar)>;

/// Returns docs/spec/cases/endpoint of the repository that holds this package. It walks up from the manifest folder to the first folder
/// that holds that path, so the location is discovered and not assumed.
fn case_directory() -> Result<PathBuf, String> {
    let start = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for dir in start.ancestors() {
        let candidate = dir.join("docs/spec/cases/endpoint");
        if candidate.is_dir() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "no docs/spec/cases/endpoint folder holds {}",
        start.display()
    ))
}

/// Decodes the raw text of one value. A value of another type gives None, and the caller reports it.
fn decode<T: DeserializeOwned>(raw: &RawValue) -> Option<T> {
    serde_json::from_str(raw.get()).ok()
}

/// Reports whether a name has the form of a variable name: a letter a-z, then letters a-z, digits and hyphens.
fn is_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Returns the name of the variable that a decoded string names: the string is "$" and a name.
fn variable_name(text: &str) -> Option<&str> {
    text.strip_prefix('$').filter(|name| is_name(name))
}

/// A JSON value whose objects keep the order of their members. The output of sok keeps the order that the endpoint sends, so a host
/// frame is written with the member order of its case. serde_json keeps that order only with its feature preserve_order, which would
/// also change the order in which sok itself writes objects in this test build, so the player decodes and encodes its frames through
/// this type with serde instead.
#[derive(Clone)]
enum Ordered {
    Object(Vec<(String, Ordered)>),
    Array(Vec<Ordered>),
    Scalar(Value),
}

impl<'de> serde::Deserialize<'de> for Ordered {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visit;
        impl<'de> serde::de::Visitor<'de> for Visit {
            type Value = Ordered;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a JSON value")
            }
            fn visit_bool<E>(self, value: bool) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::Bool(value)))
            }
            fn visit_i64<E>(self, value: i64) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::from(value)))
            }
            fn visit_u64<E>(self, value: u64) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::from(value)))
            }
            fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Ordered, E> {
                serde_json::Number::from_f64(value)
                    .map(|number| Ordered::Scalar(Value::Number(number)))
                    .ok_or_else(|| E::custom(format!("{value} is not a JSON number")))
            }
            fn visit_str<E>(self, value: &str) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::String(value.to_string())))
            }
            fn visit_string<E>(self, value: String) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::String(value)))
            }
            fn visit_unit<E>(self) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(Value::Null))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Ordered, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Ordered::Array(items))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Ordered, A::Error> {
                let mut members = Vec::new();
                while let Some(member) = map.next_entry()? {
                    members.push(member);
                }
                Ok(Ordered::Object(members))
            }
        }
        deserializer.deserialize_any(Visit)
    }
}

impl serde::Serialize for Ordered {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::{SerializeMap, SerializeSeq};
        match self {
            Ordered::Scalar(value) => value.serialize(serializer),
            Ordered::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Ordered::Object(members) => {
                let mut map = serializer.serialize_map(Some(members.len()))?;
                for (key, value) in members {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

impl Ordered {
    /// Calls visit with the name of each string value that names a variable. An object key is never a variable.
    fn each_variable(&self, visit: &mut impl FnMut(&str)) {
        match self {
            Ordered::Scalar(Value::String(text)) => {
                if let Some(name) = variable_name(text) {
                    visit(name);
                }
            }
            Ordered::Scalar(_) => {}
            Ordered::Array(items) => items.iter().for_each(|item| item.each_variable(visit)),
            Ordered::Object(members) => members
                .iter()
                .for_each(|(_, value)| value.each_variable(visit)),
        }
    }

    /// Returns the value with each string value that names a variable replaced by the value that bind returns for the name.
    fn bound(&self, bind: &impl Fn(&str) -> Result<Ordered, String>) -> Result<Ordered, String> {
        Ok(match self {
            Ordered::Scalar(Value::String(text)) => match variable_name(text) {
                Some(name) => bind(name)?,
                None => self.clone(),
            },
            Ordered::Scalar(_) => self.clone(),
            Ordered::Array(items) => Ordered::Array(
                items
                    .iter()
                    .map(|item| item.bound(bind))
                    .collect::<Result<_, _>>()?,
            ),
            Ordered::Object(members) => Ordered::Object(
                members
                    .iter()
                    .map(|(key, value)| Ok((key.clone(), value.bound(bind)?)))
                    .collect::<Result<_, String>>()?,
            ),
        })
    }

    /// Returns the JSON text of the value on one line, with its member order.
    fn text(&self) -> String {
        serde_json::to_string(self).expect("an ordered JSON value encodes")
    }
}

fn case_error(file: &Path, reason: impl Display) -> String {
    format!("{}: {reason}", file.display())
}

/// One step of a case. A send step holds the frame that the client must send, with the text that a message shows. A host step holds a
/// frame that the host writes, as raw JSON text that still names its variables. A close step names the side that closes the connection.
enum Step {
    Send { text: String, expected: Value },
    Host { frame: Ordered, text: String },
    Close { by_client: bool, text: String },
}

impl Step {
    fn text(&self) -> &str {
        match self {
            Step::Send { text, .. } | Step::Host { text, .. } | Step::Close { text, .. } => {
                text.as_str()
            }
        }
    }
}

/// A case that passed the check of its form: its steps, and the example of each variable as raw JSON text.
struct Case {
    steps: Vec<Step>,
    examples: BTreeMap<String, Box<RawValue>>,
}

/// Reads and checks the case of the name in directory. A case that does not have the form of the case format is an error that names
/// the file.
fn load_case(directory: &Path, name: &str) -> Result<Case, String> {
    let file = directory.join(format!("{name}.json"));
    let data = std::fs::read_to_string(&file).map_err(|error| case_error(&file, error))?;
    let root: Members = serde_json::from_str(&data)
        .map_err(|error| case_error(&file, format!("is not a JSON object: {error}")))?;
    let fail = |reason: &str| case_error(&file, reason);

    let name_field = root.get("name").and_then(|raw| decode::<String>(raw));
    if name_field.as_deref() != Some(name) {
        return Err(fail("name does not match the file name"));
    }
    match root
        .get("description")
        .and_then(|raw| decode::<String>(raw))
    {
        Some(description) if !description.is_empty() => {}
        _ => return Err(fail("description must be a non-empty string")),
    }
    let Some(replay) = root.get("replay").and_then(|raw| decode::<bool>(raw)) else {
        return Err(fail("replay must be true or false"));
    };
    let reason = root
        .get("reason")
        .and_then(|raw| decode::<String>(raw))
        .unwrap_or_default();
    if !replay && reason.is_empty() {
        return Err(fail("a case with replay false must give its reason"));
    }

    let mut examples = BTreeMap::new();
    if let Some(declared) = root.get("variables") {
        let declared: Members =
            decode(declared).ok_or_else(|| fail("variables must be an object"))?;
        for (variable, spec) in declared {
            if !is_name(&variable) {
                return Err(fail(&format!(
                    "variable {variable} must have the form a-z, digits and hyphens"
                )));
            }
            let mut spec: Members = decode(&spec)
                .ok_or_else(|| fail(&format!("variable {variable} must be an object")))?;
            if !spec.contains_key("type") {
                return Err(fail(&format!("variable {variable} must have a type")));
            }
            let Some(example) = spec.remove("example") else {
                return Err(fail(&format!("variable {variable} must have an example")));
            };
            examples.insert(variable, example);
        }
    }

    let raw_steps: Vec<Box<RawValue>> = root
        .get("steps")
        .and_then(|raw| decode::<Vec<Box<RawValue>>>(raw))
        .ok_or_else(|| fail("steps must be an array"))?;
    let mut steps = Vec::new();
    let mut used = BTreeSet::new();
    for (index, raw) in raw_steps.iter().enumerate() {
        let step: Members =
            decode(raw).ok_or_else(|| fail(&format!("step {index} is not an object")))?;
        let kinds: Vec<&str> = ["send", "reply", "notify", "close"]
            .into_iter()
            .filter(|kind| step.contains_key(*kind))
            .collect();
        let kind = match kinds.as_slice() {
            [kind] => *kind,
            _ => {
                return Err(fail(&format!(
                    "step {index} must have exactly one of send, reply, notify and close"
                )));
            }
        };
        if kind == "close" {
            let closer = step
                .get("close")
                .and_then(|raw| decode::<String>(raw))
                .unwrap_or_default();
            let by_client = match closer.as_str() {
                "client" => true,
                "host" => false,
                _ => {
                    return Err(fail(&format!("step {index} close must be host or client")));
                }
            };
            steps.push(Step::Close {
                by_client,
                text: format!(r#"{{"close":"{closer}"}}"#),
            });
            continue;
        }

        let frame: Members = decode(&step[kind])
            .ok_or_else(|| fail(&format!("step {index} {kind} must be an object")))?;
        if frame.contains_key("raw_hex") {
            return Err(fail(&format!(
                "step {index} sends raw bytes, which this player does not play"
            )));
        }
        if frame
            .get("jsonrpc")
            .and_then(|raw| decode::<String>(raw))
            .as_deref()
            != Some("2.0")
        {
            return Err(fail(&format!("step {index} {kind} must have jsonrpc 2.0")));
        }
        let raw_frame = step[kind].get();
        let ordered = |text: &str| -> Result<Ordered, String> {
            serde_json::from_str(text).map_err(|error| fail(&format!("step {index}: {error}")))
        };
        match kind {
            "send" => {
                if frame
                    .get("method")
                    .and_then(|raw| decode::<String>(raw))
                    .is_none()
                {
                    return Err(fail(&format!("step {index} send must name a method")));
                }
                let expected: Value = serde_json::from_str(raw_frame)
                    .map_err(|error| fail(&format!("step {index}: {error}")))?;
                steps.push(Step::Send {
                    text: ordered(raw_frame)?.text(),
                    expected,
                });
            }
            "reply" => {
                if !frame.contains_key("id") {
                    return Err(fail(&format!("step {index} reply must have an id")));
                }
                let host = ordered(raw_frame)?;
                host.each_variable(&mut |variable| {
                    used.insert(variable.to_string());
                });
                steps.push(Step::Host {
                    text: host.text(),
                    frame: host,
                });
            }
            "notify" => {
                if frame
                    .get("method")
                    .and_then(|raw| decode::<String>(raw))
                    .is_none()
                {
                    return Err(fail(&format!("step {index} notify must name a method")));
                }
                if frame.contains_key("id") {
                    return Err(fail(&format!(
                        "step {index} notify must be a notification without an id"
                    )));
                }
                let host = ordered(raw_frame)?;
                host.each_variable(&mut |variable| {
                    used.insert(variable.to_string());
                });
                steps.push(Step::Host {
                    text: host.text(),
                    frame: host,
                });
            }
            _ => unreachable!("the kind of a step is checked above"),
        }
    }
    for variable in &used {
        if !examples.contains_key(variable) {
            return Err(fail(&format!("variable ${variable} is not declared")));
        }
    }
    Ok(Case { steps, examples })
}

/// The state of one case that the accept loop and the connection threads share.
#[derive(Default)]
struct State {
    /// The index of the next step.
    cursor: usize,
    /// The frames of the client, in order.
    requests: Vec<Value>,
    /// The number of connections that the client opened.
    connections: usize,
    /// The failures of the case, each with the name of the case.
    failures: Vec<String>,
    /// Set when the player closes: the connections that end after it are not failures.
    closing: bool,
    /// The connections that are still open, by their number, so that the player can close them.
    open: BTreeMap<usize, UnixStream>,
    /// The connections in the order they were accepted.
    done: Vec<Ended>,
}

/// The part of a case that the accept loop and the connection threads share.
struct Shared {
    name: String,
    steps: Vec<Step>,
    examples: BTreeMap<String, Box<RawValue>>,
    texts: BTreeMap<String, String>,
    state: Mutex<State>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("the player state")
    }

    /// Returns the failure line of this case for a message.
    fn failure(&self, message: impl Display) -> String {
        format!("{}: {message}", self.name)
    }

    fn fail(&self, message: impl Display) {
        let line = self.failure(message);
        self.lock().failures.push(line);
    }

    /// Replaces each variable of a host frame with the text that the test gave it, or with its example.
    fn bind(&self, frame: &Ordered) -> Result<String, String> {
        let bound = frame.bound(&|variable| {
            if let Some(text) = self.texts.get(variable) {
                return Ok(Ordered::Scalar(Value::String(text.clone())));
            }
            match self.examples.get(variable) {
                Some(example) => {
                    serde_json::from_str(example.get()).map_err(|error| error.to_string())
                }
                None => Err(format!("variable ${variable} is not declared")),
            }
        })?;
        Ok(bound.text())
    }

    /// Returns the host frames that follow the cursor up to the next send step, with the variables bound. It reports whether the host
    /// closes the connection after them.
    fn host_frames(&self) -> Result<(Vec<String>, bool), String> {
        let mut state = self.lock();
        self.host_frames_locked(&mut state)
    }

    /// host_frames for a caller that holds the state.
    fn host_frames_locked(&self, state: &mut State) -> Result<(Vec<String>, bool), String> {
        let mut frames = Vec::new();
        while let Some(step) = self.steps.get(state.cursor) {
            match step {
                Step::Send { .. } => break,
                Step::Host { frame, .. } => frames.push(self.bind(frame)?),
                Step::Close {
                    by_client: true, ..
                } => return Ok((frames, false)),
                Step::Close {
                    by_client: false, ..
                } => {
                    state.cursor += 1;
                    return Ok((frames, true));
                }
            }
            state.cursor += 1;
        }
        Ok((frames, false))
    }

    /// Checks a frame of the client against the next step, which must be a send step with the same frame. It returns the host frames
    /// that follow the step, or None when the frame differs or the case cannot be played; the connection then ends.
    fn receive(&self, message: Value) -> Option<(Vec<String>, bool)> {
        let mut state = self.lock();
        if message.is_object() {
            state.requests.push(message.clone());
        }
        let cursor = state.cursor;
        let mismatch = match self.steps.get(cursor) {
            None => Some(format!(
                "the client sent {message} where the case has no further step"
            )),
            Some(Step::Send { text, expected }) => {
                if message.is_object() && message == *expected {
                    None
                } else {
                    Some(format!(
                        "step {cursor}: the client sent {message}, the case expects {text}"
                    ))
                }
            }
            Some(step) => Some(format!(
                "the client sent {message} where the case has {}",
                step.text()
            )),
        };
        if let Some(reason) = mismatch {
            let line = self.failure(reason);
            state.failures.push(line);
            return None;
        }
        state.cursor += 1;
        match self.host_frames_locked(&mut state) {
            Ok(next) => Some(next),
            Err(reason) => {
                let line = self.failure(reason);
                state.failures.push(line);
                None
            }
        }
    }

    /// Handles the end of a connection that the client closed. A close step of the client is played by the end; any other end before the
    /// next step is a failure.
    fn connection_ended(&self, error: &io::Error) {
        let mut state = self.lock();
        if state.closing || state.cursor >= self.steps.len() {
            return;
        }
        match &self.steps[state.cursor] {
            Step::Close {
                by_client: true, ..
            } => state.cursor += 1,
            step => {
                let line = self.failure(format!(
                    "the client closed the connection before step {}: {} ({error})",
                    state.cursor,
                    step.text()
                ));
                state.failures.push(line);
            }
        }
    }
}

/// The player of one case. The test takes its configuration directory from dir and sends its frames to the case. The player checks the
/// case when it is dropped at the end of the test.
pub struct CasePlayer {
    shared: Arc<Shared>,
    config_dir: Folder,
    socket_dir: Folder,
    address: PathBuf,
    accept: Option<JoinHandle<()>>,
}

/// Plays the case of the name and returns its player. Each variable of the case takes its example.
pub fn play_case(name: &str) -> CasePlayer {
    open_case(name, &[]).unwrap_or_else(|error| panic!("{error}"))
}

/// Plays the case of the name. The variable takes the text that the host would choose for it instead of its example; a test uses it for
/// a value that depends on the machine, or whose size the case does not state.
pub fn play_case_with_text(name: &str, variable: &str, text: &str) -> CasePlayer {
    open_case(name, &[(variable, text)]).unwrap_or_else(|error| panic!("{error}"))
}

/// Opens the case of the name with the given texts: writes endpoint.json of a new configuration directory, starts listening on the
/// socket that the file names, and starts the accept loop.
fn open_case(name: &str, texts: &[(&str, &str)]) -> Result<CasePlayer, String> {
    let directory = case_directory()?;
    let case = load_case(&directory, name)?;
    let mut given = BTreeMap::new();
    for (variable, text) in texts {
        if !case.examples.contains_key(*variable) {
            return Err(format!(
                "{name}: the test gives a value for variable {variable}, which the case does not declare"
            ));
        }
        given.insert(variable.to_string(), text.to_string());
    }

    let config_dir = Folder::new("sok");
    // A Unix socket path is limited to 104 bytes. The test runner gives the process a short TMPDIR under /tmp, so the socket folder
    // lies there.
    let socket_dir = Folder::new("socket");
    let address = socket_dir.path().join("e.sock");
    let listener = UnixListener::bind(&address)
        .map_err(|error| format!("{name}: cannot listen on {}: {error}", address.display()))?;
    let executable = std::env::current_exe()
        .map_err(|error| format!("{name}: cannot find the test executable: {error}"))?;
    let endpoint = json!({
        "transport": "unix",
        "address": address.display().to_string(),
        "pid": std::process::id(),
        "application": "wailsv3",
        "version": "0.0.40",
        "executable": executable.display().to_string(),
        "started": rfc3339_utc_now(),
    });
    std::fs::write(
        config_dir.path().join("endpoint.json"),
        endpoint.to_string(),
    )
    .map_err(|error| format!("{name}: cannot write endpoint.json: {error}"))?;

    let shared = Arc::new(Shared {
        name: name.to_string(),
        steps: case.steps,
        examples: case.examples,
        texts: given,
        state: Mutex::new(State::default()),
    });
    let accepting = Arc::clone(&shared);
    let accept = std::thread::spawn(move || accept_loop(accepting, listener));
    Ok(CasePlayer {
        shared,
        config_dir,
        socket_dir,
        address,
        accept: Some(accept),
    })
}

/// Returns the current time as an RFC 3339 UTC timestamp with nanoseconds (docs/spec/endpoint.md).
fn rfc3339_utc_now() -> String {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("the clock is before 1970");
    let seconds = i64::try_from(since.as_secs()).expect("the clock is in range");
    let nanos = since.subsec_nanos();
    let days = seconds.div_euclid(86_400);
    let rest = seconds.rem_euclid(86_400);
    // The civil date of the day count, from the algorithm of days_from_civil read in reverse.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{nanos:09}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

/// Accepts the connections of the client. A connection that the player makes to the listener when it closes wakes the loop, which sees
/// the closing flag and returns. A failed accept is a failure of the case.
fn accept_loop(shared: Arc<Shared>, listener: UnixListener) {
    loop {
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) => {
                let mut state = shared.lock();
                if !state.closing {
                    let line = shared.failure(format!("accept: {error}"));
                    state.failures.push(line);
                }
                return;
            }
        };
        if shared.lock().closing {
            return;
        }
        let clone = match stream.try_clone() {
            Ok(clone) => clone,
            Err(error) => {
                shared.fail(format!("cannot keep a connection: {error}"));
                continue;
            }
        };
        let ended: Ended = Arc::new((Mutex::new(false), Condvar::new()));
        let (index, prior) = {
            let mut state = shared.lock();
            state.connections += 1;
            let index = state.connections;
            state.open.insert(index, clone);
            let prior = state.done.clone();
            state.done.push(Arc::clone(&ended));
            (index, prior)
        };
        let worker = Arc::clone(&shared);
        std::thread::spawn(move || serve(worker, stream, index, prior, ended));
    }
}

/// Marks a connection as ended when it is dropped, also while a panic unwinds.
struct Finished(Ended);

impl Drop for Finished {
    fn drop(&mut self) {
        let (lock, signal) = &*self.0;
        *lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
        signal.notify_all();
    }
}

/// Waits until the connection has ended, for at most limit, and reports whether it ended.
fn wait_for_ended(ended: &Ended, limit: Duration) -> bool {
    let (lock, signal) = &**ended;
    let deadline = Instant::now() + limit;
    let mut finished = lock.lock().expect("the connection state");
    while !*finished {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return false;
        };
        finished = signal
            .wait_timeout(finished, remaining)
            .expect("the connection state")
            .0;
    }
    true
}

/// Plays one connection. The connection is released, and marked ended, when this returns.
fn serve(
    shared: Arc<Shared>,
    mut stream: UnixStream,
    index: usize,
    prior: Vec<Ended>,
    ended: Ended,
) {
    let finished = Finished(ended);
    play(&shared, &mut stream, &prior);
    shared.lock().open.remove(&index);
    drop(stream);
    drop(finished);
}

/// Waits for the connections before this one, sends the host frames before the next send step, checks each frame of the client and sends
/// the frames that follow it.
fn play(shared: &Shared, stream: &mut UnixStream, prior: &[Ended]) {
    for previous in prior {
        if !wait_for_ended(previous, CASE_LIMIT) {
            shared.fail("a connection that preceded this one did not end");
            return;
        }
    }
    let (frames, closed_by_host) = match shared.host_frames() {
        Ok(next) => next,
        Err(reason) => {
            shared.fail(reason);
            return;
        }
    };
    if !deliver(shared, stream, &frames) || closed_by_host {
        return;
    }
    loop {
        let body = match read_frame(stream) {
            Ok(body) => body,
            Err(FrameError::TooLong(length)) => {
                shared.fail(format!(
                    "the client sent an invalid frame: {length} bytes is more than {MAX_FRAME}"
                ));
                return;
            }
            Err(FrameError::Ended(error)) => {
                shared.connection_ended(&error);
                return;
            }
        };
        let message: Value = match serde_json::from_slice(&body) {
            Ok(message) => message,
            Err(error) => {
                shared.fail(format!("the client sent an invalid frame: {error}"));
                return;
            }
        };
        let Some((frames, closed_by_host)) = shared.receive(message) else {
            return;
        };
        if !deliver(shared, stream, &frames) || closed_by_host {
            return;
        }
    }
}

/// Writes the frames to the stream in order. A write that fails is a failure of the case, and the connection ends.
fn deliver(shared: &Shared, stream: &mut UnixStream, frames: &[String]) -> bool {
    for body in frames {
        if let Err(error) = write_frame(stream, body.as_bytes()) {
            shared.fail(format!("writing a host frame: {error}"));
            return false;
        }
    }
    true
}

/// Writes one frame: a 4-byte big-endian length and the UTF-8 JSON body.
fn write_frame(stream: &mut UnixStream, body: &[u8]) -> io::Result<()> {
    let length = u32::try_from(body.len())
        .map_err(|_| io::Error::other("the frame is larger than 4 GiB"))?;
    stream.write_all(&length.to_be_bytes())?;
    stream.write_all(body)
}

/// Why a frame of the client could not be read: its length is over the limit, or the connection ended.
enum FrameError {
    TooLong(u32),
    Ended(io::Error),
}

/// Reads one frame: a 4-byte big-endian length and the UTF-8 JSON body (docs/spec/endpoint.md#framing).
fn read_frame(stream: &mut UnixStream) -> Result<Vec<u8>, FrameError> {
    let mut header = [0u8; 4];
    stream.read_exact(&mut header).map_err(FrameError::Ended)?;
    let length = u32::from_be_bytes(header);
    if length > MAX_FRAME {
        return Err(FrameError::TooLong(length));
    }
    let mut body = vec![0u8; length as usize];
    stream.read_exact(&mut body).map_err(FrameError::Ended)?;
    Ok(body)
}

impl Drop for CasePlayer {
    fn drop(&mut self) {
        self.close();
        let failures = std::mem::take(&mut self.shared.lock().failures);
        if failures.is_empty() {
            return;
        }
        let message = failures.join("\n");
        // A panic during the unwinding of a failed assertion aborts the process, so that case reports on stderr.
        if std::thread::panicking() {
            eprintln!("{message}");
        } else {
            panic!("{message}");
        }
    }
}

impl CasePlayer {
    /// Returns the configuration directory that holds endpoint.json.
    pub fn dir(&self) -> String {
        self.config_dir.path().display().to_string()
    }

    /// Returns the methods of the frames that the client sent, in order.
    pub fn methods(&self) -> Vec<String> {
        self.shared
            .lock()
            .requests
            .iter()
            .map(|request| request["method"].as_str().unwrap_or("").to_string())
            .collect()
    }

    /// Returns the params of the last frame that the client sent.
    pub fn last(&self) -> Value {
        self.shared
            .lock()
            .requests
            .last()
            .expect("the client sent a frame")["params"]
            .clone()
    }

    /// Returns the frames that the client sent, in order.
    pub fn frames(&self) -> Vec<Value> {
        self.shared.lock().requests.clone()
    }

    /// Returns the number of connections that the client opened.
    pub fn connection_count(&self) -> usize {
        self.shared.lock().connections
    }

    /// Ends the player. When the next step is a close step of the client, it waits for that close first. It closes the listener and the
    /// connections that are open, and it records a step that was not played.
    fn close(&mut self) {
        let shared = Arc::clone(&self.shared);
        let (waiting, ended) = {
            let state = shared.lock();
            let waiting = matches!(
                shared.steps.get(state.cursor),
                Some(Step::Close {
                    by_client: true,
                    ..
                })
            );
            (waiting, state.done.clone())
        };
        if waiting {
            for connection in &ended {
                if !wait_for_ended(connection, CASE_LIMIT) {
                    shared.fail("the client did not close its connection");
                }
            }
        }
        let open: Vec<UnixStream> = {
            let mut state = shared.lock();
            state.closing = true;
            std::mem::take(&mut state.open).into_values().collect()
        };
        for stream in &open {
            // A connection that the client closed is already disconnected, and macOS reports its shutdown as not connected; that
            // closing succeeds, as it does for the host (endpoint.transport.closing-a-disconnected-connection-succeeds).
            match stream.shutdown(Shutdown::Both) {
                Err(error) if error.kind() != io::ErrorKind::NotConnected => {
                    shared.fail(format!("cannot close a connection: {error}"));
                }
                _ => {}
            }
        }
        // A connection made to the listener wakes the accept loop, which sees the closing flag and returns.
        match UnixStream::connect(&self.address) {
            Ok(wake) => {
                drop(wake);
                if let Some(Err(_)) = self.accept.take().map(JoinHandle::join) {
                    shared.fail("the accept loop panicked");
                }
            }
            Err(error) => shared.fail(format!("cannot wake the accept loop: {error}")),
        }
        for connection in &ended {
            if !wait_for_ended(connection, CASE_LIMIT) {
                shared.fail("a connection did not end after the player closed it");
            }
        }
        let mut state = shared.lock();
        if state.cursor < shared.steps.len() {
            let line = shared.failure(format!(
                "{} steps were not played; the next step is {}",
                shared.steps.len() - state.cursor,
                shared.steps[state.cursor].text()
            ));
            state.failures.push(line);
        }
    }
}
