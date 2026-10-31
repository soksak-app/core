# 검증 계약

[English](verification.md)

## 범위와 증거

View display acceptance는 설치되고 활성화된 view plugin을 열거하고 실제로 연 tab을 식별한다. 각 plugin은 선언된 readiness와 예상 capture pixel을 검사하는 명시적 content case를 요구한다. Case가 없으면 plugin과 tab 식별자를 밝히며 실패한다. Colour variation만으로 plugin content를 입증할 수 없다. Missing case를 거부하는 것은 acceptance 기준을 낮추지 않고 false pass를 제거한다.

macOS에서는 검사 전용 executable의 공개 Vision text recognizer로 녹화된 view content를 확인한다. 설치된 각 view에는 선언 readiness와 고정된 예상 text가 있다. Browser empty-state 안내문, editor text fixture, HWP fixture 문단 및 terminal 출력 marker를 사용한다. 전체 녹화를 decode하고 확정 frame count를 확인하며 마지막 frame crop에 예상 text가 있어야 한다. Crop은 적용된 view rectangle과 capture content origin 및 scale을 정확히 한 번 적용한다. Recognition은 application이나 rendering 경로에서 실행하지 않는다. Captured-pixel verifier 없이 readiness만 제공하는 case는 거부한다.

작업 상태 정본은 [기능 상태](../features.ko.md)다. 소스 파일 목록은 구조적 증거일 뿐 기능 동등성이나 애플리케이션의 정상 동작을 판정하지 않는다.

Core test 소유권은 독립적으로 선언된 core package를 따른다. Root `e2e` package가 window check와 `e2e/fixtures/` 아래 설치 가능한 payload를 소유한다. Fixture의 `package.json`은 설치 payload를 설명하며 별도의 core test 소유자를 만들지 않는다. E2E test는 자기 fixture manifest와 source를 읽을 수 있다. Core package test는 계속 E2E fixture 파일을 읽을 수 없고, E2E test도 다른 core package의 구현 경로를 읽을 수 없다.

문서 검사는 작업 ID 중복 금지와 대기(`[ ]`), 진행(`[~]`), 완료(`[o]`), 임시 우회(`[!]`) 상태만 사용하도록 요구한다. `[!]` 항목은 두 번역 모두에 비어 있지 않은 원인과 재시도 조건을 기록한다. 양쪽 번역의 체크리스트 ID·순서·들여쓰기·상태는 같아야 한다. 문장은 번역하되 작업 상태가 달라서는 안 된다. 변경 기록과 번역은 같은 구역, 구역마다 같은 항목 수, 위치마다 같은 작업 ID와 코드 조각을 가져야 한다.

추가 작업은 구현 전에 같은 체크리스트에 우선순위와 완료 기준을 기록한다. 완료 작업은 상태와 증거 범위를 유지한다. 후속 이슈는 완료 작업을 재개하거나 다른 체크리스트를 만드는 대신 숫자 접미사로 연결한 새 식별자를 쓴다.

워크스페이스 패키지, 빌드 매니페스트, 구현 언어, 공개 명령·상태·설정·호스트 연산을 발견한다. 지원하는 모든 기능을 명시적인 구현 진입점, 동작 테스트 식별자, 기대 결과, 필수 검증 수준에 연결한다. 저장소 목록에서 실행 가능한 구현 언어를 도출하며, 언어 어댑터 매니페스트가 실행 가능한 구현 언어를 빠뜨리거나 구현이 없는 언어를 선언하면 `make parity-check`가 실패해야 한다. 각 언어 어댑터는 이름이 있는 테스트를 실행하고 실제 수, 실패, 건너뜀, 취소, todo, 충돌, 시간 초과를 같은 결과 계약으로 보고한다. 현재 JS/TS·Rust·Go·Objective-C·셸의 증거 의무는 같다. 공용 네이티브 검사는 각 호스트를 거친 통합 검사를 대체하지 않는다. 호스트 비교는 같은 기대 결과를 사용하며, 둘 다 똑같이 잘못된 결과도 실패한다. Wails와 Tauri 호스트 테스트는 실행하는 [호스트 계약 사례](host-contract.ko.md)를 선언하고, `make host-contract-check`는 두 호스트의 테스트를 실행해 호스트 범위의 사례에 통과한 테스트가 없으면 실패한다. `make native-test`가 이 검사를 실행하므로, 어느 호스트에든 통과하는 테스트가 없는 사례를 남기는 호스트 변경은 네이티브 게이트에서 실패한다.

