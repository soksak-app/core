//! `sok debug replay` (docs/spec/replay.md#command): the events of a session are replayed by the replay executable that an
//! installed sidecar declares, and every stored hash of the sidecar and of the page is compared with the replayed one. The Go
//! implementation (packages/sok/wailsv3/src/replay.go) gives the same output and the same error text.

use crate::replay_inputs::{REPLAY_INPUT_KINDS, ReplayInput, replay_session_problem};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;

use serde_json::{Value, json};

use crate::debug::{Json, js_string};
use crate::event_log::{EventLog, Level};
use crate::files::{file_error, os_reason};
use crate::log_query::{LogRow, parse_log_query, query_logs};
use crate::plugins::read_installed;
use crate::routine::spawn_named;
use crate::{Arguments, Error, Options, config_dir_of};

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
    /// The boot of the run of the sidecar that produced the screen (docs/spec/replay.md#segments).
    pub segment: String,
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
            "replay divergence: session {} segment {} sequence {} layer {} expected {} found {}",
            self.session, self.segment, self.sequence, self.layer, self.expected, self.found
        )
    }
}

/// Why a replay did not end with equal hashes.
#[derive(Debug)]
pub enum ReplayFailure {
    Divergence(Box<ReplayDivergence>),
    Failed(String),
}

impl From<String> for ReplayFailure {
    fn from(message: String) -> Self {
        ReplayFailure::Failed(message)
    }
}

/// The frame records that were compared and found equal, the segments of the session and the greatest number of event lines that
/// the replay held at once (the lines of one segment).
#[derive(Debug, Default)]
pub struct ReplayResult {
    pub sidecar_frames: usize,
    pub page_frames: usize,
    pub segments: usize,
    pub held_lines: usize,
}

/// A frame record of the session. `segment` is the boot of the run of the sidecar: of the row for a record of the sidecar, and
/// the `fields.segment` that the page stored for a record of the page, which is empty when it stored none.
struct Frame {
    sequence: i64,
    hash: String,
    layer: &'static str,
    segment: String,
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

/// The function that a scan of a session calls for each row: the row, its event, its layer and its sequence.
type ReplayVisit<'a> =
    dyn FnMut(&LogRow, &Value, &'static str, Option<i64>) -> Result<(), ReplayFailure> + 'a;

/// Calls `visit` for each row of the session in the order of the query, with the event, its layer and its sequence (`None` when it has
/// none). A row of a layer other than sidecar and plugin (the page frame records) is not visited, and neither is a row with a sequence above `until`.
fn scan_replay_session(
    config_dir: &Path,
    session: &str,
    until: Option<i64>,
    visit: &mut ReplayVisit,
) -> Result<(), ReplayFailure> {
    let params =
        json!({"channel": "all", "session": session, "order": "asc", "limit": 5000}).to_string();
    let mut query = parse_log_query(&params)?;
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
            let sequence = integer_from_one(event["fields"].get("sequence"));
            if let (Some(sequence), Some(until)) = (sequence, until)
                && sequence > until
            {
                continue;
            }
            let layer: &'static str = match layer {
                "sidecar" => "sidecar",
                "plugin" => "plugin",
                _ => continue,
            };
            visit(row, &event, layer, sequence)?;
        }
        match page.next {
            Some(next) => query.after = Some(next),
            None => return Ok(()),
        }
    }
}

