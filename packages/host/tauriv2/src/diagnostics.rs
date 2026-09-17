//! 진단 빌드의 엔드포인트 메서드. cargo 기능 `diagnostics` 로만 포함한다.
//!
//! 화면에 표시된 결과는 페이지에서 읽을 수 없다. 표면과 모달은 이 앱이 만든 네이티브 뷰이고 창
//! 서버가 합성한다. 그래서 캡처는 화면 영역이 아니라 창을 대상으로 한다. 화면 영역은 앞에 있는
//! 창을 기록하고, 창을 앞으로 가져오면 측정 대상 상태가 바뀐다.
//!
//! 끌기 경로와 경계선 위치는 페이지가 정하고, 각 단계의 시각은 호스트가 정한다. 앞에 있지 않은
//! 창의 문서는 숨김 상태로 처리되어 타이머가 1 초 가까이 지연된다. 호스트의 시계는 창 위치와
//! 관계없이 지연되지 않는다.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use tauri::{Emitter, EventTarget, Manager, Window};

use crate::endpoint::Failure;
use crate::exposure::{self, on_main, Host, TIMEOUT};
use crate::platform;
use crate::recording::{Capture, Recording, Target};
use crate::workspace::Workspace;

/// 끌기 한 단계의 간격. 페이지도 같은 값으로 단계 수를 계산한다.
const FRAME: Duration = Duration::from_millis(16);

/// 진행 중인 녹화.
static RECORDING: Recording = Recording::new();

/// 플랫폼의 창 녹화 연산.
struct PlatformCapture(&'static dyn platform::Platform);

impl Capture for PlatformCapture {
    fn open(&self, target: Target) -> Result<(), String> {
        self.0.capture_open(target.window, target.display)
    }
    fn start(&self, directory: &Path) -> Result<(), String> {
        self.0.capture_start(&directory.to_string_lossy())
    }
    fn wait(&self) -> Result<bool, String> {
        self.0.capture_wait()
    }
    fn stop(&self) -> Result<i32, String> {
        self.0.capture_stop()
    }
}

fn recorder() -> Result<PlatformCapture, Failure> {
    Ok(PlatformCapture(platform::current().map_err(internal)?))
}

/// 캡처 디렉터리 이름을 구분하는 번호.
static CAPTURES: AtomicU64 = AtomicU64::new(0);

fn internal(error: impl ToString) -> Failure {
    Failure::new(-32603, error.to_string())
}

/// 진단 메서드를 실행한다.
pub(crate) fn call(host: &Host, window: &Window, method: &str, params: Map<String, Value>) -> Result<Value, Failure> {
    match method {
        "diagnostics.fixture" => fixture(host, window),
        "diagnostics.drag" => drag(host, window, params),
        "diagnostics.capture.start" => {
            let display = match params.get("display") {
                None | Some(Value::Null) => false,
                Some(Value::Bool(display)) => *display,
                Some(_) => return Err(Failure::params("display must be a boolean")),
            };
            let frames = capture_start(window, display)?;
            Ok(json!({"frames": frames.to_string_lossy()}))
        }
        "diagnostics.capture.stop" => capture_stop(),
        "diagnostics.knob" => {
            if !params.get("name").is_some_and(Value::is_string) || !params.get("value").is_some_and(Value::is_number) {
                return Err(Failure::params("knob takes a name string and a number value"));
            }
            host.page(window, method, params, TIMEOUT)
        }
        "diagnostics.transcript" => host.page(window, method, params, TIMEOUT),
        _ => Err(Failure::new(-32601, format!("{method} is not a diagnostic method"))),
    }
}

/// `<config-dir>/test-project` 를 빈 폴더 설정으로 만들고 페이지에 그 프로젝트만 열도록 요청한다.
fn fixture(host: &Host, window: &Window) -> Result<Value, Failure> {
    let platform = platform::current().map_err(internal)?;
    let root = window.state::<Workspace>().directory().join("test-project");
    let settings = root.join(".soksak");
    platform.private_directory(&settings).map_err(internal)?;
    std::fs::write(settings.join("settings.json"), "{}\n").map_err(internal)?;
    let mut params = Map::new();
    params.insert("root".into(), Value::String(root.to_string_lossy().into_owned()));
    host.page(window, "diagnostics.fixture", params, TIMEOUT)
}

/// 경계선 하나의 왕복 끌기를 페이지에 요청하고 단계 시각을 보낸다. 끌기가 끝나고 창이 그 결과를
/// 그린 뒤 응답한다. capture 이면 끌기 전에 창 기록을 시작하고 기록 디렉터리를 반환한다.
fn drag(host: &Host, window: &Window, mut params: Map<String, Value>) -> Result<Value, Failure> {
    if !matches!(params.get("axis").and_then(Value::as_str), Some("x" | "y")) {
        return Err(Failure::params("axis must be x or y"));
    }
    for name in ["line", "dx", "dy", "ms", "times"] {
        if !params.get(name).is_some_and(Value::is_number) {
            return Err(Failure::params(format!("{name} must be a number")));
        }
    }
    let capture = match params.remove("capture") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(capture)) => capture,
        Some(_) => return Err(Failure::params("capture must be a boolean")),
    };
    let ms = params["ms"].as_f64().unwrap_or_default();
    let times = params["times"].as_u64().unwrap_or_default();
    if ms <= 0.0 || times < 1 {
        return Err(Failure::params("ms must be positive and times must be at least 1"));
    }
    let per = ((ms / FRAME.as_millis() as f64).round() as u64).max(1);
    let steps = per * 2 * times;

    let frames = if capture { Some(capture_start(window, false)?) } else { None };

    exposure::log(window, &format!("diagnostics: drag {}:{} by {},{} in {per} steps, {times} times",
        params["axis"].as_str().unwrap_or_default(), params["line"], params["dx"], params["dy"]));
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let length = FRAME * steps as u32;
    // 페이지는 끌기를 시작할 때 이전 단계를 버리므로 단계는 요청 이벤트를 보낸 뒤 보낸다.
    let result = host.page_then(window, "diagnostics.drag", params, Some(TIMEOUT + length), move || tick(app, label, steps));
    let finished = (|| -> Result<Value, Failure> {
        let result = result?;
        // 마지막 배치가 커밋되고 표시될 때까지 기다린다. 다음 표시 한 번만 기다리면 마지막 단계의
        // 커밋보다 앞선 표시에서 끝날 수 있다. Wails 호스트도 같은 시점을 기다린다.
        let context = crate::windows::window_data(window).map_err(internal)?;
        let settled = crate::surfaces::when_settled(&context.running).map_err(internal)?;
        if settled.recv_timeout(TIMEOUT).is_err() {
            return Err(Failure::new(crate::endpoint::TIMED_OUT, "the drag was not presented within the time limit"));
        }
        exposure::log(window, "diagnostics: drag presented");
        let mut merged = match result {
            Value::Object(fields) => fields,
            Value::Null => Map::new(),
            _ => return Err(internal("the page drag result is not an object")),
        };
        if let Some(frames) = &frames {
            merged.insert("frames".into(), Value::String(frames.to_string_lossy().into_owned()));
        }
        Ok(Value::Object(merged))
    })();
    // 요청자가 프레임 폴더를 받지 못하면 녹화를 멈추고 폴더를 지운다.
    if finished.is_err() && frames.is_some() {
        RECORDING.abort(&recorder()?);
    }
    finished
}

