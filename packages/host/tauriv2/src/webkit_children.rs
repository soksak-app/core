//! 이 실행이 만든 WebKit XPC 자식의 기록과 다음 시작의 수확(V5-113).
//!
//! 밤샘 V5-105의 시작 정리는 판별이 불가능해(살아 있는 WebKit 도 소켓·경로 증명이 없다)
//! 제거되었다. 여기의 규칙은 선례를 따른다 — Chromium 의 SingletonLock 은 자기 사용자 데이터
//! 디렉터리에 hostname-PID 를 기록하고 자기 기록만 신뢰한다. 이 실행도 자기 설정 디렉터리에
//! 자기가 만든 WebKit 자식의 pid 를 기록하고, 다음 시작이 그 기록만 수확한다. 기록되지 않은
//! 프로세스는 무조건 불가침이다.
//!
//! 죽일 수 있는 조건은 셋 모두다: 기록되었고(우리가 만들었다), 지금도 그 pid 가 WebKit
//! 프로세스이며(재활용 방어), 시작 시각이 기록과 같고(같은 인스턴스), 기록한 호스트 프로세스가
//! 죽었다(살아 있는 형제 인스턴스의 자식이 아니다).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 기록 파일 이름. 설정 디렉터리의 뿌리에 둔다.
const RECORD: &str = "webkit-children.json";

/// 이 실행이 시작할 때 이미 떠 있던 WebKit XPC — 남의 것이다. 기록에서 뺀다.
static BASELINE: OnceLock<Vec<u32>> = OnceLock::new();

#[derive(Serialize, Deserialize)]
struct Record {
    host_pid: u32,
    children: Vec<Child>,
}

#[derive(Serialize, Deserialize)]
struct Child {
    pid: u32,
    kind: String,
    /// 프로세스의 시작 시각(ps lstart). pid 재활용 방어 — 같은 pid 를 다른 프로세스가 쓰면
    /// 값이 다르다. 같은 기계에서 형식은 변하지 않으므로 문자열 그대로 비교한다.
    lstart: String,
}

/// 살아 있는 WebKit XPC 의 (pid, 종류) 목록.
fn webkit_processes() -> Vec<(u32, String)> {
    let Ok(output) = std::process::Command::new("ps")
        .args(["-axo", "pid=,command="])
        .output()
    else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Some((pid, command)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let Some(pid) = pid.trim().parse::<u32>().ok() else {
            continue;
        };
        let Some(kind) = ["WebContent", "GPU", "Networking"]
            .iter()
            .find(|kind| command.contains(&format!("com.apple.WebKit.{kind}")))
        else {
            continue;
        };
        found.push((pid, kind.to_string()));
    }
    found
}

/// pid 의 프로세스가 살아 있는가. ps 로 묻는다(시그널을 쓰지 않는다).
fn exists(pid: u32) -> bool {
    std::process::Command::new("ps")
        .args(["-o", "pid=", "-p", &pid.to_string()])
        .output()
        .is_ok_and(|out| !String::from_utf8_lossy(&out.stdout).trim().is_empty())
}

/// pid 프로세스의 시작 시각. 없으면 빈 문자열이다 — 빈 문자열은 기록의 어떤 lstart 와도
/// 같지 않으므로 판정이 그 항목을 죽이지 않는다(모호하면 죽이지 않는다).
fn start_time(pid: u32) -> String {
    match std::process::Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .output()
    {
        // 기본값: ps 가 실패하면 빈 문자열 — 판정이 그 항목을 죽이지 않게 한다.
        Ok(out) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        Err(_) => String::new(),
    }
}

/// pid 프로세스의 명령줄. 없으면 빈 문자열이다 — 형제 인스턴스 판정은 `soksak` 문구를
/// 찾지 못해 거짓이 되고, 수확은 계속 진행된다.
fn command(pid: u32) -> String {
    match std::process::Command::new("ps")
        .args(["-o", "command=", "-p", &pid.to_string()])
        .output()
    {
        // 기본값: ps 가 실패하면 빈 문자열 — 형제 판정이 거짓이 되어 수확이 멈추지 않는다.
        Ok(out) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        Err(_) => String::new(),
    }
}

/// 시작 시점의 WebKit XPC 를 기준선으로 찍는다. 이 실행이 WebKit 을 만들기 전에 한 번만
/// 유효하다(그 뒤의 호출은 아무 일도 하지 않는다). 기준선에 든 프로세스는 남의 것이다.
pub fn snapshot_baseline() {
    BASELINE.get_or_init(|| webkit_processes().into_iter().map(|(pid, _)| pid).collect());
}

