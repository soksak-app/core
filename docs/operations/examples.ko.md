# 애플리케이션 빌드와 검증

[English](examples.md)

저장소 루트에서 명령을 실행한다. `package.json`의 패키지 관리자 버전, `go.work`와 `packages/host/wailsv3/go.mod`와 호환되는 Go 도구 체인, 루트 `Cargo.toml` 워크스페이스와 호환되는 Rust 도구 체인을 사용한다. [네이티브 호스트 명세](../spec/hosts.ko.md)가 호스트 패키지, 애플리케이션, 워크스페이스 파일을 설명한다. 현재 네이티브 검증은 macOS에서 Command Line Tools SDK를 사용한다. Tauri 진단 캡처는 현재 프로세스 전용 ScreenCaptureKit 조회를 사용하므로 화면 기록 권한이 필요하지 않다.

## 네이티브 업데이트

네이티브 소스·프레임워크·SDK·OS를 업데이트하기 전에 [비공개 네이티브 API 목록](private-native-apis.ko.md)을 읽는다. 업데이트 후 네이티브 동작이 실패하면 이 문서를 가장 먼저 검토한다. 현재 호출, 필요성, 실패 징후, 필수 검증을 기록한다.

## 빌드

```sh
make prepare
pnpm build
make wailsv3-build tauriv2-build
```

`native/darwin`은 `native/darwin/build/`에 `libsoksak-darwin.a`와 `soksak-darwin.pc`를 생성한다. Makefile은 이 디렉터리를 `PKG_CONFIG_PATH`에 추가하고, Wails와 Tauri는 pkg-config로 헤더와 링크 옵션을 찾는다. 캡처 코드가 macOS 14.0에서 추가된 ScreenCaptureKit API를 사용하므로 두 네이티브 애플리케이션의 최소 버전은 macOS 14.0이다. Makefile은 이 값을 Go에는 `CGO_CFLAGS`와 `-extldflags`로, Rust에는 `MACOSX_DEPLOYMENT_TARGET`으로 전달한다.

브라우저 애플리케이션은 `pnpm example`로 실행하고 `http://localhost:8749/index.html`을 연다. 모든 패키지 테스트는 `pnpm test`로 실행한다.

빌드 대상은 `native/darwin`, 워크벤치, 사이드카를 빌드한 뒤 각 애플리케이션에서 `soksak-stage src/frontend --executables <실행 파일 디렉터리>`를 실행한다. 이 도구는 워크벤치, 배치 라이브러리, 플러그인 API, `environment.json`에 적힌 플러그인, 애플리케이션의 `runtime/` 디렉터리를 생성된 `apps/<app>/src/frontend/`에 배치하고, 사이드카 실행 파일을 실행 파일 디렉터리에 복사한다. 디버그 대상은 `--diagnostics`를 더해 페이지 진단 모듈(`diagnostics.js`)을 배치하고, 릴리스 대상은 빈 모듈을 배치한다. 두 실행 파일 모두 빌드 시 프런트엔드를 포함한다. 실행 중인 프로세스에는 새 프런트엔드가 적용되지 않으므로 빌드 후 해당 앱을 다시 실행한다.

디버그 실행 파일은 `target/debug/soksak-wailsv3.app`와 `target/debug/soksak-tauriv2.app`다. 릴리스 빌드는 `make wailsv3-build-release tauriv2-build-release`를 사용하며 `target/release/soksak-wailsv3`와 `target/release/soksak-tauriv2`를 만든다. 두 release 실행 파일에는 기호 테이블이 없다. Wails 빌드는 `-s -w`로 링크하고, 루트 `Cargo.toml`의 release 프로필은 `strip = true`다. 그래서 `make release-check`는 기호를 벗겨도 남는 문자열(진단 메서드 이름과 녹화 클래스 이름 `SPCapture`)로 진단 코드를 찾는다. `make examples-size`는 두 프로파일을 빌드하고 크기를 출력한다.

## 테스트 동등성

`make parity-check`로 구조 목록 게이트를 실행한다. 언어별 고정 루트 없이 Git에 보이는 JS/TS·Rust·Go·Objective-C·네이티브 헤더·HTML/CSS·셸 스크립트·계약 선언·빌드 매니페스트를 발견한다. 생성된 라이브러리 출력·Tauri 스키마는 명시적 제외 사유를 갖고 소스/출력 일치는 별도 빌드 검사로 유지한다. 연결 없는 구현·테스트, 빈 패턴, 중복 소유는 실패한다. 테스트 공유를 이유로 구현 중복 소유를 허용하지 않는다.

`make host-contract-check`는 두 호스트의 테스트를 실행해 [호스트 계약 사례](../spec/host-contract.ko.md)와 비교하며, `make native-test`가 이를 실행하며, 먼저 `make rust-format-check`를 실행한다. 이 검사는 루트나 `sidecars` 워크스페이스의 Rust 패키지가 `rustfmt` 형식이 아니면 실패한다. 현재 목록은 lane 63개, 구현 파일 322개, 테스트 파일 261개다. 현재 연결 목록은 미완료다. 구조 검사가 통과해도 동작 동등성은 입증하지 않는다. [검증 계약](../spec/verification.ko.md)의 이름 있는 동작 연결, 언어별 실제 실행, 일치하는 빌드의 증거가 필요하다. 통과하려고 관련 없는 glob을 넓히거나 발견한 파일을 제외하지 않는다.

