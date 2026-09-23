# 변경 기록

- F8-5 진행: 빈 native `compose` callback이 이전 marked 문자열을 PTY 확정 입력으로 합성하던 결함을 수정했다. Red 회귀검사는 `compose("한글") → compose("")`가 `insert` callback 없이 `한글`을 쓰는 것을 재현한다. 이제 빈 조합 상태는 지우기/취소로 처리하고 `insert`만 확정한다. 터미널 런타임 명세와 한영 F8-5 기록에 계약을 반영했다. 네이티브 입력, 후보창 픽셀, 재빌드 호스트의 실제 IME 동작 검증은 아직 남아 있다.
- F8-1 Red를 터미널 오류 스크린샷 기준으로 기록했다. 네이티브 영역이 Ctrl `Char`에 `charactersIgnoringModifiers`를 직렬화하고 VT encoder는 지원하는 ASCII 제어 문자 범위 밖의 문자를 거부했다. 한글 `ㅕ` payload와 물리 ANSI U를 넣은 native 회귀 검사는 수정 전 실패했고, 수정 뒤 `u`를 내보낸다. sidecar 계약은 Ctrl+U가 `0x15`를 기록하는지 검증한다. 집중 검사·`pnpm test`·경계·노출·전체 vt-core 검사는 통과했다. `make native-test`는 별도 `input_inject_test`에서 예상하지 못한 pointer sequence와 WebKit 평가 timeout으로 두 번 중단됐고 원인은 미확정이라 F8-2에 기록했다. 스크린샷의 실제 키 payload는 알 수 없다.
- F8-1의 지원되는 물리 Ctrl 문자 매핑을 완료했다. ANSI U 키의 한글 `ㅕ` payload가 Ctrl+U로 전달되며 vt-core는 `0x15`를 검증한다. 스크린샷의 실제 키는 특정하지 못했다. 독립 `make native-test` 실패는 F8-2에 남아 있다.
- F8-3 Red: “terminal commits the first Korean syllable exactly once” 검사는 완성된 `나`를 `terminal.input`으로 기록한다. 따라서 네이티브 IME를 우회해 조합을 검증할 수 없다. 호스트 증거로 세기 전에 native 키 입력과 관측 가능한 preedit 검사로 교체한다.
- F8-3 진행: 호스트 검사가 ANSI `s`, `k`를 누르고 `나` preedit을 관측한 뒤 Space로 확정하며, 정확히 한 번 PTY 전달을 확인하고 native Ctrl+U로 정리하도록 바꿨다. 문법·패키지·경계·노출·문서 검사가 통과했다. 실행 중인 호스트가 없어 재빌드 Tauri/Wails 실행은 아직 검증하지 않았다.
- F8-2 완료: 포커스 라우팅 검사는 활성 입력 소스에 따라 문자가 달라지는 물리 키 대신 명시적 `a`/`b` 문자를 보낸다. 키 입력 전 자식 문서 응답·입력 포커스 검사와 timeout 진단을 추가해 실제 대기 query를 확인했다. 집중 `input_inject_test`와 전체 `make native-test`가 Wails 일반/diagnostics Go, sidecar Rust workspace, Tauri 일반/diagnostics 검사를 포함해 통과했다.
- F8-3 진행: 재빌드 호스트 IME 검사는 native `s`/`k`, `나` preedit 표시, Space 확정, 정확히 한 번 PTY 전달, native Ctrl+U 정리를 요구한다. 현재 앱 프로세스는 종료되어 있으므로 호스트 검사 전에 빌드해야 하며, 검사는 이미 실행된 바이너리에 연결한다.
- F8을 진행했다. WebKit 비표준 한글 IME 경로가 조합 중 compatibility-jamo `insertText` echo를 보류하고 조합 해제 때 마지막 preedit을 정확히 한 번 확정한다. terminal plugin 집중 Red/Green 검사가 통과했고 재빌드 Wails가 직접 전달한 최초 `나`를 정확히 한 번 받아들였다. native 활성화는 브라우저 좌표의 대상 WebView만 기다리고 native 표면에서는 관련 없는 WebView를 기다리지 않는다. endpoint 키 주입은 사람이 직접 입력한 최초 `나`를 결정론적으로 재현하지 못하므로 실제 macOS IME와 후보 픽셀 증거는 아직 열려 있다.
- F8를 진행했다. named character 입력이 물리 macOS ANSI 키 이벤트를 만들도록 하여 활성 키보드 입력 소스가 한글을 조합하게 했다. terminal plugin은 이제 sidecar 계약 `{operation: "input", compose: {...}}`으로 조합을 보내며, 이전 `{operation: "compose"}`가 확인된 `Unknown operation: compose` 원인이었다. `com.apple.inputmethod.Korean.2SetKorean`을 사용한 재빌드 Tauri·Wails probe가 각각 `terminal.compose` 전환 `ㅏ → ㄴ → 나`를 만들었고 session 오류는 0건이었다. 후보창 픽셀과 확정 입력의 정확히 한 번 전달은 아직 열려 있다.
- V5 최종 감사를 시작했다. 필수 검사를 독립적인 제한시간과 START/PASS/FAIL 출력이 있는 lane으로 실행하며, 전체 타임아웃이나 mandatory skip을 완료 근거로 세지 않는다.
- V5 Red에서 두 구조 실패를 확인했다. OSC 133이 shell plugin ID와 충돌하는 무접두사 `shell.state` namespace를 사용했고 Wails geometry 검사에 Tauri 대응 파일이 없었다. vendor event를 `vendor.shell.state`로 바꾸고 Tauri geometry 검사를 대응하는 `surfaces_geometry_test.rs` lane으로 옮겼다.
- 대응하는 geometry lane을 추가한 뒤 V5 parity inventory를 보정했다. 현재 출력은 lane 56개·구현 파일 252개·테스트 파일 173개이며, 이전 171/172개 테스트 수는 날짜가 있는 증거로 남긴다.
- F6.3-11을 완료했다. 일반 터미널 클릭은 더 이상 빈 selection을 열지 않으며, 포인터 이동 뒤에만 selection을 시작하고 완전한 drag start/update/end 계약은 보존한다. 터미널 모듈 drag/click 집중 검사 2/2, 재빌드 Tauri·Wails keyboard E2E 각각 4/4가 통과했고 `terminal.session.error`가 없으며 검증 뒤 양쪽 앱을 종료했다.
- F8을 진행했다. custom image region의 명령 외 키 입력을 `interpretKeyEvents:`가 아니라 `NSTextInputContext handleEvent:`로 전달한다. 제한된 native image-region 회귀 검사가 일반 insert·조합·취소/키 라우팅·범위·후보 기하를 통과했다. 재빌드 Tauri·Wails 활성 입력 소스 probe가 이제 한글 조합 상태를 관측하며 후보 픽셀과 확정 정확히 한 번 전달 증거는 아직 열려 있다.
- F7.1–F7.18가 완료된 뒤 CSI 체크리스트 집계 상태를 바로잡았다. 부모 행은 F7.14–F7.17을 낡은 미완료 범위로 남기지 않고 selector 단위와 기계적 감사 근거를 기록한다.
- F7.17을 완료했다. `scripts/check-terminal-protocol-inventory.mjs`가 고정 patch-411 reference, 필수 CSI 25행, selector 중복, 이름 있는 Rust 테스트와 complete-CSI 계약을 기계적으로 검사한다. 정상·주입 Red 실행이 통과했으며 vendor 계약은 F7.18에 남겼다.
- F7.16을 완료했다. CSI inventory가 `5n/6n`, primary/secondary `c/>c`, `14t`, 분할 unsupported window, rectangle/protected-cell/palette intermediate와 framing/잘못된 입력 근거를 이름 있는 검사에 연결한다. 순서가 있는 device/status 응답이 15초 감독 아래 1/1 통과했다.
- F7.16을 시작했다. device/status/window 응답과 XTerm intermediate 형식을 구현된 응답과 명시적 거부 케이스로 분리하고, 제한된 순서·잘못된 입력 검사를 추가한다.
- F7.15를 완료했다. 공개 `Modes` 계약이 focus-in/out, UTF-8 mouse, SGR mouse, alternate-scroll 상태를 노출한다. engine 검사가 설정/초기화 전환, 상호 배타적인 UTF-8/SGR 전환, 기존 keyboard/mouse/bracketed-paste mode와 명시적 inventory 연결을 검증하며 15초 감독 아래 1/1 통과했다.
- F7.15를 시작했다. terminal mode 계약이 focus 보고, UTF-8/SGR mouse 변형, alternate scroll, keyboard mode, bracketed paste와 cursor policy를 노출하고 검사해야 하며 parser 수용을 근거로 삼지 않는다.
- F7.14를 완료했다. CSI inventory가 `E/F`를 관측 가능한 cursor 행 동작에 연결하고 `?1049` primary/alternate 분리를 검사하며, 지원하지 않는 `?47`, `?1047`, `?1048` mode를 성공한 no-op처럼 다루지 않고 명시적으로 거부한다. 세 집중 engine 검사가 각각 15초 감독 아래 통과했다.
- F7.14–F7.17을 명시적 CSI 완료 단위로 추가했다. 남은 표준 형식·private mode·device/status/window 응답과 고정 reference 기계 감사기를 구현·검증해야 F7을 닫을 수 있다.
- F7 CSI 감사를 진행했다. Alacritty 경계가 지원하지 않는 window·rectangle·protected-cell·palette 보고를 분류하고 각 분할 입력 케이스마다 한 번의 명시적 오류를 내보낸다. window와 묶음 미지원 보고 집중 검사가 각각 15초 감독 안에서 1/1 통과했으며, 남은 CSI 범위는 계속 열려 있다.
- F9-1을 완료했다. parity inventory가 F9를 `e2e/library.test.mjs`의 복원 구현·애플리케이션 검사에 연결하며, F9를 다시 열지 않고 `node scripts/check-test-parity.mjs`와 `make docs-check`가 통과한다.

- F9를 완료했다. 재빌드 Tauri·Wails library 복귀 검사가 연결·문서 ready·래스터 표시·창 최초 표시 단계를 분리해 출력한다. Tauri는 1/1·1.90초와 3/3/3/20ms, Wails는 1/1·1.72초와 3/2/1/14ms를 기록했다. 잘못된 폴더 연산은 명시적 `-32000` 오류를 유지한다. 강제 SIGINT 종료의 socket 경고는 성공 결과가 아닌 fixture 종료 로그로 구분했다.

- V3을 완료했다. `0f70b5d`에서 커밋 규율을 감사한 결과 미커밋 변경이 없었고, 최근 기하·CSI 단위는 집중 Green 검사와 양국어 문서 갱신 뒤 범위가 분리된 `70983e5`·`0f70b5d` 커밋을 남겼다.

- F7.13을 완료했다. CSI inventory가 지원하지 않는 `CSI Ps t` 창 보고를 구현된 `14t`와 분리해 기록하며, 분할된 지원하지 않는 입력은 정확히 한 번 명시적 오류를 내보낸다. 제한시간 15초 감독 아래 집중 검사가 전체 5초·테스트 본체 0.00초에 1/1 통과했다.

- F0.5.9-6을 완료했다. 2026-09-21 크래시 증거에서 Tauri endpoint worker가 중단되기 직전에 AppKit으로 음수 표면 기하가 전달된 사실을 확인했다. 양쪽 host가 네이티브 배치 전에 유한·음수가 아닌 표면·오버레이 기하를 거부하고 0 크기 숨김 표면은 보존한다. Rust 집중 검사는 10초 테스트 감독 아래 소스 컴파일 6초 후 1/1·테스트 본체 0.00초, Go 집중 검사는 1/1·0.428초에 통과했으며 parity는 lane 56개·구현 파일 251개·테스트 파일 172개를 기록한다.

- G2.8을 완료하여 날짜가 기록된 Tauri/Wails parity 감사 서술을 완료된 G2.5 반환값 증거와 일치시켰다. 파일명 불일치는 역사적 관찰로 명시해 유지한다.
- G2.9를 완료하여 native region을 분리하기 전에 진행 중인 surface composition placement를 기다리도록 했다. 재빌드 Tauri·Wails 분할 터미널 검사가 통과했고 양쪽 수명주기 로그에서 composition declaration 오류가 사라졌다.
- F7 OSC/CSI 감사를 시작했다. Red 기록에서 일부 title/color/OSC52/OSC1337·CSI scroll 검사만으로는 XTerm patch 411 selector 단위 범위를 충족하지 못함을 확인했다. 누락된 목록과 명시적 unsupported/policy-denied 케이스는 미완료로 남긴다.

- G2.5–G2.7을 완료했다. Tauri·Wails runtime contract test가 같은 `waitPresented` 결과를 단언하고, 기계적 E2E 감사가 앱 suite 15개에 양쪽 adapter 순회를 강제하며 호스트 독립 suite 3개를 명시적으로 기록한다. parity inventory는 lane 56개·구현 파일 251개·테스트 파일 171개로 동기화했다.

- F6을 완료했다. 터미널 선택·클립보드·bracketed paste·파일 드롭·이미지 붙여넣기·inline image 계약을 명시적 소유권·오류·네이티브 호스트 검증과 함께 완료했다.

