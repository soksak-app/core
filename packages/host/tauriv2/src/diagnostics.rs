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

use crate::application_log::log_error;
use crate::endpoint::Failure;
use crate::exposure::{self, on_main, Host, TIMEOUT};
use crate::platform;
use crate::recording::{layout_trace, Capture, Recording, Target};
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
        "diagnostics.fixture" => fixture(host, window, params),
        "diagnostics.drag" => drag(host, window, params),
        "diagnostics.capture.start" => {
            let display = match params.get("display") {
                None | Some(Value::Null) => false,
                Some(Value::Bool(display)) => *display,
                Some(_) => return Err(Failure::params("display must be a boolean")),
            };
            let frames = capture_start(window, display)?;
            let traced = (|| -> Result<(), Failure> {
                let platform = platform::current().map_err(internal)?;
                on_main(window, move || platform.layout_trace_start()).map_err(internal)
            })();
            if let Err(error) = traced {
                if let Err(cleanup) =
                    recorder().and_then(|capture| RECORDING.abort(&capture).map_err(internal))
                {
                    return Err(internal(format!(
                        "{}; abort capture: {}",
                        error.message, cleanup.message
                    )));
                }
                return Err(error);
            }
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
            capture_stop(window, after)
        }
        // 메인 페이지가 처리하는 진단 메서드. 표면의 exposure 답은 페이지에서 나가기 전에 붙잡아야 요청이 끝난 뒤에
        // 도착하므로 표면 답 붙잡기도 페이지가 처리한다(docs/spec/endpoint.md).
        "diagnostics.transcript"
        | "diagnostics.surface.hold"
        | "diagnostics.surface.held"
        | "diagnostics.page.request" => {
            exposure::parsed(&host.page(window, method, params, TIMEOUT)?)
        }
        "diagnostics.modal.hold" => {
            let Some(on) = params.get("on").and_then(Value::as_bool) else {
                return Err(Failure::params("on must be a boolean"));
            };
            modal_hold(window.label(), on);
            Ok(Value::Null)
        }
        "diagnostics.modal.held" => modal_held(window.label()),
        "diagnostics.input.source" => input_source(window, params),
        "diagnostics.capture.still" => capture_still(window),
        "diagnostics.notifications" => delivered_notifications(window),
        "diagnostics.page.collect" => page_collect(window),
        "diagnostics.native.objects" => native_objects(window, &params),
        "diagnostics.process.exit" => process_exit(window, &params),
        "diagnostics.navigation.delay" => {
            let ms = params
                .get("ms")
                .and_then(Value::as_u64)
                .filter(|ms| *ms <= 10_000)
                .ok_or_else(|| Failure::params("ms must be an integer from 0 to 10000"))?;
            navigation_delay(window.label(), ms);
            Ok(Value::Null)
        }
        "diagnostics.presentation.failure" => {
            exposure::inject_presentation_failure(window)?;
            Ok(Value::Null)
        }
        _ => Err(Failure::new(
            -32601,
            format!("{method} is not a diagnostic method"),
        )),
    }
}

/// 창의 앱 페이지 WebContent process 가 JavaScript 객체를 수집하게 한다. 메모리 검사가 수집 시점과 관계없이 남은
/// 메모리를 재도록 재기 전에 부른다.
fn page_collect(window: &Window) -> Result<Value, Failure> {
    let target = window.clone();
    on_main(window, move || {
        let view = crate::windows::root_view(&target)
            .ok_or_else(|| "the main page is gone".to_string())?;
        crate::exposure::with_view(&view, |native| platform::current()?.collect_garbage(native))
    })
    .map_err(internal)?;
    Ok(Value::Null)
}

