//! A shell process behind a terminal surface.
//!
//! A terminal surface is a webview like the browser one; what differs is that
//! its page is local and is fed by a process running here. The process keeps
//! producing output, which is the point: a surface showing live output cannot
//! be replaced by a still of itself.
//!
//! This is a console, not a terminal emulator: output is streamed as text and
//! input is sent a line at a time. Control sequences are left to the page.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
pub struct Output {
    pub id: String,
    pub text: String,
}

struct Session {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct Shells(Mutex<HashMap<String, Session>>);

/// The user's shell, or the platform's default when it is not set.
///
/// Not interactive. An interactive shell draws its own prompt with the escape
/// sequences a terminal would act on, and this page is not a terminal: it would
/// print them as text. The page draws the prompt itself and the shell is left to
/// produce output only.
fn shell() -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        let program = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
        (program, vec![])
    }
    #[cfg(not(windows))]
    {
        let program = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        (program, vec![])
    }
}

impl Shells {
    /// Starts a shell for `id`, or does nothing if one is already running.
    pub fn open(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let mut running = self.0.lock().map_err(|e| e.to_string())?;
        if running.contains_key(id) {
            return Ok(());
        }

        let (program, args) = shell();
        // Started in the user's home directory, not the app's working directory.
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(std::path::PathBuf::from);
        let mut child = Command::new(&program);
        if let Some(home) = home {
            child.current_dir(home);
        }
        let mut child = child
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("{program}: {e}"))?;

        let stdin = child.stdin.take().ok_or("no stdin")?;
        for stream in [
            child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
            child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let app = app.clone();
            let id = id.to_string();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream);
                let mut line = Vec::new();
                // Read as bytes. A shell writes whatever the program printed, and
                // reading it as text ends the stream on the first byte that is not
                // UTF-8, which silences that surface for the rest of the session.
                // The newline is kept, so the page receives the breaks the shell
                // actually wrote.
                loop {
                    line.clear();
                    match reader.read_until(b'\n', &mut line) {
                        Ok(0) => break,
                        Ok(_) => {}
                        Err(e) => {
                            eprintln!("terminal {id}: {e}");
                            break;
                        }
                    }
                    let _ = app.emit(
                        "terminal-output",
                        Output {
                            id: id.clone(),
                            text: String::from_utf8_lossy(&line).into_owned(),
                        },
                    );
                }
            });
        }

        running.insert(id.to_string(), Session { child, stdin });
        Ok(())
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let mut running = self.0.lock().map_err(|e| e.to_string())?;
        let Some(session) = running.get_mut(id) else {
            return Err(format!("shell {id} is not running"));
        };
        session.stdin.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        session.stdin.flush().map_err(|e| e.to_string())
    }

    /// Ends the shells whose surfaces are gone. A surface that closed with its
    /// process still running would leave the process with nothing to write to.
    ///
    /// The processes are ended on a thread of their own. Ending one means
    /// waiting for it, and this is called from the main thread, where waiting
    /// stops the window from drawing.
    pub fn retain(&self, alive: &dyn Fn(&str) -> bool) -> Result<(), String> {
        let mut running = self.0.lock().map_err(|e| e.to_string())?;
        let ended: Vec<String> = running.keys().filter(|id| !alive(id)).cloned().collect();
        let gone: Vec<Session> = ended.iter().filter_map(|id| running.remove(id)).collect();
        if !gone.is_empty() {
            std::thread::spawn(move || {
                for mut session in gone {
                    let _ = session.child.kill();
                    let _ = session.child.wait();
                }
            });
        }
        Ok(())
    }
}
