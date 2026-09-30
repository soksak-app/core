//! 성능 트레이스의 호스트 스위치와 기록기(docs/spec/performance-trace.md).
//! 스위치·중계 오류는 호출자에게 반환하고, 수동 계측 오류는 stderr 에 보고한다.

use serde_json::{json, Map, Value};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static WRITING: Mutex<()> = Mutex::new(());

/// 구성 디렉터리가 가리키는 트레이스 대상.
pub fn target(config: &Path) -> PathBuf {
    config.join("logs").join("performance.ndjson")
}

/// 서비스 플래그를 쓴 뒤 호스트 실행 스위치를 켠다.
pub fn enable(config: &Path) -> Result<PathBuf, String> {
    let target = target(config);
    fs::create_dir_all(config.join("logs"))
        .map_err(|error| format!("create logs directory: {error}"))?;
    if let Err(error) = write_sidecar_flags(config, &target) {
        return Err(rollback_enable(config, error));
    }
    if let Err(error) = fs::write(
        config.join("performance"),
        format!("{}\n", target.display()),
    ) {
        return Err(rollback_enable(
            config,
            format!("write performance switch: {error}"),
        ));
    }
    Ok(target)
}

fn rollback_enable(config: &Path, error: String) -> String {
    match disable(config) {
        Ok(()) => error,
        Err(cleanup) => format!("{error}; {cleanup}"),
    }
}

fn report_errors(errors: Vec<String>) -> Result<(), String> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// 실행·서비스 플래그를 지우고 모든 정리 오류를 반환한다.
pub fn disable(config: &Path) -> Result<(), String> {
    let mut errors = Vec::new();
    if let Err(error) = fs::remove_file(config.join("performance")) {
        if error.kind() != ErrorKind::NotFound {
            errors.push(format!("remove performance switch: {error}"));
        }
    }
    let entries = match fs::read_dir(config.join("services")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return report_errors(errors),
        Err(error) => {
            errors.push(format!("read performance services: {error}"));
            return report_errors(errors);
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                errors.push(format!("read performance service entry: {error}"));
                continue;
            }
        };
        match entry.file_type() {
            Ok(kind) if !kind.is_dir() => continue,
            Err(error) => {
                errors.push(format!(
                    "read performance service type {}: {error}",
                    entry.path().display()
                ));
                continue;
            }
            _ => {}
        }
        let flag = entry.path().join("performance");
        if let Err(error) = fs::remove_file(&flag) {
            if error.kind() != ErrorKind::NotFound {
                errors.push(format!(
                    "remove performance flag {}: {error}",
                    flag.display()
                ));
            }
        }
    }
    report_errors(errors)
}

/// 호스트 실행 플래그를 읽는다. 읽기·내용 오류는 상태로 바꾸지 않는다.
pub fn enabled(config: &Path) -> Result<bool, String> {
    let data = match fs::read(config.join("performance")) {
        Ok(data) => data,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("read performance switch: {error}")),
    };
    if data != format!("{}\n", target(config).display()).as_bytes() {
        return Err(format!(
            "invalid performance switch in {}",
            config.display()
        ));
    }
    Ok(true)
}

/// 활성 계측만 구성·기록하고 오류를 보고한다. 측정한 동작은 그대로 진행한다.
pub fn observe(config: &Path, layer: &str, fields: impl FnOnce() -> Value) {
    let result = (|| {
        let _writing = WRITING
            .lock()
            .map_err(|error| format!("performance writer lock: {error}"))?;
        if enabled(config)? {
            line(&target(config), layer, fields())?;
        }
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        eprintln!("performance trace failed: {error}");
    }
}

/// 서비스 생성·재접속 전에 유효 실행 스위치를 전파한다.
pub fn sync_services(config: &Path) -> Result<(), String> {
    let _writing = WRITING
        .lock()
        .map_err(|error| format!("performance writer lock: {error}"))?;
    if enabled(config)? {
        write_sidecar_flags(config, &target(config))
    } else {
        disable(config)
    }
}

/// 서비스 디렉터리마다 대상 경로를 담은 플래그 파일을 쓴다.
pub fn write_sidecar_flags(config: &Path, target: &Path) -> Result<(), String> {
    let entries = match fs::read_dir(config.join("services")) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("read performance services: {error}")),
    };
    let mut errors = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                errors.push(format!("read performance service entry: {error}"));
                continue;
            }
        };
        match entry.file_type() {
            Ok(kind) if !kind.is_dir() => continue,
            Err(error) => {
                errors.push(format!(
                    "read performance service type {}: {error}",
                    entry.path().display()
                ));
                continue;
            }
            _ => {}
        }
        let flag = entry.path().join("performance");
        if let Err(error) = fs::write(&flag, format!("{}\n", target.display())) {
            errors.push(format!(
                "write performance flag {}: {error}",
                flag.display()
            ));
        }
    }
    report_errors(errors)
}

