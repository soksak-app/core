//! 개발 중 관찰 기능. 별도 Tauri 플러그인으로 등록한다.
//!
//! 화면에 표시된 결과는 페이지에서 읽을 수 없다. 표면과 모달은 이 앱이 만든 네이티브 뷰이고
//! 창 서버가 합성한다. 그래서 외부에서 관찰하고, 캡처 도구는 화면 영역이 아니라 창을 대상으로
//! 한다. 화면 영역은 앞에 있는 창을 기록하고, 창을 앞으로 가져오면 측정 대상 상태가 바뀐다.
//!
//! 제품 계약에 속하지 않는다. 요청한 경우에만 등록하고, 등록하지 않으면 실행되지 않는다.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Emitter, Listener, Manager, Wry};

use crate::platform;

/// 명령줄 플래그 값을 반환한다. 다른 호스트와 같이 `--flag value` 와 `--flag=value` 형식을
/// 모두 받는다. Go 의 flag 패키지가 두 형식을 받으므로 한 애플리케이션용 명령을 다른 애플리케이션에도
/// 사용할 수 있다.
pub fn flag(name: &str) -> Option<String> {
    let mut args = std::env::args().skip(1);
    let long = format!("--{name}");
    let short = format!("-{name}");
    while let Some(arg) = args.next() {
        if arg == long || arg == short {
            return args.next();
        }
        for prefix in [format!("{long}="), format!("{short}=")] {
            if let Some(value) = arg.strip_prefix(&prefix) {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// 값이 없는 플래그가 주어졌는지 반환한다.
pub fn given(name: &str) -> bool {
    let long = format!("--{name}");
    let short = format!("-{name}");
    std::env::args().skip(1).any(|a| a == long || a == short)
}

/// 이 애플리케이션이 명령을 받는 포트. 두 호스트를 동시에 실행할 수 있도록 다른 호스트는 다른
/// 포트를 사용한다. `e2e/app.mjs` 에 같은 번호가 있다.
const CONTROL_PORT: u16 = 49733;

/// 현재 열린 제어 연결.
static TOLD: Mutex<Vec<TcpStream>> = Mutex::new(Vec::new());

/// 기록 프레임을 저장할 디렉터리와, 그 디렉터리가 한 번의 연속 갱신만 기록하는지 여부.
/// `--capture` 는 손으로 끄는 경계선도 기록하도록 디렉터리를 지정하고 모든 연속 갱신을 기록한다.
/// 명령으로 요청한 기록은 요청한 드래그만 기록한다.
static INTO: Mutex<(Option<String>, bool)> = Mutex::new((None, false));

/// 한 줄을 표준 오류와 열린 모든 제어 연결에 쓴다.
///
/// 검사는 관찰 기능이 남긴 줄과 페이지 자체 검사가 남긴 줄을 읽는다. 두 줄 모두 이 함수로 기록한다.
pub fn say(line: &str) {
    eprintln!("{line}");
    let mut open = TOLD.lock().unwrap();
    open.retain_mut(|conn| conn.write_all(format!("{line}\n").as_bytes()).is_ok());
}

/// 기록을 끝내고 결과 줄을 반환한다.
fn stopped(dir: &str) -> String {
    match platform::current().and_then(|platform| platform.capture_stop()) {
        Ok(frames) => format!("observe: wrote {frames} frames to {dir}"),
        Err(error) => format!("observe: capture error: {error}"),
    }
}

/// 다음 기록을 저장할 디렉터리를 반환한다.
fn into() -> Option<String> {
    INTO.lock().unwrap().0.clone()
}

/// 다음 기록을 저장할 디렉터리를 설정한다. `once` 이면 한 번의 연속 갱신만 기록한다.
fn write_to(dir: Option<String>, once: bool) {
    *INTO.lock().unwrap() = (dir, once);
}

/// 연속 갱신 하나의 종료를 기록한다. 한 번만 기록하는 디렉터리는 여기서 해제한다.
fn wrote() {
    let mut at = INTO.lock().unwrap();
    if at.1 {
        *at = (None, false);
    }
}

/// 명령을 받는 제어 포트를 연다.
///
/// 애플리케이션 하나를 여러 검사가 반복해서 사용하고, 애플리케이션은 검사보다 오래 실행된다.
/// 그래서 검사를 다시 실행해도 창을 새로 열지 않는다. 새 창은 사용자가 보고 있는 화면 앞에
/// 놓인다.
///
/// 제어 포트는 한 줄에 명령 하나를 받고, 명령이 끝날 때까지 이 애플리케이션의 로그를 돌려보낸다.
/// 호출자는 기다리는 줄을 읽은 뒤 연결을 닫는다.
fn commands(app: AppHandle) {
    let listener = match TcpListener::bind(("127.0.0.1", CONTROL_PORT)) {
        Ok(listener) => listener,
        Err(why) => {
            say(&format!("observe: no control port, {why}"));
            return;
        }
    };
    say(&format!("observe: control on {CONTROL_PORT}"));
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || serve(app, conn));
        }
    });
}

