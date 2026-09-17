# 애플리케이션 빌드와 검증

[English](examples.md)

저장소 루트에서 명령을 실행한다. `package.json`의 패키지 관리자 버전, `go.work`와 `packages/host/wailsv3/go.mod`와 호환되는 Go 도구 체인, 루트 `Cargo.toml` 워크스페이스와 호환되는 Rust 도구 체인을 사용한다. [네이티브 호스트 명세](../spec/hosts.ko.md)가 호스트 패키지, 애플리케이션, 워크스페이스 파일을 설명한다. 현재 네이티브 검증은 macOS에서 Command Line Tools SDK와 캡처를 위한 화면 기록 권한을 사용한다.

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

디버그 실행 파일은 `target/debug/soksak-wailsv3`와 `target/debug/soksak-tauriv2`다. 릴리스 빌드는 `make wailsv3-build-release tauriv2-build-release`를 사용하며 `target/release/soksak-wailsv3`와 `target/release/soksak-tauriv2`를 만든다. `make examples-size`는 두 프로파일을 빌드하고 크기를 출력한다.

## 창 검사

각각 다른 터미널에서, 하네스가 읽는 설정 디렉터리(Node.js의 `os.tmpdir()`, macOS에서는 `$TMPDIR`)로 앱을 한 번씩 실행한다.

```sh
./target/debug/soksak-wailsv3 --config-dir "$TMPDIR/soksak-check-wailsv3"
./target/debug/soksak-tauriv2 --config-dir "$TMPDIR/soksak-check-tauriv2"
```

디스플레이를 켜고 두 창이 렌더링 가능한 상태에서 실행한다.

```sh
pnpm -F @soksak/e2e run verify
```

하네스(`e2e/app.mjs`)는 `@soksak/client`로 `<config-dir>/endpoint.json`을 읽어 연결한다([로컬 엔드포인트](../spec/endpoint.ko.md)). `application`이 기대한 호스트인지, `executable`이 이 체크아웃의 실행 파일인지 확인한다. 임시 디렉터리의 잠금 파일 `soksak-check.lock`이 동시 실행을 막으며, 두 번째 실행은 측정하지 않고 실패한다. 검사는 앱을 시작하지 않는다. 상태 조회와 변경은 선언된 항목([노출](../spec/exposure.ko.md))만 사용한다. status 값, 명령, DOM 항목, 호스트 항목, 디버그 빌드의 진단 메서드다. 대기는 `status.watch` 알림과 `host.window.presented`를 사용하며 하네스에는 폴링 반복이나 고정 지연이 없다. 실제 입력 검사는 애플리케이션을 활성화하지 않는 `input.pointer`와 `input.key`를 사용한다. `make e2e-check`는 `e2e/`의 타이머, `eval`, `Function` 생성자, 제거된 네이티브 프로브, 제거된 TCP 제어 포트를 거부한다. 실행 중인 앱이 없으면 실패하고, 바이너리가 없으면 건너뜀으로 표시한다. 호스트 검사를 건너뛴 실행으로 두 호스트를 검증했다고 기록하지 않는다.

`make examples-verify`는 `make e2e-check`, `make exposure-check`, 문서 검사, 창 검사를 실행한다. 검증 전에 두 앱을 빌드하고 다시 실행한다. 실행 파일을 다시 빌드해도 이미 실행 중인 프로세스는 교체되지 않는다.

일회용 설정 디렉터리를 사용한다. 하네스는 해당 디렉터리의 프로젝트 목록과 공통 설정을 교체하고 검사 전용 설정을 포함한 `test-project` 폴더를 생성한다. 프로젝트 창 검사는 추가 임시 프로젝트 폴더를 생성하고 일반 파일과 창 API를 실행한다.

하네스는 검사마다 다른 창을 닫고 1200×760 시작 크기로 되돌린 뒤 `diagnostics.fixture`를 실행하고, `host.window.reload`로 메인 문서를 다시 로드하며, 보이는 모든 셸 표면이 테마를 적용한 상태로 `core.surface.document`를 등록할 때까지 기다린 뒤 표시 완료를 확인한다. `diagnostics.drag`에서는 호스트가 16ms 간격으로 드래그 단계를 보낸다. `capture: true`이면 호스트가 첫 단계 전부터 제스처가 표시될 때까지 창을 녹화하고, 하네스가 `diagnostics.capture.stop`으로 녹화를 멈춘다. `diagnostics.capture.start`는 다른 요청의 앞뒤를 녹화한다. `display: true`이면 창이 있는 디스플레이에서 이 앱의 창을 녹화하므로, 창이 전체 화면 Space로 옮겨져도 녹화가 이어진다. 프레임 파일은 BGRA 픽셀 앞에 버퍼 안에서 창이 차지한 사각형, 콘텐츠 배율, 백킹 배율, 표시 시각을 담는다. 버퍼보다 큰 창은 줄여서 담긴다. 기록되지 않은 프레임이 있으면 녹화는 blank와 suspended 프레임 수를 알린다. 녹화는 프레임을 수신 처리기에서 복사하고 별도 큐에서 쓰므로, 디스크가 느려도 스트림이 프레임을 버리지 않는다. `diagnostics.capture.stop`은 `longestGap`을 반환하며, 프레임 사이 간격이 100ms를 넘는 끌기 녹화는 제스처 일부가 기록되지 않았으므로 실패한다. 요청 시간의 1/1.25배에서 1.25배 범위를 벗어난 드래그는 한 번 반복한 뒤 실패한다. 제스처 미완료, 프레임 부족, 측정 가능 프레임 부족은 검사 실패다.

