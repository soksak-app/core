//! 실행 중인 애플리케이션의 로컬 엔드포인트(docs/spec/endpoint.md)에 연결해 JSON-RPC 요청을 보낸다. 프레임은
//! 4바이트 빅엔디언 길이와 UTF-8 JSON 본문이다.

use std::io::{ErrorKind, Read, Write};
use std::path::Path;

use serde_json::value::RawValue;
use serde_json::{json, Value};

use crate::platform;

/// 프레임 본문의 최대 길이.
pub const MAX_FRAME_LENGTH: usize = 16 * 1024 * 1024;

/// 설정 폴더의 endpoint.json.
pub struct Endpoint {
    pub address: String,
    pub pid: i32,
}

/// 요청이 실패한 이유. 엔드포인트가 돌려준 JSON-RPC 오류는 code 를 가진다.
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

/// config_dir 의 endpoint.json 을 읽고, 이 플랫폼의 transport 이며 그 프로세스가 실행 중인지 확인한다.
pub fn read_endpoint(config_dir: &Path) -> Result<Endpoint, String> {
    let file = config_dir.join("endpoint.json");
    let text = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Err(format!(
                "{} does not exist; the application is not running",
                file.display()
            ))
        }
        Err(error) => return Err(format!("{}: {error}", file.display())),
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
    // 기본값: transport 가 없는 파일은 빈 transport 로 읽고 아래에서 거부한다. Go 구현과 같은 문구를 낸다.
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

/// 엔드포인트 연결 하나. 요청은 차례로 보내고 응답을 기다리며, 그 사이에 온 알림은 notify 로 넘긴다.
pub struct Client {
    #[cfg(unix)]
    stream: std::os::unix::net::UnixStream,
    next_id: u64,
}

/// 엔드포인트가 보낸 메시지 하나.
struct Message {
    id: Option<u64>,
    method: Option<String>,
    params: Option<Box<RawValue>>,
    result: Option<Box<RawValue>>,
    error: Option<(i64, String)>,
}

impl Client {
    /// 엔드포인트의 socket 에 연결한다.
    #[cfg(unix)]
    pub fn dial(endpoint: &Endpoint) -> Result<Client, String> {
        let stream = std::os::unix::net::UnixStream::connect(&endpoint.address)
            .map_err(|error| format!("cannot connect to {}: {error}", endpoint.address))?;
        Ok(Client { stream, next_id: 1 })
    }

    #[cfg(not(unix))]
    pub fn dial(_endpoint: &Endpoint) -> Result<Client, String> {
        Err("not implemented on this operating system".into())
    }

    /// 연결을 닫는 함수를 돌려준다. 다른 thread 가 읽기를 끝내게 할 때 쓴다.
    #[cfg(unix)]
    pub fn closer(&self) -> Result<impl Fn() + Send + 'static, String> {
        let stream = self
            .stream
            .try_clone()
            .map_err(|error| format!("endpoint connection: {error}"))?;
        Ok(move || {
            // 기본값: 이미 닫힌 연결을 다시 닫으면 오류지만, 닫는 목적은 이미 이루어졌으므로 결과를 쓰지 않는다.
            let _ = stream.shutdown(std::net::Shutdown::Both);
        })
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
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
        let raw: std::collections::HashMap<String, Box<RawValue>> =
            serde_json::from_slice(&body)
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
                // 기본값: message 가 없는 JSON-RPC 오류는 빈 message 와 code 로 보고한다.
                let message = error["message"].as_str().unwrap_or("").to_string();
                let code = error["code"]
                    .as_i64()
                    .ok_or("invalid frame from endpoint: error has no code")?;
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

    #[cfg(not(unix))]
    fn write(&mut self, _message: &Value) -> Result<(), String> {
        Err("not implemented on this operating system".into())
    }

    #[cfg(not(unix))]
    fn read(&mut self) -> Result<Message, String> {
        Err("not implemented on this operating system".into())
    }

    /// method 를 보내고 결과를 원래 JSON 그대로 돌려준다. 결과가 없으면 null 이다.
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
                // 기본값: result 가 없는 응답은 결과가 없는 명령이며 출력은 null 이다(docs/spec/cli.md).
                .unwrap_or_else(|| "null".into()));
        }
    }

    /// 연결이 닫힐 때까지 알림을 notify 로 넘긴다. 반환값은 연결이 끝난 이유다.
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
            {
                if let Err(error) = notify(method, params) {
                    return error;
                }
            }
        }
    }
}
