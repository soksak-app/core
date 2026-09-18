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
pub struct DaemonResponse {
    pub command: Option<String>,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(rename = "defaultCols")]
    pub default_cols: Option<i32>,
    #[serde(rename = "defaultRows")]
    pub default_rows: Option<i32>,
    pub output: Option<String>,
    pub truncated: Option<bool>,
    pub sequence: Option<i64>,
    #[serde(rename = "resizeCols")]
    pub resize_cols: Option<i32>,
    #[serde(rename = "resizeRows")]
    pub resize_rows: Option<i32>,
    pub error: Option<String>,
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
    pub async fn read_response(&mut self) -> Result<Option<DaemonResponse>, String> {
        let mut line = String::new();
        let n = self.reader.read_line(&mut line)
            .await
            .map_err(|e| format!("Failed to read from daemon: {}", e))?;

        if n == 0 {
            return Ok(None);
        }

        let resp = serde_json::from_str::<DaemonResponse>(&line)
            .map_err(|e| format!("Failed to parse daemon response: {}", e))?;
        Ok(Some(resp))
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

    pub async fn read_response(&mut self) -> Result<Option<DaemonResponse>, String> {
        let mut line = String::new();
        let n = self.reader.read_line(&mut line)
            .await
            .map_err(|e| format!("Failed to read from daemon: {}", e))?;

        if n == 0 {
            return Ok(None);
        }

        let resp = serde_json::from_str::<DaemonResponse>(&line)
            .map_err(|e| format!("Failed to parse daemon response: {}", e))?;
        Ok(Some(resp))
    }
}
