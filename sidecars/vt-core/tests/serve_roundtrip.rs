/// End-to-end integration test with real ptyd daemon
///
/// This test verifies the complete flow from serve() function through DaemonSessionPort
/// to the real ptyd daemon and back. It tests that:
/// 1. serve() can open a session with the daemon
/// 2. serve() can send input to the daemon
/// 3. daemon output is captured and converted to screen events
///
/// NOTE: This test currently fails because the daemon is not sending output responses
/// for shell commands. This appears to be a PTY configuration issue where the shell's
/// output is not being captured by the daemon. The daemon_integration.rs tests confirm
/// that the daemon can handle output (they pass), so the issue is specific to how
/// serve() is using DaemonSessionPort with a /bin/sh session.
use soksak_sidecar_vt_core::protocol::{serve, Engine, Screen, Cursor, Modes, Cell, SessionPort};
use soksak_sidecar_vt_core::platform::DarwinDaemonFinder;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncWriteExt, AsyncBufReadExt};

/// Simple engine that builds a screen from bytes
/// \r moves to column 0, \n moves to next line, other bytes are cells
struct SimpleEngine {
    cols: u16,
    rows: u16,
    screen: Vec<Vec<Cell>>,
    current_row: usize,
    current_col: usize,
}

impl SimpleEngine {
    fn new() -> Self {
        Self {
            cols: 80,
            rows: 24,
            screen: vec![vec![]; 24],
            current_row: 0,
            current_col: 0,
        }
    }
}

impl Engine for SimpleEngine {
    fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols;
        self.rows = rows;
        self.screen = vec![vec![]; rows as usize];
        self.current_row = 0;
        self.current_col = 0;
    }

    fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            match b {
                b'\r' => {
                    self.current_col = 0;
                }
                b'\n' => {
                    self.current_row = (self.current_row + 1).min(self.screen.len() - 1);
                    self.current_col = 0;
                }
                _ => {
                    // Regular byte as a cell
                    let ch = (b as char).to_string();
                    let cell = Cell {
                        ch: Some(ch),
                        width: 1,
                        ..Default::default()
                    };

                    // Extend row if needed
                    while self.screen[self.current_row].len() <= self.current_col as usize {
                        self.screen[self.current_row].push(Cell {
                            ch: None,
                            width: 1,
                            ..Default::default()
                        });
                    }

                    self.screen[self.current_row][self.current_col as usize] = cell;
                    self.current_col += 1;
                }
            }
        }
    }

    fn screen(&mut self) -> Screen {
        Screen {
            cols: self.cols,
            rows: self.rows,
            cursor: Cursor {
                col: self.current_col as u16,
                row: self.current_row as u16,
            },
            lines: self.screen.iter().filter(|line| !line.is_empty()).cloned().collect(),
        }
    }

    fn modes(&self) -> Modes {
        Modes::default()
    }

    fn reset(&mut self) {
        self.screen = vec![vec![]; self.screen.len()];
        self.current_row = 0;
        self.current_col = 0;
    }
}