녹화는 임시 파일이다. 각 검사는 통과 여부와 무관하게 끝날 때 프레임 디렉터리를 지운다. 실패 메시지는 측정값과 프레임 번호만 보고하며 하네스는 이미지를 쓰지 않는다.

`outside.test.mjs`는 측정 가능한 모든 프레임에서 카드 밖 표면 픽셀 0, 왕복 두 번 전체, 셸 콘텐츠, DOM 입력 구분선, 카드 UI, 사이드바, 레일의 일정한 상대 좌표를 검사한다. `paint.test.mjs`는 렌더링되지 않은 영역을 검사하고, 드래그 동안의 모든 `core.verify` 결과에 실패 행이 없어야 한다. `footer.test.mjs`는 창이 있는 디스플레이의 배율에서 가로 디바이더 드래그 전체 프레임의 푸터 픽셀을 검사한다. `modal.test.mjs`는 순서, 투명도, 배경 블러(`core.window.document`, `core.surface.document`, `core.modal`), `host.hit`의 네이티브 입력 대상, 닫기, 네이티브 드래그 입력에 의한 이동, 크기 변경, 다시 로드 후 제거를 검사한다. `commands.test.mjs`는 카드, 탭, 메뉴, 설정, 라이브러리, 이름 변경 명령을 실행하고 각 결과를 status로 확인한다. `audit.test.mjs`는 모든 화면, 설정 구역과 범위, 메뉴, 이름 변경 상태, 보이는 플러그인 표면을 방문해 `core.page.audit`와 `core.surface.document`의 `unbound`가 비어 있기를 요구한다. `controls.test.mjs`는 최대화와 녹화 후 `host.window`의 버튼 좌표를 읽는다. `resize.test.mjs`는 `host.screens`의 `visible`까지 최대화하고 되돌리는 과정을 녹화해, 표면이 새 크기에 도달한 뒤의 프레임이 창 크기의 배치를 보여 주는지 확인하고, 배치가 창 프레임보다 늦은 프레임 수를 보고한다. 창 프레임과 WebKit 내용은 따로 표시되므로(WebKit/WebKit#72971, tauri-apps/tao#1207) 그 프레임은 측정값으로 남기고 실패로 보지 않는다. `hosts.test.mjs`는 `diagnostics.transcript` 줄의 최종 요청과 표시 좌표를 비교한다. 준비 식별자는 해당 창 내부 값이다.

`projects.test.mjs`는 공통·폴더 설정 파일, 일반 범위 탭 위치, 각 탭의 파일 저장, 분류 전환 후 범위 유지, 재정의 제거, 라이브러리 전역 범위 전용 설정과 외관 동작, 작업 화면 덮어쓰기 복원, 폴더 별칭, 탭·창 정책, 독립 모달, 네이티브 창 닫기·다시 열기 후 배치와 창 좌표 복원을 검사한다. `library.test.mjs`는 생성·선택 후 창 재사용, 디렉터리 작업 실패, 실제 열림 상태, 고정, 검색, 작업 화면 복귀, `host.dock`의 Dock 새 창을 검사한다. 미리보기 검사는 카드 순서와 분할 방향을 작업 화면과 비교하고 행 높이, 사이드바 폭, 간격의 균일성과 렌더러 좌표 미저장을 요구한다. `shell.test.mjs`는 네이티브 입력으로 셸 입력 칸을 누르고 한 줄을 입력한 뒤 `shell.output`에 줄이 나타날 때까지 기다리며, `echo` 출력 한 번, `pwd`의 프로젝트 디렉터리, 다른 셸 탭에 출력 없음을 요구한다. `browser.test.mjs`는 검사가 띄운 루프백 HTTP 서버의 문서를 사용한다. `browser.navigate`로 문서를 열고, 뒤로·앞으로 이동하고, `input.key`로 `browser.address`에 주소를 입력한다. 이어서 `host.hit`이 문서 영역을 보고하는지, 네이티브 `input.pointer` 스크롤이 앱 활성 상태를 바꾸지 않고 `browser.location.scroll`을 요청한 120픽셀만큼 바꾸는지, 표면이 이동하고 크기가 바뀐 뒤 `host.window`의 영역 프레임이 `browser.document`와 같은지 요구한다. 두 번째 브라우저 표면이 첫 표면의 문서를 받지 않는지, 탭을 닫으면 그 표면의 영역만 닫히는지도 검사한다. 설정 우선순위와 브라우저 저장소 트랜잭션은 `packages/workbench`와 `apps/browser`의 `pnpm test`가 검사한다. `make native-test`는 `make -C native/darwin test`, `packages/host/wailsv3`와 `sidecars/shell`의 `go test`, `cargo test -p soksak-host-tauriv2`를 실행하며, 호스트 검사는 파일 저장, 사이드카 중계, 엔드포인트, 문서 영역의 소유 확인과 정리를 다룬다. `webview_geometry_test`는 문서 영역의 배율도 검사하고, `document_view_test`는 영역의 이동, 상태 보고, 배치, 격리를 검사한다.

창의 백킹 픽셀 해상도로 녹화한다. 포인트 크기로 축소하면 0.5pt 선이 인접 픽셀과 섞여 정확한 색을 측정할 수 없다. 원시 프레임은 32비트 값 세 개(너비, 높이, 행 바이트 수)와 BGRA 픽셀 데이터로 구성된다. 누락되거나 일부만 기록된 녹화를 통과로 처리하지 않는다.

`geometry.test.mjs`는 창 크기 변경 후 네이티브 프레임(`host.window`), DOM 슬롯(`core.surfaces`), 표면 문서와 뷰포트 크기(`core.surface.document`)를 비교한다. 마지막 장치 픽셀의 소유자를 `host.hit`으로 확인하고 `input.pointer`로 누르고 뗀 뒤 `core.surface.input`의 신뢰 이벤트 좌표를 검사한다. 배율과 배율 변경은 연결된 디스플레이와 무관하게 `native/darwin/tests/webview_geometry_test.m`이 검사한다. 창의 백킹 배율을 2, 1, 다시 2로 바꾸며 반 포인트 표면 높이, 마지막 장치 픽셀 행의 문서 표시, 그 행의 네이티브 입력을 확인한다. 특정 디스플레이가 필요한 창 검사는 없다.

## 수동 인수

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

디버그 빌드(`make wailsv3-build tauriv2-build`)는 [로컬 엔드포인트](../spec/endpoint.ko.md)의 진단 메서드 `diagnostics.fixture`, `diagnostics.drag`, `diagnostics.capture.start`, `diagnostics.capture.stop`, `diagnostics.knob`, `diagnostics.transcript`를 포함한다. `soksak` 명령과 `soksak-mcp` 서버도 같은 요청을 보낸다. 예를 들어 `soksak status core.screen --window main --config-dir DIR`이다. `soksak dom dispatch NAME --window main --event '{"type":"click"}' --config-dir DIR`는 선언된 DOM 항목에 합성 이벤트를 보낸다. 실제 입력 검사는 `input.pointer`와 `input.key`를 쓴다.

`pnpm -F @soksak/client run bench:application -- --config-dir DIR`은 실행 중인 애플리케이션의 세 경로 순차 왕복을 잰다. `windows.list`(호스트만 응답), `status.get core.screen`(메인 페이지에 중계), 표면을 지정한 `status.get core.surface.document`(메인 페이지를 거쳐 표면 페이지에 중계)다. `bench`는 전송만 잰다. 2026-09-17(M3 Pro, 디버그 빌드, 경로당 2000회, 두 번 실행)의 p50은 Wails 호스트 142–157µs, 페이지 1.5–1.7ms, 표면 4.4–4.5ms, Tauri 호스트 443µs, 페이지 2.6–2.7ms, 표면 1.4–7.5ms였다.

공용 라이브러리에는 네이티브 입력 검사 묶음이 두 개 있다. 공통 입력 코드를 변경할 때 둘 다 실행한다.

```sh
make -C native/darwin test
make -C native/darwin test-activation
```

`test`는 비활성 애플리케이션의 창에서 `input_inject_test`를 실행한다. 누름, 끌기, 스크롤, 키, 포커스, 버튼 없는 이동의 비활성 결과를 검사하며 애플리케이션을 활성화하지 않는다.

`test-activation`은 검사 애플리케이션을 활성화하므로 키보드 포커스를 가져간다. 검사 창은 `ignoresMouseEvents`를 설정하지만, AppKit은 실제 포인터가 있는 추적 영역에 이동을 계속 전달한다. 그래서 겹친 웹뷰 검사는 창을 포인터에서 떨어진 곳에 두고, 포인터가 창에 들어오면 그 이유로 실패한다. `input_activate_test`(활성화 후 호버)를 실행한 뒤, 겹친 웹뷰 검사 `webview_input_test`를 기준 실행과 입력 등록 실행 순서로 실행한다.

기준 실행은 겹친 DOM의 중복 포인터 이동을 확인한다. 입력 등록 실행은 단일 대상 포인터 추적, 키보드 입력 유지, 오버레이 숨김·제거 후 정리를 검사한다. 두 실행 모두 지연된 커서 응답을 검사하지 않는다.
