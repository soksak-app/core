use serde::{Deserialize, Serialize};
use tokio::net::UnixStream;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonIdentity {
    pub protocol: String,
    pub build_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonRequest {
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub program: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::HashMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cols: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExitMessage {
    pub command: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub code: i32,
}

/// Reply to a request command (open, attach, detach, write, resize, signal, close, list, purge)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reply {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "defaultCols")]
    pub default_cols: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "defaultRows")]
    pub default_rows: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sessions: Option<Vec<SessionInfo>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub consumers: i32,
    pub closed: bool,
}

/// 데몬이 보내는 모든 메시지. command 로 구분한다.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "command", rename_all = "lowercase")]
pub enum DaemonMessage {
    Output {
        #[serde(rename = "sessionId")]
        session_id: String,
        sequence: i64,
        output: String,
        truncated: bool,
    },
    Resized {
        #[serde(rename = "sessionId")]
        session_id: String,
        sequence: i64,
        cols: i32,
        rows: i32,
        truncated: bool,
    },
    Exit {
        #[serde(rename = "sessionId")]
        session_id: String,
        code: i32,
    },
    Open(Reply),
    Attach(Reply),
    Detach(Reply),
    Write(Reply),
    Resize(Reply),
    Signal(Reply),
    Close(Reply),
    List(Reply),
    Purge(Reply),
}

/// 데몬 찾기/띄우기를 담당하는 플랫폼 트레이트
pub trait DaemonFinder: Send + Sync {
    fn find_or_start(&self, identity: &DaemonIdentity) -> Result<String, String>;
}

/// 데몬 클라이언트 라이터
pub struct DaemonWriter {
    write_half: tokio::net::unix::OwnedWriteHalf,
}

impl DaemonWriter {
    pub async fn send_request(&mut self, req: &DaemonRequest) -> Result<(), String> {
        let json = serde_json::to_string(req)
            .map_err(|e| format!("Failed to serialize request: {}", e))?;
        self.write_half.write_all(json.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to daemon: {}", e))?;
        self.write_half.write_all(b"\n")
            .await
            .map_err(|e| format!("Failed to write newline: {}", e))?;
        self.write_half.flush()
            .await
            .map_err(|e| format!("Failed to flush: {}", e))?;
        Ok(())
    }
}

/// 데몬 클라이언트 리더
pub struct DaemonReader {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
}

impl DaemonReader {
    /// read_message reads a JSON line and parses it as a DaemonMessage.
    pub async fn read_message(&mut self) -> Result<Option<DaemonMessage>, String> {
        let mut line = String::new();
        let n = self.reader.read_line(&mut line)
            .await
            .map_err(|e| format!("Failed to read from daemon: {}", e))?;

        if n == 0 {
            return Ok(None);
        }

        let msg = serde_json::from_str::<DaemonMessage>(&line)
            .map_err(|e| format!("Failed to parse daemon message: {}", e))?;
        Ok(Some(msg))
    }

}

/// 데몬 클라이언트
pub struct DaemonClient {
    write_half: tokio::net::unix::OwnedWriteHalf,
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
}

impl DaemonClient {
    pub async fn connect(socket_path: &str) -> Result<Self, String> {
        let stream = UnixStream::connect(socket_path)
            .await
            .map_err(|e| format!("Failed to connect to daemon: {}", e))?;

        let (read_half, write_half) = stream.into_split();
        let reader = BufReader::new(read_half);

        Ok(DaemonClient {
            write_half,
            reader,
        })
    }

    pub fn into_split(self) -> (DaemonWriter, DaemonReader) {
        (
            DaemonWriter {
                write_half: self.write_half,
            },
            DaemonReader {
                reader: self.reader,
            },
        )
    }