/// 한 계층의 이벤트를 기록하고 잘못된 이벤트·쓰기 실패를 반환한다.
pub fn line(target: &Path, layer: &str, fields: Value) -> Result<(), String> {
    let event = fields
        .get("event")
        .and_then(Value::as_str)
        .ok_or("event must be a string")?;
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

/// 페이지 이벤트의 계층을 지정하여 기록하고 거부·쓰기 실패를 반환한다.
pub fn relay(target: &Path, mut record: Value) -> Result<(), String> {
    let object = record
        .as_object_mut()
        .ok_or("line requires the page event object")?;
    if object.get("event").and_then(Value::as_str).is_none() {
        return Err("event must be a string".into());
    }
    object.insert("layer".into(), json!("page"));
    append(target, &record)
}

fn append(target: &Path, record: &Value) -> Result<(), String> {
    let mut line =
        serde_json::to_vec(record).map_err(|error| format!("encode performance event: {error}"))?;
    line.push(b'\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(target)
        .map_err(|error| format!("open performance output {}: {error}", target.display()))?;
    file.write_all(&line)
        .map_err(|error| format!("append performance output {}: {error}", target.display()))
}

/// 스위치와 중계를 같은 순서로 실행한다.
pub fn command(config: &Path, request: Value) -> Result<Value, String> {
    let action = request
        .get("action")
        .and_then(Value::as_str)
        .ok_or("action must be on, off, or line")?;
    if !["on", "off", "line"].contains(&action) {
        return Err(format!("action must be on, off, or line, not {action}"));
    }
    let _writing = WRITING
        .lock()
        .map_err(|error| format!("performance writer lock: {error}"))?;
    let enabled = enabled(config)?;
    match action {
        "on" => {
            if enabled {
                return Ok(Value::Null);
            }
            let target = enable(config)?;
            if let Err(error) = line(&target, "host", json!({"event":"trace_on"})) {
                return Err(rollback_enable(config, error));
            }
            spawn_sampler(config);
            Ok(Value::Null)
        }
        "off" => {
            let mut errors = Vec::new();
            if enabled {
                if let Err(error) = line(&target(config), "host", json!({"event":"trace_off"})) {
                    errors.push(error);
                }
            }
            if let Err(error) = disable(config) {
                errors.push(error);
            }
            report_errors(errors)?;
            Ok(Value::Null)
        }
        "line" => {
            let record = request
                .get("line")
                .cloned()
                .ok_or("line requires the page event object")?;
            if !enabled {
                return Err("the performance trace is off".into());
            }
            relay(&target(config), record)?;
            Ok(Value::Null)
        }
        _ => unreachable!("validated performance action"),
    }
}

/// 유닉스 시각(밀리초)을 ISO-8601 로 바꾼다(종속성을 더하지 않는다).
fn now_iso8601_ms() -> String {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default(); // 기본값: 시계는 에포크 이전을 돌려주지 않는다
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

/// 메모리 샘플러(V5-104). 트레이스가 켜져 있는 동안 5초마다 이 프로세스의 상주
/// 크기를 한 줄로 남긴다. 사이드카 pid 는 프로세스 등록부 줄(process 이벤트)에
/// 쌓이므로 로그 소비자가 짝지는다. 꺼지면 대기로 돌아간다.
pub fn spawn_sampler(config: &Path) {
    static SPAWNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if SPAWNED.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return;
    }
    let config = config.to_path_buf();
    std::thread::spawn(move || loop {
        observe(
            &config,
            "sampler",
            || json!({"event":"memory", "rss_host_kb":resident_kb(std::process::id())}),
        );
        std::thread::sleep(std::time::Duration::from_secs(5));
    });
}

/// pid 의 상주 크기(KB). 실패는 0 — 프로세스가 끝났을 수 있다.
fn resident_kb(pid: u32) -> u64 {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output();
    match output {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .unwrap_or(0), // 기본값: ps 출력이 비었으면 프로세스가 끝났다
        Err(_) => 0,
    }
}