/// 연결 하나가 보낸 명령을 실행한다.
fn serve(app: AppHandle, conn: TcpStream) {
    let Ok(mine) = conn.try_clone() else {
        return;
    };
    TOLD.lock().unwrap().push(conn);
    for line in BufReader::new(mine).lines().map_while(Result::ok) {
        command(&app, line.trim());
    }
}

/// 명령 하나를 실행한다.
///
/// `drag` 는 `--drive` 의 드래그에서 대기를 뺀 것이다. 그 대기는 페이지의 첫 렌더링을 기다리고,
/// 명령은 페이지가 그려진 뒤에만 도착한다.
fn command(app: &AppHandle, line: &str) {
    let (verb, rest) = line.split_once(' ').unwrap_or((line, ""));
    match verb {
        "" => {}
        "drag" => {
            // 디렉터리는 선택 사항이다. 디렉터리가 없는 드래그의 결과는 프레임이 아니라 로그로 확인한다.
            let (spec, dir) = rest.split_once(' ').unwrap_or((rest, ""));
            let mut plan = match Plan::parse(spec) {
                Ok(plan) => plan,
                Err(why) => {
                    say(&format!("observe: drag {why}"));
                    return;
                }
            };
            plan.wait = Duration::ZERO;
            write_to((!dir.is_empty()).then(|| dir.to_string()), true);
            if !dir.is_empty() {
                match platform::current().and_then(|platform| {
                    platform.capture_start(dir)?;
                    platform.capture_wait()
                }) {
                    Ok(true) => {}
                    Ok(false) => {
                        say("observe: capture did not produce an initial frame");
                        return;
                    }
                    Err(error) => {
                        say(&format!("observe: capture error: {error}"));
                        return;
                    }
                }
            }
            start_drag(app, plan);
        }
        "quit" => {
            say("observe: quit requested");
            app.exit(0);
        }
        "stop" => {
            let dir = into().unwrap_or_default();
            wrote();
            say(&stopped(&dir));
        }
        "fixture" => {
            let Some(directory) = flag("config-dir") else { say("observe: fixture error: --config-dir is required for window tests"); return };
            let root = std::path::Path::new(&directory).join("test-project");
            if let Err(error) = std::fs::create_dir_all(root.join(".soksak"))
                .and_then(|_| std::fs::write(root.join(".soksak/settings.json"), "{}\n")) {
                say(&format!("observe: fixture error: {error}")); return;
            }
            let _ = emit_main(&app, "observe-fixture", root.to_string_lossy().into_owned());
        }
        "reset" => {
            // 애플리케이션은 여러 검사보다 오래 실행된다. 이전 검사가 연 모달이나 옮긴 경계선은 다음
            // 검사가 만들지 않은 상태이므로, 페이지를 다시 읽어 모든 검사를 같은 상태에서 시작한다.
            // 창 크기가 이미 시작 크기이면 바꾸지 않는다. 크기를 다시 설정하면 그 동안 창 버튼 위치가
            // 바뀌고 페이지 검사가 그 변화를 측정한다.
            if let Some(window) = app.get_window("main") {
                if window.is_maximized().unwrap_or(false) {
                    let _ = window.unmaximize();
                }
                if let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) {
                    let now = size.to_logical::<f64>(scale);
                    if now.width != START.0 || now.height != START.1 {
                        let _ = window.set_size(tauri::LogicalSize::new(START.0, START.1));
                    }
                }
            }
            if let Some(webview) = app.get_webview("main") {
                let _ = webview.reload();
            }
            say("observe: reset");
        }
        "click" => {
            let _ = emit_main(&app, "observe-click", rest.to_string());
        }
        "native" => {
            let request = rest.to_owned();
            let held = app.clone();
            let _ = app.run_on_main_thread(move || {
                let probed = platform::current().and_then(|platform| {
                    let handle = held.get_window("main").and_then(|w| platform.window_handle(&w).ok()).unwrap_or(0);
                    platform.probe(handle, &request, |text| say(&format!("observe: native {text}")))
                });
                if let Err(error) = probed {
                    say(&format!("observe: native error: {error}"));
                }
            });
        }
        "transcript" => {
            // 기록을 끄는 명령은 없다. reset 은 페이지를 다시 읽고 기록도 처음부터 시작한다.
            let _ = emit_main(&app, "observe-record", ());
            say("observe: transcript on");
        }
        "zoom" => {
            if let Some(window) = app.get_window("main") {
                let _ = if rest == "off" {
                    window.unmaximize()
                } else {
                    window.maximize()
                };
            }
            say(if rest == "off" { "observe: zoom off" } else { "observe: zoom on" });
        }
        "size" => match size_of(rest) {
            Some((w, h)) => set_size(app, w, h),
            None => say(&format!("observe: size takes width,height, got {rest:?}")),
        },
        _ => say(&format!("observe: {verb:?} is not a command")),
    }
}

pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new("observe")
        .setup(|app, _api| {
            // 모달 문서가 렌더링할 때마다 기록한다. 내용 갱신이 문서에 도달했는지는 이 줄로만 확인한다.
            app.listen("modal-rendered", |event| {
                say(&format!("observe: modal rendered {}", event.payload().trim_matches('"')));
            });
            // 관찰은 페이지의 첫 커밋 뒤에 시작한다. 이때 창이 화면에 있고 표면이 존재한다. 페이지 로드
            // 이벤트는 다시 읽을 때마다 발생하므로 관찰을 여러 번 시작하게 된다.
            let ready = app.clone();
            let started = std::sync::atomic::AtomicBool::new(false);
            app.listen("page-ready", move |_| {
                if started.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                transcribe(ready.clone());
                report(ready.clone());
                open(ready.clone());
                zoom(ready.clone());
                resize(ready.clone());
                drive(ready.clone());
                click(ready.clone());
                commands(ready.clone());
            });
            // 페이지가 후속 갱신 여부를 보고하므로 손으로 끈 경계선도 명령으로 끈 경계선과 같이 기록한다.
            write_to(capturing(), false);
            app.listen("run-began", move |_| {
                if let Some(into) = into() {
                    if let Err(error) = platform::current().and_then(|platform| platform.capture_start(&into)) {
                        say(&format!("observe: capture error: {error}"));
                    }
                }
            });
            // 수신기는 이벤트를 발생시킨 스레드에서 실행되고, run-ended 는 명령 안의 메인 스레드에서
            // 발생한다. 기록 종료는 응답을 기다리므로 여기서 기다리면 창 그리기가 멈춘다.
            app.listen("run-ended", move |_| {
                if INTO.lock().unwrap().1 {
                    say("observe: drag presented");
                    return;
                }
                let ended = into();
                wrote();
                let Some(into) = ended else {
                    return;
                };
                std::thread::spawn(move || {
                    say(&stopped(&into));
                });
            });
            Ok(())
        })
        .build()
}

/// main 창을 최대화한다.
///
/// 창 버튼 위치는 창 크기로 계산하므로 검사는 창 크기를 바꾸고 다시 측정한다.
fn zoom(app: AppHandle) {
    if !given("zoom") {
        return;
    }
    for (label, window) in app.windows() {
        if label != "main" {
            continue;
        }
        let _ = window.maximize();
    }
}

/// 창 콘텐츠를 요청한 크기로 바꾸고 적용된 크기를 보고한다.
///
/// 최대화 크기는 화면의 사용 가능 영역이고, 그 영역은 애플리케이션 시작 직후 1 포인트 바뀐다.
/// 두 애플리케이션이 그 변경 전후에 최대화하면 창 크기가 달라진다. 크기를 지정하면 이 경쟁의
/// 영향을 받지 않는다.
///
/// 요청한 크기를 적용하지 않는 경우를 확인할 수 있도록 적용된 크기를 보고한다.
fn resize(app: AppHandle) {
    let Some(spec) = flag("resize") else {
        return;
    };
    let asked = size_of(&spec);
    let Some((w, h)) = asked else {
        say(&format!("observe: --resize takes width,height, got {spec:?}"));
        return;
    };
    set_size(&app, w, h);
}

/// 페이지에 모든 호스트 호출과 응답의 기록을 요청한다.
///
/// 기록기는 두 애플리케이션이 실행하는 페이지에 있으므로 두 애플리케이션의 기록 형식이 같다.
fn transcribe(app: AppHandle) {
    if !given("transcript") {
        return;
    }
    let _ = emit_main(&app, "observe-record", ());
}

