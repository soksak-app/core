# 네이티브 호스트와, 그것이 있어야 할 곳

초안. [`NATIVE-HOST.md`](NATIVE-HOST.md) 의 한국어 번역이다.

`examples/wailsv3` 와 `examples/tauriv2` 는 같은 계약 세 개를 각각 구현한다. 이
문서는 그 계약이 무엇이고, 이미 공유하는 것이 무엇이며, Wails 서비스와 Tauri
플러그인으로 내려면 무엇이 필요한지 적는다.

## 페이지가 필요로 하는 것

인터페이스 네 개. 모두 `host.js` 가 export 한다. 브라우저에서는 `surfaces` 와
`shapes` 와 `overlay` 가 있고 아무 일도 하지 않으며, `chrome` 은 null 이고
`native` 가 false 다.

`surfaces` — 표면마다 웹뷰 하나를, 페이지가 선언한 프레임에 배치한다.

    kinds                호스트가 그리는 플러그인 종류. 페이지는 그 종류를
                         모사하지 않는다
    report(line)         애플리케이션 로그에 한 줄
    theme(values)        호스트가 서비스하는 페이지에 줄 토큰 값
    place(record)        커밋마다 표면의 id, url, 프레임, 표시 여부, 흐림

`shapes` — 표면 위의 사각형. 레이어를 가진 뷰가 그린다.

    set(id, rect, style) 프레임, 모서리 반경, 선 두께, 채움과 선의 색
    clear(id)

`chrome` — 창 자체. 두 창 모두 자기 프레임을 쓰고 제목 표시줄이 투명하며 콘텐츠가
그 아래까지 차지하므로, 플랫폼이 그리는 단추 세 개가 페이지 위에 놓인다.

    draggable(el)            이 요소를 끌면 창이 움직인다
    controls()               그 단추가 차지하는 영역. 페이지 좌표다

`overlay` — `[data-native-modal]` 요소 하나. 표면 위의 웹뷰가 그린다.

    show(el, rect, onPick)   요소의 클래스, 마크업, 스타일시트
    place(el, rect)          열려 있는 동안의 새 프레임
    update(el)               열려 있는 동안의 새 내용
    hide(el)

돌아오는 이벤트는 둘이다. `host.js` 가 받아서 페이지가 등록한 함수에 전달한다.
`onSurfaceInput({press, input})` 은 입력이 도달한 표면과 끌기의 한 단계를 페이지
좌표로 받고, 모달의 `(key, value)` 는 `overlay.show` 에 전달한 함수가 받는다.

## 이미 하나인 것

`examples/browser/host.js` 는 파일 하나다. 페이로드를 만들고 색을 합성하고 직전과
같은 요청을 거르고 인터페이스 넷을 설치한다. 애플리케이션을 참조하지 않는다.

`examples/browser/framework/` 가 런타임의 차이를 갖는다: 호출하는 법, 이벤트를
받는 법, 이 호스트가 서비스하는 페이지의 주소. 런타임마다 파일 하나, export 넷.

`terminal.html` 과 `overlay.html` 은 각각 한 벌이고 `framework/` 에게 어느 런타임인지
묻는다.

## 중복된 것

호스트 둘. 같은 플랫폼에 같은 동작을 각각 구현한다.

| 동작 | Wails, Go | Tauri, Rust + objc2 |
| --- | --- | --- |
| 표면 생성 | `window.AddWebview` | `window.add_child` |
| 이동·크기·숨김 | `SetBounds`, `SetHidden` | `set_position`, `set_size`, `hide` |
| 흐리게 | `surfaceSetAlpha` | `native::alpha` |
| 모달의 창 | `window.Attach` | `WebviewWindowBuilder` + `parent_raw` |
| 모서리 둥글게 | `Mac.CornerRadius` | `native::corners` |
| 눌린 뷰 판별 | `surfaceWatchMouse` + `hitTest:` | `native::watch_mouse` |
| 표면 위의 도형 | `shapeCreate`, `shapeSetStyle` | `native::shape_*` |
| 웹뷰가 흰 배경을 칠하지 않게 | `WebviewOptions.Transparent` | wry 가 모든 웹뷰에 건다 |
| 창을 녹화 | `capture_darwin.go` | `capture.m` |
| 로컬 페이지 서비스 | 앱 자체 스킴 | 앱 자체 스킴 |
| 셸 실행 | `shell.go` | `shell.rs` |

양쪽 모두 macOS 만 구현되어 있다. Windows 와 Linux 는 `native_other.go` 와
`native.rs` 에 이름으로만 있다.

그중 한 줄은 공개 인터페이스가 아니다. 웹뷰는 레이아웃한 영역만 렌더링하고 나머지는
불투명한 흰색으로 채운다. 이를 끄는 공개 인터페이스는 없다. 공개된
`underPageBackgroundColor` 는 페이지 끝 너머에만 적용된다.

두 프레임워크 모두 그 키를 이름으로 설정하고, 키가 아니라 의도를 노출한다. wry 는
투명한 웹뷰로, Wails 는 창에 추가한 웹뷰의 `WebviewOptions.Transparent` 로 노출한다.
Wails 쪽은 [포크](https://github.com/min-median-max/wails/tree/webview-in-window)다.
Wails v3 는 창 하나에 웹뷰 하나를 만들고 추가하는 메서드가 없어서, 이 예제의 표면은
예제가 직접 만든 웹뷰였다. macOS 전용이고, 애플리케이션의 자산 서버 밖이며, 자체
메시지 채널을 사용했다.

포크는 창의 configuration 으로 웹뷰를 만드는 `AddWebview` 와, 다른 창의 내용 위
한 점에 창을 배치하는 `Attach` 를 추가한다. 이로써 표면과 모달은 애플리케이션의 자체
스킴에서 로드되고, 그 런타임을 import 하고, 그 이벤트를 받는다. 이 예제에는 웹뷰를
만드는 코드가 없다. 창의 단추를 배치하는 `Mac.TrafficLightPosition` 도 추가하고,
창의 내용 크기를 고친다. Wails v3 는 내용 사각형을 그 안의 웹뷰보다 1포인트 작게
만들었고, 그래서 페이지는 모든 크기에서 창보다 1포인트 큰 판을 받았으며 크기가
바뀐 뒤 두 호스트의 배치가 달라졌다.

## 플러그인이 된다면

**Wails.** 지금의 `main.Surfaces` 처럼 등록하는 서비스. 메인 페이지에는
`SyncSurfaces`, `SetShape`, `ClearShape`, `OverlayShow`, `OverlayPlace`,
`OverlayUpdate`, `OverlayHide`, `SetTheme`, `Report` 를, 표면과 모달의 페이지에는
`Theme`, `ShellOpen`, `ShellWrite`, `ModalContent`, `ModalReady`, `OverlayPick` 을
내보내고, `surface-pressed`, `surface-input`, `overlay-pick`, `theme`,
`shell-output`, `modal-content` 을 발행한다. `native_darwin.go` 의 도형이 함께
간다. 나머지는 없다 — 웹뷰는 프레임워크가 만든다.

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

- 페이지의 인터페이스 넷을 그대로 넷으로 둘지, 하나의 네임스페이스로 합칠지.
- 셸이 같은 플러그인에 속하는지. 셸은 터미널의 기능이지 합성의 기능이 아니고,
  터미널 표면이 필요로 해서 여기 있을 뿐이다.
- Windows 와 Linux 가 무엇을 하는지. 두 네이티브 파일에 이름만 있고 구현이 없으므로
  설계된 플랫폼은 macOS 뿐이다.
