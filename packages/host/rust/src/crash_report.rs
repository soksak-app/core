//! The crash reports of the system (docs/spec/logging.md#automatic-entrances): when the application crashes, the system writes a
//! report into the folder of the crash reports of the user, and the next start of the host announces each report of the
//! application once as the event `host.crash.found`.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::json;

use crate::event_log::Level;
use crate::event_record::emit_host;

/// The number of reports that one lookup reads: the newest reports of the application by name, which carries the date and the
/// time.
pub const CRASH_REPORT_LIMIT: usize = 64;

/// The largest size in bytes of a report that the lookup reads.
const CRASH_REPORT_BYTES: u64 = 16 << 20;

/// The file of the logs folder that lists the announced reports, one path in each line.
const CRASH_LEDGER_NAME: &str = "crash-found.txt";

/// The file under the logs folder of `config` that lists the announced crash reports.
pub fn crash_ledger_path(config: &Path) -> PathBuf {
    config.join("logs").join(CRASH_LEDGER_NAME)
}

/// The first line of a report: the name of the process and the time of the crash.
#[derive(Deserialize)]
struct Header {
    app_name: String,
    timestamp: String,
}

/// The body of a report, of which the lookup reads the process identifier.
#[derive(Deserialize)]
struct Body {
    pid: Option<i64>,
}

/// Stores the event `host.crash.found` (`path`, `pid`, `time`) for each report of the application in `directory` that the ledger
/// file does not list, and lists it there. A report is a file `<application>-<date>.ips` whose header names the application.
/// The lookup reads the newest [`CRASH_REPORT_LIMIT`] reports. A report that cannot be read is an error that names the file; it
/// is listed too, so the error is reported once. A folder that does not exist has no reports. The error joins the failures
/// with a line feed.
pub fn announce_crash_reports(
    directory: &Path,
    ledger: &Path,
    application: &str,
) -> Result<(), String> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // silent: the system creates its folder of crash reports with the first report, so a missing folder holds no report.
            return Ok(());
        }
        Err(error) => {
            return Err(format!("crash reports: {}: {error}", directory.display()));
        }
    };
    let announced = read_ledger(ledger)?;
    let prefix = format!("{application}-");
    let mut names = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("crash reports: {}: {error}", directory.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_file = entry
            .file_type()
            .map(|kind| !kind.is_dir())
            .map_err(|error| format!("crash reports: {}: {error}", entry.path().display()))?;
        if is_file && name.starts_with(&prefix) && name.ends_with(".ips") {
            names.push(name);
        }
    }
    names.sort();
    if names.len() > CRASH_REPORT_LIMIT {
        names.drain(..names.len() - CRASH_REPORT_LIMIT);
    }
    let mut failures = Vec::new();
    let mut kept = String::new();
    for name in names {
        let path = directory.join(&name);
        kept.push_str(&path.to_string_lossy());
        kept.push('\n');
        if announced.contains(&path.to_string_lossy().into_owned()) {
            continue;
        }
        match read_report(&path, application) {
            Ok(Some((pid, time))) => emit_host(
                Level::Warn,
                "host.crash.found",
                json!({"path": path.to_string_lossy(), "pid": pid, "time": time}),
            ),
            Ok(None) => {}
            Err(error) => failures.push(error),
        }
    }
    // The ledger lists only the reports that the next lookup can still read, so it does not grow with the history of the folder.
    if let Err(error) = std::fs::write(ledger, kept) {
        failures.push(format!("crash reports: {}: {error}", ledger.display()));
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("\n"))
    }
}

/// Reads the paths of the announced reports. A missing file lists none.
fn read_ledger(ledger: &Path) -> Result<HashSet<String>, String> {
    match std::fs::read_to_string(ledger) {
        Ok(text) => Ok(text
            .lines()
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // silent: the first lookup creates the ledger, so a missing file lists no announced report.
            Ok(HashSet::new())
        }
        Err(error) => Err(format!("crash reports: {}: {error}", ledger.display())),
    }
}

/// Reads the process identifier and the time of the report at `path`. A report whose header names another application
/// returns `None`.
fn read_report(path: &Path, application: &str) -> Result<Option<(i64, String)>, String> {
    let file = std::fs::File::open(path)
        .map_err(|error| format!("crash report {}: {error}", path.display()))?;
    let mut reader = BufReader::new(file.take(CRASH_REPORT_BYTES));
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|error| {
        format!(
            "crash report {}: the header line cannot be read: {error}",
            path.display()
        )
    })?;
    let header: Header = serde_json::from_str(&line).map_err(|error| {
        format!(
            "crash report {}: the header is not JSON: {error}",
            path.display()
        )
    })?;
    if header.app_name != application {
        // silent: a report of another process whose name starts with the name of the application is not a report of it.
        return Ok(None);
    }
    let body: Body = serde_json::from_reader(reader).map_err(|error| {
        format!(
            "crash report {}: the body has no readable pid: {error}",
            path.display()
        )
    })?;
    match body.pid {
        Some(pid) if pid > 0 => Ok(Some((pid, header.timestamp))),
        _ => Err(format!(
            "crash report {}: the body has no pid",
            path.display()
        )),
    }
}

/// Looks up the crash reports of this application in the folder that the system names and announces them. The application is
/// the name of the executable.
pub fn announce_crash_reports_at_start(config: &Path) -> Result<(), String> {
    let directory = crate::platform::current()
        .map_err(|error| format!("crash reports: {error}"))?
        .diagnostic_reports_directory()
        .map_err(|error| format!("crash reports: {error}"))?;
    let executable = std::env::current_exe().map_err(|error| format!("crash reports: {error}"))?;
    let application = executable
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            format!(
                "crash reports: the executable name of {} is not text",
                executable.display()
            )
        })?;
    announce_crash_reports(&directory, &crash_ledger_path(config), application)
}