구현·테스트 누락, 미등록 빌드 대상, 해석 불가 참조, 필수 테스트 실행 제외, 테스트 0개, 필수 검사 생략, 오래된 증거, 충돌, 시간 초과는 해당 게이트를 실패시킨다. 감사 자체 테스트로 이 실패들을 입증한다. 동작 변이 검사는 구현을 무동작으로 바꾸거나 필수 효과·응답을 제거하고 대응 테스트의 실패를 요구한다. 파일 이름과 소스 패턴으로 동작을 입증하지 않는다.


증거에는 기능·테스트, 검증 수준, 언어·호스트·플랫폼, 미커밋 내용까지 포함한 소스·테스트 해시, 빌드 옵션, 실행 파일·사이드카 해시, 기대·실제 결과, 경과 시간을 기록한다. 의존 내용이 바뀌면 이전 증거는 무효다. 구조 범위·동작 검증·배포 승인은 별도 결과다.

언어 증거 recorder(`scripts/test-evidence.mjs`)는 이 필드를 schema 1로 저장한다. `make language-test`는 선언된 실행 언어 케이스마다 레코드를 출력한다. `--evidence-file PATH`를 전달하면 레코드를 보존하고, 이후 실행은 불변 소스·테스트·의존성·dirty 작업 트리·빌드 옵션·프로세스 snapshot이 같을 때만 번호가 붙은 시도를 추가한다. 최초 실패를 보존하고 오래되거나 잘못된 레코드는 거부한다. 실행 중인 호스트·사이드카가 필요한 경우 PID와 실행 파일 경로를 받아 살아 있는 동안 해시해야 하며, 빈 프로세스 목록은 해당 케이스가 소유한 실행 중 프로세스가 없다는 명시적 증거다.

## CI와 release 소유권

언어와 host job은 필요한 toolchain과 잠긴 의존성을 설치하고 자기 output을 build하며 소유 검사를 실행한다. Wails job은 Rust를 요구하지 않고 Tauri job은 Go를 요구하지 않는다. 필요한 frontend 생성과 native library는 각 host의 직접 prerequisite으로 유지한다. 공유 setup 절차는 각 job 안에서 독립 실행한다. Cache는 선택적인 가속 수단이며 다른 job이 제공하는 설치나 필수 build output이 아니다.

Host-equivalence job은 비교에 필요한 모든 언어와 toolchain을 설치하고 잠긴 의존성을 직접 받으며 두 host와 그 contract 선언의 정적 비교를 실행한다. host suite를 다시 실행하지 않는다. 언어 job에 의존하지 않고 그 build output을 내려받지 않는다. Cross-toolchain JavaScript harness 검사는 이 job에 속하며 순수 JavaScript package 검사는 별도로 유지한다. 지정 scope는 필수 skip이나 누락 owner 없이 전체 test inventory를 보존한다. 각 host job은 자기 host의 coverage를 보고한다. 한 host의 contract audit은 다른 host의 결과를 읽지 않으므로, cross-host equivalence는 정적 비교와 두 host job이 함께 required 판정에서 성공하는 것이다. 두 host를 한 job에서 실행하면 같은 run 설정을 같은 flag로 build하고 host마다 같은 판정에 이른다. 그 실행은 Wails release build가 쓰지 않는 Rust deployment 변수를 Go build에 더하고, 두 suite를 한 queue에 넣어 부하만 더할 뿐 더 검사하는 것이 없다. Tauri host job은 다른 job의 Rust build처럼 `CARGO_INCREMENTAL=0`을 설정한다.

의존성을 받은 뒤 build와 check stage는 offline으로 실행한다. Node와 pnpm은 정확한 선언 버전, Go는 module/workspace 선언, Rust는 정확하게 선언된 toolchain을 따른다. Frozen pnpm lock, Cargo.lock과 Go module sum을 계속 검사한다. Offline 검사는 누락된 의존성을 받거나 lock을 갱신하지 않으며 빠진 input을 밝히고 실패한다.

Release host별 job은 자체 bundle을 build하고 audit하며 release file를 만든다. Registry compatibility는 별도 필수 검사로 유지한다. 최종 판정은 독립 equivalence를 포함한 모든 필수 job의 성공을 요구한다. Publish는 그 판정 후 audit한 host release file만 받는다. 필수 job의 실패, 취소나 skip은 publication을 막는다.

