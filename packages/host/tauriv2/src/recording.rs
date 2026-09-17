//! 진단 녹화의 상태. cargo 기능 `diagnostics` 로만 포함한다.
//!
//! 녹화는 한 번에 하나다. 시작이 어느 단계에서 실패하든, 그리고 요청이 녹화 폴더를 요청자에게
//! 돌려주기 전에 실패하든 녹화를 멈추고 폴더를 지운다. 남은 녹화는 다음 녹화를 막고, 남은 폴더는
//! 요청자가 지울 수 없다.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// 녹화 장치. 플랫폼 구현이나 검사의 가짜가 제공한다.
pub trait Capture {
    /// 창 서버 번호의 창을 녹화 대상으로 정한다.
    fn open(&self, window_number: isize) -> Result<(), String>;
    /// directory 에 프레임 기록을 시작한다.
    fn start(&self, directory: &Path) -> Result<(), String>;
    /// 첫 프레임이 기록되었는지 반환한다.
    fn wait(&self) -> Result<bool, String>;
    /// 기록을 끝내고 기록한 프레임 수를 반환한다.
    fn stop(&self) -> Result<i32, String>;
}

struct State {
    directory: Option<PathBuf>,
    opened: Option<isize>,
}

/// 진행 중인 녹화의 폴더와 녹화 대상으로 준비한 창 번호.
pub struct Recording {
    state: Mutex<State>,
}

impl Recording {
    pub const fn new() -> Recording {
        Recording { state: Mutex::new(State { directory: None, opened: None }) }
    }

    /// directory 를 make 로 만들고 window_number 의 창을 그 폴더에 녹화하기 시작한다. 첫 프레임이
    /// 기록된 뒤 반환한다. 실패하면 녹화를 멈추고 폴더를 지운다.
    pub fn start(
        &self,
        capture: &dyn Capture,
        window_number: isize,
        directory: &Path,
        make: &dyn Fn(&Path) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        if let Some(running) = &state.directory {
            return Err(format!("a capture into {} is running", running.display()));
        }
        make(directory)?;
        let started = (|| -> Result<(), String> {
            // 녹화 대상 준비는 창 서버 목록을 조회하므로 창이 바뀔 때만 실행한다.
            if state.opened != Some(window_number) {
                state.opened = None;
                capture.open(window_number)?;
                state.opened = Some(window_number);
            }
            capture.start(directory)?;
            match capture.wait() {
                Ok(true) => Ok(()),
                Ok(false) => {
                    let _ = capture.stop();
                    Err("capture did not produce an initial frame".into())
                }
                Err(error) => {
                    let _ = capture.stop();
                    Err(error)
                }
            }
        })();
        match started {
            Ok(()) => {
                state.directory = Some(directory.to_path_buf());
                Ok(())
            }
            Err(error) => {
                let _ = std::fs::remove_dir_all(directory);
                Err(error)
            }
        }
    }

    /// 진행 중인 녹화를 멈추고 폴더를 지운다. 녹화가 없으면 아무 일도 하지 않는다.
    pub fn abort(&self, capture: &dyn Capture) {
        let directory = match self.state.lock() {
            Ok(mut state) => state.directory.take(),
            Err(_) => return,
        };
        if let Some(directory) = directory {
            let _ = capture.stop();
            let _ = std::fs::remove_dir_all(directory);
        }
    }

    /// 진행 중인 녹화를 끝내고 폴더와 프레임 수를 반환한다. 폴더는 요청자가 지운다.
    pub fn finish(&self, capture: &dyn Capture) -> Result<(PathBuf, i32), String> {
        let directory = self
            .state
            .lock()
            .map_err(|e| e.to_string())?
            .directory
            .take()
            .ok_or_else(|| "no capture is running".to_string())?;
        let count = capture.stop()?;
        Ok((directory, count))
    }

    /// 진행 중인 녹화의 폴더.
    pub fn running(&self) -> Option<PathBuf> {
        self.state.lock().ok().and_then(|state| state.directory.clone())
    }
}