`pnpm test`는 패키지 검사 전에 감사·체크리스트·명령 감독 자체 검사를 실행한다. Rust 터미널 패키지 두 개는 실제 Cargo 검사를 호출한다. 패키지 명령 검사는 Cargo를 실패 fixture로 교체해 호출·실패 전달을 검증하며 엔진 동작 검사로 세지 않는다.

시간을 제한한 명령 실행:

```sh
node scripts/test-command.mjs --id inventory --timeout-ms 10000 -- node scripts/check-test-parity.mjs
```

감독기는 stdout/stderr를 전달하고 경과 밀리초와 함께 JSON 시작/진행/종료 이벤트를 출력한다. 비정상 종료·실행 파일 없음·시간 초과·취소·정리 오류를 보고한다. 정리 확인의 권한 거부는 프로세스 부재 증거가 아니다. 이 도구는 명령 프로세스 그룹 하나를 감독한다. 언어 어댑터의 케이스 발견·케이스별 실행·0개/생략 거부·소스/실행 파일 증거는 여전히 필요하다. 독립적으로 실행 중인 검사 앱은 닫지 않는다.

네 언어 어댑터 게이트는 `make language-test`로 실행한다. 선언된 JS/TS·Rust·Go·Objective-C 케이스별 기대·실제 테스트 수와 증거 해시를 출력한다. 재시도 사이에 실패를 보존하려면 저장소 밖 파일을 지정한다: `node scripts/language-test-adapters.mjs --evidence-file "$TMPDIR/soksak-language-evidence.json" scripts/language-test-cases.json`. 다음 실행은 소스·테스트·의존성·dirty 작업 트리·빌드 옵션·프로세스 snapshot이 같을 때만 시도를 추가하고, 다르면 오래된 증거로 실패한다.

`make node-repeat FILE=<test> NAME=<pattern> COUNT=<n>`은 회차 번호와 자식 검사의 stdout/stderr를 실행 중 출력하고 첫 실패에서 중단한다. 출력 전달은 자식의 실패 종료 상태를 보존해야 하며 일치하는 성공 검사가 없는 실행도 실패한다.

## 창 검사

각각 다른 터미널에서, 하네스가 읽는 설정 디렉터리(Node.js의 `os.tmpdir()`, macOS에서는 `$TMPDIR`)로 앱을 한 번씩 실행한다.

```sh
./target/debug/soksak-wailsv3.app/Contents/MacOS/soksak-wailsv3 --config-dir "$TMPDIR/soksak-check-wailsv3"
./target/debug/soksak-tauriv2.app/Contents/MacOS/soksak-tauriv2 --config-dir "$TMPDIR/soksak-check-tauriv2"
```

디스플레이를 켜고 두 창이 렌더링 가능한 상태에서 실행한다.

```sh
pnpm -F @soksak/e2e run verify
```

하네스(`e2e/app.mjs`)는 `@soksak/client`로 `<config-dir>/endpoint.json`을 읽어 연결한다([로컬 엔드포인트](../spec/endpoint.ko.md)). `application`이 기대한 호스트인지, `executable`이 이 체크아웃의 실행 파일인지 확인한다. 임시 디렉터리의 잠금 파일 `soksak-check.lock`이 동시 실행을 막으며, 두 번째 실행은 측정하지 않고 실패한다. 검사는 앱을 시작하지 않는다. 상태 조회와 변경은 선언된 항목([노출](../spec/exposure.ko.md))만 사용한다. status 값, 명령, DOM 항목, 호스트 항목, 디버그 빌드의 진단 메서드다. 대기는 `status.watch` 알림과 `host.window.presented`를 사용하며 하네스에는 폴링 반복이나 고정 지연이 없다. 실제 입력 검사는 애플리케이션을 활성화하지 않는 `input.pointer`와 `input.key`를 사용한다. `input.key`는 명시한 text가 없는 모든 키를 이름 있는 키까지 macOS 키 코드로 만들므로 AppKit과 입력기가 하드웨어 입력처럼 문자를 계산한다. 따라서 라틴 문자를 입력하는 검사는 `session.selectInputSource`로 ABC 자판을 선택하며, 이 함수는 검사가 끝나면 이전 입력 소스를 되돌린다. `make e2e-check`는 `e2e/`의 타이머, `eval`, `Function` 생성자, 제거된 네이티브 프로브, 제거된 TCP 제어 포트를 거부한다. 실행 중인 앱이 없으면 실패하고, 바이너리가 없으면 건너뜀으로 표시한다. 호스트 검사를 건너뛴 실행으로 두 호스트를 검증했다고 기록하지 않는다.

`make examples-verify`는 `make e2e-check`, `make exposure-check`, 문서 검사, 창 검사를 실행한다. 검증 전에 두 앱을 빌드하고 다시 실행한다. 실행 파일을 다시 빌드해도 이미 실행 중인 프로세스는 교체되지 않는다. 연결이 끊겨도 세션은 유지되므로([터미널 런타임](../spec/terminal-runtime.ko.md)) 검사 설정의 터미널 서비스는 정상 종료 없이 끝난 앱의 세션을 계속 가진다. 터미널 프로세스 검사는 그 서비스의 셸을 세므로, 앱을 강제로 끝낸 뒤에는 검사 전에 `--service-dir`가 그 설정 디렉터리에 있는 `soksak-vt-alacritty` 프로세스를 멈춘다.