명시적으로 선택한 registry index에는 고정한 SHA-256을 지정할 수 있다. Digest를 지정하면 정확히 소문자 hexadecimal 64자리여야 하고 비어 있지 않은 명시적 index URL이 필요하며 JSON parsing 전에 받은 bytes와 비교한다. 불일치는 acceptance 실패다. 기본 public-index 검사와 digest 없는 명시적 index는 기존 동작을 유지한다.


## Candidate registry release acceptance

Plugin format acceptance를 바꾸는 release는 대체 component release와 core release file이 준비될 때까지 현재 public registry를 유지한다. 이전 plugin 형식을 거부한다는 이유로 이전 released core에서 설치할 수 있는 모든 plugin을 제거하는 조기 public-index 전환을 허용하지 않는다.

Registry owner는 검증된 registry declaration에서 candidate index를 만들고 그 bytes를 prerelease file로 게시한다. Candidate proof format 1은 registry source revision, candidate SDK revision, API version과 API tree를 식별한다. 보존한 core version 집합, 정확한 대체 component identity와 version, 보존한 revocation, 추가 plugin revocation 및 검사한 candidate manifest 수를 기록한다. Registry producer는 proof를 만들기 전에 보존된 core entry 객체 전체와 candidate projection을 검증한다. Plugin이 0개인 결과로는 충분하지 않다.

Core candidate acceptance에는 명시적 index와 proof URL 및 SHA-256 값이 필요하다. 두 JSON 문서 중 하나를 parsing하기 전에 양쪽 raw bytes digest를 검사하고, proof가 정확한 index bytes에 결합됐는지 확인하며 지원하지 않는 index 또는 proof format을 거부한다. Proof identity 필드는 선언된 문자열 형식이어야 한다. Core는 현재 `packages/plugin-api` manifest에서 candidate SDK version을 읽고 해당 경로에 tracked/untracked 변경이 없을 때만 `HEAD:packages/plugin-api` tree를 사용한다. Candidate SDK의 API version과 tree를 이 identity와 비교한 뒤 보존한 core version 집합, 대체 identity 및 revocation projection을 index와 대조한다. 대체 sidecar 집합은 비어 있어도 되지만 plugin 대체 집합은 비어 있을 수 없다. Core revocation member는 없어도 되고 빈 array와 같은 의미이며, 비어 있지 않은 목록은 정확히 일치해야 한다. Proof의 manifest count는 producer 보고값이며 대체 plugin 집합과 같아야 한다. Candidate proof 검사 성공은 consumer가 plugin manifest를 내려받아 검사했다는 뜻이 아니다. 기존 registry manifest 검사는 candidate plugin release를 내려받고 artifact digest를 확인하며 manifest를 검증한다.

Core tag를 만들기 전에 동일하게 고정한 candidate index와 proof가 필수 main CI를 통과해야 한다. Tag는 정확히 그 통과한 commit을 가리킨다. Tag-triggered release 검사는 tag가 이미 존재한 뒤 실행되며 release file을 게시하기 전에 candidate acceptance를 다시 수행한다. Release job 실패는 public tag를 제거하지 않는다. Component packaging 뒤 API가 바뀌면 이전 SDK 결과를 재사용하지 않고 component acceptance를 새로 수행한다.

Core release file이 준비된 뒤 registry owner는 이미 검증한 component와 revocation projection에 새 core entry를 더한 index 하나를 게시한다. Prerelease candidate는 public index를 바꾸지 않는다. URL만으로 release-file 내용을 고정할 수 없으며 고정한 digest와 source proof가 모두 필요하다.

## 제한된 실행

E2E 실행기는 시험 child를 시작하기 전에 비어 있지 않은 `SOKSAK_RUN_ID`와 `SOKSAK_RUN_FOLDER`를 함께 요구한다. 누락되거나 일부만 있는 metadata는 실행기 경계에서 실패한다. 실행기는 전달받은 두 값을 child에 그대로 전달하며 id나 폴더를 만들어내지 않는다. 따라서 모든 window-check child를 해당 run과 감사 출력에 연결할 수 있다.

독립 실행하는 각 케이스에 자체 타임아웃을 둔다. 기본값은 순수 단위 동작 10초, 네이티브 프로세스 동작 30초, 앱 동작 60초다. 더 오래 필요한 케이스는 제한과 구체적 사유를 선언한다. 빌드 시간은 별도로 보고하며 테스트 결과로 세지 않는다. 전체 스위트 타임아웃이 케이스별 제한을 대체하지 않는다.

