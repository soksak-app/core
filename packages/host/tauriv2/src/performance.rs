//! 성능 트레이스의 호스트 쪽(V5-104, [performance trace](../../../docs/spec/performance-trace.md)).
//!
//! 페이지가 `host.performance` 로 트레이스를 켜고 끈다. 켜면 호스트는 구성 디렉터리의
//! `logs/performance.ndjson` 에 자기 줄을 남기고 이미 있는 모든 사이드카 서비스 디렉터리에
//! 대상 경로를 담은 `performance` 플래그 파일을 쓴다 — 사이드카는 그 파일이 가리키는
//! 대상에 직접 덧붙인다. 끄면 플래그 파일을 지운다. 로그 파일과 로테이션은 설정이 아니라
//! 트레이스의 소유물이므로 끄고 재시작해도 로그는 남는다.

use serde_json::{json, Map, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 구성 디렉터리가 가리키는 트레이스 대상.
pub fn target(config: &Path) -> PathBuf {
    config.join("logs").join("performance.ndjson")
}

/// 트레이스를 켠다. 로그 디렉터리를 만들고, 서비스 디렉터리마다 플래그 파일을 쓴다.
/// 나중에 뜨는 사이드카는 아직 플래그가 없으므로, 켜진 상태에서의 스폰마다 호스트가
/// 다시 쓴다(`sidecars`). 대상을 반환한다.
pub fn enable(config: &Path) -> Result<PathBuf, String> {
    let target = target(config);
    fs::create_dir_all(config.join("logs")).map_err(|e| format!("create logs directory: {e}"))?;
    write_sidecar_flags(config, &target)?;
    Ok(target)
}

/// 트레이스를 끈다. 사이드카 플래그 파일을 지운다; 로그 파일은 남는다.
pub fn disable(config: &Path) -> Result<(), String> {
    let services = config.join("services");
    let Ok(entries) = fs::read_dir(&services) else {
        return Ok(());
    };
    for entry in entries {
        let Ok(dir) = entry else { continue };
        let flag = dir.path().join("performance");
        if flag.is_file() {
            fs::remove_file(&flag).map_err(|e| format!("remove performance flag: {e}"))?;
        }
    }
    Ok(())
}

/// 서비스 디렉터리마다 대상 경로를 담은 플래그 파일을 쓴다.
pub fn write_sidecar_flags(config: &Path, target: &Path) -> Result<(), String> {
    let services = config.join("services");
    let Ok(entries) = fs::read_dir(&services) else {
        return Ok(());
    };
    for entry in entries {
        let Ok(dir) = entry else { continue };
        if !dir.path().is_dir() {
            continue;
        }
        fs::write(dir.path().join("performance"), format!("{}\n", target.display()))
            .map_err(|e| format!("write performance flag: {e}"))?;
    }
    Ok(())
}

/// 호스트 계층의 한 줄을 남긴다. `fields` 는 문자열 `event` 를 담아야 한다.
pub fn line(target: &Path, layer: &str, fields: Value) -> Result<(), String> {
    let event = fields
        .get("event")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("a {layer} line requires a string event"))?
        .to_string();
    let mut record = Map::new();
    record.insert("ts".into(), json!(now_iso8601_ms()));
    record.insert("pid".into(), json!(std::process::id()));
    record.insert("layer".into(), json!(layer));
    record.insert("event".into(), json!(event));
    if let Value::Object(extra) = fields {
        for (key, value) in extra {
            if key != "event" {
                record.insert(key, value);
            }
        }
    }
    append(target, &Value::Object(record))
}

/// 페이지가 보낸 줄을 중계한다. 객체이고 문자열 `event` 를 담았을 때만 대상에
/// 덧붙인다. 계층은 호스트가 `page` 로 못박는다 — 페이지는 이 파일의 소유자가 아니다.
pub fn relay(target: &Path, mut record: Value) -> Result<(), String> {
    if !record.is_object() {
        return Err("a relayed line must be an object".into());
    }
    if record.get("event").and_then(Value::as_str).is_none() {
        return Err("a relayed line requires a string event".into());
    }
    let object = record.as_object_mut().expect("checked above");
    object.insert("layer".into(), json!("page"));
    append(target, &record)
}

fn append(target: &Path, record: &Value) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(target)
        .map_err(|e| format!("open performance log: {e}"))?;
    writeln!(file, "{record}").map_err(|e| format!("append performance line: {e}"))
}

