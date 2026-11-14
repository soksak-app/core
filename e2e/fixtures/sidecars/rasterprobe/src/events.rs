// The event files of the service (docs/spec/logging.md#event, #files, #policy-file): `<role>-<boot>.jsonl` holds the levels error,
// warn and info and `<role>-<boot>.debug.jsonl` the levels debug and trace, each starting with log.open; seq runs across both. The
// policy is `log-policy.json` in the parent folder of the log folder. The fixture writes each event synchronously under one lock and
// reads the policy again before an event when the file changed (its inode, size or modification time), so it needs no watcher; the
// first policy and each change of it are the event log.policy, which passes every gate.
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

use crate::service::{Class, Level};

unsafe extern "C" {
    /// The monotonic clock of docs/spec/logging.md#event (`CLOCK_UPTIME_RAW` on macOS) in nanoseconds.
    fn clock_gettime_nsec_np(clock: libc::clockid_t) -> u64;
}

pub const ROLE: &str = "rasterprobe";
const CLASSES: [&str; 5] = ["lifecycle", "input", "call", "io", "frame"];
const LEVELS: [&str; 6] = ["off", "error", "warn", "info", "debug", "trace"];

/// The UTC time `YYYY-MM-DDTHH:MM:SS.mmmZ` of a text record (docs/spec/diagnostics.md#forms).
pub fn utc(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since.as_secs() as i64;
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // The civil date of a day count (Howard Hinnant, days_from_civil inverted).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        since.subsec_millis()
    )
}

/// Writes one text record of the layer sidecar to the standard error, which the host opened on `logs/<executable>.log`.
pub fn record(level: &str, place: &str, text: &str) {
    let line = format!("{} {level} sidecar {place}: {}\n", utc(SystemTime::now()), text.replace('\n', "\\n"));
    // A failed write of the standard error has no other place to go.
    let _ = std::io::stderr().write_all(line.as_bytes());
}

/// The least severe level that the policy stores for each class, as an index of LEVELS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy([usize; 5]);

impl Policy {
    pub const DEFAULT: Policy = Policy([1; 5]);

    fn stores(&self, class: Class, level: Level) -> bool {
        level as usize <= self.0[class as usize]
    }

    fn classes(&self) -> Value {
        Value::Object(CLASSES.iter().zip(self.0).map(|(class, level)| (class.to_string(), json!(LEVELS[level]))).collect())
    }

    /// Reads a policy file with the rules of docs/spec/logging.md#policy-file; None for a file that is being written.
    pub fn parse(file: &str, text: &str) -> Result<Option<Policy>, String> {
        if text.trim().is_empty() {
            return Ok(None);
        }
        let value: Value = serde_json::from_str(text).map_err(|error| format!("{file}: not JSON: {error}"))?;
        let object = value.as_object().ok_or_else(|| format!("{file}: not JSON: not an object"))?;
        let mut names: Vec<&String> = object.keys().collect();
        names.sort();
        if let Some(name) = names.iter().find(|name| name.as_str() != "schema" && name.as_str() != "classes") {
            return Err(format!("{file}: the member {name} is not one of schema, classes"));
        }
        match object.get("schema") {
            Some(Value::Number(number)) if number.is_i64() || number.is_u64() => {
                if number.as_i64() != Some(1) {
                    return Err(format!("{file}: schema {number} is not 1"));
                }
            }
            // default: a missing schema prints as null, the value that the reader found.
            other => return Err(format!("{file}: schema must be the number 1, found {}", other.unwrap_or(&Value::Null))),
        }
        let classes = object
            .get("classes")
            .and_then(Value::as_object)
            .ok_or_else(|| format!("{file}: classes must be an object that names every class"))?;
        let mut given: Vec<&String> = classes.keys().collect();
        given.sort();
        if let Some(name) = given.iter().find(|name| !CLASSES.contains(&name.as_str())) {
            return Err(format!("{file}: the class {name} is not one of lifecycle, input, call, io, frame"));
        }
        let mut levels = [0; 5];
        for (index, class) in CLASSES.iter().enumerate() {
            let value = classes.get(*class).ok_or_else(|| format!("{file}: the class {class} is missing"))?;
            let text = value.as_str().ok_or_else(|| format!("{file}: the level of the class {class} must be text, found {value}"))?;
            levels[index] = LEVELS.iter().position(|level| *level == text).ok_or_else(|| {
                format!("{file}: the level \"{text}\" of the class {class} is not one of off, error, warn, info, debug, trace")
            })?;
        }
        Ok(Some(Policy(levels)))
    }
}

struct Inner {
    seq: u64,
    main: Option<File>,
    debug: Option<File>,
    policy: Policy,
    stamp: Option<(u64, u64, i64, i64)>,
    announced: bool,
}

/// The writer of the event files of one run of the service.
pub struct EventLog {
    dir: Option<PathBuf>,
    boot: String,
    pid: u32,
    inner: Mutex<Inner>,
}