실행기는 시작 이벤트, 실행 중 최소 5초마다 진행 이벤트, 최종 통과·실패·시간 초과·취소 이벤트를 출력한다. 모든 이벤트에 케이스와 경과 밀리초를 담는다. 자식의 표준 출력과 오류를 그대로 공개한다. 명령의 성공 종료는 명령 실행 증거일 뿐 테스트 실행이나 단언 통과를 입증하지 않는다. 언어별 어댑터가 발견한 테스트 식별자와 결과를 별도로 검증해야 한다. 비어 있거나 생략된 실행으로 필수 테스트를 검증할 수 없다. 재시도하더라도 최초 실패를 남긴다.

명령 감독기는 명시적 식별자, 실행 파일·인자, 작업 디렉터리, 양의 타임아웃을 받는다. 셸을 사용하거나 없는 실행 파일을 몰래 대체하거나 비정상 종료를 성공으로 바꾸지 않는다. 시간 초과·취소 시 자신이 실행한 명령의 프로세스 그룹만 종료하고 정리를 기다린다. 성공한 감독 명령의 자손이 남아서는 안 된다. 독립적으로 실행 중인 검사 앱이나 영속 사용자 세션은 종료하지 않는다.

## 앱 인수 검증

창 검사는 frontmost application을 저장하거나 복원하거나 판정하지 않는다. 명세된 애플리케이션 동작은 자기 창을 활성화할 수 있고, 검사 중 사람이 앞으로 가져온 다른 애플리케이션은 검사가 일으킨 것이 아니며, 이전 애플리케이션을 활성화하면 그 사람에게서 활성화를 빼앗기 때문이다. 활성화 상태가 필요한 검사는 시험하는 동작의 선언된 status로 이를 확인한다.

요구된 검증 등급에서 관측하지 못한 완료 조건은 미해결로 남는다. 단위 검사 통과, 성공한 명령 응답, 동작 추정은 앱의 완료 검증을 입증하지 않는다.

안정화 기간에는 변경 영역 자체 검사에 더해 검사 빌드에서 터미널·셸·브라우저·모달 기본 동작을 매번 검사한다. 호출 성공뿐 아니라 선언된 입력, 결과 상태, 실제 출력, 격리, 정리를 확인한다. 창 검사는 일회용 실행 인스턴스에 연결하고 사용자가 실패를 보고한 창을 보존한다. 앱을 직접 기동하거나 잘못된 상태를 보정해서 통과시키지 않는다.

OS 입력기는 활성 애플리케이션의 키 창만 처리하므로 입력기 동작은 사용자 승인 아래 실행하는 활성화 등급 검사로만 검증한다. 각 실행은 같은 창의 AppKit 텍스트 뷰에도 같은 키를 보내며, 그 대조군이 기대한 문서를 만들 때만 결과를 증거로 인정한다.

네이티브 좌표·픽셀 검사는 요청한 캡처 속도로 전체 제스처를 포함한다. 녹화 상한 도달은 실제 프레임 수와 `limited: true`를 갖는 정상 결과지만 끝을 기록하지 못한 제스처를 검증할 수 없다. 검사 후 녹화를 제거한다. 독립된 초기 상태 두 번과 같은 인스턴스의 생성·사용·종료·재생성을 반복한다. 전체 구현을 마친 뒤 필수 스위트를 실행하며 단언을 완화하거나 이전 빌드 결과를 대입하지 않는다.

IME 기능 acceptance는 승인된 전체 입력 gesture, 동일 window의 일치하는 AppKit reference document, 일관된 terminal 상태 및 각 입력 단계의 녹화된 glyph와 underline 증거를 요구한다. Capture cadence는 별도 성능 측정으로 기록한다. ScreenCaptureKit API가 요청한 update 간격을 보장하지 않으므로 고정 sample-gap 목표는 기능 acceptance 기준이 아니다. 잘린 recording, frame 누락, decode하지 못한 identity, 필요한 단계 증거 누락 및 잘못된 입력은 계속 실패한다.

기존 terminal-focus activation consumer는 click, 정확한 native input 및 AppKit document와 완전한 callback-to-frame 대응을 검증한다. Raw callback timing과 cadence 초과를 관측값으로 유지한다. 이 consumer는 glyph나 underline pixel을 측정하지 않으며 전체 IME visual-proof consumer를 대체하지 않는다.
