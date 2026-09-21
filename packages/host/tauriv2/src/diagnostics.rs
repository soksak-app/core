//! 진단 빌드의 엔드포인트 메서드. cargo 기능 `diagnostics` 로만 포함한다.
//!
//! 화면에 표시된 결과는 페이지에서 읽을 수 없다. 표면과 모달은 이 앱이 만든 네이티브 뷰이고 창
//! 서버가 합성한다. 그래서 캡처는 화면 영역이 아니라 창을 대상으로 한다. 화면 영역은 앞에 있는
//! 창을 기록하고, 창을 앞으로 가져오면 측정 대상 상태가 바뀐다.
//!
//! 끌기 경로와 경계선 위치는 페이지가 정하고, 각 단계의 시각은 호스트가 정한다. 앞에 있지 않은
//! 창의 문서는 숨김 상태로 처리되어 타이머가 1 초 가까이 지연된다. 호스트의 시계는 창 위치와
//! 관계없이 지연되지 않는다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
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

/// 플랫폼의 창 녹화 연산. 둘째 값은 멈출 때 기록에 포함할 마지막 표시 시각(ms)이다.
struct PlatformCapture(&'static dyn platform::Platform, f64);

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
        self.0.capture_stop(self.1)
    }
}

fn recorder() -> Result<PlatformCapture, Failure> {
    Ok(PlatformCapture(platform::current().map_err(internal)?, 0.0))
}

/// 캡처 디렉터리 이름을 구분하는 번호.
static CAPTURES: AtomicU64 = AtomicU64::new(0);

fn internal(error: impl ToString) -> Failure {
    Failure::new(-32603, error.to_string())
}

