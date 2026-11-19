//! `sok message send <folder> <text>`: writes one message into a registered folder (docs/spec/cli.md#commands,
//! docs/spec/messaging.md#message). The text is written under a temporary name that does not end in `.txt`, and the file is renamed
//! to `<from>.<token>.txt`, the rename being the point at which the message becomes visible.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

use crate::Error;
use crate::files::file_error;

/// The largest text of a message, in bytes; a larger text is refused before a file is written (docs/spec/messaging.md#message).
const MAX_TEXT_BYTES: usize = 64 * 1024;

/// The variable that names the sending surface (docs/spec/sidecars.md#processes-of-a-surface).
const SURFACE_VARIABLE: &str = "SOKSAK_SURFACE";

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// Runs the message commands; `args` are the arguments after the word `message`.
pub(crate) fn run(args: &[String], stdout: &mut dyn Write) -> Result<(), Error> {
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
    let [folder, text] = &args[1..] else {
        return Err(Error::Usage(
            "message send requires a folder and a text".into(),
        ));
    };
    let surface = match std::env::var(SURFACE_VARIABLE) {
        Ok(surface) if !surface.is_empty() => surface,
        _ => {
            return Err(Error::Failed(format!(
                "message send requires {SURFACE_VARIABLE}, which names the sending surface"
            )));
        }
    };
    if surface.contains(['/', '\\', '\0']) {
        return Err(Error::Failed(format!(
            "{SURFACE_VARIABLE} is not a valid surface identifier: {surface}"
        )));
    }
    let name = send(folder, &surface, text)?;
    let output = json!({ "path": name });
    writeln!(stdout, "{output}").map_err(|error| error.to_string())?;
    Ok(())
}

/// Writes `text` as a message of `surface` into `folder` and returns the name of the message file. A text over the limit fails before
/// any file is created.
fn send(folder: &str, surface: &str, text: &str) -> Result<String, Error> {
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
    let name = format!("{surface}.{token}.txt");
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
