//! `sok message send [--reply] <folder> <text>`: writes one message into a registered folder (docs/spec/cli.md#commands,
//! docs/spec/messaging.md#message). A message carries the request for a report to the folder of the sender, and a report (`--reply`)
//! carries the text alone under the token prefix `report-` (docs/spec/messaging.md#report-request). The text is written under a temporary name that does not end in `.txt`, and the file is renamed
//! to `<from>.<token>.txt`, the rename being the point at which the message becomes visible.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::value::RawValue;
use serde_json::{Value, json};

use crate::Error;
use crate::endpoint::{Client, Failure, read_running_endpoint};
use crate::files::file_error;

/// The largest text of a message, in bytes; a larger text is refused before a file is written (docs/spec/messaging.md#message).
const MAX_TEXT_BYTES: usize = 64 * 1024;

/// The end of a refusal of `agent.surface` when `CODEX_THREAD_ID` is in the environment: codex runs the commands of its agent in a
/// shared server that detaches from the terminal, which is no process of a surface (docs/spec/cli.md#commands).
const NO_DAEMON_HINT: &str = "; start codex with --no-daemon, so that the commands of its agent run in processes of the surface";

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// Runs the message commands; `args` are the arguments after the word `message`.
pub(crate) fn run(
    args: &[String],
    stdout: &mut dyn Write,
    options: &crate::Options,
) -> Result<(), Error> {
    if args.len() == 1 && args[0] == "--help" {
        writeln!(stdout, "{}", crate::USAGE).map_err(|error| error.to_string())?;
        return Ok(());
    }
    if args.is_empty() {
        return Err(Error::Usage("message requires an action".into()));
    }
    if args[0] != "send" {
        return Err(Error::Usage(format!(
            "unknown command: message {}",
            args.join(" ")
        )));
    }
    let parsed = crate::parse_scoped_arguments(&args[1..], &["reply"], &["config-dir"])?;
    let [folder, text] = parsed.positionals.as_slice() else {
        return Err(Error::Usage(
            "message send requires a folder and a text".into(),
        ));
    };
    let config_dir = crate::config_dir_of(&parsed.values, options)?;
    let endpoint = match read_running_endpoint(&config_dir)? {
        Ok(endpoint) => endpoint,
        Err(_) => {
            return Err(Error::Failed(
                "message send requires a running application, which answers the surface of this process"
                    .into(),
            ));
        }
    };
    let mut client = Client::dial(&endpoint)?;
    let written = write_message(
        &mut client,
        folder,
        text,
        parsed.flags.contains_key("reply"),
    );
    let closed = client.close();
    let (name, receiver) = written?;
    closed?;
    let output = json!({ "path": name, "receiver": receiver });
    writeln!(stdout, "{output}").map_err(|error| error.to_string())?;
    Ok(())
}

/// The group of a surface in exposure.snapshot, with the members that the receiver reads.
#[derive(Deserialize)]
struct SnapshotGroup {
    #[serde(default)]
    owner: String,
    #[serde(default)]
    surface: String,
    #[serde(default)]
    plugin: String,
}

#[derive(Deserialize)]
struct Snapshot {
    groups: Vec<SnapshotGroup>,
}

#[derive(Deserialize)]
struct Home {
    #[serde(default)]
    window: String,
}

/// Asks the application for the surface of this process, writes the message of that surface into `folder` and reads the hold of its
/// receiver. A refusal of `agent.surface` writes no file.
fn write_message(
    client: &mut Client,
    folder: &str,
    text: &str,
    report: bool,
) -> Result<(String, Value), Error> {
    let own = crate::agent_window::own_surface(&mut |method: &str, params: Option<Value>| {
        client.request(method, params, &mut |_: &str, _: &RawValue| Ok(()))
    })
    .map_err(|failure| Error::Failed(failure.to_string()))?;
    let surface = match own {
        crate::agent_window::OwnSurface::Surface(surface) => surface,
        crate::agent_window::OwnSurface::Refused(refusal) => {
            // default: without CODEX_THREAD_ID the refusal has no hint.
            let hint = match std::env::var_os("CODEX_THREAD_ID") {
                Some(thread) if !thread.is_empty() => NO_DAEMON_HINT,
                _ => "",
            };
            return Err(Error::Failed(format!("message send: {refusal}{hint}")));
        }
    };
    if surface.contains(['/', '\\', '\0']) {
        return Err(Error::Failed(format!(
            "agent.surface answered {surface}, which is not a valid surface identifier"
        )));
    }
    let text = if report {
        text.to_string()
    } else {
        format!("{text}{}", report_request(folder, &surface)?)
    };
    let name = send(folder, &surface, &text, report)?;
    let receiver = receiver(client, folder)
        .map_err(|error| Error::Failed(format!("message {name} was written; {error}")))?;
    Ok((name, receiver))
}

/// Reads the hold of the terminal whose folder is `folder` (docs/spec/messaging.md#delivery): `{surface, plugin, held}` from
/// surface.window, exposure.snapshot and the status `<plugin>.messages` of the surface. It is null when `folder` is not
/// `<root>/.soksak/messages/<surface>`, when the surface is in no window and when the status is null.
fn receiver(client: &mut Client, folder: &str) -> Result<Value, String> {
    let clean: PathBuf = Path::new(folder).components().collect();
    let parent = clean.parent();
    let named = |path: Option<&Path>, name: &str| {
        path.and_then(Path::file_name)
            .is_some_and(|base| base == name)
    };
    if !named(parent, "messages") || !named(parent.and_then(Path::parent), ".soksak") {
        return Ok(Value::Null);
    }
    let Some(terminal) = clean.file_name().and_then(|name| name.to_str()) else {
        return Ok(Value::Null);
    };
    read_receiver(client, terminal)
}