/// 애플리케이션이 이벤트 하나를 처리한 뒤 창과 웹뷰에 붙인 라이브러리 객체의 살아 있는 수를 반환한다. 닫은 창의
/// 객체는 그 창을 닫은 이벤트 반복의 자동 해제 풀이 비워질 때 해제되고, 풀은 애플리케이션이 이벤트를 처리할 때
/// 비워진다. 창 검사가 닫은 창의 해제를 사용자 입력 없이 재도록 이벤트 하나를 넣고 그 뒤에 센다. AppKit 은 화면에
/// 있던 창을 닫기 애니메이션이 끝날 때까지 유지하므로, equal 을 주면 수가 equal 과 같아질 때 응답한다.
fn native_objects(window: &Window, params: &Map<String, Value>) -> Result<Value, Failure> {
    let expected = params
        .get("equal")
        .map(platform::WindowObjects::from_equal)
        .transpose()
        .map_err(Failure::params)?;
    let (tx, rx) = std::sync::mpsc::channel();
    on_main(window, move || {
        platform::current()?.window_objects_when(
            expected,
            TIMEOUT.as_secs_f64(),
            Box::new(move |counts, reached| {
                if tx.send((counts, reached)).is_err() {
                    crate::application_log::log_info(
                        "diagnostics",
                        "window object counts arrived after their request ended",
                    );
                }
            }),
        )
    })
    .map_err(internal)?;
    // 라이브러리는 이벤트를 처리한 뒤 TIMEOUT 안에 답하므로, 이벤트 처리 시간까지 두 배를 기다린다.
    let (counts, reached) = rx.recv_timeout(2 * TIMEOUT).map_err(|_| {
        Failure::new(
            crate::endpoint::TIMED_OUT,
            format!("the application did not handle an event within {TIMEOUT:?}"),
        )
    })?;
    if !reached {
        let expected = expected.expect("only expected counts can be unreached");
        return Err(Failure::new(
            crate::endpoint::TIMED_OUT,
            format!("window object counts did not reach {expected} within {TIMEOUT:?}; they are {counts}"),
        ));
    }
    Ok(counts.payload())
}

/// pid 의 프로세스가 끝나면 응답한다. 창 검사가 닫은 창의 WebContent 프로세스가 끝나는 것을 커널의 종료 알림으로
/// 기다린다.
fn process_exit(window: &Window, params: &Map<String, Value>) -> Result<Value, Failure> {
    let pid = platform::parse_process_id(params.get("pid")).map_err(Failure::params)?;
    let (tx, rx) = std::sync::mpsc::channel();
    on_main(window, move || {
        platform::current()?.when_process_exited(
            pid,
            TIMEOUT.as_secs_f64(),
            Box::new(move |exited| {
                if tx.send(exited).is_err() {
                    crate::application_log::log_info(
                        "diagnostics",
                        "process exit answer arrived after its request ended",
                    );
                }
            }),
        )
    })
    .map_err(internal)?;
    // 라이브러리는 TIMEOUT 안에 답하므로, 메인 스레드가 답을 보낼 시간까지 두 배를 기다린다.
    let exited = rx.recv_timeout(2 * TIMEOUT).map_err(|_| {
        Failure::new(
            crate::endpoint::TIMED_OUT,
            format!("the application did not answer within {:?}", 2 * TIMEOUT),
        )
    })?;
    if !exited {
        return Err(Failure::new(
            crate::endpoint::TIMED_OUT,
            format!("process {pid} did not exit within {TIMEOUT:?}"),
        ));
    }
    Ok(Value::Null)
}

/// 창을 포커스를 주지 않고 한 장 찍어 `<config-dir>/captures/still-*/window.png` 로 쓰고 경로를 반환한다.
/// 개발 중 눈으로 확인하는 관측 자료이며, 요청자가 확인한 뒤 그 디렉터리를 지운다.
fn capture_still(window: &Window) -> Result<Value, Failure> {
    let platform = platform::current().map_err(internal)?;
    let held = window.clone();
    let numbers = on_main(window, move || platform.window_numbers(&held)).map_err(internal)?;
    let number = *numbers
        .first()
        .ok_or_else(|| internal("the window has no window number"))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(internal)?
        .as_millis();
    // 녹화와 같이 캡처마다 비공개 디렉터리를 만든다.
    let directory = window
        .state::<Workspace>()
        .directory()
        .join("logs")
        .join("captures")
        .join(format!(
            "still-{stamp}-{}",
            CAPTURES.fetch_add(1, Ordering::Relaxed)
        ));
    platform.private_directory(&directory).map_err(internal)?;
    let path = directory.join("window.png");
    platform
        .capture_still(number, &path.to_string_lossy())
        .map_err(internal)?;
    Ok(json!({"path": path.to_string_lossy()}))
}