    pub async fn send_request(&mut self, req: &DaemonRequest) -> Result<(), String> {
        let json = serde_json::to_string(req)
            .map_err(|e| format!("Failed to serialize request: {}", e))?;
        self.write_half.write_all(json.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to daemon: {}", e))?;
        self.write_half.write_all(b"\n")
            .await
            .map_err(|e| format!("Failed to write newline: {}", e))?;
        self.write_half.flush()
            .await
            .map_err(|e| format!("Failed to flush: {}", e))?;
        Ok(())
    }

    pub async fn read_message(&mut self) -> Result<Option<DaemonMessage>, String> {
        let mut line = String::new();
        let n = self.reader.read_line(&mut line)
            .await
            .map_err(|e| format!("Failed to read from daemon: {}", e))?;

        if n == 0 {
            return Ok(None);
        }

        let msg = serde_json::from_str::<DaemonMessage>(&line)
            .map_err(|e| format!("Failed to parse daemon message: {}", e))?;
        Ok(Some(msg))
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_daemon_message_output_deserialize() {
        let json = r#"{"command":"output","sessionId":"test-session","sequence":0,"output":"hello","truncated":false}"#;
        let msg: DaemonMessage = serde_json::from_str(json).expect("Failed to deserialize output message");
        match msg {
            DaemonMessage::Output { session_id, sequence, output, truncated } => {
                assert_eq!(session_id, "test-session");
                assert_eq!(sequence, 0);
                assert_eq!(output, "hello");
                assert!(!truncated);
            }
            _ => panic!("Expected Output variant"),
        }
    }

    #[test]
    fn test_daemon_message_resized_deserialize() {
        let json = r#"{"command":"resized","sessionId":"test-session","sequence":0,"cols":120,"rows":40,"truncated":false}"#;
        let msg: DaemonMessage = serde_json::from_str(json).expect("Failed to deserialize resized message");
        match msg {
            DaemonMessage::Resized { session_id, sequence, cols, rows, truncated } => {
                assert_eq!(session_id, "test-session");
                assert_eq!(sequence, 0);
                assert_eq!(cols, 120);
                assert_eq!(rows, 40);
                assert!(!truncated);
            }
            _ => panic!("Expected Resized variant"),
        }
    }

    #[test]
    fn test_daemon_message_exit_deserialize() {
        let json = r#"{"command":"exit","sessionId":"test-session","code":0}"#;
        let msg: DaemonMessage = serde_json::from_str(json).expect("Failed to deserialize exit message");
        match msg {
            DaemonMessage::Exit { session_id, code } => {
                assert_eq!(session_id, "test-session");
                assert_eq!(code, 0);
            }
            _ => panic!("Expected Exit variant"),
        }
    }

    #[test]
    fn test_daemon_message_open_deserialize() {
        let json = r#"{"command":"open","sessionId":"test-session","defaultCols":80,"defaultRows":24}"#;
        let msg: DaemonMessage = serde_json::from_str(json).expect("Failed to deserialize open response");
        match msg {
            DaemonMessage::Open(reply) => {
                assert_eq!(reply.session_id, Some("test-session".to_string()));
                assert_eq!(reply.default_cols, Some(80));
                assert_eq!(reply.default_rows, Some(24));
            }
            _ => panic!("Expected Open variant"),
        }
    }

    #[test]
    fn test_daemon_message_write_error_deserialize() {
        let json = r#"{"command":"write","error":"session not found"}"#;
        let msg: DaemonMessage = serde_json::from_str(json).expect("Failed to deserialize write error response");
        match msg {
            DaemonMessage::Write(reply) => {
                assert_eq!(reply.error, Some("session not found".to_string()));
            }
            _ => panic!("Expected Write variant"),
        }
    }

    #[test]
    fn test_daemon_message_sequence_zero() {
        let json = r#"{"command":"output","sessionId":"test-session","sequence":0,"output":"test","truncated":false}"#;
        let msg: DaemonMessage = serde_json::from_str(json).expect("Failed to deserialize output with sequence 0");
        match msg {
            DaemonMessage::Output { sequence, .. } => {
                assert_eq!(sequence, 0);
            }
            _ => panic!("Expected Output variant"),
        }
    }

    #[test]
    fn test_daemon_message_missing_sequence_error() {
        let json = r#"{"command":"output","sessionId":"test-session","output":"test","truncated":false}"#;
        let result: Result<DaemonMessage, _> = serde_json::from_str(json);
        assert!(result.is_err(), "Expected deserialization to fail when sequence is missing");
    }

    #[test]
    fn test_daemon_message_unknown_command_error() {
        let json = r#"{"command":"unknown","sessionId":"test-session"}"#;
        let result: Result<DaemonMessage, _> = serde_json::from_str(json);
        assert!(result.is_err(), "Expected deserialization to fail for unknown command");
    }
}
