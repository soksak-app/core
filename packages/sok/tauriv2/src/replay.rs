//! `sok debug replay` (docs/spec/replay.md#command): the events of a session are replayed by the replay executable that an
//! installed sidecar declares, and every stored hash of the sidecar and of the page is compared with the replayed one. The Go
//! implementation (packages/sok/wailsv3/src/replay.go) gives the same output and the same error text.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;

use serde_json::{json, Value};

use crate::debug::{js_string, Json};
use crate::event_log::{EventLog, Level};
use crate::files::{file_error, os_reason};
use crate::log_query::{parse_log_query, query_logs};
use crate::plugins::read_installed;
use crate::routine::spawn_named;
use crate::{config_dir_of, Arguments, Error, Options};

thread_local! {
    /// The event file of the run that `logged` started in this thread; a command stores its own events in it. It is `None` in a
    /// run without an event file (`logged` could not start it and reported that), where the failure that an event describes is
    /// also the error of the command. The command runs in the thread that called `logged`, so a thread has its own run.
    static RUN_LOG: RefCell<Option<Arc<EventLog>>> = const { RefCell::new(None) };
}

/// Installs the event file of the run of this thread, or removes it when the run ends.
pub(crate) fn set_run_log(log: Option<Arc<EventLog>>) {
    RUN_LOG.with(|slot| *slot.borrow_mut() = log);
}

/// The first stored hash that differs from the replayed one.
#[derive(Debug)]
pub struct ReplayDivergence {
    pub session: String,
    pub sequence: i64,
    /// The layer of the stored hash: `sidecar` or `page`.
    pub layer: String,
    /// The replayed hash, or `none` for a page frame that has no frame of the sidecar.
    pub expected: String,
    pub found: String,
}

impl std::fmt::Display for ReplayDivergence {
    fn fmt(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(
            formatter,
            "replay divergence: session {} sequence {} layer {} expected {} found {}",
            self.session, self.sequence, self.layer, self.expected, self.found
        )
    }
}

/// Why a replay did not end with equal hashes.
#[derive(Debug)]
pub enum ReplayFailure {
    Divergence(ReplayDivergence),
    Failed(String),
}

impl From<String> for ReplayFailure {
    fn from(message: String) -> Self {
        ReplayFailure::Failed(message)
    }
}

/// The frame records that were compared and found equal.
#[derive(Debug, Default)]
pub struct ReplayResult {
    pub sidecar_frames: usize,
    pub page_frames: usize,
}

struct Frame {
    sequence: i64,
    hash: String,
    layer: &'static str,
}

fn replay_error(session: &str, text: impl AsRef<str>) -> ReplayFailure {
    ReplayFailure::Failed(format!("replay session {session}: {}", text.as_ref()))
}

