# 네이티브 호스트와, 그것이 있어야 할 곳

초안. [`NATIVE-HOST.md`](NATIVE-HOST.md) 의 한국어 번역이며 독자적인 규칙을 정의하지 않는다.

`examples/wailsv3` 와 `examples/tauriv2` 는 같은 계약 세 개를 각각 구현한다. 이
문서는 그 계약이 무엇이고, 이미 공유하는 것이 무엇이며, Wails 서비스와 Tauri
플러그인으로 내려면 무엇이 필요한지 적는다.

## 페이지가 요구하는 것

인터페이스 세 개. 모두 `host.js` 가 `window` 에 설치하고, 브라우저에서는 없다.

`hostSurfaces` — 표면마다 웹뷰 하나를, 페이지가 선언한 프레임에 배치한다.

    kinds                호스트가 그리는 플러그인 종류. 페이지는 그 종류를
                         모사하지 않는다
    report(line)         애플리케이션 로그에 한 줄
    theme(values)        호스트가 서비스하는 페이지에 줄 토큰 값
    place(record)        커밋마다 표면의 id, url, 프레임, 표시 여부, 흐림

`hostShapes` — 표면 위의 사각형. 레이어를 가진 뷰가 그린다.

    set(id, rect, style) 프레임, 모서리 반경, 선 두께, 채움과 선의 색
    clear(id)

`hostOverlay` — `[data-native-modal]` 요소 하나. 표면 위의 웹뷰가 그린다.

    show(el, rect, onPick)   요소의 클래스, 마크업, 스타일시트
    place(rect)              열려 있는 동안의 새 프레임
    update(el)               열려 있는 동안의 새 내용
    hide()

돌아오는 것은 둘이다. `surface-pressed` 는 입력이 도달한 표면을 알리고,
`overlay-pick` 은 모달의 `(key, value)` 하나를 나른다.

## 이미 하나인 것

`examples/browser/host.js` 는 파일 하나다. 페이로드를 만들고 색을 합성하고 직전과
같은 요청을 거르고 인터페이스 셋을 설치한다. 애플리케이션을 참조하지 않는다.

`examples/browser/framework/` 가 런타임의 차이를 갖는다: 호출하는 법, 이벤트를
받는 법, 이 호스트가 서비스하는 페이지의 주소. 런타임마다 파일 하나, export 넷.

`terminal.html` 과 `overlay.html` 은 각각 한 벌이고 `framework/` 에게 어느 런타임인지
묻는다.

## 중복된 것

호스트 둘. 같은 플랫폼에 같은 동작을 각각 구현한다.

| 동작 | Wails, Go + cgo | Tauri, Rust + objc2 |
| --- | --- | --- |
| 표면 생성 | `surfaceCreate`, content view 의 WKWebView | `window.add_child` |
| 이동·크기·숨김 | `surfaceSetFrame`, `surfaceResize`, `surfaceSetHidden` | `set_position`, `set_size`, `hide` |
| 흐리게 | `surfaceSetAlpha` | `native::alpha` |
| 모서리 둥글게 | `surfaceSetCornerRadius` | `native::corners` |
| 눌린 뷰 판별 | `surfaceWatchMouse` + `hitTest:` | `native::watch_mouse` |
| 표면 위의 도형 | `shapeCreate`, `shapeSetStyle` | `native::shape_*` |
| 로컬 페이지 서비스 | `serve.go`, 루프백 서버 | 앱 자체 스킴 |
| 셸 실행 | `shell.go` | `shell.rs` |

양쪽 모두 macOS 만 구현되어 있다. Windows 와 Linux 는 `native_other.go` 와
`native.rs` 에 이름으로만 있다.

## 플러그인이 된다면

**Wails.** 지금의 `main.Surfaces` 처럼 등록하는 서비스. `SyncSurfaces`,
`SetShape`, `ClearShape`, `OverlayShow`, `OverlayPlace`, `OverlayUpdate`,
`OverlayHide`, `SetTheme`, `Report` 를 내보내고 `surface-pressed` 와
`overlay-pick` 을 발행한다. `native_darwin.go` 의 cgo 와 `serve.go` 의 루프백
서버가 함께 간다.

**Tauri.** 플러그인 크레이트 `tauri-plugin-native-surfaces`. 커맨드는 같은 목록의
스네이크 케이스다. Tauri 플러그인은 자기 JavaScript 를 함께 배포하므로 `host.js`
와 `framework/tauriv2.js` 가 페이지 옆이 아니라 플러그인 안에 들어간다.

**페이지.** `host.js` 와 `framework/` 는 같은 계약의 JavaScript 쪽이다. 두 플러그인이
각자 사본을 배포하면 계약이 둘이 아니라 셋이 된다. 대안은 두 플러그인이 함께
의존하는 npm 패키지 하나다.

## 있어야 할 곳

이 저장소가 아니다. `soksak` 은 배치 라이브러리다. 사각형을 계산하고 요소를
배치할 뿐 DOM 정책도, 애플리케이션 상태도, 네이티브 코드도 갖지 않는다. 네이티브
합성은 예제의 호스트일 뿐 다른 제품이다.

별도 저장소가 플러그인 둘과 JavaScript 패키지를 갖고, 이 저장소의 예제가 그것에
의존한다. 그 저장소가 생기기 전까지는 실제로 돌려 보는 이곳에 둔다.

## 정하지 않은 것

- 페이지의 인터페이스 셋을 그대로 셋으로 둘지, 하나의 네임스페이스로 합칠지.
- 셸이 같은 플러그인에 속하는지. 셸은 터미널의 기능이지 합성의 기능이 아니고,
  터미널 표면이 필요로 해서 여기 있을 뿐이다.
- Windows 와 Linux 가 무엇을 하는지. 두 네이티브 파일에 이름만 있고 구현이 없으므로
  설계된 플랫폼은 macOS 뿐이다.