/// Writes a still capture of each window for the debug view and returns their paths (docs/spec/debug.md).
pub(crate) fn capture_windows(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    let mut paths = Vec::new();
    for (label, window) in app.windows() {
        let value = capture_still(&window)
            .map_err(|failure| format!("window {label}: {}", failure.message))?;
        let path = value["path"].as_str().ok_or_else(|| {
            format!("window {label}: the still capture answered {value} without a path")
        })?;
        paths.push(path.to_string());
    }
    Ok(paths)
}

/// select 가 있으면 그 입력 소스를 선택하고, 현재 선택된 키보드 입력 소스를 반환한다.
fn input_source(window: &Window, params: Map<String, Value>) -> Result<Value, Failure> {
    let select = match params.get("select") {
        None | Some(Value::Null) => None,
        Some(Value::String(identifier)) if !identifier.is_empty() => Some(identifier.clone()),
        Some(_) => return Err(Failure::params("select must be a non-empty string")),
    };
    let platform = platform::current().map_err(internal)?;
    let current = on_main(window, move || {
        if let Some(identifier) = &select {
            platform.select_input_source(identifier)?;
        }
        platform.input_source()
    })
    .map_err(internal)?;
    Ok(json!({"current": current}))
}

/// `<config-dir>/test-project` 를 빈 폴더 설정으로 만들고 페이지에 그 프로젝트만 열도록 요청한다.
fn fixture(host: &Host, window: &Window, request: Map<String, Value>) -> Result<Value, Failure> {
    let platform = platform::current().map_err(internal)?;
    let root = window.state::<Workspace>().directory().join("test-project");
    let settings = root.join(".soksak");
    platform.private_directory(&settings).map_err(internal)?;
    platform
        .write_private_file(&settings.join("settings.json"), b"{}\n")
        .map_err(internal)?;
    let mut params = Map::new();
    params.insert(
        "root".into(),
        Value::String(root.to_string_lossy().into_owned()),
    );
    // settings 는 기본값 위에 적용할 공통 설정이다. 주어지면 객체여야 한다.
    if let Some(settings) = request.get("settings") {
        if !settings.is_object() {
            return Err(Failure::params(
                "diagnostics.fixture settings must be an object",
            ));
        }
        params.insert("settings".into(), settings.clone());
    }
    exposure::parsed(&host.page(window, "diagnostics.fixture", params, TIMEOUT)?)
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
    // 기본값: 없거나 숫자가 아닌 값은 0 으로 두어 바로 아래 검사가 잘못된 인자로 거부한다.
    let ms = params["ms"].as_f64().unwrap_or_default();
    // 기본값: 없거나 숫자가 아닌 값은 0 으로 두어 바로 아래 검사가 잘못된 인자로 거부한다.
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
    if capture {
        let platform = platform::current().map_err(internal)?;
        on_main(window, move || platform.layout_trace_start()).map_err(internal)?;
    }

    exposure::log(
        window,
        &format!(
            "diagnostics: drag {}:{} by {},{} in {per} steps, {times} times",
            // 기본값: 로그 문장만 만든다. 축은 페이지가 검사하고 잘못된 값을 오류로 답한다.
            params["axis"].as_str().unwrap_or_default(),
            params["line"],
            params["dx"],
            params["dy"]
        ),
    );
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let length = FRAME * steps as u32;
    // 기록하면 걸음을 보낸 시각을 프레임과 같은 시계로 남긴다. 걸음부터 화면까지의 지연을 잴 수 있다.
    let sent = std::sync::Arc::new(std::sync::Mutex::new(Vec::<f64>::new()));
    let clock = if frames.is_some() {
        Some(platform::current().map_err(internal)?)
    } else {
        None
    };
    let recorded = sent.clone();
    // 페이지는 끌기를 시작할 때 이전 단계를 버리므로 단계는 요청 이벤트를 보낸 뒤 보낸다.
    let result = host.page_then(
        window,
        "diagnostics.drag",
        params,
        Some(TIMEOUT + length),
        move || tick(app, label, steps, clock, recorded),
    );
    // 끌기의 성공과 관계없이 기록을 멈춘다.
    let layouts = (|| -> Result<_, Failure> {
        if frames.is_some() {
            let platform = platform::current().map_err(internal)?;
            on_main(window, move || platform.layout_trace_stop())
                .map(Some)
                .map_err(internal)
        } else {
            Ok(None)
        }
    })();
    let finished = (|| -> Result<Value, Failure> {
        let (result, layouts) = match (result, layouts) {
            (Ok(result), Ok(layouts)) => (result, layouts),
            (Err(error), Ok(_)) | (Ok(_), Err(error)) => return Err(error),
            (Err(error), Err(trace)) => {
                return Err(internal(format!(
                    "{}; layout trace: {}",
                    error.message, trace.message
                )))
            }
        };
        // 마지막 배치가 커밋되고 표시될 때까지 기다린다. 다음 표시 한 번만 기다리면 마지막 단계의
        // 커밋보다 앞선 표시에서 끝날 수 있다. Wails 호스트도 같은 시점을 기다린다.
        let context = crate::windows::window_data(window).map_err(internal)?;
        let settled = crate::surfaces::when_settled(&context.running).map_err(internal)?;
        if settled.recv_timeout(TIMEOUT).is_err() {
            return Err(Failure::new(
                crate::endpoint::TIMED_OUT,
                format!("the drag was not presented within {TIMEOUT:?}"),
            ));
        }
        exposure::log(window, "diagnostics: drag presented");
        let mut merged = match exposure::parsed(&result)? {
            Value::Object(fields) => fields,
            Value::Null => Map::new(),
            _ => return Err(internal("the page drag result is not an object")),
        };
        if let Some(frames) = &frames {
            merged.insert(
                "frames".into(),
                Value::String(frames.to_string_lossy().into_owned()),
            );
            let ticks = sent.lock().map_err(internal)?.clone();
            merged.insert("ticks".into(), serde_json::json!(ticks));
            merged.insert(
                "layouts".into(),
                layout_trace(
                    layouts
                        .as_deref()
                        .ok_or_else(|| internal("the recorded drag has no layout trace"))?,
                ),
            );
        }
        Ok(Value::Object(merged))
    })();
    // 요청자가 프레임 폴더를 받지 못하면 녹화를 멈추고 폴더를 지운다.
    if let Err(error) = finished {
        if frames.is_some() {
            let cleanup =
                recorder().and_then(|capture| RECORDING.abort(&capture).map_err(internal));
            if let Err(cleanup) = cleanup {
                return Err(internal(format!(
                    "{}; abort capture: {}",
                    error.message, cleanup.message
                )));
            }
        }
        return Err(error);
    }
    finished
}