- F6.6-3과 F6.6을 완료했다. 재빌드 Tauri·Wails 터미널 inline-image 수명 E2E가 테스트별 실행 시간과 스크롤 전 native 픽셀, 스크롤·삭제 후 0 픽셀, 교체·리사이즈·소유권·제한된 정리를 검증한다. Red에서 OSC 셸 입력 오용, frame sequence를 무시한 같은 raster 표시 대기, raster 교체 중 inline-image 상태 소실을 확인했다. Green에서 `terminal.image.inline.delete`와 `terminal.session.inlineImages`를 명시적으로 추가하고 사이드카 raster 교체에서 소유권을 보존하며 양쪽 호스트가 양수인 최신 frame sequence를 요구한다. Tauri 1/1(1.79초), Wails 1/1(1.45초), 터미널 모듈 57/57, Tauri 이미지 16/16, Wails 이미지 검사와 구조/parity 검사가 통과했다.

- F2.13을 완료했다. Tauri와 Wails가 stale이 아닌 native image 표시 실패를 현재 raster 상태에 기록하고 일반 raster timeout 대신 정확한 원인을 반환하며, stale 프레임 교체는 폐기 가능한 상태로 유지한다. Tauri 이미지 검사 16/16, Wails 이미지 검사와 `make native-test`가 통과했고 재빌드 분할 터미널 표시·주입 실패 E2E가 양쪽 호스트에서 case별 START/PASS, 실행 시간, 폐기 가능한 config, 명시적 애플리케이션 정리를 포함해 통과했다.

- F6.6-3을 완료했다. inline-image placement가 terminal 행 anchor를 유지하고 primary grid의 scroll generation을 따라가므로 오래된 절대 행에 고정되지 않는다. 화면 밖 placement는 소유 상태를 삭제하지 않고 숨긴다. 재빌드 Tauri·Wails 수명 E2E가 테스트별 출력·시간, native 픽셀, 명시적 삭제와 정리를 검증한다.

- F6.6-2를 완료했다. 검증된 OSC 1337 event가 제한된 sidecar 계약을 통해 macOS native raster까지 전달된다. ImageIO가 선언된 위치에 소유 이미지를 합성하고, 같은 이름 교체는 해당 이미지만 바꾸며, `image.inline.delete`는 소유된 이름만 제거하고 소유하지 않은 이름은 명시적으로 보고한다. surface 종료가 이미지 수명을 제한한다. Alacritty 32/32, native frame 11/11, sidecar 계약 45/45와 `make native-test`가 통과했다. 재빌드 Tauri/Wails 픽셀·수명 검증은 F6.6-3에 남아 있다.

- 앞선 F6.6-2 진행 단계에서 macOS native ImageIO 합성과 같은 이름 교체 경로를 추가했다. 위의 완료 기록에 삭제·수명 계약을 기록했으며, 재빌드 Tauri/Wails 픽셀 검증은 F6.6-3에 남아 있다.

- 앞선 F6.6-2 진행 단계에서 VT→sidecar 경계를 만들었다. OSC 1337 record가 PTY 출력 청크 중간에서도 보존되고, 타입 있는 inline-image event가 되며, 잘못된 record는 명시적 오류로 보고되고, 제한된 이미지 바이트는 base64로 전달된다. 위의 후속 진행 기록에서 native 합성을 추가했으며, 삭제·수명 의미와 재빌드 호스트 검증은 남아 있다.

- F6.6-1을 완료했다. `File`, `MultipartFile`, `FilePart`, `FileEnd`에 대한 엄격한 OSC 1337 이미지 전송 parser를 추가했다. 타입 있는 표시·전송·multipart 결과가 payload 상한, 선언 크기와 실제 크기 일치, 엄격한 base64, 크기 단위, 이름 있는 소유권, 명시적 inline 의미를 검증한다. Rust 집중 검사 5개가 0.02초에 통과했고 parity·문서 검사도 통과했다. VT engine과 native raster 통합은 F6.6-2에 남아 있다.

- F6.3-2를 완료했다. 네이티브 정착 표시 실패가 Darwin callback 경계를 넘어 명시적 오류로 전달되며, 실패를 버렸다가 일반적인 1005 타임아웃으로 보고하지 않는다. Red에서 새 진단 주입기의 AppKit UI 스레드 위반도 드러났고, 양쪽 호스트가 이제 주입을 UI 큐로 전달한다. 재빌드 Tauri·Wails 실패 주입 E2E는 각각 1/1(0.76초, 0.47초)으로 통과했으며, 주입 오류를 보고하고 이후 분할에서 제시된 래스터를 완료했다. 별도로 확인한 오래된 사이드카 프로세스를 종료한 뒤 반복 세 터미널 검사는 Tauri 1/1(1.01초), Wails 1/1(0.89초)로 통과했다.

- F6.3-1을 완료했다. 분할로 만든 새 터미널이 모듈의 이미지 래스터 선언·배치보다 네이티브 표시 완료를 먼저 기다리지 않도록 해 `1005` 표시 순환을 제거했다. 제한된 회귀 검사는 START/PASS를 출력하며 재빌드 Wails 1/1(0.79초), Tauri 1/1(0.37초)로 통과했고, 사이드카 세션 ID와 표시·제시된 네이티브 영역을 확인한다.

- F6.3을 완료했다. 터미널 포인터 드래그에 명시적 `selection.start`, `selection.update`, `selection.end` 동작을 추가했고, Alacritty engine이 선택 셀을 렌더링하며 비어 있지 않은 선택 복사 payload를 한 번 반환한다. 터미널 모듈은 `userInitiated`가 확인된 선택 event만 기록한다. 워크벤치는 타입 있는 클립보드 capability를 표면 범위 객체로 바꾸지 않고 전달하며, 표면 테스트가 브리지 누락을 거부한다. 잘못된 좌표와 복사 데이터 부재/공백은 명시적 오류다. 터미널 모듈 50/50, Alacritty 30/30, VT core 44/44, `pnpm test`, 구조 게이트, `make native-test`가 통과했다. 재빌드 Tauri 선택 드래그·래스터·클립보드 E2E는 1/1(0.99초), Wails는 1/1(0.63초)로 통과했다.

- `encode_paste` 소스 계약 주석을 실제 구현과 일치시켰다. UTF-8 바이트와 개행은 보존하고, 입력 안의 bracketed-paste 종료 시퀀스는 삭제하지 않고 거부한다고 명시한다. 대응하는 F6.1-1 체크리스트 항목은 VT core 집중 검사와 문서 검사로 검증했다.

- F6.2를 완료했다. 터미널 프로그램의 클립보드 저장/조회가 선언된 `clipboard.program` deny/allow 정책을 따른다. 거부는 명시적 `clipboard.rejected` event를 내고 engine의 대기 callback을 정리하며, 허용 경로도 텍스트 클립보드 동작으로 제한한다. 사용자 시작 `terminal.paste`는 별도 경로다. 터미널·Alacritty·VT protocol 집중 검사가 통과했다.

- F6.1을 완료했다. 명시적 터미널 텍스트 붙여넣기가 범위가 지정된 사용자 시작 클립보드 capability를 사용하고, 부재/비텍스트 값을 거부하며, 사이드카 paste 동작을 한 번만 보내고 UTF-8 payload 바이트를 보존한다. 입력 안의 bracketed-paste 종료 시퀀스는 삭제하지 않고 거부한다. 터미널·사이드카 집중 검사가 통과했으며 선택·파일·이미지·터미널 출력 이미지 범위는 F6에 남아 있다.

- 터미널 커서 설정에 타입 있는 플러그인/environment 선언, 공통/프로젝트 저장값의 엄격한 검증, 공용 설정 모달 컨트롤, 터미널 사이드카에 대한 실시간 전달을 추가했다. 패키지·native frame·구조 게이트는 통과했다. 최신 애플리케이션 endpoint가 없어 재빌드 호스트의 설정→픽셀 E2E는 별도 체크리스트 항목으로 남겼다.

- F0.4-1.5를 완료하고 F0.4-1을 닫았다. 교차 언어 실패 matrix가 귀속 가능한 JS/TS·Rust·Go·Objective-C 감사를 실행한다. Wails Darwin capture 상태, recording 정리, shell close, persistent protocol decoding이 더 이상 오류를 버리지 않으며 Wails·shell 테스트와 parity 자기 테스트 27개가 통과한다.

- F0.4-1.4를 완료했다. Darwin capture 실패가 이제 로그만 남기는 `void` 호출이나 조용히 버려지는 잘못된 경로가 아니라 명시적 상태와 오류 문자열로 Objective-C/Rust 경계를 통과한다. native capture 테스트와 기계 실패 감사가 수정된 계약을 검증하고 parity 자기 테스트 25개가 통과한다. 교차 언어 실패 매트릭스는 F0.4-1.5에 남아 있다.

## 미배포

- F5 커서 렌더링 항목을 완료했다. 터미널 커서가 포커스/비포커스 모양, Never/Off/On/Always 깜빡임 정책, 기본 750ms 간격, 5초 idle 제한, 프로그램 가시성, 페이드·크기 애니메이션 없음 규칙을 명시적으로 따른다. Red에서 정책과 잘못된 값 경계의 부재를 재현했고, Green에서 native frame 픽셀 10개·sidecar 계약 41개·Alacritty engine 28개·터미널 모듈 42개 검사를 통과했다. `operation: "cursor"` 계약은 잘못된 값을 거부하고 `blinkVisible`을 보고하며 PTY와 셀 메트릭을 재생성하지 않는다.

- F5.2를 완료했다. 네이티브 그림 포커스 뒤 다음 합성 포인터를 보내기 전에 대상 웹뷰를 응답자로 복원하고, 그림 포커스 통지와 모달 포커스 복원이 WebKit 이벤트 경로에 동기 재진입하지 않게 했다. Red에서 터미널 2·3의 포인터 receipt 시간 초과와 모달 종료 교착을 재현했으며, 재빌드 Tauri·Wails 포커스 행렬이 터미널 3개·브라우저/탭 전환·리사이즈·설정 모달 종료·프로젝트 복귀·별도 프로젝트 창을 포함한 제한된 하위 검사 4/4를 각각 통과했다.

- F5.1을 완료했다. 터미널 표면이 선언된 테마 구독과 `operation: "theme"` 사이드카 요청을 통해 유효한 애플리케이션 라이트/다크 외관을 받는다. 사이드카는 PTY·세션·텍스트·셀 메트릭을 다시 만들지 않고 기본·커서·인덱스 ANSI 래스터 색상을 바꾸며, 잘못된 모드는 명시적으로 거부한다. Rust frame/engine/protocol 검사, 터미널 모듈 검사, 재빌드 Tauri/Wails 픽셀 검사가 통과했고 Wails 표면 테마 바인딩도 호스트 계약에 추가했다.

- F4를 완료했다. 브라우저 문서 facts가 실제 네이티브 first-responder 포커스를 보고하고, 직접 `input.pointer` 누름도 네이티브 이벤트 감시기에만 의존하지 않고 Tauri·Wails 양쪽에서 소유 표면에 전달된다. 재빌드한 Tauri·Wails 포커스 격리 검사가 각각 1/1 통과했고, 양쪽 브라우저 기본 동작 검사가 탐색·주소 입력·문서 스크롤을 통과했으며, 재빌드한 네이티브 facts 검사도 문서 포커스를 보고했다.

- F0.5.7-1과 G2.4를 완료했다. 명령 정착의 표면 표시 순환을 제거하고, hybrid controller가 문서별 paint-boundary token 하나를 공유해 MutationObserver 루프를 만들지 않도록 했으며, Tauri 프로젝트/창 작업을 AppKit 이벤트 루프로 옮기고 Wails 창 준비가 오래된 웹뷰 크기를 다시 적용하지 않도록 했다. 재빌드 단독 프로젝트/창 검사는 Tauri 1/1(3.12초)·Wails 1/1(2.31초), 정상 종료는 65ms·14ms로 통과했다.

- F0.5.7 기록을 정정했다. 명령 정착의 표면 준비 대기가 `명령 정착 → 표면 준비 → 네이티브 표시 → 명령 정착` 순환을 만들어 로딩과 endpoint 무응답을 일으켜 제거했다. 순환하지 않는 계약과 Tauri·Wails 독립 증거는 F0.5.7-1에 남아 있다.

- G2.3을 완료했다. 표면 binder 감사가 이제 ShadowRoot를 `parentNode`로 통과하므로 위임된 shell 컨트롤을 명령 없음으로 잘못 보고하지 않는다. plugin-api 72/72, 재빌드 Tauri·Wails 감사 검사 각각 1/1, 정상 종료 66ms·64ms가 통과했다. 전체 matrix의 다른 실패는 명시적으로 열어 두었다.

- F1을 닫았다. 최신 재빌드 Tauri·Wails 합성/줄바꿈 증거를 하나의 부모 게이트로 기록했다. 디바이더·프로젝트 복귀 캡처가 네이티브 보더 침범과 셸 흰 잔상 없이 통과했고, Alacritty 엔진 검사는 27/27, 양쪽 호스트 창 크기 변경 검사는 각각 1/1 통과했다. 브라우저 포커스, 터미널 상호작용, OSC/CSI, IME, 복원, 모달 후속 항목은 별도로 남아 있다.