/// 이 앱의 창 번호를 한 줄로 기록한다.
///
/// 창은 메인 스레드에서만 다루므로 번호를 메인 스레드에서 읽는다.
fn report(app: AppHandle) {
    let ask = app.clone();
    let _ = app.run_on_main_thread(move || match numbers(&ask) {
        Ok(found) if !found.is_empty() => {
            let list: Vec<String> = found.iter().map(|n| n.to_string()).collect();
            say(&format!("observe: windows {}", list.join(" ")));
        }
        Ok(_) => {}
        Err(error) => say(&format!("observe: windows error: {error}")),
    });
}

/// main 창의 번호와 main 창에 붙은 창의 번호를 반환한다. main 창이 없으면 빈 목록이다.
/// 메인 스레드에서 호출한다.
fn numbers(app: &AppHandle) -> Result<Vec<isize>, String> {
    // 이 애플리케이션은 창 하나에 웹뷰 여러 개를 둔다. 그런 창은 webview_windows 가 아니라
    // windows 에 있다.
    let Some((_, window)) = app.windows().into_iter().find(|(label, _)| label == "main") else {
        return Ok(Vec::new());
    };
    platform::current()?.window_numbers(&window)
}

/// 프레임을 저장할 디렉터리가 요청되었으면 반환한다.
fn capturing() -> Option<String> {
    flag("capture")
}

/// 이 창의 기록을 준비한다. 창 서버 목록 조회가 느리므로 여기서 한 번만 조회한다.
///
/// 조회는 응답을 기다린다. 응답에 메인 큐가 필요할 때 메인 스레드에서 기다리면 서로를 기다리므로,
/// 메인 스레드에서는 창 번호만 읽고 조회는 별도 스레드에서 실행한다.
fn open(app: AppHandle) {
    let (tell, hear) = std::sync::mpsc::channel();
    let ask = app.clone();
    if app
        .run_on_main_thread(move || {
            let _ = tell.send(numbers(&ask).map(|found| found.first().copied()));
        })
        .is_err()
    {
        return;
    }
    // 별도 스레드에서 실행한다. 이 함수는 수신기에서 호출되고, 수신기는 이벤트를 발생시킨 스레드
    // (메인 스레드일 수 있다)에서 실행된다.
    std::thread::spawn(move || {
        let opened = match hear.recv() {
            Ok(Ok(Some(first))) => platform::current().and_then(|platform| platform.capture_open(first)),
            Ok(Ok(None)) | Err(_) => Ok(()),
            Ok(Err(error)) => Err(error),
        };
        if let Err(error) = opened {
            say(&format!("observe: capture error: {error}"));
        }
    });
}

/// CSS 선택자로 지정한 페이지 요소 하나를 누른다.
///
/// 경계선은 표면 위에 있으므로 드래그는 좌표로 전달한다. 페이지 크롬의 버튼은 문서 요소이므로
/// 문서만 누를 수 있고, 페이지의 관찰 모듈이 누른다.
fn click(app: AppHandle) {
    let Some(spec) = flag("click") else {
        return;
    };
    let Some((wait, selector)) = spec.split_once(',') else {
        say(&format!("observe: --click takes ms,selector, got {spec:?}"));
        return;
    };
    let Ok(after) = wait.trim().parse::<u64>() else {
        say(&format!("observe: --click wait {wait:?} is not a number"));
        return;
    };
    let selector = selector.to_string();
    std::thread::spawn(move || {
        // --drive 와 같이 지정한 시간을 기다린다. 누를 요소가 그려진 시점을 알리는 이벤트가 없다.
        std::thread::sleep(Duration::from_millis(after));
        let _ = emit_main(&app, "observe-click", selector);
    });
}
/// 페이지에 경계선 하나의 드래그를 요청한다.
///
/// 드래그는 페이지가 실행한다. 두 애플리케이션이 같은 페이지를 실행하므로 드래그 대상과 방법은
/// 한 곳에 정의한다.
fn drive(app: AppHandle) {
    let Some(spec) = flag("drive") else {
        return;
    };
    let plan = match Plan::parse(&spec) {
        Ok(plan) => plan,
        Err(why) => {
            say(&format!("observe: --drive {why}"));
            return;
        }
    };
    std::thread::spawn(move || {
        // 이 앱이 열지 않은 페이지는 그려진 시점을 알리는 이벤트가 없으므로 요청한 시간을 기다린다.
        std::thread::sleep(plan.wait);
        start_drag(&app, plan);
    });
}

/// 창을 만들 때의 콘텐츠 크기. reset 은 이 크기로 되돌린다.
const START: (f64, f64) = (1200.0, 760.0);

/// "width,height" 를 읽는다.
fn size_of(spec: &str) -> Option<(f64, f64)> {
    spec.split_once(',')
        .and_then(|(w, h)| Some((w.trim().parse::<f64>().ok()?, h.trim().parse::<f64>().ok()?)))
        .filter(|(w, h)| *w > 0.0 && *h > 0.0)
}