/// 페이지에 끌기 단계 시각을 steps 번 보낸다. 각 단계는 시작 시각 기준의 예정 시각에 보낸다.
/// 한 단계씩 잠들면 각 단계의 실행 시간이 이후 단계에 누적된다.
fn tick(app: tauri::AppHandle, label: String, steps: u64) {
    std::thread::spawn(move || {
        let began = Instant::now();
        for step in 1..=steps {
            let due = FRAME * step as u32;
            if let Some(left) = due.checked_sub(began.elapsed()) {
                std::thread::sleep(left);
            }
            if let Err(error) = app.emit_to(EventTarget::webview(&label), "diagnostics-tick", ()) {
                eprintln!("{error}");
                return;
            }
        }
    });
}

/// 창 기록을 시작하고 기록 디렉터리를 반환한다. display 이면 창이 있는 디스플레이에서 이 앱의 창을 기록한다.
fn capture_start(window: &Window, display: bool) -> Result<PathBuf, Failure> {
    let platform = platform::current().map_err(internal)?;
    let held = window.clone();
    let numbers = on_main(window, move || platform.window_numbers(&held)).map_err(internal)?;
    let number = *numbers.first().ok_or_else(|| internal("the window has no window number"))?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let directory = window
        .state::<Workspace>()
        .directory()
        .join("captures")
        .join(format!("{stamp}-{}", CAPTURES.fetch_add(1, Ordering::Relaxed)));
    let recorder = recorder()?;
    RECORDING
        .start(&recorder, Target { window: number, display }, &directory, &|path| recorder.0.private_directory(path))
        .map_err(internal)?;
    Ok(directory)
}

/// 진행 중인 기록을 끝내고 디렉터리와 프레임 수를 반환한다.
fn capture_stop() -> Result<Value, Failure> {
    let recorder = recorder()?;
    let (directory, count) = RECORDING.finish(&recorder).map_err(internal)?;
    let gap = recorder.0.capture_longest_gap().map_err(internal)?;
    Ok(json!({"frames": directory.to_string_lossy(), "count": count, "longestGap": gap}))
}