일회용 설정 디렉터리를 사용한다. 하네스는 해당 디렉터리의 프로젝트 목록과 공통 설정을 교체하고 검사 전용 설정을 포함한 `test-project` 폴더를 생성한다. 프로젝트 창 검사는 추가 임시 프로젝트 폴더를 생성하고 일반 파일과 창 API를 실행한다. `fresh`는 `host.window.move`로 Wails 검사 창을 주 화면 작업 영역의 왼쪽 위에, Tauri 검사 창을 오른쪽 위에 두므로 모든 검사가 같은 창 자리에서 시작한다(`placement.test.mjs`). 이동은 두 애플리케이션을 활성화하지 않는다. 화면이 두 창 폭의 합보다 좁으면 가운데가 겹친다. 다른 애플리케이션의 창은 여전히 검사 창을 가릴 수 있고, 끌기 검사가 이를 알린다.

하네스는 검사마다 일반 페이스트보드의 모든 항목 형식을 저장하고, 검사의 다른 정리가 끝난 뒤 되돌려 쓰며, 그 뒤 페이스트보드가 검사 전과 다르면 검사를 실패시킨다. 또한 다른 창을 닫고 1200×760 시작 크기로 되돌린 뒤 `diagnostics.fixture`를 실행하고, `host.window.reload`로 메인 문서를 다시 로드하며, 보이는 모든 셸 표면이 테마를 적용한 상태로 `core.surface.document`를 등록할 때까지 기다린 뒤 표시 완료를 확인한다. `diagnostics.drag`에서는 호스트가 16ms 간격으로 드래그 단계를 보낸다. `capture: true`이면 호스트가 첫 단계 전부터 제스처가 표시될 때까지 창을 녹화하고, 하네스가 `host.window.presented`의 `displayed` 시각을 넘겨 `diagnostics.capture.stop`으로 녹화를 멈추므로 녹화에 표시된 화면이 포함된다. `diagnostics.capture.start`는 다른 요청의 앞뒤를 녹화한다. `display: true`이면 창이 있는 디스플레이에서 이 앱의 창을 녹화하므로, 창이 전체 화면 Space로 옮겨져도 녹화가 이어진다. 프레임 파일은 BGRA 픽셀 앞에 버퍼 안에서 창이 차지한 사각형, 콘텐츠 배율, 백킹 배율, 표시 시각을 담는다. 버퍼보다 큰 창은 줄여서 담긴다. 기록되지 않은 프레임이 있으면 녹화는 blank와 suspended 프레임 수를 알린다. 녹화는 프레임을 수신 처리기에서 복사하고 별도 큐에서 쓰므로, 디스크가 느려도 스트림이 프레임을 버리지 않는다. `diagnostics.capture.stop`은 `longestGap`을 반환하며, 프레임 사이 간격이 100ms를 넘는 끌기 녹화는 제스처 일부가 기록되지 않았으므로 실패한다. 요청 시간의 1/1.25배에서 1.25배 범위를 벗어난 드래그는 한 번 반복한 뒤 실패한다. 제스처 미완료, 프레임 부족, 측정 가능 프레임 부족은 검사 실패다.

녹화는 임시 파일이다. 각 검사는 통과 여부와 무관하게 끝날 때 프레임 디렉터리를 지운다. 실패 메시지는 측정값과 프레임 번호만 보고하며 하네스는 이미지를 쓰지 않는다.

카드 사이드바 제스처 검사는 기대 경계가 없는 모든 프레임을 거부한다. 오류는 프레임 번호·전체 개수, 캡처 기하·배율·시각, 표본 색상, 전체 축의 일치 경계 좌표와 초기·끌기·뗌의 표시 배치 타임라인과 녹화 시작·종료가 반환한 배치 트랜잭션의 시작·DOM 표시·네이티브 커밋 시각을 포함한다. 이 진단은 실패 프레임을 찾는 근거이며 완전한 제스처 인수를 대신하지 않는다.