/// Replays the session from the event files of the configuration directory and compares the frame records. `until` is the
/// greatest sequence that is replayed and compared; `None` replays the whole session. A stored hash that differs from the replayed
/// one is returned as `ReplayFailure::Divergence`.
///
/// A session is a list of segments, one for each run (boot) of the sidecar, because the sequence restarts at 1 in a new run
/// (docs/spec/replay.md#segments). The first scan reads the frame records and the boots; the second scan collects the event lines
/// of one segment at a time, runs the replay executable on them and compares that segment, so the lines of the session are never
/// held together.
pub fn replay_logs(
    config_dir: &Path,
    session: &str,
    until: Option<i64>,
) -> Result<ReplayResult, ReplayFailure> {
    let mut roles: BTreeSet<String> = BTreeSet::new();
    let mut segments: Vec<String> = vec![];
    let mut frames: Vec<Frame> = vec![];
    scan_replay_session(
        config_dir,
        session,
        until,
        &mut |row, event, layer, sequence| {
            if layer == "sidecar" {
                roles.insert(row.role.clone());
                if segments.last() != Some(&row.boot) {
                    if segments.contains(&row.boot) {
                        return Err(replay_error(
                            session,
                            format!(
                                "the sidecar events of the segments {} and {} are interleaved",
                                row.boot,
                                segments.last().expect("a segment exists")
                            ),
                        ));
                    }
                    segments.push(row.boot.clone());
                }
            }
            if event["class"].as_str() != Some("frame") {
                return Ok(());
            }
            let fields = &event["fields"];
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
            let segment = if layer == "sidecar" {
                row.boot.clone()
            } else {
                match fields.get("segment") {
                    None | Some(Value::Null) => String::new(),
                    Some(Value::String(stored)) => stored.clone(),
                    Some(_) => {
                        return Err(replay_error(
                            session,
                            format!(
                                "the page frame record at sequence {sequence} has a fields.segment that is not text"
                            ),
                        ));
                    }
                }
            };
            frames.push(Frame {
                sequence,
                hash: hash.to_string(),
                layer,
                segment,
            });
            Ok(())
        },
    )?;
    if segments.is_empty() {
        return Err(replay_error(
            session,
            "the event files hold no event of the layer sidecar for it",
        ));
    }
    if roles.len() > 1 {
        let names: Vec<&str> = roles.iter().map(String::as_str).collect();
        return Err(replay_error(
            session,
            format!("sidecar events of more than one role: {}", names.join(", ")),
        ));
    }
    let role = roles.iter().next().cloned().expect("a role exists");
    if !frames.iter().any(|frame| frame.layer == "sidecar") {
        return Err(replay_error(session, "no frame record to compare"));
    }
    // A page frame names the segment of the screen message it received.
    for frame in frames.iter().filter(|frame| frame.layer == "plugin") {
        if frame.segment.is_empty() {
            return Err(replay_error(
                session,
                format!(
                    "the page frame record at sequence {} has no fields.segment",
                    frame.sequence
                ),
            ));
        } else if !segments.contains(&frame.segment) {
            return Err(replay_error(
                session,
                format!(
                    "the page frame record at sequence {} names the segment {}, which the session does not have",
                    frame.sequence, frame.segment
                ),
            ));
        }
    }
    let tool = replay_executable(config_dir, session, &role)?;
    let mut result = ReplayResult {
        segments: segments.len(),
        ..ReplayResult::default()
    };
    let mut next = 0;
    let mut lines: Vec<String> = vec![];
    // Replays and compares the segments up to and including `through`, the first of them with the lines held now.
    let mut finish = |through: Option<usize>,
                      lines: &mut Vec<String>,
                      result: &mut ReplayResult|
     -> Result<(), ReplayFailure> {
        let Some(through) = through else {
            return Ok(());
        };
        while next <= through {
            compare_replay_segment(session, &segments[next], &frames, &tool, lines, result)?;
            lines.clear();
            next += 1;
        }
        Ok(())
    };
    scan_replay_session(
        config_dir,
        session,
        until,
        &mut |row, _event, layer, _sequence| {
            if layer != "sidecar" {
                return Ok(());
            }
            let Some(index) = segments.iter().position(|boot| *boot == row.boot) else {
                return Err(replay_error(
                    session,
                    format!(
                        "the event files changed during the replay: the segment {} was not there before",
                        row.boot
                    ),
                ));
            };
            finish(index.checked_sub(1), &mut lines, &mut result)?;
            lines.push(row.event.get().to_string());
            result.held_lines = result.held_lines.max(lines.len());
            Ok(())
        },
    )?;
    finish(segments.len().checked_sub(1), &mut lines, &mut result)?;
    Ok(result)
}