/// Create socket directory with 0700 permissions
fn create_socket_dir(dir: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

#[tokio::test]
async fn test_b_serve_roundtrip_with_real_daemon() {
    // Create temporary directories
    let temp_dir = tempfile::TempDir::new()
        .expect("Failed to create temp directory");
    let socket_dir = temp_dir.path().join("sockets");
    let exe_dir = temp_dir.path().join("exes");

    create_socket_dir(&socket_dir).expect("Failed to create socket directory");
    fs::create_dir(&exe_dir).expect("Failed to create exe directory");

    // Build ptyd
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .expect("Cannot find parent")
        .parent()
        .expect("Cannot find grandparent")
        .to_path_buf();

    let daemon_exe = exe_dir.join("soksak-ptyd");
    let build_output = Command::new("go")
        .args(&["build", "-o", daemon_exe.to_str().unwrap()])
        .arg("./sidecars/ptyd/src")
        .current_dir(&repo_root)
        .output()
        .expect("Failed to execute go build");

    assert!(
        build_output.status.success(),
        "Failed to build ptyd: {}",
        String::from_utf8_lossy(&build_output.stderr)
    );

    // Create finder and port
    let finder = DarwinDaemonFinder::with_dirs(exe_dir.clone(), socket_dir.clone());
    eprintln!("Finder created with exe_dir: {:?}, socket_dir: {:?}", exe_dir, socket_dir);
    let port: Arc<dyn SessionPort> = Arc::new(
        soksak_sidecar_vt_core::protocol::DaemonSessionPort::with_finder(Box::new(finder))
    );
    let port_for_factory = port.clone();
    let factory = Arc::new(move || port_for_factory.clone());

    // Create engine factory
    let engine_factory = Arc::new(|| Box::new(SimpleEngine::new()) as Box<dyn Engine>);

    // Use duplex for stdin/stdout
    let (mut to_serve, serve_in) = tokio::io::duplex(64 * 1024);
    let (serve_out, from_serve) = tokio::io::duplex(64 * 1024);

    let task = tokio::spawn(async {
        match serve(engine_factory, serve_in, serve_out, factory).await {
            Ok(()) => eprintln!("serve() completed successfully"),
            Err(e) => eprintln!("serve() error: {}", e),
        }
    });
    let mut lines = tokio::io::BufReader::new(from_serve).lines();

    // 1) Send open command - use /bin/sh with -c to run "echo hi"
    // But actually, since serve doesn't support passing args, we need to use a shell script
    // OR we can just use sh interactively - but let's use the simpler approach of
    // sending input that will result in shell output. Since the shell doesn't automatically
    // output prompts in non-interactive mode, let's add a printf command
    to_serve
        .write_all(br#"{"surface":"s1","root":"/tmp","body":{"op":"open","width":800,"height":384,"scale":1.0}}
"#)
        .await
        .expect("Failed to write open command");

    // Wait for state response within 5 seconds
    let state_line = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
        .await
        .expect("timeout waiting for state")
        .expect("failed to read state line")
        .expect("state line is empty");

    let state_json: serde_json::Value =
        serde_json::from_str(&state_line).expect("failed to parse state JSON");
    assert_eq!(
        state_json["body"]["event"], "state",
        "expected state event, got: {}", state_line
    );
    let _session_id = state_json["body"]["sessionId"]
        .as_str()
        .expect("no sessionId in state");

    // 2) Send input: echo hi with newline to execute command
    let input_bytes = b"echo hi\n";
    let input_b64 = base64_encode(input_bytes);
    let input_cmd = format!(
        r#"{{"surface":"s1","body":{{"op":"input","bytes":"{}"}}}}"#,
        input_b64
    );
    eprintln!("Sending input command: {}", input_cmd);
    to_serve
        .write_all(input_cmd.as_bytes())
        .await
        .expect("Failed to write input");
    to_serve
        .write_all(b"\n")
        .await
        .expect("Failed to write newline after input");

    // Give the daemon time to process
    tokio::time::sleep(Duration::from_millis(200)).await;

    // 3) Read screen events for up to 10 seconds, looking for "hi"
    let start = std::time::Instant::now();
    let mut found_hi = false;
    let mut found_hi_line = String::new();
    let mut event_count = 0;

    while start.elapsed() < Duration::from_secs(10) {
        let remaining = Duration::from_secs(10).saturating_sub(start.elapsed());
        if remaining.is_zero() {
            break;
        }

        let screen_line = tokio::time::timeout(remaining, lines.next_line())
            .await;

        match screen_line {
            Ok(Ok(Some(line))) => {
                eprintln!("Received line: {}", line);
                if let Ok(screen_json) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(event) = screen_json.get("body").and_then(|b| b.get("event")) {
                        eprintln!("Event type: {}", event);
                        if event == "screen" {
                            event_count += 1;
                            // Check if any line contains "hi"
                            if let Some(lines_arr) =
                                screen_json.get("body").and_then(|b| b.get("lines"))
                            {
                                if let Some(lines_vec) = lines_arr.as_array() {
                                    for line_cells in lines_vec {
                                        if let Some(cells) = line_cells.as_array() {
                                            let mut line_text = String::new();
                                            for cell in cells {
                                                if let Some(ch) =
                                                    cell.get("ch").and_then(|c| c.as_str())
                                                {
                                                    line_text.push_str(ch);
                                                }
                                            }
                                            let trimmed = line_text.trim_end();
                                            eprintln!("Line content: '{}'", trimmed);
                                            if trimmed == "hi" {
                                                found_hi = true;
                                                found_hi_line = line.clone();
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Ok(Ok(None)) => {
                eprintln!("EOF reached");
                break;
            }
            Ok(Err(_)) | Err(_) => {
                eprintln!("Read error or timeout");
                break;
            }
        }

        if found_hi {
            break;
        }
    }

    eprintln!("Event count: {}", event_count);
    assert!(found_hi, "Did not find 'hi' in screen output within 10 seconds");

    // 4) Close stdin and wait for serve to complete
    drop(to_serve);
    task.await.expect("task join failed");

    println!(
        "Found 'hi' in screen event: {}",
        found_hi_line
    );
}

/// Simple base64 encoder for the test
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    let mut i = 0;

    while i < data.len() {
        let b1 = data[i];
        let b2 = if i + 1 < data.len() { data[i + 1] } else { 0 };
        let b3 = if i + 2 < data.len() { data[i + 2] } else { 0 };

        let idx1 = ((b1 >> 2) & 0x3F) as usize;
        let idx2 = (((b1 & 0x03) << 4) | ((b2 >> 4) & 0x0F)) as usize;
        let idx3 = (((b2 & 0x0F) << 2) | ((b3 >> 6) & 0x03)) as usize;
        let idx4 = (b3 & 0x3F) as usize;

        result.push(ALPHABET[idx1] as char);
        result.push(ALPHABET[idx2] as char);

        if i + 1 < data.len() {
            result.push(ALPHABET[idx3] as char);
        } else {
            result.push('=');
        }

        if i + 2 < data.len() {
            result.push(ALPHABET[idx4] as char);
        } else {
            result.push('=');
        }

        i += 3;
    }

    result
}