/// 창 콘텐츠 크기를 바꾸고 적용된 크기를 보고한다.
///
/// 보고 수신기는 한 번만 등록한다. 명령마다 등록하면 변경 하나에 여러 줄이 기록된다.
fn set_size(app: &AppHandle, w: f64, h: f64) {
    let Some(window) = app.get_window("main") else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    if !SIZED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        // 적용된 크기는 창 이벤트로 확인한다. 설정 직후 읽으면 일부 애플리케이션은 아직 적용되지 않은
        // 크기를 반환한다.
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::Resized(got) = event {
                let got = got.to_logical::<f64>(scale);
                say(&format!("observe: sized {}x{}", got.width, got.height));
            }
        });
    }
    let _ = window.set_size(tauri::LogicalSize::new(w, h));
}

/// 창 크기 보고 수신기를 등록했는지 나타낸다.
static SIZED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 드래그 한 단계의 간격. 페이지의 observe.js 도 같은 값을 사용한다.
const FRAME: Duration = Duration::from_millis(16);

/// 드래그를 요청하고 각 단계의 시점을 보낸다.
///
/// 드래그 내용은 페이지가 갖고 각 단계의 시점은 이 함수가 정한다. 앞에 있지 않은 창의 문서는
/// 숨김 상태로 처리되어 타이머가 1 초 가까이 지연되므로, 페이지가 단계를 직접 세면 요청보다
/// 느리게 드래그한다. 이 함수의 시계는 창 위치와 관계없이 지연되지 않는다.
///
/// 보내는 단계 수는 페이지가 사용하는 단계 수와 같다.
fn start_drag(app: &AppHandle, plan: Plan) {
    let steps = plan.steps() * 2 * plan.times;
    let _ = emit_main(&app, "observe-drag", &plan);
    let app = app.clone();
    std::thread::spawn(move || {
        // 각 단계는 이전 단계가 끝난 시점이 아니라 시작 시점 기준의 예정 시각에 실행한다. 한 프레임씩
        // 잠들면 각 단계의 실행 시간이 이후 단계에 누적되어 드래그가 요청보다 느려진다.
        let began = std::time::Instant::now();
        for step in 1..=steps {
            let due = FRAME * step as u32;
            if let Some(left) = due.checked_sub(began.elapsed()) {
                std::thread::sleep(left);
            }
            let _ = emit_main(&app, "observe-tick", ());
        }
    });
}

/// 경계선 하나를 왕복으로 흔드는 드래그. 누른 점을 밖으로 옮겼다가 되돌리므로 경계선은 시작
/// 위치에서 끝나고 매 왕복이 같은 픽셀을 지난다.
#[derive(Serialize)]
struct Plan {
    #[serde(skip)]
    wait: Duration,
    axis: String,
    line: i64,
    dx: f64,
    dy: f64,
    ms: u64,
    times: usize,
}

impl Plan {
    /// 한 번 이동하는 단계 수. 페이지와 같은 방식으로 계산한다.
    fn steps(&self) -> usize {
        let n = (self.ms as f64 / FRAME.as_millis() as f64).round() as usize;
        n.max(1)
    }

    /// "wait,axis,line,dx,dy,ms,times" 를 읽는다. 페이지가 그려지도록 wait ms 를 기다리고, 경계선
    /// line 을 눌러 ms 동안 dx,dy 만큼 밖으로 옮겼다가 되돌리는 동작을 times 번 반복한다.
    fn parse(spec: &str) -> Result<Plan, String> {
        let parts: Vec<&str> = spec.split(',').collect();
        if parts.len() != 7 {
            return Err(format!("wants wait,axis,line,dx,dy,ms,times, got {spec:?}"));
        }
        if parts[1] != "x" && parts[1] != "y" {
            return Err(format!("axis is x or y, got {:?}", parts[1]));
        }
        let number = |at: usize| -> Result<f64, String> {
            parts[at]
                .trim()
                .parse()
                .map_err(|_| format!("{:?} is not a number", parts[at]))
        };
        Ok(Plan {
            wait: Duration::from_millis(number(0)? as u64),
            axis: parts[1].to_string(),
            line: number(2)? as i64,
            dx: number(3)?,
            dy: number(4)?,
            ms: number(5)? as u64,
            times: number(6)? as usize,
        })
    }
}

fn emit_main<S: serde::Serialize + Clone>(app: &AppHandle, event: &str, payload: S) -> tauri::Result<()> {
    app.emit_to(tauri::EventTarget::webview("main"), event, payload)
}