impl EventLog {
    /// A writer into `dir`, or a writer that stores nothing for a service started without `--log-dir`.
    pub fn new(dir: Option<PathBuf>) -> EventLog {
        // The boot `<seconds>-<pid>` of the hosts and sok, so the files take the name form `<role>-<digits>-<digits>` that the
        // audit of a configuration folder reads (scripts/check-events.mjs, eventFiles).
        let pid = std::process::id();
        let seconds = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        EventLog {
            dir,
            boot: format!("{seconds}-{pid}"),
            pid,
            inner: Mutex::new(Inner { seq: 0, main: None, debug: None, policy: Policy::DEFAULT, stamp: None, announced: false }),
        }
    }

    pub fn boot(&self) -> &str {
        &self.boot
    }

    fn clocks() -> (u64, u64) {
        let ts_us = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_micros() as u64;
        // SAFETY: the call takes a clock id and returns its time.
        let mono_ns = unsafe { clock_gettime_nsec_np(libc::CLOCK_UPTIME_RAW) };
        (ts_us, mono_ns)
    }

    fn line(inner: &mut Inner, level: &str, class: &str, event: &str, ids: &[(&str, &str)], cids: &[String], fields: Value) -> String {
        let (ts_us, mono_ns) = Self::clocks();
        inner.seq += 1;
        let mut object = Map::new();
        object.insert("ts_us".into(), json!(ts_us));
        object.insert("mono_ns".into(), json!(mono_ns));
        object.insert("seq".into(), json!(inner.seq));
        object.insert("level".into(), json!(level));
        object.insert("class".into(), json!(class));
        object.insert("layer".into(), json!("sidecar"));
        object.insert("event".into(), json!(event));
        for (key, value) in ids {
            object.insert((*key).into(), json!(value));
        }
        if !cids.is_empty() {
            object.insert("cids".into(), json!(cids));
        }
        object.insert("fields".into(), fields);
        let mut text = Value::Object(object).to_string();
        text.push('\n');
        text
    }

    /// Writes the line that `build` makes after the file of its channel exists, so log.open takes the seq before it.
    fn write(&self, inner: &mut Inner, debug: bool, build: impl FnOnce(&mut Inner) -> String) {
        let Some(dir) = &self.dir else { return };
        let missing = if debug { inner.debug.is_none() } else { inner.main.is_none() };
        if missing {
            let name = if debug { format!("{ROLE}-{}.debug.jsonl", self.boot) } else { format!("{ROLE}-{}.jsonl", self.boot) };
            if let Err(error) = std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir) {
                record("error", "event log", &format!("{}: {error}", dir.display()));
                return;
            }
            let opened = OpenOptions::new().create(true).append(true).mode(0o600).open(dir.join(&name));
            let mut file = match opened {
                Ok(file) => file,
                Err(error) => {
                    record("error", "event log", &format!("{name}: {error}"));
                    return;
                }
            };
            let open = Self::line(inner, "info", "lifecycle", "log.open", &[], &[],
                json!({"schema": 3, "pid": self.pid, "role": ROLE, "boot": self.boot}));
            if let Err(error) = file.write_all(open.as_bytes()) {
                record("error", "event log", &format!("{name}: {error}"));
            }
            if debug { inner.debug = Some(file) } else { inner.main = Some(file) }
        }
        let text = build(inner);
        let file = if debug { inner.debug.as_mut() } else { inner.main.as_mut() };
        if let Some(file) = file
            && let Err(error) = file.write_all(text.as_bytes())
        {
            record("error", "event log", &format!("write: {error}"));
        }
    }

    /// Applies the policy file when it changed since the last read, and stores log.policy for the first policy and each change.
    fn refresh(&self, inner: &mut Inner) {
        let Some(dir) = &self.dir else { return };
        let Some(parent) = dir.parent() else { return };
        let path = parent.join("log-policy.json");
        let (stamp, next) = match std::fs::metadata(&path) {
            Ok(meta) => {
                let stamp = (meta.ino(), meta.size(), meta.mtime(), meta.mtime_nsec());
                if inner.stamp == Some(stamp) && inner.announced {
                    return;
                }
                let read = std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()));
                match read.and_then(|text| Policy::parse(&path.display().to_string(), &text)) {
                    Ok(Some(policy)) => (Some(stamp), Some((policy, "file"))),
                    Ok(None) => return,
                    Err(error) => {
                        record("error", "log policy", &error);
                        (Some(stamp), None)
                    }
                }
            }
            Err(_) => (None, Some((Policy::DEFAULT, "default"))),
        };
        if inner.stamp == stamp && inner.announced {
            return;
        }
        inner.stamp = stamp;
        let Some((policy, source)) = next else { return };
        if inner.announced && policy == inner.policy {
            return;
        }
        inner.policy = policy;
        inner.announced = true;
        let fields = json!({"source": source, "classes": inner.policy.classes()});
        self.write(inner, false, |inner| Self::line(inner, "info", "lifecycle", "log.policy", &[], &[], fields));
    }
}