/// 진단 메서드를 실행한다.
pub(crate) fn call(
    host: &Host,
    window: &Window,
    method: &str,
    params: Map<String, Value>,
) -> Result<Value, Failure> {
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
        "diagnostics.capture.stop" => {
            let after = match params.get("after") {
                None | Some(Value::Null) => 0.0,
                Some(value) => value
                    .as_f64()
                    .filter(|after| *after >= 0.0)
                    .ok_or_else(|| Failure::params("after must be a non-negative number"))?,
            };
            capture_stop(after)
        }
        "diagnostics.knob" => {
            if !params.get("name").is_some_and(Value::is_string)
                || !params.get("value").is_some_and(Value::is_number)
            {
                return Err(Failure::params(
                    "knob takes a name string and a number value",
                ));
            }
            host.page(window, method, params, TIMEOUT)
        }
        "diagnostics.transcript" => host.page(window, method, params, TIMEOUT),
        "diagnostics.modal.hold" => {
            let Some(on) = params.get("on").and_then(Value::as_bool) else {
                return Err(Failure::params("on must be a boolean"));
            };
            modal_hold(window.label(), on);
            Ok(Value::Null)
        }
        "diagnostics.modal.held" => modal_held(window.label()),
        _ => Err(Failure::new(
            -32601,
            format!("{method} is not a diagnostic method"),
        )),
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
    params.insert(
        "root".into(),
        Value::String(root.to_string_lossy().into_owned()),
    );
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
        return Err(Failure::params(
            "ms must be positive and times must be at least 1",
        ));
    }
    let per = ((ms / FRAME.as_millis() as f64).round() as u64).max(1);
    let steps = per * 2 * times;

    let frames = if capture {
        Some(capture_start(window, false)?)
    } else {
        None
    };

    exposure::log(
        window,
        &format!(
            "diagnostics: drag {}:{} by {},{} in {per} steps, {times} times",
            params["axis"].as_str().unwrap_or_default(),
            params["line"],
            params["dx"],
            params["dy"]
        ),
    );
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let length = FRAME * steps as u32;
    // 페이지는 끌기를 시작할 때 이전 단계를 버리므로 단계는 요청 이벤트를 보낸 뒤 보낸다.
    let result = host.page_then(
        window,
        "diagnostics.drag",
        params,
        Some(TIMEOUT + length),
        move || tick(app, label, steps),
    );
    let finished = (|| -> Result<Value, Failure> {
        let result = result?;
        // 마지막 배치가 커밋되고 표시될 때까지 기다린다. 다음 표시 한 번만 기다리면 마지막 단계의
        // 커밋보다 앞선 표시에서 끝날 수 있다. Wails 호스트도 같은 시점을 기다린다.
        let context = crate::windows::window_data(window).map_err(internal)?;
        let settled = crate::surfaces::when_settled(&context.running).map_err(internal)?;
        if settled.recv_timeout(TIMEOUT).is_err() {
            return Err(Failure::new(
                crate::endpoint::TIMED_OUT,
                "the drag was not presented within the time limit",
            ));
        }
        exposure::log(window, "diagnostics: drag presented");
        let mut merged = match result {
            Value::Object(fields) => fields,
            Value::Null => Map::new(),
            _ => return Err(internal("the page drag result is not an object")),
        };
        if let Some(frames) = &frames {
            merged.insert(
                "frames".into(),
                Value::String(frames.to_string_lossy().into_owned()),
            );
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
    let number = *numbers
        .first()
        .ok_or_else(|| internal("the window has no window number"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let directory = window
        .state::<Workspace>()
        .directory()
        .join("captures")
        .join(format!(
            "{stamp}-{}",
            CAPTURES.fetch_add(1, Ordering::Relaxed)
        ));
    let recorder = recorder()?;
    RECORDING
        .start(
            &recorder,
            Target {
                window: number,
                display,
            },
            &directory,
            &|path| recorder.0.private_directory(path),
        )
        .map_err(internal)?;
    Ok(directory)
}

/// after 의 표시 시각까지 기록한 뒤 진행 중인 기록을 끝내고 디렉터리와 프레임 수를 반환한다.
fn capture_stop(after: f64) -> Result<Value, Failure> {
    let recorder = PlatformCapture(recorder()?.0, after);
    let (directory, count) = RECORDING.finish(&recorder).map_err(internal)?;
    let limited = recorder.0.capture_limited().map_err(internal)?;
    let gap = recorder.0.capture_longest_gap().map_err(internal)?;
    Ok(json!({"frames": directory.to_string_lossy(), "count": count, "limited": limited, "longestGap": gap}))
}

/// 한 창에서 붙잡은 모달 내용 응답.
#[derive(Default)]
struct ModalHold {
    /// (놓았는지, 붙잡은 응답 수)
    state: Mutex<(bool, u32)>,
    changed: Condvar,
}

/// 창 이름별로 모달 내용 응답을 붙잡는다. 검사는 모달 문서가 처음 내용을 이후 이벤트보다 늦게
/// 받는 순서를 만든다.
static MODAL_HOLDS: Mutex<Option<HashMap<String, Arc<ModalHold>>>> = Mutex::new(None);

fn modal_hold_of(window: &str) -> Option<Arc<ModalHold>> {
    MODAL_HOLDS
        .lock()
        .expect("modal holds")
        .as_ref()?
        .get(window)
        .cloned()
}

/// 창 window 의 응답을 붙잡은 동안 반환하지 않는다.
pub(crate) fn hold_modal_content(window: &str) {
    let Some(hold) = modal_hold_of(window) else {
        return;
    };
    let mut state = hold.state.lock().expect("modal hold");
    state.1 += 1;
    hold.changed.notify_all();
    while !state.0 {
        state = hold.changed.wait(state).expect("modal hold");
    }
}

/// on 이면 창의 모달 내용 응답을 붙잡기 시작하고, 아니면 붙잡은 응답을 보내고 붙잡기를 멈춘다.
fn modal_hold(window: &str, on: bool) {
    let mut holds = MODAL_HOLDS.lock().expect("modal holds");
    let holds = holds.get_or_insert_with(HashMap::new);
    if on {
        holds.entry(window.to_string()).or_default();
    } else if let Some(hold) = holds.remove(window) {
        hold.state.lock().expect("modal hold").0 = true;
        hold.changed.notify_all();
    }
}

/// 창에서 모달 내용 응답을 하나 붙잡으면 답한다.
fn modal_held(window: &str) -> Result<Value, Failure> {
    let hold = modal_hold_of(window)
        .ok_or_else(|| internal("modal content answers are not held in this window"))?;
    let mut state = hold.state.lock().map_err(internal)?;
    while state.1 == 0 && !state.0 {
        state = hold.changed.wait(state).map_err(internal)?;
    }
    Ok(Value::Null)
}
