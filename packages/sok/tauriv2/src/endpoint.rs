//! Connects to the local endpoint of the running application (docs/spec/endpoint.md) and sends JSON-RPC requests. A frame is
//! a 4-byte big-endian length followed by a UTF-8 JSON body.

use std::io::{ErrorKind, Read, Write};
use std::path::Path;

use serde_json::value::RawValue;
use serde_json::{Value, json};

use crate::platform;

/// The maximum length of a frame body.
pub const MAX_FRAME_LENGTH: usize = 16 * 1024 * 1024;

/// The endpoint.json of the configuration folder.
pub struct Endpoint {
    pub address: String,
    pub pid: i32,
}

/// The reason a request failed. A JSON-RPC error that the endpoint returned has a code.
#[derive(Debug)]
pub enum Failure {
    Endpoint { code: i64, message: String },
    Other(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Endpoint { code, message } => write!(f, "{message} ({code})"),
            Failure::Other(message) => f.write_str(message),
        }
    }
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Failure::Other(message)
    }
}

/// Reads endpoint.json of config_dir and checks that its transport belongs to this platform and that its process is running.
pub fn read_endpoint(config_dir: &Path) -> Result<Endpoint, String> {
    let file = config_dir.join("endpoint.json");
    let text = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err(format!(
                "{} does not exist; the application is not running",
                file.display()
            ));
        }
        Err(error) => return Err(crate::files::file_error(file.display(), &error)),
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", file.display()))?;
    let address = value["address"]
        .as_str()
        .filter(|address| !address.is_empty());
    let pid = value["pid"].as_i64().filter(|pid| *pid > 0);
    let (Some(address), Some(pid)) = (address, pid) else {
        return Err(format!("{} has no address or pid", file.display()));
    };
    // default: a file without a transport reads as an empty transport and is rejected below. The text matches the Go implementation.
    let transport = value["transport"].as_str().unwrap_or("");
    if transport != "unix" {
        return Err(format!(
            "{} has transport {transport}; this command line connects to unix sockets",
            file.display()
        ));
    }
    let pid =
        i32::try_from(pid).map_err(|_| format!("{} has no address or pid", file.display()))?;
    platform::current()?.process_running(pid).map_err(|_| {
        format!(
            "{} names process {pid}, which is not running",
            file.display()
        )
    })?;
    Ok(Endpoint {
        address: address.to_string(),
        pid,
    })
}

/// One connection to the endpoint. It sends requests one at a time, waits for each response, and passes notifications that arrive in between to notify.
pub struct Client {
    stream: Box<dyn platform::Connection>,
    next_id: u64,
}

/// One message that the endpoint sent.
pub struct Message {
    pub id: Option<u64>,
    pub method: Option<String>,
    pub params: Option<Box<RawValue>>,
    pub result: Option<Box<RawValue>>,
    pub error: Option<(i64, String)>,
}

impl Client {
    /// Connects to the address of the endpoint.
    pub fn dial(endpoint: &Endpoint) -> Result<Client, String> {
        let stream = platform::current()?.connect(&endpoint.address)?;
        Ok(Client { stream, next_id: 1 })
    }

    /// Returns a function that closes the connection. It lets another thread end a read.
    pub fn closer(&self) -> Result<Box<dyn Fn() -> Result<(), String> + Send>, String> {
        self.stream.closer()
    }

    /// Closes the connection and returns the result.
    pub fn close(self) -> Result<(), String> {
        self.stream.close()
    }