- F1.4를 완료했다. 고정 renderer metric, hard/soft newline, 한글·전각 셀, overflow/scrollback, primary와 alternate screen 격리를 검사하는 터미널 줄바꿈 단언을 추가했다. Alacritty 엔진 검사가 27/27 통과했고 최신 재빌드 Tauri·Wails 창 크기 변경 검사가 각각 1/1 통과하며 PTY·DOM plane·네이티브 래스터 기하를 확인했다.

- F0을 완료했다. 명시한 범위의 시작·기존 기본 동작 게이트를 닫았다. 재빌드 Tauri·Wails 하위 검사가 입력, 셸, 브라우저, appearance, 프로젝트/창 수명주기, 소유권, 프로토콜 명칭, 표시를 포함하며, 더 넓은 Wails 동등성과 합성/줄바꿈은 별도 항목으로 남겼다.

- F0.5를 완료했다. 완료한 하위 검사와 최신 재빌드 단일 인스턴스 Tauri matrix가 startup·prompt/output·control·첫 클릭 네이티브 입력·appearance와 surface scope·first-run 프로젝트 열기·view timing·프로세스 소유권·stale composition 거부를 모두 포함한다. 제한된 모든 케이스가 통과했고 정상 종료가 endpoint와 lock을 제거했다.

- F0.5.6을 완료했다. 제한된 재빌드 Tauri matrix에서 실제 SIGABRT가 드러났다. `project_open`과 `window_new`가 비동기 명령이어서 AppKit 창 생성·활성화가 Tokio 워커에서 실행되었고 Rust foreign exception이 IPC 작업 경계를 넘어갔다. 두 명령과 메뉴 콜백이 이제 이벤트 루프 스레드에서 AppKit 작업을 실행한다. 현재 Tauri 터미널·셸·모달/제어·브라우저 탐색/theme·라이브러리/프로젝트·정상 종료 검사가 케이스별 출력을 유지하며 통과했고, 정상 종료가 endpoint와 process lock을 제거한다.

- G3을 완료했다. host pair 감사가 이제 fixture에 주입된 호스트 또는 counterpart 누락을 거부한다. parity·언어·증거·mutation 주입 검사와 합쳐 도구 테스트 80/80을 생략·todo 없이 통과했고 패키지·문서·경계·노출 게이트도 통과했다.

- G3-1을 완료했다. 감사 자기 검사에 중복 소유권, 잘못된 동작 테스트 귀속, 무동작·응답 누락 구현, 필수 생략 언어 결과, 오래된 실행 파일 digest를 주입한다. 전용 검사는 구조 inventory·언어 결과·mutation 동작·내용 해시 증거를 서로 다른 결과로 유지하며 36/36 단언을 통과했고, 전체 패키지 및 저장소 게이트도 통과했다.

- F0.5.4와 F0.5.5를 완료했다. Tauri picker 닫기에서 discard 중 모달 상태 잠금을 재진입해 교착하던 경로를 제거했다. Tauri와 Wails가 이제 설정 디렉터리마다 앱 프로세스 하나만 허용하고 두 번째 소유자에는 명시적 오류를 반환하며, PID가 실제로 사라진 경우에만 오래된 잠금을 교체하고 정상 종료 때 잠금을 정리한다. 재빌드 Tauri의 제한된 모달·명령·3터미널 입력·같은 디렉터리 거부·다른 디렉터리 동시 실행 검사와 양쪽 host endpoint 단위 검사가 통과했다.

- G2-2를 완료했다. host 구조 동작 검사를 이름 있는 테스트로 추가하고 parity feature audit에서 G2-1·G2-2를 연결했으며, G1.4 현재 inventory 기록을 lane 56개·구현 파일 249개·테스트 파일 169개로 정정했다. 이전 56/250/169 결과는 과거 증거로 보존했다. parity 자기 검사와 전체 `pnpm test`가 통과했다.

- F0.5.3을 완료했다. 터미널 표면의 중복 pointerdown 포커스 바인더를 제거하고 카드가 단일 포커스 제스처를 소유하게 했다. `terminal.focus`는 명시적 명령으로 남기고 오류 전달도 관측 가능하게 유지한다. 터미널·워크벤치 테스트와 재빌드 Tauri 3터미널 네이티브 키보드 검사가 제한된 3회 실행에서 두 번째 클릭 없이 통과했다. 앞선 전체 실행의 capture 실패는 환경 디스크 부족 오류이며 제품 통과로 세지 않았다.

- G2-1을 닫았다. Tauri persistent-service process probe를 platform endpoint 계약으로 옮기고 Windows에서는 명시적 미지원 오류를 반환하게 했다. 비공개 helper를 호스트 API 확장 없이 검사하는 진단 전용 Wails 단위 검사는 H5 언어 경계 예외로 기록했다. `make hosts-check`와 선언된 환경의 Tauri host library 검사가 통과했다.

- F0.6을 완료했다. JavaScript/TypeScript, Rust, Go, Objective-C, Tauri, Wails와 테스트·fixture·오류·사양 전체의 사이드카 wire 필드 `op`를 `operation`으로 바꿨다. 이전 필드는 폴백 없이 명시적으로 거부된다. 전체 패키지·언어·문서·경계·노출·네이티브 게이트가 통과했으며 `e70a6e6`으로 커밋했다.

- G4 명령 감독 항목을 닫았다. 전용 감독기 스위트가 1.58초에 16/16 단언을 통과했고 실패·생략·todo가 0개이며, 비정상 종료·실행 파일 없음·타임아웃·취소·관측기 오류·출력 drain 오류·정리 검증 거부를 명시적 실패로 유지한다. 언어 어댑터와 내용 해시 증거는 G4에 남아 있다.

- G4.2 언어 어댑터를 닫았다. `make language-test`가 10초/30초/30초/30초 제한, 시작·진행·종료 이벤트, 기대·실제 테스트 수 비교, 테스트 0개·생략·충돌 거부를 적용해 명시적 JS/TS·Rust·Go·Objective-C 케이스를 실행한다. 현재 재빌드 결과는 JS/TS 16개·Rust 2개·Go 13개·Objective-C 5개이며 모두 생략·todo 없이 통과했다. G4의 남은 내용 해시 증거 항목은 계속 열려 있다.

- 언어 어댑터 구현·manifest·테스트를 추가한 뒤 기계 inventory를 다시 맞췄다. lane 55개·구현 파일 249개·테스트 파일 168개이며 이전 53/247/166 기록은 G1.3-2 아래 과거 증거로 남겼다.

- schema 버전이 있는 언어 증거 레코드를 추가했다. `make language-test`가 구현·테스트·의존성·dirty 작업 트리·빌드 옵션·프로세스·기대/실제 결과·경과 시간·시도 이력을 출력한다. `--evidence-file`은 불변 snapshot이 같을 때만 재시도를 추가하고 오래된 증거는 거부한다. 현재 inventory는 lane 56개·구현 파일 250개·테스트 파일 169개이며 이전 55/249/168 결과는 G1.3-7 아래 과거 증거다.

- F0.4-1.3.3을 완료했다. Rust 실패 감사가 이제 VT core·VT Alacritty·Tauri host·Tauri application production lane을 모두 포함해 남은 bridge 경로를 암묵적으로 남기지 않는다. 선언된 native build 환경에서 production `Result` 무시가 없고, Windows 미지원 연산은 명시적 오류를 반환하며, parity 자기 테스트와 native workspace 검사가 통과했다. Objective-C와 교차 언어 실패 매트릭스는 F0.4-1.4와 F0.4-1.5에 남아 있다.

- F0.4-1.3.2 Tauri host 작업을 완료했다. 범위 Rust 감사에서 callback send·transport read·정리·capture stop·close-owner 직렬화 결과 무시를 찾았다. production lane이 이제 각 결과를 반환하거나 명시적으로 보고하고, recording abort가 stop과 정리의 동시 오류를 보존하며, Tauri Rust 검사와 parity 감사가 통과한다. 남은 Rust host/bridge와 Objective-C lane은 F0.4-1.3.3부터 F0.4-1.5에 남아 있다.

- F0.4-1.2 JS/TS 실패 전달 감사를 완료했다. 기계적 Red inventory에서 client unwatch·exposure release·layout queue·project switching·transcript 경로의 빈/undefined promise rejection handler 6개를 찾았다. 각 경로가 이제 오류를 전달하거나 보고한다. 감사 자기 테스트, 패키지 검사와 저장소 게이트가 통과했으며 Rust·Objective-C lane은 F0.4-1.3·F0.4-1.4에 남아 있다.

- F0.4-1.3.1 VT sidecar 작업을 완료했다. Red clippy 감사에서 actor·session·monitor·shutdown 결과를 무시한 경로를 찾았고, production lane이 이제 각 결과를 반환하거나 명시적으로 보고한다. panic/shutdown 계약 검사는 오류가 관측 가능하게 남는지 요구하며 sidecar 검사와 Rust 실패 감사가 통과했다. Tauri host Rust는 F0.4-1.3.2에 남아 있다.

- Wails 표면 생성 오류 전달을 수정했다. 네이티브 생성 오류와 nil handle이 귀속 가능한 오류로 반환되고, layout 준비 실패는 취소되며, 새로 만든 표면은 되돌려지고, 모달 정렬 오류 뒤 0 사각형으로 대체하지 않는다. Rust·Objective-C 감사 lane은 F0.4-1.3부터 F0.4-1.5에 남아 있다.

- workspace inventory·소유권 강제·기능 증거 연결과 기계 검사가 완료되어 G1을 닫았다. 동작 검증은 각 연결된 기능의 증거 범위에 귀속되며 구조적 완료가 동작 완료를 뜻하지 않는다.

- core·plugin·sidecar·native·애플리케이션·계약 테스트의 구현 소유권 독립을 강제했다. 기계 감사가 plugin→sidecar 구현·테스트 참조 4개를 찾아 제거했고, host-scoped runtime이 플러그인의 선언된 단일 sidecar를 해석하며 package-name·모호한 sidecar fallback을 거부한다. 소유권·집중 runtime 검사가 Green이고 구조 검사가 ownership 오류 0개를 보고한다.

- 완료 항목을 현재 증거와 대조하는 감사를 수행했다. 오래되거나 오해를 일으키는 기록 4개를 찾아 G1.3-2부터 G1.3-5까지 후속 ID로 보존했다: parity 테스트 파일 수, F3 범위 문구, Wails 모달 parity 스냅샷, F0.1의 미커밋 작업 트리 표현이다. 각 수정이 자체 Red/Green 증거와 커밋을 남기기 전까지 원래 주장은 변경하지 않는다.
- G1.4 parity 기록을 현재 기계 출력과 맞췄다: lane 53개, 구현 파일 247개, 테스트 파일 166개다. parity 감사는 기록된 수가 달라지면 실패하며, 자기 테스트 15개가 일치·불일치 경우를 모두 검사한다.
- F3.1/F3.2 범위 문구를 고쳐 과거 순서를 보존하면서 이후 닫힌 F3 검사를 현재 미완료로 보고하지 않게 했다. parity 감사는 오래된 현재형 문구 두 개를 거부하고 자기 검사 16개가 정상·주입된 오래된 기록을 모두 검사한다.
- 2026-09-21 Wails 모달 parity Red를 과거 스냅샷으로 한정하고 원래 실패를 삭제하지 않은 채 현재 F10.2 수정을 명시했다. parity 감사는 날짜 없는 스냅샷이나 현재 수정이 빠진 기록을 거부하며 자기 검사 17개가 통과한다.
- F0.1의 오래된 미커밋 작업 트리 표현을 실제 커밋 빌드 `7a3cee6`으로 바꾸고 원래 범위의 관측을 보존했다. parity 감사는 오래된 문구나 커밋 식별자 누락을 거부하며 자기 검사 18개가 통과한다.
- 완료된 모든 기능에 대한 증거 연결 감사를 완료했다. parity 감사는 구현 진입점·이름 있는 동작 테스트·기대 결과·검증 수준이 없는 완료 기능을 거부하며, 집계형 검토 기록은 기능에서 명시적으로 제외한다. 41개 링크 감사, 자기 테스트 15개, 워크스페이스·경계·노출·문서 검사가 통과했다.
- 양쪽 네이티브 호스트의 브라우저 문서 웹뷰에 호스트 dark/light appearance 변경을 명시적으로 전달한다. F3의 애플리케이션 픽셀 및 복원/신규 문서 검증은 아직 남아 있다.
- 표면 복원 시 네이티브 문서가 숨은 상태로 남는 문제를 수정했다. 문서 기하를 재적용하기 전에 표면 호스트를 먼저 표시한다. 현재 Tauri 브라우저 E2E에서 수정 전 프레임은 정확하지만 `visible:false`가 관측되었고, 네이티브 회귀 검사와 재빌드 브라우저 탐색·입력·스크롤·배치·격리 검사가 통과했다. F3 통제 사이트 픽셀과 복원/신규 문서 검증은 남아 있다.
- 네이티브 문서를 만들 때 현재 호스트 테마를 적용하고 브라우저 표면별 명시적 HTTP(S) 위치를 보존한다. 재빌드한 Tauri·Wails 브라우저 E2E가 기존·신규·재로드 문서의 통제 사이트 light/dark 픽셀 검사를 통과하며, 잘못된 저장 위치는 명시적으로 실패한다.
- Google Search 사이트 설정 격리를 검증했다. disposable profile의 명시적 라이트 설정은 호스트가 light→dark로 바뀌어도 `[255,255,255]`로 유지되고 Google URL도 양쪽 재빌드 호스트에서 변하지 않는다.
- 터미널 자원·복구 게이트를 명시적 실패 영역 경계와 함께 닫았다. 애플리케이션 종료/업데이트는 살아 있는 공유 서비스에 재연결하지만, 서비스 충돌은 서비스 실패로 보고하고 소유권이 불명확한 새 세션으로 바꾸지 않는다.