/// 페이지에 끌기 단계 시각을 steps 번 보낸다. 각 단계는 시작 시각 기준의 예정 시각에 보낸다.
/// 한 단계씩 잠들면 각 단계의 실행 시간이 이후 단계에 누적된다.
fn tick(
    app: tauri::AppHandle,
    label: String,
    steps: u64,
    clock: Option<&'static dyn platform::Platform>,
    sent: std::sync::Arc<std::sync::Mutex<Vec<f64>>>,
) {
    std::thread::spawn(move || {
        let began = Instant::now();
        for step in 1..=steps {
            let due = FRAME * step as u32;
            if let Some(left) = due.checked_sub(began.elapsed()) {
                std::thread::sleep(left);
            }
            if let Some(platform) = clock {
                match (platform.capture_clock(), sent.lock()) {
                    (Ok(now), Ok(mut ticks)) => ticks.push(now),
                    (Err(error), _) => log_error("drag tick clock", error),
                    (_, Err(error)) => log_error("drag tick clock", error),
                }
            }
            if let Err(error) = app.emit_to(EventTarget::webview(&label), "diagnostics-tick", ()) {
                log_error("diagnostics-tick", error);
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
        .map_err(|e| internal(format!("the system clock is before 1970: {e}")))?;
    let directory = window
        .state::<Workspace>()
        .directory()
        .join("logs")
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
fn capture_stop(window: &Window, after: f64) -> Result<Value, Failure> {
    let recorder = PlatformCapture(recorder()?.0, after);
    let (directory, count) = RECORDING.finish(&recorder).map_err(internal)?;
    let finished = (|| -> Result<Value, Failure> {
        let platform = recorder.0;
        let layouts = on_main(window, move || platform.layout_trace_stop()).map_err(internal)?;
        let limited = recorder.0.capture_limited().map_err(internal)?;
        let gap = recorder.0.capture_longest_gap().map_err(internal)?;
        Ok(crate::recording::stop_payload(
            &directory, count, limited, gap, &layouts,
        ))
    })();
    if let Err(error) = finished {
        if let Err(cleanup) = std::fs::remove_dir_all(&directory) {
            return Err(internal(format!(
                "{}; capture directory cleanup: {cleanup}",
                error.message
            )));
        }
        return Err(error);
    }
    finished
}

/// 한 창에서 붙잡은 모달 내용 응답.
#[derive(Default)]
struct ModalHold {
    /// (놓았는지, 붙잡은 응답 수)
    state: Mutex<(bool, u32)>,
    changed: Condvar,
}

/// 창 이름별로 main webview navigation callback 처리를 늦출 밀리초.
static NAVIGATION_DELAYS: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

/// 창의 이후 navigation callback 처리를 ms 밀리초 늦춘다. 0 은 지연을 없앤다.
fn navigation_delay(window: &str, ms: u64) {
    let mut delays = NAVIGATION_DELAYS.lock().expect("navigation delays");
    let delays = delays.get_or_insert_with(HashMap::new);
    if ms == 0 {
        delays.remove(window);
    } else {
        delays.insert(window.to_string(), ms);
    }
}

/// 창의 지연만큼 기다린 뒤 navigation callback 처리를 실행하고, 끝났음을 진단 기록에 남긴다.
pub(crate) fn handle_navigation(window: &Window, handle: impl FnOnce()) {
    let delay = NAVIGATION_DELAYS
        .lock()
        .expect("navigation delays")
        .as_ref()
        .and_then(|delays| delays.get(window.label()).copied())
        // 기본값: 지연을 지정하지 않은 창은 기다리지 않는다.
        .unwrap_or(0);
    std::thread::sleep(std::time::Duration::from_millis(delay));
    handle();
    exposure::log(
        window,
        &format!("navigation callback handled after {delay} ms"),
    );
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
/// 알림 센터가 아직 보이는 이 애플리케이션의 알림을 반환한다.
fn delivered_notifications(window: &Window) -> Result<Value, Failure> {
    let (tx, rx) = std::sync::mpsc::channel();
    on_main(window, move || {
        platform::current()?.delivered_notifications(Box::new(move |list| {
            if tx.send(list).is_err() {
                crate::application_log::log_info(
                    "diagnostics",
                    "delivered notifications arrived after their request ended",
                );
            }
        }))
    })
    .map_err(internal)?;
    let list = rx.recv_timeout(TIMEOUT).map_err(|_| {
        Failure::new(
            crate::endpoint::TIMED_OUT,
            format!(
                "the notification center did not list delivered notifications within {TIMEOUT:?}"
            ),
        )
    })?;
    serde_json::from_str(&list)
        .map_err(|error| internal(format!("delivered notifications {list:?}: {error}")))
}

fn modal_held(window: &str) -> Result<Value, Failure> {
    let hold = modal_hold_of(window)
        .ok_or_else(|| internal("modal content answers are not held in this window"))?;
    let mut state = hold.state.lock().map_err(internal)?;
    while state.1 == 0 && !state.0 {
        state = hold.changed.wait(state).map_err(internal)?;
    }
    Ok(Value::Null)
}