/// Runs the replay executable on the lines of the segment and compares the frame records of the segment in the order of
/// sequence, a record of the sidecar before a record of the page. A segment with no frame record of the sidecar runs nothing:
/// its page frame records have none to equal.
fn compare_replay_segment(
    session: &str,
    segment: &str,
    all: &[Frame],
    tool: &ReplayTool,
    lines: &[String],
    result: &mut ReplayResult,
) -> Result<(), ReplayFailure> {
    // The replay inputs of the segment follow the rules of a session before the executable applies them
    // (docs/spec/replay.md#command).
    let mut inputs = vec![];
    for line in lines {
        let event: Value = serde_json::from_str(line)
            .map_err(|error| replay_error(session, format!("segment {segment}: {error}")))?;
        let Some(kind) = event
            .get("event")
            .and_then(Value::as_str)
            .and_then(|name| tool.kinds.get(name))
        else {
            continue;
        };
        inputs.push(ReplayInput {
            kind: kind.clone(),
            fields: event
                .get("fields")
                .map(Value::to_string)
                // default: an event without fields has none, which the form check refuses with the member it lacks.
                .unwrap_or_default(),
        });
    }
    if let Some(problem) = replay_session_problem(&inputs) {
        return Err(replay_error(
            session,
            format!("segment {segment}: {problem}"),
        ));
    }
    let mut frames: Vec<&Frame> = all
        .iter()
        .filter(|frame| frame.segment == segment)
        .collect();
    frames.sort_by_key(|frame| (frame.sequence, frame.layer != "sidecar"));
    let replayed = if frames.iter().any(|frame| frame.layer == "sidecar") {
        let mut input = String::new();
        for line in lines {
            input.push_str(line);
            input.push('\n');
        }
        run_replay_executable(session, &tool.folder, &tool.executable, input)?
    } else {
        BTreeMap::new()
    };
    let mut stored: BTreeSet<i64> = BTreeSet::new();
    for frame in frames {
        let hash = replayed.get(&frame.sequence);
        let divergence = |layer: &str, expected: String| {
            ReplayFailure::Divergence(Box::new(ReplayDivergence {
                session: session.to_string(),
                segment: segment.to_string(),
                sequence: frame.sequence,
                layer: layer.to_string(),
                expected,
                found: frame.hash.clone(),
            }))
        };
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
                return Err(divergence("sidecar", hash.clone()));
            }
            result.sidecar_frames += 1;
            continue;
        }
        let expected = match (stored.contains(&frame.sequence), hash) {
            (true, Some(hash)) => hash.clone(),
            _ => "none".to_string(),
        };
        if expected != frame.hash {
            return Err(divergence("plugin", expected));
        }
        result.page_frames += 1;
    }
    Ok(())
}

/// The replay executable of the installed sidecar that declares the role: its folder, the declared path of the executable,
/// and the kind of each replay input by the name of its event (`replay.inputs`).
struct ReplayTool {
    folder: std::path::PathBuf,
    executable: String,
    kinds: BTreeMap<String, String>,
}

/// Finds the installed sidecar that declares the replay role and returns its replay executable and the kinds of its inputs.
fn replay_executable(
    config_dir: &Path,
    session: &str,
    role: &str,
) -> Result<ReplayTool, ReplayFailure> {
    let installed = read_installed(config_dir)?;
    let mut declaring: Vec<&String> = vec![];
    let mut found = ReplayTool {
        folder: std::path::PathBuf::new(),
        executable: String::new(),
        kinds: BTreeMap::new(),
    };
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
        // The kind of a replay input is the sidecar's choice of event name, which replay.inputs declares (docs/spec/sidecars.md).
        let mut kinds = BTreeMap::new();
        for kind in REPLAY_INPUT_KINDS {
            let event = replay
                .get("inputs")
                .and_then(|inputs| inputs.get(kind))
                .and_then(Value::as_str);
            let Some(event) = event.filter(|event| event.starts_with("sidecar.")) else {
                return Err(ReplayFailure::Failed(format!(
                    "{}: replay.inputs must name the event of the layer sidecar of each kind of replay input; {kind} is {:?}",
                    file.display(),
                    // default: an absent member is shown as the empty text, as the Go tool shows it.
                    event.unwrap_or("")
                )));
            };
            kinds.insert(event.to_string(), kind.to_string());
        }
        declaring.push(name);
        found = ReplayTool {
            folder,
            executable: path.to_string(),
            kinds,
        };
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
        if let Some(earlier) = hashes.get(&sequence)
            && earlier != hash
        {
            return Err(replay_error(
                session,
                format!("the replay executable reported two hashes for the sequence {sequence}"),
            ));
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
                )));
            }
        },
        None => None,
    };
    let config_dir = config_dir_of(&a.values, options)?;
    match replay_logs(&config_dir, session, until) {
        Ok(result) => writeln!(
            stdout,
            "replay session {session}: {} sidecar frames and {} page frames equal in {} segments",
            result.sidecar_frames, result.page_frames, result.segments
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
                            "segment": divergence.segment,
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