네이티브 `surface_layout_test`는 앱 DOM 경계·네이티브 표면 컨테이너·지연된 투명 배경 클립 변경으로 열린 배치 트랜잭션의 정적 합성도 제어해 녹화한다. 완전한 픽셀 버퍼, 커밋 전 초기 경계와 최종 이동 경계를 검사하고 녹화를 정리한다. 유지된 합성이 유휴 상태이면 ScreenCaptureKit은 변경된 두 프레임만 반환할 수 있다. 이 대조 사례는 완전한 제스처의 프레임 간격 기준을 적용하거나 앱 제스처를 인수하지 않는다. 통과한 대조 사례로 앱 검사에서 재현된 경계 누락을 해결 처리하지 않는다. 프레임 displayTime은 윈도 서버 표시 시각이다([Apple 문서](https://developer.apple.com/documentation/screencapturekit/scstreamframeinfo/displaytime)). 트랜잭션 타임라인과 대조하되 상관관계를 원인으로 단정하지 않는다.


`outside.test.mjs`는 측정 가능한 모든 프레임에서 카드 밖 표면 픽셀 0, 왕복 두 번 전체, 셸 콘텐츠, DOM 입력 구분선, 카드 UI, 사이드바, 레일의 일정한 상대 좌표를 검사한다. `paint.test.mjs`는 렌더링되지 않은 영역을 검사하고, 드래그 동안의 모든 `core.verify` 결과에 실패 행이 없어야 한다. `footer.test.mjs`는 창이 있는 디스플레이의 배율에서 가로 디바이더 드래그 전체 프레임의 푸터 픽셀을 검사한다. `modal.test.mjs`는 순서, 투명도, 배경 블러(`core.window.document`, `core.surface.document`, `core.modal`), `host.hit`의 네이티브 입력 대상, 닫기, 네이티브 드래그 입력에 의한 이동, 크기 변경, 다시 로드 후 제거를 검사한다. `commands.test.mjs`는 카드, 탭, 메뉴, 설정, 라이브러리, 이름 변경 명령을 실행하고 각 결과를 status로 확인한다. `audit.test.mjs`는 모든 화면, 설정 구역과 범위, 메뉴, 이름 변경 상태, 보이는 플러그인 표면을 방문해 `core.page.audit`와 `core.surface.document`의 `unbound`가 비어 있기를 요구한다. `controls.test.mjs`는 최대화, 녹화, 이동, 크기 변경, 제목 변경 뒤의 `host.window` 버튼 좌표를 읽는다. 복원 전에 창이 화면의 사용 가능 영역 크기에 도달할 때까지 기다린다. Wails 는 AppKit 의 확대를 자체 애니메이션으로 대체하는데, 그 애니메이션이 진행 중일 때 복원을 요청하면 창이 최대화 상태로 남는다. `resize.test.mjs`는 `host.screens`의 `visible`까지 최대화하고 되돌리는 과정을 표시된 배치의 `displayed` 시각 뒤 100ms까지 녹화하고, 측정한 녹화를 바로 지우며, 마지막 프레임이 창 크기의 배치를 보여 주는지와 배치가 150ms 안에 창을 따라잡는지 확인하고, 배치가 창 프레임보다 늦은 프레임 수를 보고한다. 창 프레임과 WebKit 내용은 따로 표시되므로(WebKit/WebKit#72971, tauri-apps/tao#1207) 그 프레임은 측정값으로 남기고 실패로 보지 않는다. `hosts.test.mjs`는 `diagnostics.transcript` 줄의 최종 요청과 표시 좌표를 비교한다. 준비 식별자는 해당 창 내부 값이다.

`terminal.test.mjs`는 한 프로젝트에 터미널 표면을 세 개 이상 만들고 각 PTY에 표시할 표식을 보낸 뒤, 가로 디바이더를 빠르게 다섯 번 드래그한다. 녹화된 모든 프레임에서 입력 속도, 프레임 간격, 터미널 셀 크기 불변, 네이티브 영역의 완전한 덮음, 터미널 영역의 세로 흰색 줄 부재를 측정한다. 네이티브 `image_region_test`의 Red 검사는 표시 중인 그림 영역이 새 배치를 즉시 적용하는지도 요구한다. 표시된 스냅샷이 이전 배치에 네이티브 프레임을 남겨서는 안 된다.

`terminal-protocols.test.mjs`는 구현한 CSI와 OSC 시퀀스를 셸로 PTY에 쓰고, 그 결과를 화면 칸, `terminal.cursor`, `terminal.session`, `core.grid`, 페이스트보드, 또는 셸 `read`가 16진수로 찍은 응답에서 읽는다. 벤더 OSC 시퀀스는 `terminal.test.mjs`와 `e2e/real/terminal.test.mjs`에 각자의 검사가 있다.

`projects.test.mjs`는 공통·폴더 설정 파일, 일반 범위 탭 위치, 각 탭의 파일 저장, 분류 전환 후 범위 유지, 재정의 제거, 라이브러리 전역 범위 전용 설정과 외관 동작, 작업 화면 덮어쓰기 복원, 폴더 별칭, 탭·창 정책, 독립 모달, 네이티브 창 닫기·다시 열기 후 배치와 창 좌표 복원을 검사한다. `library.test.mjs`는 생성·선택 후 창 재사용, 디렉터리 작업 실패, 실제 열림 상태, 고정, 검색, 작업 화면 복귀, `host.dock`의 Dock 새 창을 검사한다. 미리보기 검사는 카드 순서와 분할 방향을 작업 화면과 비교하고 행 높이, 사이드바 폭, 간격의 균일성과 렌더러 좌표 미저장을 요구한다. `shell.test.mjs`는 네이티브 입력으로 셸 입력 칸을 누르고 한 줄을 입력한 뒤 `shell.output`에 줄이 나타날 때까지 기다리며, `echo` 출력 한 번, `pwd`의 프로젝트 디렉터리, 다른 셸 탭에 출력 없음을 요구한다. `browser.test.mjs`는 검사가 띄운 루프백 HTTP 서버의 문서를 사용한다. `browser.navigate`로 문서를 열고, 뒤로·앞으로 이동하고, `input.key`로 `browser.address`에 주소를 입력한다. 이어서 `host.hit`이 문서 영역을 보고하는지, 네이티브 `input.pointer` 스크롤이 앱 활성 상태를 바꾸지 않고 `browser.location.scroll`을 요청한 120픽셀만큼 바꾸는지, 표면이 이동하고 크기가 바뀐 뒤 `host.window`의 영역 프레임이 `browser.document`와 같은지 요구한다. 두 번째 브라우저 표면이 첫 표면의 문서를 받지 않는지, 탭을 닫으면 그 표면의 영역만 닫히는지도 검사한다. 설정 우선순위와 브라우저 저장소 트랜잭션은 `packages/workbench`와 `apps/browser`의 `pnpm test`가 검사한다. `make native-test`는 `make -C native/darwin test`, `packages/host/wailsv3`와 `sidecars/shell`의 `go test`, `cargo test -p soksak-host-tauriv2`를 실행하며, 호스트 검사는 파일 저장, 사이드카 중계, 엔드포인트, 문서 영역의 소유 확인과 정리를 다룬다. `webview_geometry_test`는 문서 영역의 배율도 검사하고, `document_view_test`는 영역의 이동, 상태 보고, 배치, 격리를 검사한다.

창의 백킹 픽셀 해상도로 녹화한다. 포인트 크기로 축소하면 0.5pt 선이 인접 픽셀과 섞여 정확한 색을 측정할 수 없다. 원시 프레임은 32비트 값 세 개(너비, 높이, 행 바이트 수)와 BGRA 픽셀 데이터로 구성된다. 누락되거나 일부만 기록된 녹화를 통과로 처리하지 않는다.

`geometry.test.mjs`는 창 크기 변경 후 네이티브 프레임(`host.window`), DOM 슬롯(`core.surfaces`), 표면 문서와 뷰포트 크기(`core.surface.document`)를 비교한다. 마지막 장치 픽셀의 소유자를 `host.hit`으로 확인하고 `input.pointer`로 누르고 뗀 뒤 `core.surface.input`의 신뢰 이벤트 좌표를 검사한다. 배율과 배율 변경은 연결된 디스플레이와 무관하게 `native/darwin/tests/webview_geometry_test.m`이 검사한다. 창의 백킹 배율을 2, 1, 다시 2로 바꾸며 반 포인트 표면 높이, 마지막 장치 픽셀 행의 문서 표시, 그 행의 네이티브 입력을 확인한다. 특정 디스플레이가 필요한 창 검사는 없다.

빠른 셸 검사는 완전한 왕복 4회와 셸의 어두운 콘텐츠에서 흰 픽셀 0개를 요구한다. 터미널 3개 검사는 누른 채 연속 완전한 왕복 5회, 모든 프레임에서 측정 가능한 터미널 영역 3개, DOM 테두리 침범 없음, 첫 글자의 크기와 픽셀 수 불변을 요구한다. 정지한 화면이나 요청한 왕복이 누락된 녹화는 실패다. 진단 녹화 1회는 최대 600프레임의 유한한 burst이며, 상한에 도달하면 프레임을 조용히 버리지 않고 불완전한 녹화 오류로 실패한다. 터미널 프로젝트 복귀 검사는 5회 왕복과 라이브러리 복귀를 3세트 반복하고, 매 복귀 직후 네이티브 래스터 3개를 검사한다. 라이브러리 검사는 표시 오류가 보고된 뒤 사라졌어도 실패한다. 합성 제스처는 [엔드포인트 계약](../spec/endpoint.ko.md#진단-빌드)의 페이지 기반 진단 경로를 사용하며 OS 버튼 상태를 검증하지 않는다.

실패한 앱을 보존하면서 새 빌드를 검사할 때는 별도의 임시 설정 폴더를 사용한다. ScreenCaptureKit은 실행 경로로 Tauri 캡처 클라이언트를 식별할 수 있다. 같은 경로의 여러 프로세스가 동시에 캡처하면 replayd가 연결을 취소하는 현상이 관측되었다. 바이트가 동일한 실행 파일과 사이드카를 별도 검사 디렉터리에 복사하고 해시를 확인한 뒤, 하네스 연결 전에 `APPS.tauriv2.binary`를 해당 경로로 명시한다. 실행 파일 검사를 끄거나 보존 중인 앱을 재시작하지 않는다. 각 검사가 끝나면 검사 녹화를 제거한다.

매 빌드 후 앱과 스테이징한 환경에 선언된 모든 사이드카를 복사하고 해시를 대조한다. 앱만 교체하면 같은 폴더의 사이드카 실행 파일은 이전 빌드로 남는다. 실행 중인 영속 서비스도 검사할 구현과 일치해야 하며, 명시적인 재연결·업데이트 검사에서만 이전 서비스를 유지한다. 빌드가 섞인 실행은 현재 구현을 검증할 수 없는 실행으로 기록하며 현재 코드의 통과나 실패로 판정하지 않는다.

터미널 3개 숨김 검사는 먼저 네이티브 스냅샷 3개의 표시를 기다린 다음 라이브러리 진입 후 각 네이티브 프레임과 스냅샷을 비교한다. 숨겨진 표면은 둘 다 유지해야 한다. 프로젝트 복귀 검사는 복귀 명령 직후 현재 래스터 3개를 모두 검사한다. 추가 표시 대기로 불완전한 복귀를 감추면 안 된다.

하네스는 메인 문서를 다시 읽기 전에 픽스처의 표시를 확인해야 한다. 시간 초과이면 준비를 실패시키고 그 상태를 유지하며, 재로드로 열린 트랜잭션을 해제해 통과시키지 않는다. 마지막 검증 상태에는 이전 오류가 남지 않을 수 있으므로 하네스는 표시 오류의 로그 알림도 수집한다.

프로젝트 복귀 프로세스 검사는 검사 설정의 터미널 서비스 엔드포인트와 OS 프로세스 목록을 읽는다. 해당 설정의 서비스가 정확히 하나이고 열린 터미널(숨겨진 탭 포함)마다 직접 자식 셸이 하나이며 PTY 헬퍼 자식과 좀비 자식이 없어야 한다. 라이브러리 복귀는 개수뿐 아니라 서비스와 셸 PID 자체를 보존해야 한다. 다른 실행 중인 앱은 설정 식별자로 제외한다. 파서 단위 검사는 서비스 수명주기를 검증하지 않으며 재빌드한 호스트 실행이 필요하다.

## 브라우저 예제 검사

`make browser-example-check`는 스테이징된 브라우저 예제로 `apps/browser/check/served.test.mjs`를 실행한다. 검사는 자기 루프백 HTTP 서버로 `apps/browser/build`를 제공하고, 설치된 Google Chrome을 일회용 프로필로 headless 실행하며(`CHROME`이 다른 실행 파일을 지정한다), Node 내장 `WebSocket`으로 Chrome DevTools 프로토콜을 통해 조작하므로 브라우저 자동화 패키지를 의존성으로 두지 않는다. 사람이 그 애플리케이션에서 하듯 프로젝트를 연다. `core.library.add`를 누르고 `core.library.form.parent`에 폴더 경로를 입력한 뒤 `core.library.form.submit`을 누른다. 브라우저 예제는 입력한 경로를 등록하므로 폴더 선택기가 필요 없다([프로젝트](../spec/projects.ko.md)). 페이지가 작업 화면을 보이고 모든 사이드바 섹션이 마운트될 때까지 기다리며, 처리되지 않은 예외, `console.error`, 수준 `error`의 브라우저 로그가 하나라도 있으면 각각을 보고하며 실패한다. Chrome이 없으면 건너뛰지 않고 실패한다. 검사는 끝날 때 프로필을 지우고 Chrome과 서버를 멈춘다.

## 수동 인수

터미널 키보드 검사는 호스트마다 보이는 터미널 3개에서 네이티브 클릭과 키를 사용한다. 문자·Backspace·Ctrl+U·Enter·정확히 한 번의 명령 출력·다른 터미널 화면의 불변을 확인한다. 현재 화면을 한 번 읽고 `terminal.screen` 알림을 기다리며, 키보드 전달 검증에 `terminal.input`을 사용하지 않는다. 입력 통과가 드래그 결과를 대신하지 않도록 합성 녹화와 별도로 실행한다.

- 존재하는 프로젝트 폴더 두 개를 추가하고 순서를 변경한 뒤 앱을 종료하고 다시 실행한다. 라이브러리는 표면이나 셸을 시작하지 않고 저장된 프로젝트 목록을 표시한다. 프로젝트를 선택하여 같은 OS 창에 배치와 설정이 복원되는지 확인한다.
- 두 네이티브 호스트의 새 프로젝트에서 생성 위치 선택을 한 번 취소한 뒤 디렉터리를 선택한다. 생성 실패 시 기존 디렉터리를 유지해야 한다. 모든 창을 닫은 경우를 포함해 Dock 메뉴의 새 창을 선택한다. 작업 화면에서 프로젝트 목록으로 이동한 뒤 복귀하여 배치와 셸이 유지되는지 확인한다.
- 일반 본문의 탭에서 전역·프로젝트를 선택해 각각 값을 변경하고 프로젝트 재정의를 초기화한다. 두 창의 상속과 분류 변경 후 범위 유지를 확인한다. 열기 방식은 전역에만 표시되어야 한다. 작업 화면에서 돌아온 경우를 포함해 모든 라이브러리 화면은 공통 설정을 적용하고 전역 탭만 표시해야 한다. 라이브러리 편집과 제목 표시줄의 모드 버튼은 프로젝트 덮어쓰기를 변경하면 안 된다. 작업 화면으로 복귀하면 해당 덮어쓰기와 두 범위 탭을 복원해야 한다.

- 브라우저·셸 위에 설정을 연다. 검정 50% 배경, 보이는 블러, 선명한 설정 콘텐츠를 확인한다. 배경 클릭과 스크롤이 하부 콘텐츠를 조작하면 안 된다.
- 설정 헤더를 드래그하고 메인 창 크기를 변경하며 창 관리 도구를 사용한다. 설정은 메인 창 내부에 유지되어야 한다. ×만 설정을 닫으며 배경 클릭과 Escape는 닫지 않는다.
- 추가·분할 선택 메뉴를 연다. 배경 투명, 블러 없음, 선택·바깥 클릭·Escape로 닫기를 확인한다.
- 설정을 닫고 화면·입력 복원을 확인한다. 설정이 열린 상태에서 브라우저를 다시 로드하고 새 문서의 블러를 확인한다.
- 구분선 드래그를 녹화하고 전체화면을 진입·해제한다. 네이티브 버튼은 첫 행의 상하 중앙을 유지해야 한다.

2026-09-07 수동 외관 검증에서 두 macOS 호스트의 설정 블러를 확인했다. 이는 자동 좌표·입력 검사와 구분되는 수동 외관 검증이다. 새 결과는 [기능 상태](../features.ko.md)와 [변경 기록](../../CHANGELOG.ko.md)에 기록한다. Windows와 Linux는 네이티브 실행과 검증이 추가로 필요하다.

## 진단

디버그 빌드(`make wailsv3-build tauriv2-build`)는 [로컬 엔드포인트](../spec/endpoint.ko.md)의 진단 메서드 `diagnostics.fixture`, `diagnostics.drag`, `diagnostics.capture.start`, `diagnostics.capture.stop`, `diagnostics.modal.hold`, `diagnostics.modal.held`, `diagnostics.notifications`, `diagnostics.transcript`를 포함한다. `soksak` 명령과 `soksak-mcp` 서버도 같은 요청을 보낸다. 예를 들어 `soksak status core.screen --window main --config-dir DIR`이다. `soksak dom dispatch NAME --window main --event '{"type":"click"}' --config-dir DIR`는 선언된 DOM 항목에 합성 이벤트를 보낸다. 실제 입력 검사는 `input.pointer`와 `input.key`를 쓴다.

`pnpm -F @soksak/client run bench:application -- --config-dir DIR`은 실행 중인 애플리케이션의 세 경로 순차 왕복을 잰다. `windows.list`(호스트만 응답), `status.get core.screen`(메인 페이지에 중계), 표면을 지정한 `status.get core.surface.document`(메인 페이지를 거쳐 표면 페이지에 중계)다. `bench`는 전송만 잰다. 2026-09-17(M3 Pro, 디버그 빌드, 경로당 2000회, 두 번 실행)의 p50은 Wails 호스트 142–157µs, 페이지 1.5–1.7ms, 표면 4.4–4.5ms, Tauri 호스트 443µs, 페이지 2.6–2.7ms, 표면 1.4–7.5ms였다.

공용 라이브러리에는 네이티브 입력 검사 묶음이 두 개 있다. 공통 입력 코드를 변경할 때 둘 다 실행한다.

```sh
make -C native/darwin test
make -C native/darwin test-activation
```

`test`는 비활성 애플리케이션의 창에서 `input_inject_test`를 실행한다. 누름, 끌기, 스크롤, 키, 포커스, 버튼 없는 이동의 비활성 결과를 검사하며 애플리케이션을 활성화하지 않는다. 모든 네이티브 검사는 `tests/support/no_activation.m`을 링크하며, 이 파일은 종료할 때 프로세스가 활성이면 검사를 실패시킨다. `test-activation`에서 앱을 활성화하는 검사는 먼저 `sp_test_declare_activation`을 호출한다.

`test-activation`은 검사 애플리케이션을 활성화하므로 키보드 포커스를 가져간다. 검사 창은 `ignoresMouseEvents`를 설정하지만, AppKit은 실제 포인터가 있는 추적 영역에 이동을 계속 전달한다. 그래서 겹친 웹뷰 검사는 창을 포인터에서 떨어진 곳에 두고, 포인터가 창에 들어오면 그 이유로 실패한다. `input_activate_test`(활성화 후 호버), 겹친 웹뷰 검사 `webview_input_test`(기준 실행 뒤 입력 등록 실행), `document_view_test --activation`(문서 영역에 OS 이벤트 대기열 클릭과 키), `image_region_ime_test`(그림 영역과 AppKit 텍스트 뷰 대조군의 한국어 2벌식 조합. 실행 동안 한국어 2벌식을 선택하고 이전 입력 소스를 되돌린다)를 실행한다.

활성화 등급 창 검사는 `e2e/activation/`에 있으며 사용자가 승인한 실행에서 `pnpm -F @soksak/e2e verify:activation`으로만 실행한다. `pnpm -F @soksak/e2e verify`는 이를 포함하지 않는다. 이 검사는 `input.pointer`의 `activate: true`로 앱을 활성화할 수 있고(`make e2e-check`는 다른 곳에서 이를 거부한다), `diagnostics.input.source`로 키보드 입력 소스를 바꾸며 정리에서 이전 입력 소스를 되돌린다. `ime.test.mjs`는 ABC `ddd`를 치고 한국어 2벌식으로 바꿔 `g k s r m f`, Space, Enter를 치며, 조합 문자열 `ㅎ`, `하`, `한`, `ㄱ`, `그`, `글`, ` `과 화면의 확정 명령 `ddd한글`이 정확히 한 번임을 요구한다. `marked-text.test.mjs`는 일본어(로마자)를 선택해 `n i h o n n`을 입력하고(입력기는 이를 marked text로 표시한다), ABC로 바꿔 조합을 끝낸 뒤, 마지막 marked text가 PTY에 정확히 한 번 도착하고 확정 뒤 preedit가 없기를 요구한다. `com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese` 입력 소스가 켜져 있어야 한다. `terminal-keyboard.test.mjs`는 세 터미널에서, 그리고 브라우저 탭, 크기 변경, 모달, 프로젝트 복귀, 두 번째 프로젝트 창 뒤에 네이티브 키로 명령을 입력하고 편집하고 실행한다. 입력 컨텍스트가 자기 입력 소스를 되돌릴 수 있으므로 포커스를 줄 때마다 ABC를 고른다. 두 번째 검사는 두 번째 프로젝트 창을 열어 키 창으로 만든 뒤 첫 창의 포커스된 터미널에 문자 키를 보내고, 터미널이 입력기가 답하지 않았다고 보고하기를 요구한다. 키 창은 포인터 위치를 이동으로 받으므로, 각 검사는 앱을 활성화하기 전에 창이 시스템 포인터를 덮으면 창을 포인터 옆으로 옮긴다(`e2e/app.mjs`의 `keepPointerOutside`). 창이 어느 쪽에도 들어가지 않으면 먼저 창 폭을 넓은 쪽에 맞게 줄인다. 검사가 키보드 포커스를 가져가므로 실행 전에 앱 하나만 띄운다.

실제 입력 등급 창 검사는 `e2e/real/`에 있으며 사용자가 승인한 실행에서 `pnpm -F @soksak/e2e verify:real`로만 실행한다. 기본 실행은 이를 포함하지 않는다. 실제 입력 검사, 전체 화면, 새 프로젝트 창처럼 애플리케이션을 활성으로 만든 창 검사는 끝날 때 하네스가 앞서 활성이던 애플리케이션을 다시 활성화한다. 기본 창 검사는 비활성 애플리케이션을 재기 때문이다. 활성 창은 배치가 바뀔 때 AppKit의 커서 갱신을 받아 시스템 포인터 위치를 페이지에 넘기고, 이 이동은 합성한 `diagnostics.drag`와 섞인다. 그래서 하네스는 애플리케이션이 활성이면 끌기를 명시적인 오류로 실패시킨다. 실제 입력 검사는 `e2e/real/hid.mjs`를 통해 `CGEventPost`로 HID 이벤트를 보낸다. 이 도구는 검사를 실행하는 터미널에 손쉬운 사용 권한이 있어야 하고, 없으면 바로 실패한다. 검사는 포인터와 키보드를 쓰고 앱을 활성화하며, 다른 창 위에 보낸 이벤트는 그 창으로 가므로 보낸 모든 지점에서 앱의 창이 맨 앞이어야 한다. 원본 없이 만든 이벤트는 HID 시스템 수정키 플래그를 물려받으므로(V5-25-1) 보낸 모든 이벤트의 플래그를 정한다. `input.test.mjs`는 시스템 포인터가 보낸 지점에 도달하고 보낸 클릭이 터미널 영역에 네이티브 포커스를 주기를 요구한다.

`soksak capture --window main --config-dir DIR`은 실행 중인 진단 빌드의 창을 포커스 없이 정지 PNG로 쓰고 경로를 출력한다. 개발 중 결과를 눈으로 확인할 때 쓴다. 확인한 뒤 출력된 `still-*` 디렉터리를 지우며, 수치 검사는 녹화 프레임을 쓴다.

추적 `capture-still.test.mjs`는 정지 파일의 장치 픽셀 크기·투명도와 선언된 네이티브 좌표의 경계 픽셀을 확인한다. `png.test.mjs`는 PNG 투명도와 잘못된 좌표·디코딩 길이 검사를 소유한다. 이는 출력 무결성 검증이며 제스처 완전성·표시 시간은 계속 녹화 프레임으로 검증한다.

`pnpm -F @soksak/e2e run repeat --file <파일> --name <검사 이름 패턴> --count <n>`은 실행 중인 앱에 창 검사 하나를 반복 실행한다(`SOKSAK_APP`으로 호스트 하나를 고른다). 실행마다 새 `node:test` 프로세스를 쓰며, 처음 실패한 실행에서 멈춰 그 출력을 보이고, 실행된 검사가 없으면 실패한다. `make -C native/darwin repeat TEST=<name>_test COUNT=<n>`은 기본 검사 하나를, `make -C native/darwin repeat-suite COUNT=<n>`은 기본 스위트를 반복 실행한다. 둘 다 첫 실패에서 멈추고 실행 번호와 시스템 부하를 보고한다. `make rust-tests-alone PACKAGE=<package> [MANIFEST=<Cargo.toml>]`은 Rust 패키지의 각 테스트를 새 프로세스에서 혼자 실행하고, 혼자 실행할 때 실패하는 첫 테스트를 보고한다. 다른 테스트가 실행된 뒤에만 통과하는 테스트는 공유 상태나 시간 순서에 의존한다. `make rust-repeat PACKAGE=<package> COUNT=<n> [TEST=<name>] [MANIFEST=<Cargo.toml>]`은 Rust 패키지의 테스트, 또는 `TEST`로 이름을 준 테스트 하나를 `COUNT`번 차례로 실행한다. 첫 실패한 실행에서 멈춰 그 출력, 실행 번호, 시스템 부하를 보고하고, `TEST`가 어떤 테스트도 가리키지 않으면 실패한다. `make go-repeat PACKAGE=<go package path> COUNT=<n> [TEST=<regexp>]`는 Go 테스트에 대해 같은 일을 하며, `TEST`는 `go test -run` 패턴이다. `make node-repeat FILE=<test file> NAME=<test name pattern> COUNT=<n>`은 저장소 루트에서 Node 테스트 파일의 맞는 테스트를 같은 방식으로 실행하고, 맞는 테스트가 없으면 실패한다.

기준 실행은 겹친 DOM의 중복 포인터 이동을 확인한다. 입력 등록 실행은 단일 대상 포인터 추적, 키보드 입력 유지, 오버레이 숨김·제거 후 정리를 검사한다. 두 실행 모두 지연된 커서 응답을 검사하지 않는다.