/// Asks the application for the window, the plugin and the status `<plugin>.messages` of the surface `terminal`.
fn read_receiver(client: &mut Client, terminal: &str) -> Result<Value, String> {
    let mut ignore = |_: &str, _: &RawValue| Ok(());
    let result = match client.request(
        "surface.window",
        Some(json!({ "surface": terminal })),
        &mut ignore,
    ) {
        Err(Failure::Endpoint { code: 1012, .. }) => return Ok(Value::Null),
        other => other.map_err(|error| error.to_string())?,
    };
    let window = serde_json::from_str::<Home>(&result)
        .map_err(|error| format!("surface.window returned an unexpected value: {error}: {result}"))?
        .window;
    if window.is_empty() {
        return Err(format!(
            "surface.window returned an unexpected value: {result}"
        ));
    }
    let result = client
        .request(
            "exposure.snapshot",
            Some(json!({ "window": window, "surface": terminal })),
            &mut ignore,
        )
        .map_err(|error| error.to_string())?;
    let snapshot = serde_json::from_str::<Snapshot>(&result)
        .map_err(|_| format!("exposure.snapshot returned an unexpected value: {result}"))?;
    let Some(group) = snapshot
        .groups
        .iter()
        .find(|group| group.owner == "surface" && group.surface == terminal)
    else {
        return Err(format!(
            "exposure.snapshot of window {window} holds no group of surface {terminal}"
        ));
    };
    let name = format!("{}.messages", group.plugin);
    let value = client
        .request(
            "status.get",
            Some(json!({ "name": name, "surface": terminal, "window": window })),
            &mut ignore,
        )
        .map_err(|error| error.to_string())?;
    let status: Value = serde_json::from_str(&value)
        .map_err(|_| format!("status.get returned an unexpected value: {value}"))?;
    if status.is_null() {
        return Ok(Value::Null);
    }
    let Some(held) = status.as_object().and_then(|status| status.get("held")) else {
        return Err(format!(
            "the status {name} of surface {terminal} is not {{folder, registration, held, last}}: {value}"
        ));
    };
    Ok(json!({ "surface": terminal, "plugin": group.plugin, "held": held }))
}

/// The request for a report that a message carries after its text: the folder of the sender is `<root>/.soksak/messages/<surface>`,
/// beside the folder of the receiver, `<root>/.soksak/messages/<receiver>` (docs/spec/messaging.md#report-request). A folder of another
/// form names no root, and the send is refused.
fn report_request(folder: &str, surface: &str) -> Result<String, Error> {
    let messages = Path::new(folder).parent().filter(|messages| {
        messages.file_name().is_some_and(|name| name == "messages")
            && messages
                .parent()
                .and_then(Path::file_name)
                .is_some_and(|name| name == ".soksak")
    });
    let Some(messages) = messages else {
        return Err(Error::Failed(format!(
            "message send: {folder} is not the folder of a terminal, <root>/.soksak/messages/<surface>, so it names no folder of the sender for the report; a report is sent with --reply"
        )));
    };
    Ok(format!(
        " (When done, report the result with sok message send --reply {} \"<report>\")",
        messages.join(surface).display()
    ))
}

/// Writes `text` as a message of `surface` into `folder` and returns the name of the message file; the token of a report starts
/// with `report-`. A text over the limit fails before any file is created.
fn send(folder: &str, surface: &str, text: &str, report: bool) -> Result<String, Error> {
    if !Path::new(folder).is_absolute() {
        return Err(Error::Failed(format!(
            "folder is not an absolute path: {folder}"
        )));
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err(Error::Failed(format!(
            "message text is {} bytes; the limit is {MAX_TEXT_BYTES} bytes (64 KiB)",
            text.len()
        )));
    }
    let folder = Path::new(folder);
    let token = unique_token()?;
    let temporary = folder.join(format!(".tmp-{token}"));
    let name = if report {
        format!("{surface}.report-{token}.txt")
    } else {
        format!("{surface}.{token}.txt")
    };
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| Error::Failed(file_error(temporary.display(), &error)))?;
    let result = file
        .write_all(text.as_bytes())
        .map_err(|error| Error::Failed(file_error(temporary.display(), &error)))
        .and_then(|()| {
            drop(file);
            std::fs::rename(&temporary, folder.join(&name))
                .map_err(|error| Error::Failed(file_error(folder.join(&name).display(), &error)))
        });
    match result {
        Ok(()) => Ok(name),
        // The file was created by this call and holds no message; a failed write or rename removes it.
        Err(error) => match std::fs::remove_file(&temporary) {
            Ok(()) => Err(error),
            Err(removal) => Err(Error::Failed(format!(
                "{}; the temporary file was not removed: {removal}",
                match error {
                    Error::Failed(text) | Error::Usage(text) => text,
                }
            ))),
        },
    }
}

/// A token that holds no dot and is unique for this process and time, so two sends never share a message name.
fn unique_token() -> Result<String, Error> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            Error::Failed(format!(
                "the system clock is before the Unix epoch: {error}"
            ))
        })?
        .as_nanos();
    Ok(format!(
        "{:x}-{nanos:x}-{:x}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    ))
}