[English](CHANGELOG.md)

## 미배포

- 정상 종료 창 검사의 고정 sleep을 endpoint 파일 이벤트와 상태 알림으로 교체했다. 케이스별 거부 타이머와 경과 시간 출력을 유지하며 애플리케이션 PID와 endpoint가 모두 사라지는 것을 요구한다. 현재 재빌드 Wails·Tauri 검사가 14ms·25ms에 통과했고 전체 스크립트 스위트가 Green이다.

- 3터미널 디바이더 검사를 세 번의 프로젝트 복귀 세트 각각 누른 채 연속 최소↔최대 폭 5왕복으로 강화하고, 실제 범위 이동과 디바이더 옆 카드가 기본 최소 카드 가장자리 96pt와 간격 12pt에 도달했음을 요구하며, 기능 `F1.3`으로 연결했다. 준비된 DOM/네이티브 레이아웃 스냅샷을 보존하고 draw 트랜잭션을 도착 순서대로 처리해 빠른 입력을 조용히 교체하지 않는다. 현재 재빌드한 Wails와 Tauri 검사가 `ms:96` 3세트를 모두 통과했고 세트마다 끝점 전환 11개와 합성 단언을 확인했으며, 이전 Wails 7/11 Red를 수정했다.

- 레이아웃 준비 중에는 네이티브 표면을 숨기고 앱 DOM 표시가 끝난 뒤 일치하는 표시 티켓에서만 각 표면을 표시하도록 했다. Tauri·Wails 호스트 계약이 준비와 표시 사이에 선언된 표시 상태를 전달하며 호스트 컴파일과 집중 검사가 통과했다. 재빌드 애플리케이션 캡처 증거는 아직 대기 상태다.

- 엔드포인트 프로세스가 현재 실행 파일 빌드보다 먼저 시작된 경우 창 증거를 거부한다. 집중 stale 프로세스 검사가 오래된 바이너리를 현재 증거로 측정하지 않고 명시적으로 실패하며, 계약 단언 3개와 실제 Tauri 창 시도가 거부를 확인한다.

- 제한 시간 정상 종료 검사를 parity 감사의 구현·이름 있는 동작·기대 결과·애플리케이션 검증 수준에 연결했다. 감사가 이제 기능 링크 25개를 검사하며 저장소 전체 연결 집합은 여전히 미완료임을 명시한다.

- 선언된 `command.run` → `host.quit` 경로를 검사하는 제한 시간 검사 `e2e/normal-shutdown.mjs`를 추가했다. 준비된 창 하나를 기다리고 `null` 응답을 요구한 뒤, 재빌드한 Wails·Tauri의 애플리케이션 PID와 엔드포인트가 5초 케이스 제한 안에 사라지는지 확인한다. 선언되지 않은 직접 `host.quit` 엔드포인트 호출은 생명주기 증거로 취급하지 않는다.

- 현재 재빌드한 macOS 호스트에서 프로젝트·라이브러리 반복 복귀를 검증했다. Tauri 0.98초, Wails 2.99초 검사에서 복귀 3회 동안 앱 DOM 1개, 브라우저 문서 2개, 터미널 서비스 PID 1개, 셸 PID 3개와 모든 터미널 세션 ID를 유지했다. 정상 서비스 종료를 완료했다고 주장하지 않으며 별도 게이트로 남긴다.

- Wails 진단 캡처가 실제 프레임 수·최장 간격과 함께 상한 도달 상태 `limited`를 반환하게 했다. 상한 도달은 정상적인 제한 결과로 유지하며, Wails payload 검사가 상한·비상한 응답을 모두 다루고 다시 빌드한 진단 호스트의 집중 검사를 통과한다.

- 두 macOS 호스트의 비동기 셸 명령 검증을 완료한다. 주입한 포인터 요청을 직렬화하고, 현재 receipt를 등록하기 전에 WebKit의 대기 중인 마우스 작업을 비우며, 뗌으로 생성된 click을 기다리고, 명시적인 미수신 오류를 유지한다. 전용 셸 e2e의 세 케이스가 Wails와 Tauri에서 모두 통과하며 네이티브·워크스페이스·경계·노출·문서 검사가 통과한다.

- 마운트 브라우저 모듈에서 최초 포커스 주소 선택과 최초 뗌 시 선택 유지를 복구하고 후속 클릭의 캐럿 편집과 처리기 해제를 유지한다. 선택 명령은 등록소로 바인딩한다. 모듈이 이전 페이지 진입점을 대체한다. 신규 회귀 2개가 수정 전 실패했으며 브라우저 패키지 검사 9개와 재빌드 macOS Tauri의 탐색·네이티브 대체 입력·스크롤·배치·격리가 통과했다. 미커밋 변경을 포함한 이 구현에서 터미널·셸·설정·추가/분할 메뉴 기본 검사도 통과했으며 Wails 통합은 남아 있다.

- 카드 선택 전파를 막지 않고 DOM 앵커의 기본 포커스 동작을 취소하여 포인터를 뗄 때도 네이티브 터미널 포커스를 유지한다. `terminal.focus`를 선언·바인딩하고 실패를 세션 상태에 노출한다. 단위 회귀 2개가 Red를 재현했고 재빌드 macOS Tauri에서 터미널 3개의 네이티브 편집과 추가 클릭 없는 연속 명령이 통과했다. 이 결과는 Wails 포커스 통합이나 커서 렌더링을 검증하지 않는다.

- 노출 DOM 사각형에 더하던 오래된 표면 문서 오프셋을 제거했다. 마운트 플러그인 모듈은 앱 좌표를 공유하고 별도 문서 원점은 유지한다. 수정 전 좌표 회귀 검사 2개가 실패했으며 등록소 검사 16개와 패키지 테스트가 통과하고 두 호스트를 빌드했다. 재빌드 Tauri에서 좌표 수정과 첫 터미널의 네이티브 입력을 확인했다. 남은 터미널 포커스·브라우저 주소 선택 실패는 별도로 기록하며 앱 통과로 보고하지 않는다.

- 시작/진행/종료·경과 시간·원본 출력 전달·시간 초과/취소·정리 증거를 갖춘 명령 그룹 감독기를 추가했다. 권한 거부를 프로세스 부재 증거로 취급하지 않는다. 잘못된 EPERM 성공의 Red를 포함해 감독기 단언 16개가 통과했다. 언어별 케이스 어댑터와 전체 프로세스 소유권 검사는 남아 있다.

- 고정된 감사 루트 밖의 소스·테스트 언어를 발견하고 연결 없는 파일을 구조적 실패로 공개하며 동작 동등성으로 보고하지 않는다. 누락 파일 여섯 범주와 중복 소유 재현 검사를 추가했다. 빈 성공 명령 대신 실제 Rust 터미널 패키지 검사를 실행하고 루트 검사에 감사 자체 검사를 연결했다. 목록/체크리스트/패키지 명령 단언 22개와 패키지 스위트는 통과했고 저장소 목록과 Tauri 네이티브 키보드 인수 검사는 실패 상태다.
- docs-check에서 정본 체크리스트 하나와 번역 상태 일치를 강제한다. ID 중복·잘못된 상태·순서/깊이 차이·완료 ID 재개/삭제를 거부하고 후속 이슈는 완료한 선행 항목을 유지한다. 잘못된 전환 8개가 실패를 재현한 뒤 체크리스트 단언 9개가 모두 통과했다.

- Wails의 메인 페이지 바인딩과 표면 브리지에 `CompositionDeclare`를 등록하고, 배치 전에 불변 계약을 검증·저장하며 런타임 메서드 맵을 동기화했다. 다시 빌드한 Wails 앱은 `unknown host call: compositionDeclare`로 표면 마운트에 실패하지 않으며, 3터미널 프로젝트 복귀와 빠른 분할기 검사가 다시 빌드한 Tauri 검사와 함께 통과한다. 네이티브 합성 검사, 문서 검사, diff 검사가 통과했다.

- 터미널 PTY 자식 회수를 PTY 출력 reader와 분리했다. PTY master가 열린 채 자식이 먼저 끝나도 전용 reaper가 기다리며, 정상 종료는 세션을 제거하기 전에 reader와 reaper를 모두 join한다. 새 다시 빌드한 호스트 검사가 Tauri와 Wails에서 통과했다. 터미널 3개가 PTY 자식 3개를 만들고, 터미널 탭을 모두 닫은 뒤 공유 서비스 PID는 유지되며 PTY 자식과 좀비가 남지 않는다.

- 창 진단에서 웹뷰뿐 아니라 논리 네이티브 컨테이너를 측정한다. 하나의 UI 스레드 스냅샷에서 위치, 컨테이너 식별자, 그림 상태를 읽어 측정 중 부착이 닫혀 핸들이 무효화되지 않게 한다. 컨테이너 3개 검사가 수정 전 실패하고 수정 후 통과했다. 앱 DOM 재로드는 영속 터미널 세션을 닫지 않고 모든 플러그인 부착 상태를 정리하며 실제 앱 재로드와 재연결 검증은 남아 있다.

- 단일 DOM의 실제 기동·표면 생성 오류를 수정한다: 공개된 이름 기반 AppKit appearance API 사용, 표면 포트 레지스트리를 소비자와 같은 범위에 배치, 설정 폴더 생성 후 경로 정규화, 네이티브 창 생성 후 Wails 메인 뷰 등록, 표면 삽입 전 Tauri 조회 잠금 해제, Wails 창 핸들을 등록된 앱 웹뷰로 변환. 잘못된 핸들의 네이티브 검사가 수정 전 충돌을 재현했고 수정 후 표면 호스트 검사 29개가 통과했다. 앱 관측에서는 여전히 플러그인 마운트 통합 오류가 발생하며 이 구성요소 결과로 터미널 정상 동작을 판단하지 않는다.

- 네이티브 표시 대기의 URL 출처 추정을 창의 단일 앱 DOM 소유권으로 바꾼다. 네이티브 회귀검사에서 같은 출처의 별도 문서로 인한 3.007초 지연을 재현했고 해당 대기를 제거한 뒤 0.009초로 통과했다. 앱 DOM과 열린 트랜잭션 대기는 유지한다. 구성요소 검사 11개가 통과했으며 재빌드한 호스트 합성 검증은 남아 있다.
- 터미널 입력의 base64 디코더가 유효한 앞부분만 조용히 수락하지 않도록 라이브러리의 엄격한 디코더로 잘못된 인코딩을 거부한다. 새 잘못된 입력 검사는 수정 전 실패했고 수정 후 인코딩 검사 2개가 통과했다.

- 빈 콜백에서 버리던 네이티브 그림 이벤트를 소유 Tauri 표면에 전달한다. 즉시·대기 중인 터미널 입력에서 조합키 문자를 보존한다. `terminal.screen` 알림을 공개하고 창 검사의 반복 화면 요청을 현재 화면 한 번 읽기와 상태 알림으로 대체하며, 검사 문자를 복원할 때 빈 셀의 폭을 보존한다. 새 네이티브 입력 검사는 수정 전 실패했고 수정 후 두 macOS 호스트의 터미널 각 3개에서 통과했다(8개 검사, 실패·생략 없음). 타이핑·Backspace·Ctrl+U·Enter·출력·격리를 확인했다. 패키지 검사, 네이티브 검사, 두 빌드, 구조 검사가 통과했다. 합성 검증은 별개다.

- 기존 표면을 숨길 때 보이지 않는 1×1 뷰포트를 적용하지 않고 네이티브 프레임과 스냅샷을 유지한다. 바깥 표면이 숨겨져 있으면 그림 설정을 보내지 않고, 표시 전에 실제 네이티브 좌표로 보이는 그림 래스터를 갱신한다. 네이티브 상태 검사는 숨겨진 설정과 갱신 대상을 검사하며, 터미널 3개의 창 검사는 라이브러리 진입 전후의 프레임과 스냅샷을 비교한다.
- 첫 문서 로드나 이동을 위해 그림 영역을 정리할 때 바깥 표면의 표시 상태를 유지한다. 두 호스트 단위 테스트로 첫 연결 전에 숨김 상태가 제거돼 숨겨진 1×1 그림을 잘못 설정하는 문제를 재현했다. 창 하네스는 재로드 전에 픽스처 표시를 요구하고 표시 오류 로그도 수집해, 재로드가 실패한 준비를 해제하고 그 실패를 테스트 결과에서 감추지 못하게 한다.