impl EventLog {
    #[allow(clippy::too_many_arguments)]
    pub fn event(&self, level: Level, class: Class, event: &str, surface: Option<&str>, session: Option<&str>, cids: &[String], fields: Value) {
        // default: a lock that a panicking thread poisoned still holds the counters and files, which stay usable.
        let mut inner = self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        self.refresh(&mut inner);
        if !inner.policy.stores(class, level) {
            return;
        }
        let mut ids = Vec::new();
        if let Some(surface) = surface {
            ids.push(("surface", surface));
        }
        if let Some(session) = session {
            ids.push(("session", session));
        }
        let debug = matches!(level, Level::Debug | Level::Trace);
        self.write(&mut inner, debug, |inner| Self::line(inner, level.name(), CLASSES[class as usize], event, &ids, cids, fields));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_time_of_a_text_record_is_utc_with_milliseconds() {
        let time = UNIX_EPOCH + std::time::Duration::from_millis(1_791_500_000_123);
        assert_eq!(utc(time), "2026-10-08T22:53:20.123Z");
        assert_eq!(utc(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn the_policy_file_follows_the_rules_of_the_contract() {
        let file = "log-policy.json";
        let all = r#"{"schema":1,"classes":{"lifecycle":"info","input":"trace","call":"error","io":"debug","frame":"off"}}"#;
        let policy = Policy::parse(file, all).unwrap().unwrap();
        assert!(policy.stores(Class::Io, Level::Debug));
        assert!(!policy.stores(Class::Io, Level::Trace));
        assert!(!policy.stores(Class::Frame, Level::Error));
        assert_eq!(Policy::parse(file, "  \n").unwrap(), None);
        for (text, error) in [
            ("[", "log-policy.json: not JSON: "),
            (r#"{"schema":1,"classes":{},"extra":1}"#, "log-policy.json: the member extra is not one of schema, classes"),
            (r#"{"schema":"1","classes":{}}"#, "log-policy.json: schema must be the number 1, found \"1\""),
            (r#"{"schema":2,"classes":{}}"#, "log-policy.json: schema 2 is not 1"),
            (r#"{"schema":1,"classes":[]}"#, "log-policy.json: classes must be an object that names every class"),
            (r#"{"schema":1,"classes":{"paint":"off"}}"#, "log-policy.json: the class paint is not one of lifecycle, input, call, io, frame"),
            (r#"{"schema":1,"classes":{"lifecycle":"off"}}"#, "log-policy.json: the class input is missing"),
            (r#"{"schema":1,"classes":{"lifecycle":1,"input":"off","call":"off","io":"off","frame":"off"}}"#,
                "log-policy.json: the level of the class lifecycle must be text, found 1"),
            (r#"{"schema":1,"classes":{"lifecycle":"all","input":"off","call":"off","io":"off","frame":"off"}}"#,
                "log-policy.json: the level \"all\" of the class lifecycle is not one of off, error, warn, info, debug, trace"),
        ] {
            let found = Policy::parse(file, text).unwrap_err();
            assert!(found.starts_with(error), "{text}: {found}");
        }
    }

    #[test]
    fn events_go_to_the_main_and_the_debug_file_with_one_seq_and_the_policy_gate() {
        let root = std::env::temp_dir().join(format!("rasterprobe-events-{}-{}", std::process::id(), line!()));
        let logs = root.join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(root.join("log-policy.json"),
            r#"{"schema":1,"classes":{"lifecycle":"info","input":"error","call":"error","io":"debug","frame":"error"}}"#).unwrap();
        let log = EventLog::new(Some(logs.clone()));
        log.event(Level::Debug, Class::Io, "sidecar.rasterprobe.request", Some("tab-1"), None, &["b.1".into()], json!({"operation": "open", "bytes": 2}));
        log.event(Level::Debug, Class::Frame, "sidecar.rasterprobe.frame", Some("tab-1"), None, &[], json!({}));
        log.event(Level::Info, Class::Lifecycle, "sidecar.rasterprobe.exit", None, None, &[], json!({"cause": "test"}));
        let read = |name: String| -> Vec<Value> {
            std::fs::read_to_string(logs.join(name)).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
        };
        let main = read(format!("rasterprobe-{}.jsonl", log.boot()));
        let debug = read(format!("rasterprobe-{}.debug.jsonl", log.boot()));
        std::fs::remove_dir_all(&root).unwrap();
        let names = |lines: &[Value]| lines.iter().map(|line| line["event"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(names(&main), ["log.open", "log.policy", "sidecar.rasterprobe.exit"]);
        assert_eq!(names(&debug), ["log.open", "sidecar.rasterprobe.request"]);
        assert_eq!(main[1]["fields"]["source"], "file");
        assert_eq!(debug[1]["cids"], json!(["b.1"]));
        assert_eq!(debug[1]["surface"], "tab-1");
        assert_eq!(debug[1]["layer"], "sidecar");
        let mut seqs: Vec<u64> = main.iter().chain(&debug).map(|line| line["seq"].as_u64().unwrap()).collect();
        seqs.sort();
        assert_eq!(seqs, [1, 2, 3, 4, 5], "seq runs across both files without the gated frame");
    }
}