/// 이 실행의 WebKit 자식을 기록한다. 페이지 적재마다 부른다 — WebKit 이 죽은 자식을 교체하면
/// 페이지가 다시 뜨므로 기록이 교체를 따라간다. 자식 집합이 바뀌었을 때만 쓴다(원자적 교체).
pub fn refresh(config: &Path) {
    let Some(baseline) = BASELINE.get() else {
        return;
    };
    let current: Vec<(u32, String)> = webkit_processes()
        .into_iter()
        .filter(|(pid, _)| !baseline.contains(pid))
        .collect();
    let record = Record {
        host_pid: std::process::id(),
        children: current
            .iter()
            .map(|(pid, kind)| Child {
                pid: *pid,
                kind: kind.clone(),
                lstart: start_time(*pid),
            })
            .collect(),
    };
    let target = record_path(config);
    // 내용이 같으면 다시 쓰지 않는다.
    if let Ok(previous) = std::fs::read(&target) {
        if let Ok(previous_record) = serde_json::from_slice::<Record>(&previous) {
            if previous_record
                .children
                .iter()
                .map(|c| c.pid)
                .collect::<Vec<_>>()
                == record.children.iter().map(|c| c.pid).collect::<Vec<_>>()
            {
                return;
            }
        }
    }
    let temporary: PathBuf = target.with_extension("json.new");
    match serde_json::to_vec_pretty(&record)
        .map_err(|e| e.to_string())
        .and_then(|bytes| {
            std::fs::write(&temporary, &bytes)
                .map_err(|e| format!("write {}: {e}", temporary.display()))
        })
        .and_then(|()| std::fs::rename(&temporary, &target).map_err(|e| format!("rename: {e}")))
    {
        Ok(()) => {}
        Err(error) => crate::application_log::log_error("webkit children record", error),
    }
}

fn record_path(config: &Path) -> PathBuf {
    config.join(RECORD)
}

/// 지난 실행이 기록한 WebKit 자식을 수확한다. 이 실행이 WebKit 을 만들기 전에 한 번 부른다.
/// 죽일 조건이 하나라도 성립하지 않으면 그 항목은 건드리지 않는다.
pub fn reap_recorded(config: &Path) {
    let Ok(bytes) = std::fs::read(record_path(config)) else {
        return; // 기록이 없으면 수확할 것도 없다.
    };
    let record: Record = match serde_json::from_slice(&bytes) {
        Ok(record) => record,
        Err(error) => {
            crate::application_log::log_error(
                "webkit children record",
                format!("the record is invalid: {error}"),
            );
            return;
        }
    };
    if record.host_pid == std::process::id() {
        return; // 우리 기록이다 — 이 실행의 페이지 적재가 다시 쓴다.
    }
    if exists(record.host_pid) && command(record.host_pid).contains("soksak") {
        // 살아 있는 형제 인스턴스의 자식이다.
        eprintln!(
            "webkit children: host {} still owns its recorded children; not reaping",
            record.host_pid
        );
        return;
    }
    let now = webkit_processes();
    for child in &record.children {
        let decision = reap_decision(
            exists(child.pid),
            now.iter().any(|(pid, _)| *pid == child.pid),
            start_time(child.pid) == child.lstart,
        );
        match decision {
            Ok(()) => match std::process::Command::new("kill")
                .args(["-9", &child.pid.to_string()])
                .output()
            {
                Ok(_) => eprintln!(
                    "webkit children: reaped orphaned {} pid {} left by host {}",
                    child.kind, child.pid, record.host_pid
                ),
                Err(error) => crate::application_log::log_error(
                    "webkit children",
                    format!("kill {}: {error}", child.pid),
                ),
            },
            Err(reason) => eprintln!("webkit children: pid {}: {}", child.pid, reason),
        }
    }
}

/// 기록된 자식 하나의 수확 판정. 죽일 수 있으면 Ok, 아니면 이유를 돌려준다.
/// 셋의 관측은 호출자가 얻는다 — 판정 자체는 순수해서 계약 검사가 기계적으로 다룬다.
pub fn reap_decision(alive: bool, is_webkit: bool, same_start: bool) -> Result<(), &'static str> {
    if !alive {
        return Err("already dead; nothing to reap");
    }
    if !is_webkit {
        return Err("no longer a WebKit process (recycled?); not killing");
    }
    if !same_start {
        return Err("start time differs from the record; not killing");
    }
    Ok(())
}