- 네이티브 배치 커밋 전에 앱 문서 표시를 기다리도록 복원하고, 그림 픽셀의 원래 배율과 영역 상태의 네이티브 표시 오류를 유지하며, 인셋에 소수점 visual viewport 크기를 사용한다. Tauri 이벤트 콜백에서 커밋이 창을 동기적으로 다시 그리면 교착할 수 있으므로 커밋과 취소를 네이티브 메인 큐에서 실행한다. 라이브러리 검사 실패의 스레드 샘플로 잠금 재진입을 확인했다. 문서 표시 대기 자체가 교착 원인은 아니었다.
- 실패한 배치 요청은 거절과 검증·오류 표시를 유지하면서 다음 명시적 사용자 작업은 실행한다. 거절된 준비 Promise를 재사용하거나 같은 티켓을 두 번 표시하지 않는다. 패키지 검사는 실패 후 복구, 요청 순서, 소수점 뷰포트 인셋, DOM 그리기 이전 준비를 검증한다.
- 네이티브 캡처 검사를 강화한다. 모든 프레임의 터미널 영역 3개, 테두리 침범과 흰 픽셀 0개, 글자 크기·픽셀 수 불변, 요청한 모든 왕복을 요구한다. 5회 왕복과 프로젝트 복귀를 3세트 반복하고, 이후 동작이 지운 표시 오류도 실패로 처리한다. 측정용 픽셀 픽스처는 정지 화면, 사라진 터미널, 1픽셀 테두리 침범, 흰 줄, 늘어나거나 사라진 글자를 거절한다. 기존 페이지 기반 진단 제스처는 바꾸지 않았으며 OS 버튼 상태의 증거가 아니다. 현재 측정 결과와 해결되지 않은 검증 실패는 [기능 상태](docs/features.ko.md)에 기록한다. 전체 배포 통과로 보고하지 않는다.