    fn write(&mut self, message: &Value) -> Result<(), String> {
        let body = serde_json::to_vec(message).map_err(|error| error.to_string())?;
        if body.len() > MAX_FRAME_LENGTH {
            return Err(format!(
                "frame length {} exceeds limit {MAX_FRAME_LENGTH}",
                body.len()
            ));
        }
        let mut frame = (body.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(&body);
        self.stream
            .write_all(&frame)
            .map_err(|error| format!("endpoint connection failed: {error}"))
    }

    fn read(&mut self) -> Result<Message, String> {
        let mut header = [0u8; 4];
        if let Err(error) = self.stream.read_exact(&mut header) {
            return Err(if error.kind() == ErrorKind::UnexpectedEof {
                "endpoint connection closed".into()
            } else {
                format!("endpoint connection failed: {error}")
            });
        }
        let length = u32::from_be_bytes(header) as usize;
        if length > MAX_FRAME_LENGTH {
            return Err(format!(
                "invalid frame from endpoint: frame length {length} exceeds limit {MAX_FRAME_LENGTH}"
            ));
        }
        let mut body = vec![0u8; length];
        self.stream
            .read_exact(&mut body)
            .map_err(|_| "endpoint connection closed".to_string())?;
        parse_frame(&body)
    }

    /// Sends the method and returns the result as the original JSON. The result is null when there is none.
    pub fn request(
        &mut self,
        method: &str,
        params: Option<Value>,
        notify: &mut dyn FnMut(&str, &RawValue) -> Result<(), String>,
    ) -> Result<String, Failure> {
        let id = self.next_id;
        self.next_id += 1;
        let mut request = json!({"jsonrpc": "2.0", "id": id, "method": method});
        if let Some(params) = params {
            request["params"] = params;
        }
        self.write(&request)?;
        loop {
            let message = self.read()?;
            let Some(answer) = message.id else {
                if let (Some(method), Some(params)) =
                    (message.method.as_deref(), message.params.as_deref())
                {
                    notify(method, params)?;
                }
                continue;
            };
            if answer != id {
                return Err(Failure::Other(format!(
                    "endpoint answered request {answer} while {id} was pending"
                )));
            }
            if let Some((code, message)) = message.error {
                return Err(Failure::Endpoint { code, message });
            }
            return Ok(message
                .result
                .map(|result| result.get().to_string())
                // default: a response without a result is a command without a result, and its output is null (docs/spec/cli.md).
                .unwrap_or_else(|| "null".into()));
        }
    }

    /// Passes notifications to notify until the connection closes. The return value is the reason the connection ended.
    pub fn listen(
        &mut self,
        notify: &mut dyn FnMut(&str, &RawValue) -> Result<(), String>,
    ) -> String {
        loop {
            let message = match self.read() {
                Ok(message) => message,
                Err(error) => return error,
            };
            if let Some(id) = message.id {
                return format!("endpoint sent an answer to request {id} that is not pending");
            }
            if let (Some(method), Some(params)) =
                (message.method.as_deref(), message.params.as_deref())
                && let Err(error) = notify(method, params)
            {
                return error;
            }
        }
    }
}

/// Parses the body of one frame of the endpoint into a message.
pub fn parse_frame(body: &[u8]) -> Result<Message, String> {
    let raw: std::collections::HashMap<String, Box<RawValue>> = serde_json::from_slice(body)
        .map_err(|error| format!("invalid frame from endpoint: {error}"))?;
    let id = raw
        .get("id")
        .map(|value| value.get().parse::<u64>())
        .transpose()
        .map_err(|_| "invalid frame from endpoint: id is not a number".to_string())?;
    let method = raw
        .get("method")
        .map(|value| serde_json::from_str::<String>(value.get()))
        .transpose()
        .map_err(|error| format!("invalid frame from endpoint: {error}"))?;
    let error = match raw.get("error") {
        None => None,
        Some(value) => {
            let error: Value =
                serde_json::from_str(value.get()).map_err(|error| error.to_string())?;
            // default: a JSON-RPC error without a message is reported with an empty message and code.
            let code = error["code"]
                .as_i64()
                .ok_or("invalid frame from endpoint: error has no code")?;
            let message = error["message"]
                .as_str()
                .ok_or("invalid frame from endpoint: error has no message")?
                .to_string();
            Some((code, message))
        }
    };
    let mut raw = raw;
    Ok(Message {
        id,
        method,
        params: raw.remove("params"),
        result: raw.remove("result"),
        error,
    })
}