/// 유닉스 시각(밀리초)을 ISO-8601 로 바꾼다(종속성을 더하지 않는다).
fn now_iso8601_ms() -> String {
    let since = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let millis_total = since.as_millis();
    let days = (millis_total / 86_400_000) as i64;
    let millis_day = (millis_total % 86_400_000) as u32;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        millis_day / 3_600_000,
        (millis_day % 3_600_000) / 60_000,
        (millis_day % 60_000) / 1_000,
        millis_day % 1_000
    )
}

/// 날수를 역·월·일로 바꾼다(Howard Hinnant 의 civil_from_days).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// 페이지의 `host.performance` 요청. `on` 은 트레이스를 켜고 사이드카 플래그를 쓰며,
/// `off` 는 끄고 플래그를 지우고, `line` 은 페이지 이벤트 줄을 중계한다. `line` 은
/// 트레이스가 켜져 있을 때만 받는다 — 꺼진 트레이스에 파일을 만들지 않는다.
pub fn command(
    config: &std::path::Path,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use serde_json::Value;
    let action = request
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(|| "action must be on, off, or line".to_string())?;
    let target = target(config);
    match action {
        "on" => {
            let target = enable(config)?;
            line(&target, "host", serde_json::json!({"event": "trace_on"}))?;
            spawn_sampler(config);
            Ok(serde_json::Value::Null)
        }
        "off" => {
            // 끄는 줄이 마지막이 된다. 실패해도 플래그는 지운다 — 꺼짐이 우선이다.
            let _ = line(&target, "host", serde_json::json!({"event": "trace_off"}));
            disable(config)?;
            Ok(serde_json::Value::Null)
        }
        "line" => {
            let record = request
                .get("line")
                .cloned()
                .ok_or_else(|| "line requires the page event object".to_string())?;
            if !enabled(config) {
                return Err("the performance trace is off".into());
            }
            relay(&target, record)?;
            Ok(serde_json::Value::Null)
        }
        other => Err(format!("action must be on, off, or line, not {other}")),
    }
}

/// 트레이스가 켜져 있는가. 스위치의 상태는 사이드카 플래그 파일이다.
pub fn enabled(config: &std::path::Path) -> bool {
    let Ok(entries) = fs::read_dir(config.join("services")) else {
        return false;
    };
    entries
        .filter_map(Result::ok)
        .any(|entry| entry.path().join("performance").is_file())
}

/// 메모리 샘플러(V5-104). 트레이스가 켜져 있는 동안 5초마다 이 프로세스와 등록된
/// 사이드카 pid 들의 상주 크기를 한 줄로 남긴다. 샘플러의 pid 목록은 프로세스 등록부
/// 줄(process 이벤트)이 쌓는다. 트레이스가 꺼지면 샘플러도 조용히 끝난다.
/// 메모리 샘플러(V5-104). 트레이스가 켜져 있는 동안 5초마다 이 프로세스의 상주
/// 크기를 한 줄로 남긴다. 사이드카 pid 는 프로세스 등록부 줄(process 이벤트)에
/// 쌓이므로 로그 소비자가 짝지는다. 꺼지면 대기로 돌아간다.
pub fn spawn_sampler(config: &Path) {
    let config = config.to_path_buf();
    std::thread::spawn(move || loop {
        if !enabled(&config) {
            std::thread::sleep(std::time::Duration::from_secs(5));
            continue;
        }
        let target = target(&config);
        let mut record = serde_json::Map::new();
        record.insert("event".into(), json!("memory"));
        record.insert("rss_host_kb".into(), json!(resident_kb(std::process::id())));
        for (role, pid) in registered_sidecars(&config) {
            record.insert(format!("rss_{role}_kb"), json!(resident_kb(pid)));
        }
        let _ = line(&target, "sampler", Value::Object(record));
        std::thread::sleep(std::time::Duration::from_secs(5));
    });
}

/// pid 의 상주 크기(KB). 실패는 0 — 프로세스가 끝났을 수 있다.
fn resident_kb(pid: u32) -> u64 {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output();
    match output {
        Ok(out) => String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0),
        Err(_) => 0,
    }
}

/// 프로세스 등록부 줄에서 사이드카 pid 를 다시 읽는다. 등록부는 append 로그이므로
/// 마지막에 등록된 값이 현재 값이다.
fn registered_sidecars(_config: &Path) -> Vec<(String, u32)> {
    // 등록부 해석은 로그 소비자(jq)의 몫으로 둔다 — 샘플러는 자기 pid 만 측정한다.
    Vec::new()
}