- DOM 전용·혼합 플러그인 페이지에 적용하는 단일 표면 합성 경계를 정의하고 구현한다. 각 표면은 클리핑하는 `SurfaceHost` 하나, 선언한 문서·그림 영역의 네이티브 평면, 그 위의 DOM 평면 하나를 가지며, 선언한 DOM 오버레이만 네이티브 문서 위에서 DOM 입력을 소유한다. 플러그인 manifest가 완전한 합성을 선언하고 페이지 API가 리비전을 가진 완전한 스냅샷을 보내며 두 호스트가 부분·오래된·미선언 연산을 거절한다. 그림 래스터 크기는 적용된 네이티브 좌표에서만 얻는다. 호스트는 연속 크기 변경 중 불변 스냅샷을 유지하고 메인 스레드에서 오래된 프레임을 다시 거절하며 `host.window.presented`가 표시 중인 현재 래스터를 기다리게 한다. 터미널은 그림 크기를 계산하거나 보내지 않는다. 네이티브 검사는 소수점 2×/1× 좌표, 마지막 장치 픽셀 입력, 클리핑, 오버레이 적중 소유권, 래스터 변경, 불변 그림 표시를 다룬다. 패키지·경계·노출·플랫폼·호스트·네이티브·활성화·전체 라이브러리 검사가 통과하며 두 macOS 호스트 빌드가 통과한다. 다시 빌드한 애플리케이션의 창 검사는 대기 중이다.
- 그림 영역을 추가한다: 네이티브 표면이 사이드카가 IOSurface 토큰으로 공급하는 그림을 표시할 수 있다. 페이지가 `attachImageRegion(element, name, sidecar)`를 호출해 표면 아래 영역을 붙인다. 사이드카가 토큰, 크기, 순서 번호가 담긴 그림 봉투를 호스트로 보낸다. 호스트는 그림을 검증하고, 다음 그림을 표시한 뒤 이전 그림을 반납하며, 토큰·크기·접근 거부 오류를 보낸다. 사이드카는 영역에서 키보드·조합·초점 이벤트를 받는다. 두 앱에 PTY 데몬(`sidecars/ptyd`)을 써 그림 영역에 렌더링하는 터미널 플러그인을 더한다. 이 데몬은 두 호스트와 셸 사이드카가 공유한다. `packages/plugin-api/image-region.js`와 `page.attachImageRegion`을 더한다. PTY 데몬이 세션 생명주기를 관리한다(분리는 세션을 계속 살리고, 종료는 끝낸다). 유휴 기한은 디버그 60초/릴리스 5분이며 `PTYD_IDLE_TIMEOUT`으로 무시할 수 있다. 터미널 사이드카(`@soksak/sidecar-vt-core`)가 터미널 에뮬레이터를 구현하며 `open`, `input`, `resize`, `screen.read`, `close` 요청을 처리한다. 창 검사에 `e2e/terminal.test.mjs`를 더해 셸 사이드카를 통한 터미널 입력을 검사한다. 새 그림 영역과 터미널 플러그인을 통과하도록 `e2e/browser.test.mjs`를 업데이트했다. 패키지 테스트, `make docs-check boundaries hosts-check native-test`, Wails macOS 빌드가 통과했고, Wails 애플리케이션에서 터미널이 창의 장치 배율로 그려진다. 영역을 통한 키보드 입력은 아직 동작하지 않고, Tauri 애플리케이션과 터미널 창 검사는 검증하지 않았다.
- URL 표면 대신 문서 영역에 웹 문서를 표시한다([네이티브 표면](docs/spec/native-surfaces.ko.md#문서-영역)). `plugin.json`의 `surface`는 `page`만 받고, `home`은 표면 페이지가 처음 여는 주소다. `surface.url`, 워크벤치의 `external` 표시, Tauri의 외부 표면 주소를 제거했다. `native/darwin`에 `document_view.m`을 추가했다: 표면 웹뷰 안의 웹뷰이며, 별도 영구 데이터 저장소, http·https 이동만 허용, 격리된 콘텐츠 월드에서 받은 스크롤 위치를 포함한 상태 보고, 뷰포트 여백 배치, 대화 상자 블러를 제공한다. 두 호스트에 `DocumentAttach`/`document_attach`, 배치, 로드, 이동, 분리 호출을 추가했다. 호스트는 호출한 웹뷰가 요청의 표면인지 확인하고, `document-state`를 그 표면에만 보내고, 표면이 제거되거나 표면 페이지가 새 문서를 커밋하면 영역을 닫고, `host.window`의 `documents`와 `host.hit`의 `{kind: "document"}`로 영역을 보고한다. Tauri 문서 명령은 메인 스레드 밖에서 실행하고, 메인 스레드에서 시작한 정리는 기다리지 않는다. 플러그인 API에 `attachDocument`(`ResizeObserver`, resize, scroll 이벤트로 배치), `ownManifest`, 두 런타임의 `page.document`를 추가했다. 브라우저 플러그인은 주소창, `browser.location`, `browser.navigate`·`back`·`forward`·`reload`·`stop` 명령을 가진 페이지가 되었고, 도구 막대는 카드 토큰을 사용한다. 목록에 문서 웹뷰의 `_setOverrideDeviceScaleFactor:`를 추가했다. `e2e/browser.test.mjs`는 이동, 기록, 주소 입력, 활성화 없는 네이티브 스크롤, 표면 이동·크기 변경 후 배치, 브라우저 표면 간 격리, 표면과 함께 닫힘을 검사하며, 설정 검사는 브라우저의 점이 문서 영역에 속한다고 기대한다. 패키지 테스트, 호스트 테스트, `make native-test`, `make release-check`, macOS·Windows 대상 `diagnostics` 유무별 `cargo check`, Windows `go vet`이 통과했다. 문서 영역은 표면 크기가 바뀔 때마다 여백으로 프레임을 다시 정한다. 자동 크기 조정은 표면이 여백보다 작아졌던 뒤에 여백을 잃었다. 영역은 이동을 요청한 때부터 그 이동이 시작되거나 실패할 때까지 `loading`으로 보고한다. 대체된 읽기가 새 주소의 읽기를 시작 전에 끝났다고 보고했기 때문이다.
- 창 검사가 의존하는 사실을 더 측정하고 보고한다. 녹화 프레임 파일에 버퍼 안에서 창이 차지한 사각형, 콘텐츠·백킹 배율, 표시 시각을 기록한다. `diagnostics.capture.start {display?}`는 다른 요청의 앞뒤를 녹화하고, `display`이면 창이 있는 디스플레이에서 이 앱의 창을 녹화해 전체 화면 Space에서도 녹화를 이어 간다. 녹화는 blank·suspended 프레임을 알리고, 프레임을 처리기에서 복사해 별도 큐에서 쓴다(2×에서 최대 480ms 걸린 쓰기가 프레임을 버렸고 간헐적 프레임 수 실패의 원인이었다). `diagnostics.capture.stop`은 `longestGap`을 반환하며, 간격이 100ms를 넘는 끌기 녹화는 실패한다. `sp_input_activate`는 멈춘 단계(거절, 키 창 아님, 웹뷰 대기, 빼앗김)와 최전면 애플리케이션을 알리고, 두 호스트는 이를 1006 메시지에 넣는다. `host.window`에 `maximized`, `host.screens`에 `visible`을 더하고, `host.window.fullscreen`으로 전체 화면에 들어가고 나온다. `e2e/resize.test.mjs`는 최대화와 복원을 녹화해 배치가 창 프레임보다 늦은 프레임을 보고한다(두 호스트 모두 250~400ms). 배치가 표시될 때까지 창의 Core Animation 트랜잭션을 붙잡는 방식은 프레임을 맞췄지만 AppKit 애니메이션을 느리게 했고, Wails의 디스플레이 링크 애니메이션은 조절하지 못했으며, 계속 그리는 페이지에서 멈췄으므로 제거했다.
- 네이티브 입력이 순서대로, 요청한 거리만큼 도착하게 한다. `input.pointer`의 누름과 뗌은 문서가 받은 뒤 답하며, 수신은 별도 WebKit content world의 스크립트가 알린다. 입력 칸에 초점이 있으면 WebKit은 마우스 이벤트를 입력기에 비동기로 넘기므로, 함께 보낸 누름과 뗌이 셸 페이지에 반대 순서로 도착했다. 스크롤은 대상 뷰가 표시한 뒤 전달한다. WebKit은 그보다 먼저 받은 휠 이벤트로 새 문서를 스크롤하지 않는다. 장치 픽셀 표면 컨테이너 안 웹뷰로 가는 휠 이동량은 앱의 이벤트 모니터와 네이티브 스크롤 입력에서 컨테이너 단위로 바꾼다. 2×에서 모든 표면과 문서 영역이 절반 거리만 스크롤했다. 페이지 런타임은 사이드카 메시지를 호출 순서대로 보낸다.
- 검사가 찾은 멈춤과 경합을 고친다. Tauri 호스트는 `host.window`에서 모달 뷰 잠금을 쥔 채 메인 스레드를 기다렸고, 메인 스레드는 모달을 배치하려고 그 잠금을 기다렸다. 엔드포인트 `command.run`은 메인 페이지를 자체 10초 제한 없이 기다린다. 메인 페이지는 전달한 명령을 선언의 제한 시간 안에 답하기 때문이다. 준비되지 않았거나 다시 읽히는 메인 페이지에 보낸 요청은 1003으로 끝난다. 코어 명령은 예약한 그리기가 끝난 뒤 답하므로, `core.boundary.move`가 카드가 옮겨지기 전에 반환하지 않는다. `soksak-stage`는 배치한 사이드카 실행 파일을 새 파일로 교체한다. 실행된 적 있는 파일을 덮어쓰면 macOS가 새 프로세스를 종료했다. 브라우저 검사는 페이지 제목과 전체 스크롤 거리를 기다린다.
- 환경에 등록되지 않은 플러그인이나 섹션을 가리키는 저장된 스페이스를 연다([프로젝트](docs/spec/projects.ko.md#저장)). 워크벤치는 그 탭·레일·레일 너비를 제거하고, 탭이 모두 없어진 카드는 닫거나 새 탭을 넣으며, 세트 이름에서 그 섹션을 건너뛰고, 라이브러리 미리보기에서 제외한다. 이전에는 터미널 플러그인이 `shell`이 되기 전에 저장한 데이터처럼 이런 스페이스나 미리보기가 `unknown plugin`이나 `unknown section`으로 실패했다. `e2e/projects.test.mjs`가 두 호스트에서 검사한다.
- 두 호스트가 종료 신호에서 정상적으로 끝난다([엔드포인트](docs/spec/endpoint.ko.md#주소-확인)). SIGTERM, SIGINT, SIGHUP은 기본 동작으로 프로세스를 끝내 `endpoint.json`과 소켓을 남겼다. Wails v3.0.0-beta.16은 신호 처리기를 만들기만 하고 시작하지 않는다. `platform/darwin/termination.*`의 `OnTermination`/`on_termination`은 첫 신호를 `host.quit`과 같은 종료(준비된 창을 먼저 저장)로 바꾸고, 그 뒤의 신호는 프로세스를 끝내게 둔다. Wails 기본 처리기를 끄고, Tauri 호스트에 `signal-hook`을 추가한다. 두 호스트는 수신 전에 같은 애플리케이션의 끝난 프로세스 소켓을 제거한다. `tests/termination_test.*`가 자식 프로세스에서 신호를, `tests/endpoint_test.*`가 제거를 검사한다. Tauri 호스트의 기존 clippy 경고 3개를 고치고, [네이티브 호스트](docs/spec/hosts.ko.md)의 호스트 트리에 문서 영역과 종료 파일을 적는다.
- 창의 표시 완료를 알리기 전에 확정되지 않은 배치를 기다리고, 녹화는 표시된 화면까지 담는다([네이티브 표면](docs/spec/native-surfaces.ko.md), [노출](docs/spec/exposure.ko.md)). 새 표면 준비는 창의 열린 레이어 트랜잭션을 연장하므로, 화면이 아직 이전 배치를 보여 주는 동안 표시 갱신이 끝날 수 있었다. Tauri에서 최대화 검사가 12회 중 3회, 20회 중 2회 마지막 프레임이 이전 크기인 채로 실패했다. `native/darwin`에 `surfaceLayoutAfterSettled`를 추가한다. 창에 열렸거나 대기 중인 준비가 없어질 때까지 기다리고, 이어서 표시 갱신을 기다린 뒤 화면의 `CADisplayLink`에서 다음 갱신 시각을 읽는다. 두 호스트는 `host.window.presented`에 이를 쓰며, 결과로 `{displayed}`를 반환한다. `diagnostics.capture.stop`은 `after`를 받아 그 시각의 화면을 스트림이 전달한 뒤 멈추고, 하네스는 끌기와 크기 변경에서 이 값을 넘긴다. 검사의 after 훅은 세션이 연결을 닫은 뒤 실행되므로, `resize.test.mjs`는 녹화를 측정 직후 지우고 창 복원을 세션 정리에서 한다. 복원이 실패하면 삭제가 건너뛰어져 21GB의 녹화가 남았고, 디스크가 차서 이후 녹화가 멈췄다. 이후 최대화 검사는 연속 30회 통과했다.
- 모달의 내용과 위치를 호스트가 바꾼 순서대로 적용한다([네이티브 모달](docs/spec/native-modals.ko.md)). 모달 문서는 처음 내용을 호출 응답으로, 이후 변경을 이벤트로 받는다. 나중 위치 이벤트보다 늦게 도착한 응답이 설정 창을 처음 위치로 되돌려 Wails 명령 검사가 한 번 실패했다. 두 호스트는 내용과 위치의 변경마다 번호를 붙이고, `workbench/modal-order.js`가 오래된 값을 버린다. `core.modal`의 `document`에 `loaded`를 추가하고, 디버그 빌드에 `diagnostics.modal.hold`와 `diagnostics.modal.held`를 추가한다. `modal.test.mjs`는 이를 이용해 이동 뒤에 첫 응답을 보내며, 변경 전에는 두 호스트에서 실패했다. Tauri의 `overlay_content` 명령은 더 이상 메인 스레드에서 실행하지 않는다.
- 두 호스트의 창 확대 애니메이션을 짧게 한다([네이티브 호스트](docs/spec/native-host.ko.md)). 창 프레임과 웹 내용은 따로 표시되므로 애니메이션이 진행되는 동안 이전 배치가 보였다. `resize.test.mjs`의 측정으로 Wails 263ms, Tauri 432ms였다. AppKit은 그 길이를 `NSWindowResizeTime` 사용자 기본값에서 읽으며, AppKit의 확대와 Wails 창의 대체 애니메이션이 모두 이 값을 쓴다. 0은 무시되므로 `native/darwin/src/window_motion.m`이 첫 창을 만들기 전에 0.001을 등록하고, 사용자가 직접 설정한 값이 있으면 그 값이 우선한다. 이제 배치가 최대 116ms 안에 따라오며, `resize.test.mjs`는 150ms를 넘으면 실패한다. 연속 20회 통과했다. `native/darwin/tests/window_motion_test.m`은 값을 등록한 프로세스와 등록하지 않은 프로세스의 크기 변경 시간을 비교한다(0.350초와 0.003초).
- 표면은 호스트가 적용한 프레임을 유지한다([네이티브 표면](docs/spec/native-surfaces.ko.md)). 표면 웹뷰에 웹 인스펙터를 붙이면 WebKit 이 그 뷰를 창의 남은 자리로 옮기고 인스펙터를 닫아도 그대로 두었다. 실행 중인 애플리케이션에서 셸 표면이 창 전체 폭이 되었고(412,121 428×357 대신 0,250 1512×228), `core.verify` 가 `V7b applied == declared` 를 1083px 차이로 보고했다. `webviewSetFrame` 은 표면 좌표계에 속한 뷰의 프레임을 기억하고 다른 곳에서 바뀌면 되돌린다. 그래서 열린 인스펙터는 표면을 옮기지 않고 그 위에 겹친다. 대화상자 모달은 창 크기를 따라가므로 그대로 둔다. `native/darwin/tests/webview_inspector_test.m` 이 `_WKInspector` 로 인스펙터를 열고 창에 붙여 표면 프레임을 검사한다. 수정 전에는 0,250 1000×100 이었다.
- 창 단추를 AppKit 이 소유하게 한다([네이티브 호스트](docs/spec/hosts.ko.md#창-단추)). 호스트는 페이지 첫 행(45pt)의 가운데에 맞추려고 단추를 자기 뷰로 옮겼는데, 제목이나 녹화 표시가 바뀔 때마다 AppKit 이 되찾아 갔고 그 사이의 프레임이 화면에 나왔다. 창 이동과 크기 변경을 녹화해 보니 48회당 한 번꼴로 단추가 사라지거나 제목줄 자리에 있었다. 이제 창마다 항목이 없는 도구막대를 unified compact 방식으로 붙여 제목줄을 40pt 로 만들고 AppKit 이 그 가운데에 단추를 둔다. `windowUnifiedTitlebar` 가 `windowPlaceControls` 를 대신하고, 단추를 담던 컨테이너는 없앴다. 페이지는 첫 행의 높이를 단추 영역에서 얻으므로(`--chrome-h`) 행이 제목줄을 따른다. `native/darwin/tests/window_controls_test.m` 이 크기 변경과 제목 변경 뒤의 가운데 정렬을, `e2e/controls.test.mjs` 가 두 호스트에서 이동·크기 변경·최대화·제목 변경 6회 반복을 검사한다.
- 첫 행과 전체 화면을 맞춘다([네이티브 호스트](docs/spec/hosts.ko.md#창-단추), [노출](docs/spec/exposure.ko.md)). 첫 행 높이를 단추 위치에서 얻으면 전체 화면에서 행이 1884pt 가 되었다. 전체 화면에서는 AppKit 이 단추를 행 밖으로 옮기기 때문이다. 이제 호스트가 페이지에 단추 영역과 제목줄 높이를 함께 주고, 제목줄이 없으면 페이지는 쓰던 행 높이를 지킨다. `host.window.fullscreen` 은 전환이 끝난 뒤에 답한다. macOS 는 전환 중의 요청을 무시하므로 `sp_window_fullscreen` 이 그 전환이 끝난 뒤에 적용한다. 이름을 `sp_` 로 시작하는 것은 Wails 가 자기 `windowFullscreen` 을 컴파일해 링커가 그것을 골랐고, 창은 바뀌는데 호스트는 실패로 보고했기 때문이다. `native/darwin/tests/window_fullscreen_test.m` 과 `e2e/controls.test.mjs` 가 둘 다 검사한다.
- Tauri 호스트가 프로젝트 창 위치를 창 좌표로 저장한다([프로젝트](docs/spec/projects.ko.md#저장)). `windowState` 는 크기는 포인트로, 위치는 물리 픽셀로 반환해 배율 2 인 화면에서는 저장된 수가 화면 원점에서 두 배 떨어진 자리를 가리켰다. x 755 에 있던 창은 1510 으로 저장되어 1512pt 화면의 오른쪽 끝에 붙어 다시 열렸고, 그 크기에서는 내용 열이 57pt 까지 눌렸다. Wails 호스트는 이미 포인트로 저장했으므로 같은 파일이 두 자리를 뜻했다. `e2e/projects.test.mjs` 가 저장된 값과 호스트가 보고하는 창 프레임을 비교한다. 바꾸기 전 Tauri 에서 실패하고 Wails 에서 통과했다.

- 레일 외곽선을 판의 CSS 픽셀에 그린다([네이티브 표면](docs/spec/native-surfaces.ko.md)). 외곽선은 판을 덮는 요소 안의 SVG 경로이고, 그 요소는 격자 크기의 좌표계를 갖고 있었다. 창이 커지면 요소는 페이지가 다시 그리기 전에 판을 따라 커지고 이전 경로가 새 상자에 맞춰진다. 전체 화면 전환을 녹화한 프레임에서 카드·사이드바·표면은 아직 이전 크기인데 외곽선만 커진 배치를 감싸고 있었다. 좌표계를 두지 않으면 경로의 수가 CSS 픽셀이므로, 외곽선은 다시 그릴 때까지 카드와 함께 제자리에 있다. `packages/workbench/test/rail.test.mjs` 가 페이지와 판 모두 요소에 맞춰 늘어나는 좌표계를 두지 않는지 검사한다.
- 패키지 검사, `make docs-check boundaries platforms hosts-check e2e-check exposure-check native-test`, `make release-check`, `diagnostics` 유무별 macOS Tauri 앱과 Windows Tauri 호스트의 `cargo check`, Windows `go vet`, `make -C native/darwin test-activation`이 통과한다. `make -C native/darwin test-activation`은 앞에 양보하는 앱이 있어야 한다. 시작할 때 활성화되는 Tauri 검사 앱이 앞에 있다고 보고했고, 터미널을 다시 앞으로 가져온 뒤 통과했다. 내장 2× 디스플레이에서 다시 빌드한 macOS 디버그 호스트의 창 검사는 연속 2회 60개 모두 통과했고, 건너뜀과 남은 녹화가 없었다.
- 두 macOS 호스트가 로컬 엔드포인트로 status, 명령, DOM 요소를 제공한다([노출](docs/spec/exposure.ko.md), [엔드포인트](docs/spec/endpoint.ko.md)). 엔드포인트는 `<config-dir>/endpoint.json`에 주소를 기록하는 Unix 소켓이며 길이 접두 JSON-RPC 2.0을 사용한다. 코드를 실행하는 메서드는 없다. `packages/client`, `soksak` CLI, stdio MCP 서버 `soksak-mcp`를 추가한다. 진단 메서드는 디버그 빌드(Go 태그·cargo 기능 `diagnostics`)에만 있다. TCP 제어 포트, `--observe` 계열 플래그, 프로브의 `eval`·`evalAsync`·`mouse` 동작을 제거한다. 클라이언트와 두 호스트는 한 연결의 구독 변경을 받은 순서대로 적용한다. 이전에는 감시를 끝내고 다시 시작하면 페이지 구독이 끊길 수 있었다. 페이지는 기록 줄을 응답 순서대로 보내며, 이 문제로 호스트 기록 비교가 가끔 실패했다. 라이브러리 열기가 끝난 뒤 프로젝트 전환이 판을 불러온다. 이전에는 그 사이에 연 프로젝트의 판이 지워져 창이 닫히지 않았다.
- `native/darwin`과 두 호스트에 네이티브 입력(`input.pointer`, `input.key`)을 추가한다. 키는 `-[NSWindow sendEvent:]`를 쓰고, 누름·끌기·뗌은 좌표의 뷰에 보내며, 스크롤은 문서화되지 않은 CGEvent 창 번호 필드와 `CGEventSetWindowLocation`으로 창 정보를 가진 이벤트를 만들어 창으로 보낸다. WebKit은 키 창에서만 호버를 갱신하므로 다른 창에 대한 버튼 없는 이동은 1006을 반환한다. `activate: true`는 애플리케이션을 활성화하고 WebKit의 활성 상태 반영(`_doAfterActivityStateUpdate:`)을 기다린 뒤 이동을 보낸다. 비공개 선언은 `native/darwin/src/private/`에 모으고 [비공개 네이티브 API 목록](docs/operations/private-native-apis.ko.md)에 기록한다. 표면과 모달 페이지는 요소에 초점을 줘도 키보드 초점을 가져가지 않으며(`_setShouldSuppressFirstResponderChanges:`), Tauri는 그 웹뷰를 초점 없이 만들고, `host.window`는 모달이 초점을 받은 뒤에 표시됨으로 보고한다. 불러오기를 마친 터미널 표면이 열린 메뉴의 Escape를 가져가던 문제를 고친다. `make -C native/darwin test`는 애플리케이션을 활성화하지 않는 검사를, `make -C native/darwin test-activation`은 애플리케이션을 활성화해 호버와 겹친 웹뷰 검사를 실행하며, 더 이상 키 창을 흉내 내지 않는다.
- 창 단추를 보이는 크기 기준으로 첫 행 가운데(콘텐츠 좌표 y 22.5)에 두고, 페이지가 준비될 때 배치한다. 이전 값 y 14.5는 16pt 단추를 가정해 14pt 단추가 1pt 위에 있었고, 첫 창은 첫 크기 변경 전까지 시스템 위치에 있었다. 창 제목이 바뀌면 AppKit이 단추를 가져가는데, 다음 레이아웃이 아니라 다음 화면 표시 전에 되돌린다. 이전에는 최대 80ms 동안 시스템 위치가 화면에 그려졌다. 되돌리기는 창을 다시 찾으므로 창이 닫힌 뒤의 충돌도 고친다.
- 창 검사는 엔드포인트만 사용하며(`make e2e-check`가 코드 실행, 포트, 폴링, 고정 대기를 거부한다) 녹화를 항상 지운다. 캡처는 sRGB로 기록하고, 종료 요청 뒤에 표시된 프레임을 받은 다음 멈추며, 완전히 기록된 프레임만 남긴다. Tauri의 끌기는 Wails와 같이 확정 커밋을 기다린다. 정렬 검사의 색은 이전 디스플레이의 픽셀 값 대신 테마 값에서 가져온다. 건너뛰던 외부 문서 바쁜 스크립트 검사를 제거하고, 표시 대기가 외부 문서와 숨긴 문서를 제외하는지는 `tests/surface_layout_test.m`이 검사한다. 네이티브 라이브러리가 바뀌면 Go와 cargo가 다시 링크한다. 이전에는 Wails 디버그 빌드가 예전 네이티브 코드를 링크할 수 있었다. 외부 1× 디스플레이 하나가 연결된 상태에서 다시 빌드한 macOS 디버그 호스트의 창 검사는 연속 두 번 모두 36개 중 32 통과, 2 실패(2× 디스플레이가 필요한 소수점 footer 검사), 2 건너뜀(두 디스플레이가 필요한 화면 배율 전환)이다.
- 네이티브 호스트 코드를 `apps/wailsv3`와 `apps/tauriv2`에서 라이브러리 패키지 `packages/host/wailsv3`(Go 모듈 `github.com/min-median-max/soksak/packages/host/wailsv3`, `src/`의 패키지 `host`)와 `packages/host/tauriv2`(크레이트 `soksak-host-tauriv2`, `[lib] path = "src/host.rs"`)로 옮긴다. 두 호스트는 코드를 `src/`에, 운영체제별 코드를 플랫폼 인터페이스 뒤의 `src/platform/{darwin,windows}/`에, 테스트를 `tests/`에 둔다. Go 운영체제 패키지는 `init`에서 등록하고, Rust는 `cfg`와 `#[path]`로 운영체제 모듈을 선택한다. 애플리케이션은 `src/main.*`, `environment.json`, `runtime/`, 테스트, 매니페스트, Tauri 설정만 가진다. `src-tauri/`를 제거하고, 두 애플리케이션 모두 프런트엔드를 `src/frontend/`에 스테이징한다. Wails 바인딩 서비스 이름은 이제 `github.com/min-median-max/soksak/packages/host/wailsv3/src.Host`다. 루트 `go.work`와, 하나의 `Cargo.lock`, 공용 `[patch.crates-io]`, `target/` 출력을 가진 루트 Cargo 워크스페이스를 추가한다. 두 애플리케이션 실행 파일과 사이드카 실행 파일은 `target/debug` 또는 `target/release`에 놓인다. Windows에서 두 호스트는 디렉터리 식별을 제외한 연산에 `is not implemented on windows` 오류를 반환하며 애플리케이션 시작이 실패한다. Tauri의 Windows 둥근 모서리 코드를 제거한다. 애플리케이션 크레이트가 dialog 플러그인에 직접 의존하지 않으므로 Tauri `gen/schemas`에 dialog 플러그인이 더 이상 나열되지 않는다. 셸 사이드카는 `src/platform/{darwin,linux,windows}/`로 셸을 선택하고, `packages/client`는 `platform/platform.js`로 전송 주소 모듈을 선택한다. `platform/<os>/` 밖의 운영체제 조건과 운영체제 파일 접미사를 보고하는 `make platforms`(`scripts/check-platforms.mjs`)와, 두 호스트와 두 애플리케이션을 [네이티브 호스트 명세](docs/spec/hosts.ko.md)의 허용 차이와 비교하는 `make hosts-check`(`scripts/check-hosts.mjs`)를 추가한다. 패키지 테스트, `make boundaries`, `make platforms`, `make hosts-check`, `make native-test`, 두 macOS 빌드가 통과했다. Wails 호스트의 Windows 대상 `go vet`·`go build`와 Tauri 호스트의 `x86_64-pc-windows-msvc` 대상 `cargo check`가 경고 없이 통과했다. Windows 대상 Tauri 애플리케이션 크레이트는 이 macOS 장비에 없는 Windows 리소스 컴파일러(`llvm-rc`) 단계에서 멈춘다. 외부 1× 디스플레이만 연결한 상태에서 창 검사 38개 중 22개 통과, 14개 실패, 2개 생략이며, 실패 목록은 이전 1× 실행과 같고 터미널·라이브러리·프로젝트 창·호스트 비교 검사는 통과했다.
- macOS 공용 소스를 `_darwin` 접미사 없이 `native/darwin/src`로 옮기고, 두 창 캡처 구현을 `native/darwin/src/capture.m` 하나로 합친다. 두 호스트는 라이브러리를 통해 캡처를 호출한다. 캡처가 macOS 14.0의 ScreenCaptureKit API를 사용하므로 라이브러리 최소 버전은 macOS 14.0이다. 셸 사이드카는 코드를 `src/`(패키지 `src/shell`과 진입점 `src/main.go`), 테스트를 `tests/`에 둔다. 독립 입력 검사는 `tests/webview_input_test.m`이다. 두 네이티브 빌드와 공용 입력 검사가 통과했고, 두 호스트가 공용 캡처로 끌기 한 번에 약 100프레임을 기록했으며, 두 호스트의 터미널 창 검사가 통과했다.
- 사이드카 선언을 `environment.json`에서 플러그인으로 옮긴다. `plugin.json`은 사이드카 패키지 이름을 나열하고, 각 플러그인은 이를 `package.json` 의존성으로 선언하며, 각 사이드카 패키지는 `executable`과 `protocol`을 담은 `sidecar.json`을 제공한다. `validateEnvironment`는 더 이상 `sidecars`를 허용하지 않는다. 두 호스트는 스테이징된 `environment.json`, `plugin.json`, `sidecar.json`으로 사이드카 실행 파일을 찾고 `@soksak/sidecar-shell` 같은 패키지 이름으로 사이드카를 식별한다. `soksak-stage`는 각 `sidecar.json`을 복사하고, `--executables`를 지정하면 빌드된 각 사이드카 실행 파일도 복사한다. `plugin.json`에 `preview.ink`를 추가하여 워크벤치의 라이브러리 미리보기 색에서 플러그인별 CSS를 대체한다. 런타임 모듈이 `windows`를 내보내어 워크벤치의 네이티브·브라우저 분기와 `browser:` 프로젝트 식별자를 제거한다. 브라우저 런타임은 폴더를 `path:<경로>`로 식별하므로, 이 변경 전에 브라우저 애플리케이션이 저장한 프로젝트는 디렉터리 검사에서 실패하며 다시 추가해야 한다. 코어 패키지가 플러그인과 사이드카 이름을 적지 않고 플러그인과 사이드카가 선언한 의존성 이름만 적는지 검사하는 `scripts/check-boundaries.mjs`를 추가한다. 배치 라이브러리 테스트의 카드 fixture 이름을 `upper`와 `lower`로 바꾼다. 패키지 테스트, `make boundaries`, `make native-test`, 두 네이티브 빌드가 통과했다. 외부 1× 디스플레이만 연결한 상태에서 다시 빌드한 macOS 호스트의 터미널·라이브러리·프로젝트 창·호스트 비교 창 검사는 두 호스트 모두 통과했다. 전체 창 검사는 22개 통과, 14개 실패, 2개 생략이며, 이전 2× 기준보다 늘어난 실패 4개는 2× 디스플레이가 필요한 footer 검사와 Tauri 녹화 측정 2개다.
- `callAsyncJavaScript`로 페이지 promise의 값을 반환하는 네이티브 프로브 연산 `evalAsync`와, 셸 사이드카를 거친 터미널 입력을 검사하는 `terminal.test.mjs` 창 검사를 추가한다. 실패한 사이드카 요청을 터미널 출력에 표시한다. 창 검사의 실행 파일 경로를 하네스 위치 기준으로 해석한다. 이전 경로에서는 모든 호스트 검사가 건너뛰어졌다. 라이브러리 검사는 제거된 런타임 경로를 가져오고 그 결과인 TypeError를 프로젝트 생성 거부로 받아들였다. 이제 `@soksak/runtime`을 가져오고 호스트 거부 두 번을 요구하며, 두 호스트에서 통과했다. 다시 빌드한 macOS 호스트에서 창 검사 38개 중 26개 통과, 10개 실패, 디스플레이 전환 검사 2개 건너뜀이다. 두 터미널 검사는 통과했고, Wails 사이드카 실행 파일을 제거하면 Wails 터미널 검사가 실패했다. 실패 10개는 작업 공간 분리 전 커밋 22c313b에서도 발생한다. 페이지 검증기가 45px 제목 행과 y 14.5의 네이티브 단추(위 14.5, 아래 16.5)를 보고하여 단추 중앙 검사와 흔들기 검사가 실패하고, Wails 정렬·바쁜 스크립트 검사는 터미널 줄을 측정하지 못한다. 실패한 검사는 전체 녹화를 남기며, 이번 실행에서 남은 녹화가 디스크를 채워 이후 프레임이 잘렸고 녹화를 제거한 뒤 해소되었다.
- 두 호스트의 셸 세션 코드를 `sidecars/shell` 프로세스로 옮긴다. 두 호스트는 표면 페이지와 선언된 사이드카 사이에서 한 줄 JSON을 전달하고, 사이드카 메시지를 표면을 소유한 창에만 전달하며, 제거된 표면을 알리고, 종료 시 사이드카를 멈춘다. 페이지는 `page.sidecar(name)`을 사용한다. 터미널 플러그인은 `shell` 사이드카를 선언하고 네이티브 애플리케이션은 이를 `environment.json`에 선언한다. 사이드카 프로토콜 테스트(Go 3), fake 사이드카를 사용한 Wails 전달 테스트(Go 신규 3, 전체 6), Tauri 전달 테스트(Rust 신규 3, 전체 6), 패키지 테스트가 통과했고 두 네이티브 빌드에 `soksak-shell`이 포함된다. 실행 중인 애플리케이션의 네이티브 창 검사와 터미널 입력은 실행하지 않았다.
- 모든 작업 공간 패키지와 애플리케이션의 버전을 0.0.1로 지정한다. Tauri 크레이트와 설정은 작업 공간 분리 커밋에서 0.0.1로 지정했다.
- 저장소를 pnpm 작업 공간으로 재구성한다. `packages/soksak`은 배치 라이브러리와 명세, `packages/workbench`는 워크벤치 프런트엔드, `packages/plugin-api`는 `plugin.json`·`environment.json`·스테이징 배치·페이지 import map, `plugins/{browser,terminal,files}`는 세 플러그인 선언, `apps/{browser,wails,tauri}`는 `environment.json`을 통한 조립, `native/darwin`은 pkg-config로 찾는 macOS 공용 정적 라이브러리, `e2e`는 창 검사를 담는다. 라이브러리는 `pnpm add "github:min-median-max/soksak#path:packages/soksak"`로 설치한다. 저장소 루트는 더 이상 라이브러리 패키지가 아니다.
- 네이티브 애플리케이션의 최소 버전을 macOS 14.0으로 선언한다. Wails 캡처 코드는 macOS 14.0의 ScreenCaptureKit API를, 공용 라이브러리는 macOS 12.0의 WebKit API를 사용하지만 기존 빌드는 최소 버전 11.0으로 링크했다. 공용 라이브러리 빌드는 선언한 최소 버전보다 새로운 API를 사용하는 소스에서 실패한다. 두 네이티브 빌드는 최소 버전 14.0으로 링크하고 배포 버전 경고가 없다. Wails는 의존성이 추가한 `-lobjc` 중복 경고를 계속 출력한다.
- 워크벤치에서 플러그인 이름과 기본 배치를 제거한다. 애플리케이션이 `environment.json`에 플러그인, 초기 스페이스, 사이드바 기본값을 선언하고, 런타임 판별 대신 자기 런타임 모듈을 제공한다. Wails 소스의 심볼릭 링크를 제거한다. 패키지 테스트(플러그인 API 7, 워크벤치 8, 플러그인 7, 애플리케이션 8, 라이브러리 310), 공용 입력 검사, 두 네이티브 빌드, 브라우저 애플리케이션(`verify: 17 pass`)이 통과했다. 이 변경에 대해 네이티브 창 검사는 실행하지 않았다.

- 설정 탐색의 전역·프로젝트 범위 선택을 일반 본문 상단의 가로 탭으로 이동한다. 분류 전환 시 범위를 유지하고 프로젝트 열기 방식은 전역에만 표시하며 덮어쓰기 초기화 컨트롤에 전역 명칭과 공통 글자 크기를 적용한다. 작업 화면에서 돌아온 경우를 포함해 라이브러리는 공통 설정만 적용하고 편집한다. 작업 화면으로 복귀하면 프로젝트 덮어쓰기와 두 범위 탭을 복원한다. 다시 빌드한 두 macOS 호스트에서 관련 설정·프로젝트·라이브러리·모달 검사 18개를 모두 통과했다. 네이티브 라이브러리 설정 외관을 확인했다. `make docs-check`를 통과했다.

- 다시 빌드한 두 macOS 호스트에서 단순화한 라이브러리 화면을 확인했다. 생성·저장된 프로젝트 선택·창 재사용·검색·고정·배치 도식 미리보기 검사를 통과했다. 전체 예제 검사 37개 통과, 녹화 프레임 부족 2개 실패, 화면 전환 검사 2개 생략. 실패한 검사는 코드와 기준을 변경하지 않고 재검사하여 통과했으며 간헐 프레임 부족은 미해결이다. Go 3/3·Rust 3/3·문서 검사를 통과했다.

- 공통 CSS로 라이브러리와 작업 화면의 글자 크기·자간·행간·간격·테두리·모서리·버튼·입력창·아이콘 스타일을 통일한다. 라이브러리 전용 글자 크기와 고정 테마 형태를 제거한다. 두 화면의 글자가 설정한 기본 크기에 비례한다. 다시 빌드한 macOS 호스트에서 예제 검사 39개 통과, 실패 0개, 화면 전환 검사 2개 생략. 두 호스트에서 외관 비교와 글꼴·크기·모서리 변경을 확인했다. `make docs-check`를 통과했다.

- 시작과 새 창에 프로젝트 라이브러리를 표시한다. 프로젝트 생성이나 저장된 프로젝트 선택 시 같은 미선택 OS 창을 사용한다. 셸을 닫지 않고 작업 화면에서 프로젝트 목록으로 돌아간다.
- 저장된 카드 격자로 배치 도식 미리보기를 그린다. 간격·행 높이를 일정하게 하고 사이드바 열을 좁게 표시하며 테마 기반 색상과 콘텐츠 기호를 사용한다. 렌더러 사각형·레일 경로 저장을 제거한다. 프로젝트 검색, 정렬, 고정 저장을 유지한다. 라이브러리 탐색 사이드바, 분류 필터, 별도 폴더 열기 동작, Git 복제 구현을 제거한다.
- Dock 새 창, 라이브러리 푸터 동작, Cmd/Ctrl+Shift+N을 추가한다. 상단 새 창 아이콘을 제거한다. macOS에서 모든 창을 닫아도 앱을 유지하여 Dock 새 창을 사용할 수 있다.

- 네이티브 창 검사를 실제 장치 픽셀 해상도로 녹화한다. 포인트 크기 축소가 가는 구분선 색상을 혼합하여 Wails 정렬 측정을 실패시켰다. 기존 픽셀 허용 오차와 제스처 요건을 유지한다. 앱 배치가 아닌 진단 녹화를 변경한다.

- 공통 설정을 앱 설정 디렉터리에 저장하고 명시적 프로젝트 덮어쓰기를 `.soksak/settings.json`에 저장한다. 덮어쓰기를 제거하면 상속을 복원한다. 프로젝트 열기 방식은 공통 설정만 허용한다. 네이티브 호스트는 JSON 파일을 사용하고 브라우저 예제는 IndexedDB를 사용한다.
- 정규 디렉터리 경로와 파일시스템 식별자로 프로젝트를 식별한다. 동시 요청을 포함한 중복 열기는 기존 프로젝트와 창을 사용한다. 프로젝트 순서, 스페이스, 카드, 탭, 사이드바·레일 너비, 일반 창 좌표를 저장한다. 시작 시 저장된 프로젝트를 라이브러리에 표시한다.
- 공개 프레임워크 API로 프로젝트를 독립 OS 창에서 연다. 표면, 설정 메뉴, 입력, 테마, 셸을 창별로 관리한다. 준비된 창을 닫거나 앱을 종료하기 전에 대기 중인 저장을 완료한다. 설정과 추가·분할 메뉴는 프로젝트 창 내부의 네이티브 웹뷰를 유지한다.
- UI 스레드에서 창별 네이티브 표시 처리를 직렬화한다. 프로젝트 표면을 제거하기 전에 대기 중인 표시 처리를 완료한다. 공통·프로젝트 설정값이 변경된 경우에만 설정을 적용한다. 저장된 창 크기를 복원하기 전에 Wails 메인 뷰를 준비한다.
- 두 macOS 호스트를 다시 빌드하고 재시작했다. 예제 검사 41개 중 39개 통과, 실패 0개이며 2× 화면 하나만 연결되어 화면 전환 검사 2개를 생략했다. Go 3/3·Rust 3/3 저장소 검사, Wails Windows 교차 컴파일, `make docs-check`를 통과했다. 앱 종료, 최종 저장, 프로세스 재시작 후 저장된 라이브러리 표시, 모든 창을 닫은 뒤 Dock 새 창을 확인했다. Windows·Linux 네이티브 실행은 미검증이다. 비공개 API나 프레임워크 포크를 추가하지 않았으며 배치 라이브러리는 변경하지 않았다.

- 필요성 검토, 정확한 호출 위치, 프레임워크 의존성, 업데이트 검증 절차를 포함한 비공개 네이티브 API 목록을 추가했다. 네이티브 업데이트 후 실패 시 가장 먼저 검토할 문서로 지정했다. 마우스 이탈 전달에 관한 입력 모니터 주석을 수정했다. 런타임 동작은 변경하지 않았으며 `make docs-check`를 통과했다.

- 창 검사는 초기 터미널 문서, 테마와 네이티브 표시 완료를 확인한 뒤 녹화를 시작한다.

- macOS 콘텐츠 웹뷰를 장치 픽셀 네이티브 좌표로 렌더링하면서 CSS 크기와 장치 픽셀 배율을 유지한다. 0.5pt 단위 높이에서도 네이티브 표면과 문서 크기가 일치한다. 네이티브 배경색 변경을 제거한다.
- CSS 크기가 같아도 화면 해상도 변경 시 DOM 배치를 다시 그린다. 뷰 제거 시 해상도 관찰을 제거한다.
- 디바이더 드래그 전체의 소수점 푸터 픽셀, 창 크기·화면 배율 전환 후 문서 좌표, 마지막 장치 픽셀의 네이티브 포인터 좌표를 검사한다. 두 macOS 호스트가 이 검사를 포함한 `make examples-verify` 35/35를 통과했다.

- 모달 CSS 복사에서 문서 내부 adopted 스타일시트를 제외한다. 이전에는 설정 메뉴 전환 시 메인 문서의 블러가 대화상자에 복사됐다. 메뉴 전환 검증을 추가한 두 macOS 호스트의 모달 검사 12/12가 통과했다.
- 설정과 추가·분할 선택 메뉴를 메인 창 내부의 웹뷰로 표시한다. 설정은 전체 뷰포트의 검정 50% CSS 배경과 각 배경 문서의 3px 블러를 사용한다. 메뉴 배경은 블러 없이 투명하다.
- 표면 교체 후 모달 순서를 유지하고, 설정 카드를 웹뷰 내부에서 이동하며, 부모 크기 변경을 반영한다. 메인 문서를 다시 로드하면 모달과 블러를 제거한다. 설정은 ×로만 닫는다.
- 메인 문서와 표시 중인 앱 문서들의 표시 완료를 확인한 뒤 전체 네이티브 표면 사각형과 카드 DOM을 하나의 레이어 트랜잭션으로 적용한다. 외부 문서는 콘텐츠를 독립적으로 렌더링한다. 교집합 축소와 일반 표면의 투명 렌더링을 제거한다. 다음 슬롯을 측정할 수 없는 표면은 DOM 변경 전에 숨긴다.
- 이후 배치 준비가 있으면 오래된 DOM 그리기 콜백을 무시한다. 컴포지터의 준비 Promise를 호출자에게 반환한다.
- 녹화 중 AppKit이 버튼의 부모를 변경해도 네이티브 버튼의 중앙 정렬을 유지한다. 위치 조회는 배치를 변경하지 않는다.
- 자동 제스처의 최종 복귀 좌표가 표시될 때까지 녹화한다. 왕복 전체 녹화, 측정된 외부 표시 0, 터미널 구분선·카드·사이드바·레일의 일관된 상대 좌표를 요구한다. 외부 문서의 700ms 작업 중 메인 배치가 반복 갱신되는지 확인한다.
- 배경 스크립트 초기화 전에 전달된 배경 상태를 유지한다.
- 네이티브 시각 효과 배경과 지연 커서 진단을 제거한다. 유지한 겹침 웹뷰 입력 검사는 포인터·키보드 전달을 검사한다.
- 셸 시작 전에 터미널 출력 수신을 등록한다. 별도의 터미널 시작 수정이다.
- 명세, 운영 절차, 기능 상태, 변경 기록을 분리한다. 문서 번역과 `make docs-check`를 필수 검사에 추가한다.

메인 문서만 확인한 표시 처리에서 Tauri 뷰 폭이 562pt로 커밋될 때 문서 클리핑 레이어는 558pt로 유지됐다. 공통 표시 처리는 이제 표시 중인 앱 문서들도 포함한다. 수정 후 macOS 26.6.2에서 `make examples-verify` 29/29가 통과했다. 배경 초기화, 모달 동작, 창 버튼, 정렬, 외부 작업 중 메인 배치 갱신을 포함한다. 추가 정렬 검사 4회 16/16이 통과했다. 앞서 발견한 Wails 배경 초기화 실패는 수정했다. 2026-09-07 두 호스트의 설정 블러를 수동 확인했다. Windows와 Linux 실행은 검증하지 않았다. 이 변경은 배포하지 않았다.

2026-09-08 라이브러리 검증: `make verify` 통과. 테스트 310/310, 변이 142개 검출, 문서 검사, 빌드, 생성 산출물과 커밋된 파일 비교를 포함한다.
- F6.3-9를 시작했다. 최신 Tauri 분할이 `loading`에 남고 `1005: the window did not present within 10s`를 반환했다는 새 보고가 기존 단일 프로세스 Green 증거와 충돌한다. 새 수정은 하나의 바이너리·하나의 설정 디렉터리 재현, 정확한 표시 상태, 경과 시간이 포함된 START/PASS/FAIL 출력 뒤에만 인정한다.
- F6.3-9를 완료했다. 현재 Tauri 바이너리 하나와 설정 디렉터리 하나에서 신규·4분할·반복 endpoint 케이스를 3회 실행해 9/9 통과했고, 각 케이스의 START/PASS 경과 시간과 `1005`, `notFound`, `notAttached`, native 표시 오류 부재를 확인했다. 동일 빌드에서 보고된 멈춤은 재현되지 않아 추측성 코드는 수정하지 않았으며 강제 endpoint 정리 진단은 별도로 기록했다.
- V4를 시작했다. 기존 프로젝트 수명주기 케이스는 많은 persistence 동작을 다루지만 동일 앱 인스턴스에서 독립된 초기 상태 두 번의 생성·사용·종료·재생성을 명시적으로 증명하지 않는다. 양쪽 host에 별도 제한 케이스를 추가한다.
- V4를 완료했다. 새 두 상태 수명주기 케이스가 재빌드 Tauri 1/1(1.75초), Wails 1/1(1.45초)로 통과했다. 하나의 앱 인스턴스에서 독립된 임시 프로젝트 두 개를 각각 생성·사용·종료·제거·재생성하고 30초 개별 제한을 적용했다.
- V5 Red 근거: `pnpm test`는 1.2초, `make native-test`는 167초에 통과했다. `pnpm breaks`는 142개 주입 결함마다 전체 library suite를 반복하는 기존 러너 때문에 180초 lane을 넘겼으므로 통과로 기록하지 않는다. 일치하는 Tauri 분할 matrix는 2.1초에 4/4 통과했지만 정리 중 `notFound`와 endpoint broken-pipe 진단이 명시적으로 발생했으며 분류가 필요하다.
- V5 Green: break 감사기는 격리 복사본·8개 lane·테스트 파일별 20초 제한·진행 출력을 사용하도록 수정했고 주입 결함 142개를 모두 검출했다. 일치하는 Tauri 분할 matrix는 2.1초에 4/4 통과했다. 정리 진단은 숨기지 않고 기존 stale-frame/recovery 계약으로 분류한다.
- F8은 계속 미완료다. 재빌드 Tauri probe에서 한글 2-set 입력 소스는 확인했지만 필요한 System Events 실제 키 주입이 macOS 권한 오류 1002로 거부됐고, 실제 `terminal.compose` 이벤트는 관측되지 않았다. 합성 이벤트는 IME 근거로 세지 않았다.
- F8 native 활성화 Green: 명시적 활성화가 입력을 받을 수 없는 숨겨진 WebView를 더 이상 기다리지 않는다. 집중 실행한 `native/darwin/build/input_activate_test`가 새 숨김 WebView 케이스와 기존 활성화 케이스를 모두 통과했다. 전체 `make test-activation` lane은 기존 inspector 부착 실패를 별도로 보고하므로 전체 통과로 기록하지 않았다. host IME 확정 기준은 아직 열려 있으며, 재빌드 Wails probe에서 보이는 `나` preedit 뒤 PTY에 원시 `ㄱㅏ`가 남았다.
- F8 protocol Green: focus와 compose ACK가 이제 `ack`만 포함한다. 집중 실행한 `native_input_ack_is_not_reported_as_an_unsolicited_event` 계약 검사가 1/1 통과해 정상 ACK가 terminal의 unsupported 이벤트 목록을 오염시키지 않는다. host IME 확정 기준은 계속 열어 둔다.