fn is_screen_hash(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_replay_role(text: &str) -> bool {
    let mut bytes = text.bytes();
    matches!(bytes.next(), Some(first) if first.is_ascii_lowercase())
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

/// The value of a member of an object of the JSON text of an event.
fn integer_from_one(value: Option<&Value>) -> Option<i64> {
    match value.and_then(Value::as_f64) {
        Some(n) if n >= 1.0 && n.fract() == 0.0 => Some(n as i64),
        _ => None,
    }
}

/// Replays the session from the event files of the configuration directory and compares the frame records. `until` is the
/// greatest sequence that is replayed and compared; `None` replays the whole session. A stored hash that differs from the replayed
/// one is returned as `ReplayFailure::Divergence`.
pub fn replay_logs(
    config_dir: &Path,
    session: &str,
    until: Option<i64>,
) -> Result<ReplayResult, ReplayFailure> {
    let params =
        json!({"channel": "all", "session": session, "order": "asc", "limit": 5000}).to_string();
    let mut query = parse_log_query(&params)?;
    let mut sidecar_lines: Vec<String> = vec![];
    let mut roles: BTreeSet<String> = BTreeSet::new();
    let mut frames: Vec<Frame> = vec![];
    loop {
        let page = query_logs(config_dir, &query, None)?;
        for row in &page.rows {
            let event: Value = serde_json::from_str(row.event.get()).map_err(|error| {
                replay_error(
                    session,
                    format!("{} offset {}: {error}", row.file, row.offset),
                )
            })?;
            let Some(layer) = event["layer"].as_str() else {
                return Err(replay_error(
                    session,
                    format!("{} offset {}: the event has no layer", row.file, row.offset),
                ));
            };
            let fields = &event["fields"];
            let sequence = integer_from_one(fields.get("sequence"));
            if let (Some(sequence), Some(until)) = (sequence, until) {
                if sequence > until {
                    continue;
                }
            }
            let layer: &'static str = match layer {
                "sidecar" => {
                    roles.insert(row.role.clone());
                    sidecar_lines.push(row.event.get().to_string());
                    "sidecar"
                }
                "page" => "page",
                _ => continue,
            };
            if event["class"].as_str() != Some("frame") {
                continue;
            }
            let (Some(sequence), Some(hash)) =
                (sequence, fields.get("hash").and_then(Value::as_str))
            else {
                return Err(replay_error(
                    session,
                    format!(
                        "{} offset {}: a frame record needs an integer fields.sequence from 1 and a string fields.hash",
                        row.file, row.offset
                    ),
                ));
            };
            if !is_screen_hash(hash) {
                return Err(replay_error(
                    session,
                    format!(
                        "sequence {sequence} layer {layer}: the stored hash is not 64 lowercase hexadecimal characters: {}",
                        js_string(hash)
                    ),
                ));
            }
            frames.push(Frame {
                sequence,
                hash: hash.to_string(),
                layer,
            });
        }
        match page.next {
            Some(next) => query.after = Some(next),
            None => break,
        }
    }
    let Some(role) = roles.iter().next().cloned() else {
        return Err(replay_error(
            session,
            "the event files hold no event of the layer sidecar for it",
        ));
    };
    if roles.len() > 1 {
        let names: Vec<&str> = roles.iter().map(String::as_str).collect();
        return Err(replay_error(
            session,
            format!("sidecar events of more than one role: {}", names.join(", ")),
        ));
    }
    if !frames.iter().any(|frame| frame.layer == "sidecar") {
        return Err(replay_error(session, "no frame record to compare"));
    }
    let (folder, executable) = replay_executable(config_dir, session, &role)?;
    let mut input = String::new();
    for line in &sidecar_lines {
        input.push_str(line);
        input.push('\n');
    }
    let replayed = run_replay_executable(session, &folder, &executable, input)?;
    // The records are compared in the order of sequence, a record of the sidecar before a record of the page.
    frames.sort_by_key(|frame| (frame.sequence, frame.layer != "sidecar"));
    let mut result = ReplayResult::default();
    let mut stored: BTreeSet<i64> = BTreeSet::new();
    for frame in &frames {
        let hash = replayed.get(&frame.sequence);
        if frame.layer == "sidecar" {
            let Some(hash) = hash else {
                return Err(replay_error(
                    session,
                    format!(
                        "the replay executable reported no hash for the frame record at sequence {}",
                        frame.sequence
                    ),
                ));
            };
            stored.insert(frame.sequence);
            if *hash != frame.hash {
                return Err(ReplayFailure::Divergence(ReplayDivergence {
                    session: session.to_string(),
                    sequence: frame.sequence,
                    layer: "sidecar".to_string(),
                    expected: hash.clone(),
                    found: frame.hash.clone(),
                }));
            }
            result.sidecar_frames += 1;
            continue;
        }
        let expected = match (stored.contains(&frame.sequence), hash) {
            (true, Some(hash)) => hash.clone(),
            _ => "none".to_string(),
        };
        if expected != frame.hash {
            return Err(ReplayFailure::Divergence(ReplayDivergence {
                session: session.to_string(),
                sequence: frame.sequence,
                layer: "page".to_string(),
                expected,
                found: frame.hash.clone(),
            }));
        }
        result.page_frames += 1;
    }
    Ok(result)
}

/// Finds the installed sidecar that declares the replay role and returns its folder and the declared path of its replay executable.
fn replay_executable(
    config_dir: &Path,
    session: &str,
    role: &str,
) -> Result<(std::path::PathBuf, String), ReplayFailure> {
    let installed = read_installed(config_dir)?;
    let mut declaring: Vec<&String> = vec![];
    let mut found = (std::path::PathBuf::new(), String::new());
    for (name, sidecar) in &installed.sidecars {
        let folder = config_dir.join(&sidecar.path);
        let file = folder.join("sidecar.json");
        let data = std::fs::read(&file)
            .map_err(|error| ReplayFailure::Failed(file_error(file.display(), &error)))?;
        let declaration: Value = serde_json::from_slice(&data)
            .map_err(|error| ReplayFailure::Failed(format!("{}: {error}", file.display())))?;
        let Some(replay) = declaration.get("replay").filter(|replay| !replay.is_null()) else {
            continue;
        };
        if replay.get("role").and_then(Value::as_str) != Some(role) {
            continue;
        }
        let path = replay.get("executable").and_then(Value::as_str);
        let Some(path) = path.filter(|path| {
            is_replay_role(role)
                && !path.is_empty()
                && !path.starts_with('/')
                && !path.split('/').any(|part| part == "..")
        }) else {
            return Err(ReplayFailure::Failed(format!(
                "{}: replay must have a lowercase word role and an executable path inside the package",
                file.display()
            )));
        };
        declaring.push(name);
        found = (folder, path.to_string());
    }
    match declaring.len() {
        0 => Err(replay_error(
            session,
            format!("no installed sidecar declares the replay role {role}"),
        )),
        1 => Ok(found),
        _ => Err(replay_error(
            session,
            format!(
                "the sidecars {} declare the replay role {role}",
                declaring
                    .iter()
                    .map(|name| name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )),
    }
}

/// Runs the replay executable in the folder of its sidecar with the lines on its standard input and reads one `{"sequence",
/// "hash"}` object per line of its standard output.
fn run_replay_executable(
    session: &str,
    folder: &Path,
    executable: &str,
    input: String,
) -> Result<BTreeMap<i64, String>, ReplayFailure> {
    let mut child = Command::new(folder.join(executable))
        .current_dir(folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| replay_error(session, format!("{executable}: {}", os_reason(&error))))?;
    let mut stdin = child.stdin.take().expect("the standard input is piped");
    let mut stdout = child.stdout.take().expect("the standard output is piped");
    let mut stderr = child.stderr.take().expect("the standard error is piped");
    // The input, the output and the error are served by three threads, so a replay executable that prints before it has read
    // its input does not block on a full pipe. A broken pipe means the executable stopped reading; its exit status reports why.
    let writer = spawn_named("replay-input", move || {
        match stdin.write_all(input.as_bytes()) {
            Err(error) if error.kind() != std::io::ErrorKind::BrokenPipe => Err(error.to_string()),
            _ => Ok(()),
        }
    });
    let error_reader = spawn_named("replay-error", move || {
        let mut text = Vec::new();
        stderr
            .read_to_end(&mut text)
            .map(|_| text)
            .map_err(|error| error.to_string())
    });
    let mut output = Vec::new();
    let read = stdout.read_to_end(&mut output);
    let status = child.wait();
    let written = writer
        .join()
        .map_err(|_| replay_error(session, "the input thread ended without a result"))?;
    let error_text = error_reader
        .join()
        .map_err(|_| replay_error(session, "the error thread ended without a result"))?;
    let status = status
        .map_err(|error| replay_error(session, format!("{executable}: {}", os_reason(&error))))?;
    if !status.success() {
        let reason = match error_text {
            Ok(bytes) => String::from_utf8_lossy(&bytes)
                .trim()
                .lines()
                .next()
                // default: an executable that wrote nothing to its standard error has no first line; the exit status is reported.
                .unwrap_or("")
                .to_string(),
            Err(error) => format!("the standard error cannot be read: {error}"),
        };
        return Err(match status.code() {
            Some(code) => replay_error(
                session,
                format!("{executable} exited with status {code}: {reason}"),
            ),
            None => replay_error(
                session,
                format!("{executable} was ended by a signal: {reason}"),
            ),
        });
    }
    written.map_err(|error| replay_error(session, format!("{executable}: {error}")))?;
    read.map_err(|error| replay_error(session, format!("{executable}: {}", os_reason(&error))))?;
    let text = String::from_utf8_lossy(&output).into_owned();
    let mut hashes: BTreeMap<i64, String> = BTreeMap::new();
    if text.is_empty() {
        return Ok(hashes);
    }
    // default: the last line of the output may end without a line feed.
    let body = text.strip_suffix('\n').unwrap_or(&text);
    for (index, line) in body.split('\n').enumerate() {
        let invalid = || {
            replay_error(
                session,
                format!(
                    "replay output line {} is not {{\"sequence\": <integer>, \"hash\": <64 lowercase hexadecimal characters>}}: {line}",
                    index + 1
                ),
            )
        };
        let Ok(Json::Object(object)) = serde_json::from_str::<Json>(line) else {
            return Err(invalid());
        };
        let member = |name: &str| object.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v);
        let (Some(Json::Number(sequence)), Some(Json::String(hash))) =
            (member("sequence"), member("hash"))
        else {
            return Err(invalid());
        };
        if object.len() != 2 || *sequence < 1.0 || sequence.fract() != 0.0 || !is_screen_hash(hash)
        {
            return Err(invalid());
        }
        let sequence = *sequence as i64;
        if let Some(earlier) = hashes.get(&sequence) {
            if earlier != hash {
                return Err(replay_error(
                    session,
                    format!(
                        "the replay executable reported two hashes for the sequence {sequence}"
                    ),
                ));
            }
        }
        hashes.insert(sequence, hash.clone());
    }
    Ok(hashes)
}

/// Runs `sok debug replay <session> [--until <sequence>]`.
pub(crate) fn run_replay(
    a: &Arguments,
    stdout: &mut dyn Write,
    options: &Options,
) -> Result<(), Error> {
    let session = a.positional(2, "session")?;
    let session = session.as_str();
    if let Some(extra) = a.positionals.get(3) {
        return Err(Error::Usage(format!("unexpected argument {extra}")));
    }
    let until = match a.values.get("until") {
        Some(value) => match value.parse::<i64>() {
            Ok(n) if n >= 0 => Some(n),
            _ => {
                return Err(Error::Usage(format!(
                    "--until must be a non-negative integer, found {}",
                    js_string(value)
                )))
            }
        },
        None => None,
    };
    let config_dir = config_dir_of(&a.values, options)?;
    match replay_logs(&config_dir, session, until) {
        Ok(result) => writeln!(
            stdout,
            "replay session {session}: {} sidecar frames and {} page frames equal",
            result.sidecar_frames, result.page_frames
        )
        .map_err(|error| Error::Failed(error.to_string())),
        Err(ReplayFailure::Divergence(divergence)) => {
            // default: a run without an event file stores nothing; the divergence is the error of the command below.
            RUN_LOG.with(|slot| {
                if let Some(log) = slot.borrow().as_ref() {
                    log.emit(
                        Level::Error,
                        "sok.replay.divergence",
                        &json!({
                            "session": divergence.session,
                            "sequence": divergence.sequence,
                            "layer": divergence.layer,
                            "expected": divergence.expected,
                            "found": divergence.found,
                        }),
                    );
                }
            });
            Err(Error::Failed(divergence.to_string()))
        }
        Err(ReplayFailure::Failed(message)) => Err(Error::Failed(message)),
    }
}
