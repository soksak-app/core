# 개발

[English](AGENTS.md)

디렉터리 역할과 인터페이스는 [plugin 명세](docs/spec/plugins.ko.md)가 정한다.

## 구현

- 현재 계약을 충족하는 가장 단순한 구현을 고르되, 줄인 구현은 쓰지 않는다. 오래된 코드 경로는 제거하고 호환 계층·fallback·하위 호환성을 두지 않으며, 이전 형식을 읽던 코드를 제거한다. 읽는 쪽은 현재 저장 형식만 받고, 다른 형식은 파일과 발견 내용을 밝히는 명시적 오류로 거부한다. release version이 0.0.x인 동안 저장 형식이 바뀌어도 migration을 싣지 않으며(code도 data도 아님), 이전 형식 파일(tracked이거나 사람 소유)은 같은 변경에서 현재 형식으로 고친다. 변환 code는 없으며 사람에게 파일을 다시 만들라고 요구하지 않는다. 불확실한 미래 요구를 위한 추상화, 설정, 간접 참조는 만들지 않으며, 교체가 필요한 임시 구현 대신 지속 가능한 구조를 택한다.
- 네이티브 bundle build는 [네이티브 bundle build](docs/operations/examples.ko.md#네이티브-bundle-build) 절차를 따른다.
- 유지되는 library가 제공하는 기능은 그 library를 쓴다. 계약을 충족하는 library가 없을 때만 직접 작성하고, 충족하지 못하는 요구를 code에 적는다.
- 상태 변화는 event로 발행하고 구독자가 처리한다. event 원천이 없을 때만 polling이나 timer를 쓰고 이유를 적는다. 작업은 멱등하게 하고, 각 발생은 검색하지 않고도 event, status, log로 기계적으로 관측 가능하게 한다.
- 어떤 code도 `ps`, `kill`, `pgrep`, `lsof`를 subprocess로 시작하지 않는다. process는 platform interface나 native library로 읽고, `kill(2)`로 signal을 보내고, child는 그 wait status로 판정한다. `make check-process-tools`가 Go와 Rust source에서 이를 강제하며, F1117-4가 Node 사이트를 옮긴다.
- 로컬 개발은 설치된 dependency 위치를 개발 디렉터리에 심볼릭 링크로 잇고 저장소를 clone하거나 복사하지 않는다. 빌드는 연결된 소스와 실제 설치에 같은 선언 경로를 쓰고, 경로는 선언이나 발견으로 해석한다([로컬 개발 연결](docs/operations/install.ko.md#로컬-개발-연결)).
- window가 보이는 display의 refresh rate는 미리 알 수 없고 display를 옮기면 바뀐다. 애플리케이션도 검사도 rate를 가정하지 않는다. 코드는 필요한 순간에 window display의 rate를 관측해 그 값을 따르거나, window의 display frame으로 일을 맞추거나 display가 전달한 frame으로 판정해 rate와 무관하게 설계한다. 고정 frame 시간(16 ms, 8.33 ms, 1/60 s)이나 요구하는 refresh rate는 결함이다.
- 저장소와 workspace 폴더에는 추적되는 파일과 선언된 build 출력만 둔다. 실행의 log, 임시 script, 메시지 파일은 session 임시 폴더에 두고 기록에서 인용하지 않는다. `sok-check docs`는 추적되지 않는 파일을 보고한다.
- 검사는 선언된 도구나 dependency version을 되풀이하지 않는다. package manager와 CI가 선언을 읽고, toolchain 검사는 major version을 비교하며, `scripts/check-versions.mjs`는 이 저장소가 선언한 version만 `pnpm test`에서 판단한다.
- kit은 저장소가 실행하는 유일한 도구다. 아무것도 설치하지 않고 설치 단계가 없으며 tool version을 비교하지 않고, 각 검사는 필요한 module만 load한다. 설치는 소비자와 그 package manager의 몫이다.
- 명령 이름은 하는 일을 쉬운 단어로 말한다([명령 이름](docs/operations/examples.ko.md#명령-이름)). `make check-commands`가 모든 저장소에서 강제한다.
- 저장소를 보관하면 로컬 checkout을 제거한다.
- 책임을 분리한다. 기존 API로 동작을 구현할 수 없을 때만 네이티브 플랫폼 코드를 추가한다.
- API나 호출 조건이 바뀌면 [비공개 네이티브 API 목록](docs/operations/private-native-apis.ko.md)을 갱신한다. 네이티브·framework·SDK·OS 업데이트 후 실패를 진단할 때는 먼저 읽고, 각 보정의 필요성과 실제 API 의미를 검토한다.
- 기존 변경은 해로운지 먼저 평가한다. 해로운 변경은 즉시 되돌리고, 잘못되었거나 불필요한 변경은 해롭지 않아도 제거하며, 올바른 변경은 보존한다. 무관한 변경은 가능하면 따로 커밋하고 목적을 밝힌다. 무관한 작업은 지시받은 작업의 근거가 아니다.
- 주변 파일의 서식·이름·관용을 따른다.
- runtime module을 추가하면 package의 files 선언을 갱신하고, native build 전에 소유 staging test로 staged asset을 확인한다.
- 커밋을 재작성하기 전에 동작을 검증한다. 승인 없이 병합하거나 push하지 않는다.
- 모든 오류를 알린다. 결과를 무시하거나 오류를 조용히 잡거나, 잘못된 입력을 그럴듯한 값으로 바꾸거나, 입력과 출력을 버리지 않는다. 잘못된 값은 경계에서 명시적 오류로 거부하고, 데이터를 버리는 제한된 buffer는 그 사실을 알리고 문서에 적는다.
- 정본 checklist는 하나이며 상태는 `[ ]` 대기, `[~]` 진행, `[o]` 완료, `[!]` 보류, `[-]` 종결이다. 저장소마다 자기 checklist를 둔다. 상위 항목은 하위 항목 중 하나가 `[~]`일 때만 `[~]`다.
- `[~]`는 남은 일과 기다리는 것을 적는다. `[!]`는 완료가 아니다. 보류 항목은 답, 사유, 재개 조건을 적고 조건이 충족될 때까지 보류로 남는다. 활성 작업 밖의 조건(release, pin, 개발 종료, 측정 단계)만 보류 사유가 되며, 그 사유에 대해서만 감사하며, 관련 없는 전체 모음은 다시 실행하지 않는다.
- `[-]`는 `Closed:`와 사유, 또는 [종결 형식](docs/operations/examples.ko.md#종결-형식) 중 하나를 쓴다. 종결은 결함 수정이 아니며 실행 가능한 검사나 release 조건을 닫지 않는다.
- 지시받은 작업은 구현 전에 우선순위를 정하고 계약과 checklist를 갱신한다. 완료 항목은 다시 열지 않고 후속 ID를 추가한다. 새 지시는 checklist에 기록하고 활성 작업이 멈출 지점에서 우선순위대로 진행한다. 우선순위가 요구하거나 명시적 지시가 있을 때만 활성 작업을 멈춘다.
- 항목은 따로 개발·검증·커밋할 수 있는 기능 한 단위로 정하고 더 크면 쪼갠다. 미커밋 변경은 항목 하나로 제한하고 기능 단위로 커밋한다. 독립 항목은 병렬로 진행할 수 있으나, 활성 항목의 작업·검증·문서·커밋을 마친 뒤에 다음을 시작한다.
- 항목은 검증하고 커밋한 뒤 `[o]`로 표시하며, changelog 항목은 같은 커밋에 쓴다. 과정 규칙은 이 지침에만 두고 checklist나 changelog에 복사하지 않는다.
- 다른 저장소의 release를 거쳐야 사용자에게 전달되는 수정은 기록할 때 그 release를 checklist 항목으로 등록하고, 게시 전까지 미배포로 보고한다. release, publication, deployment, registry 작업은 작업 범위에 명시된 경우에만 완료 기준에 넣는다.
- 요청을 기록하기 전에 분류한다. 과정 규칙은 이 지침에, 프로젝트 작업은 checklist에, 지속되는 사용자별 맥락은 memory에 둔다. 단순 질문은 답만 한다.
- 기본은 `main`에서 직접 작업한다. 격리가 필요하면 `{type}/{shortname}-{checklist ID}` branch나 `{프로젝트}-{shortname}-{checklist ID}` worktree를 쓴다. `main`에 병합한 직후 그 worktree와 branch를 제거하며, 병합되지 않은 것은 제거하지 않는다.
- `main`에 병합될 수 없는 test 코드는 의미가 남으면 cherry-pick하고 아니면 폐기하며, 커밋 전에 제거한다. 즉시 제거할 수 없으면 제거 조건을 적은 checklist 하위 항목을 만든다.
- 정한 기준은 유지한다. 검사에 실패한 코드는 고친다. 기준은 틀렸을 때만 바꾸고, 같은 변경에 이유를 적는다.
- 기존 원칙이나 편의가 아니라 옳은 것으로 판단한다. 기준은 상황이 요구할 때만 바꾸고 근거를 관련 문서에 남기며, 목표나 테스트가 어렵다고 낮추지 않는다. 판단이 어렵거나 새 논리에 기대는 결정은 에이전트 적대 검토에 넘긴다. 검토자는 근거로 반대하고 이견마다 해결안을 내며, 이견이 없을 때까지 반복한다. 결정, 이유, 답한 이견은 관련 문서에 적는다.
- 기존 코드의 예상과 다른 점은 결함으로 보고하고 고치거나 옳다는 검증을 기록한다. 규칙이 빠졌으면 규칙을 추가한다. 기존 코드라는 사실만으로는 근거가 되지 않는다.
- 보고되었거나 가정한 동작 결함은 프로덕션 코드를 바꾸기 전에 소유 모듈에 재현하는 추적 test를 추가하고, Red와 Green 결과를 기록한다([에이전트 검증 규칙](docs/spec/verification.ko.md#에이전트-검증-규칙)).
- 요청을 정석으로 충족할 수 없으면 구현 전에 어느 부분에 다른 방법이 필요한지와 이유를 밝힌다. 우회는 받아들이지 않는다. 증상이 아니라 원인을 고치며, 문제를 또 다른 문제를 더해 풀지 않는다.
- 계약, 규칙, 측정된 사실이 정하는 것은 스스로 정하고 선택지 없이 진행한다. 사용자의 몫인 결정이거나 새 발견이 이전 결정을 바꿀 때만 묻는다. 그때는 발견, 영향받는 결정, 구체적 변경을 명확히 적는다. 이미 정해진 사항은 다시 묻지 않는다.
- 판단이나 변경이 잘못되었으면 원인과 자신의 몫을 먼저 완전히 밝힌다. 변명하지 않고, 결함을 예상된 동작으로 만들려고 계약을 바꾸지 않으며, 다른 변경으로 덮지 않는다.

## 구조

- 코어(`packages/`), plugin, sidecar는 코드와 테스트에서 서로의 이름을 적지 않는다. plugin과 sidecar는 자기 repository에 있으며([repositories](docs/spec/plugins.ko.md#repository)), 선언 파일만 잇는다. `environment.json`은 `workspace`, `sidebars`, `settings`에서 plugin을 참조로만 이름 붙이며 설치하지 않고, `plugin.json`은 필요한 sidecar와 plugin을 `dependencies`에, 확장 지점을 `extends`와 `contributes`에 적으며, `sidecar.json`은 sidecar를 설명한다([plugin](docs/spec/plugins.ko.md)). `make check-boundaries`는 plugin을 알지 않으며, 코어 소스가 core package 외의 `@soksak/` package를 이름 붙이지 않는지, 코어의 window check·benchmark·harness module이 `e2e/fixtures`의 fixture 외의 plugin이나 sidecar를 이름 붙이지 않는지 검사한다([검증 경계](docs/spec/plugin-processes.ko.md#검증-경계)). 각 plugin과 sidecar repository는 자기 소스를 검사한다.
- 저장소 경계는 선언된 계약, 노출된 command, DOM, status, 확장 지점만 주고받는다. 코어의 빌드나 검사는 다른 저장소를 읽지 않는다. 패키지 관계는 manifest의 `dependencies`로만 선언한다.
- 공통 기능은 코어에 둔다. plugin 기능은 코어로 옮기지 않는다. sidecar는 한 영역의 네이티브 기능을 담는다.
- 플랫폼 코드는 소유 패키지의 `platform/<os>/`(`darwin`, `windows`, `linux`) 아래에만 둔다. 다른 플랫폼용 빈 파일은 두지 않는다. 네이티브 패키지의 배치(`src/`, `tests/`, 루트 매니페스트, `_test` 파일)는 [네이티브 호스트 명세](docs/spec/hosts.ko.md)를 따른다.
- 테스트 배치, 공통 계약 사례, 실제 입력 규칙은 [test 종류](docs/operations/examples.ko.md#test-종류)를 따른다.
- 프레임워크 비공개 선언은 플랫폼 디렉터리의 `private/`에 두며 [비공개 네이티브 API](docs/operations/private-native-apis.ko.md)를 따른다. 인터페이스가 없다고 프레임워크 상태를 흉내 내지 않는다.
- 플랫폼은 호스트 플랫폼 인터페이스의 각 기능을 구현하거나 `platform/<os>/unsupported.*`에서 `not implemented on <os>`를 반환한다. 기능을 제공하지 못하는 호스트는 시작할 때 실패한다([호스트 명세](docs/spec/hosts.ko.md)).
- 검사가 시작한 녹화, 프로세스, 서비스는 검사가 끝나면 종료하거나 제거한다. 남으면 검사가 실패한다.
- 모든 사용자 조작은 선언된 명령을 실행하고, 보이는 모든 상태는 status를 가진다. 요소는 공용 연결기로 선언된 명령에만 연결되며, 적용 범위는 실행 중 audit이 판단한다([노출](docs/spec/exposure.ko.md)).
- 표면은 plugin의 페이지를 표시한다. 페이지는 자기 요소에 붙인 문서 영역에서만 웹 문서를 보여준다([네이티브 표면](docs/spec/native-surfaces.ko.md#문서-영역)). 웹 주소는 표면이 아니다.
- 진단 코드는 진단 빌드에만 있다. 이 빌드의 event log 규칙은 [로그 정책](docs/spec/logging.ko.md#정책)에 있다.
- 런타임 진단은 기존 애플리케이션 event log를 단일 기록으로 쓴다. 빠진 관측값은 gate가 있는 writer에 추가하며, 별도의 history, collector, profiling run을 만들지 않는다.
- 사용자가 볼 수 있는 모든 오류는 하나의 표시 경로로 보이며, 이 경로가 오류 발생 시 `error: <where>: <text>`를 애플리케이션 log에 쓴다. 다른 경로의 오류 표시는 결함이고 오류 색은 이 경로만 쓴다. 표시는 현재 상태만 보이므로 log가 오류를 남긴다.
- core의 ResizeObserver는 animation frame에서 관찰을 시작하며, 이 frame의 관찰 round보다 먼저 실행된다. Round 중에 시작한 관찰은 첫 알림을 미루고, WebKit은 loop 오류를 보고한다([네이티브 표면](docs/spec/native-surfaces.ko.md)).

## 문서

- 동작을 바꾸기 전에 해당 명세를 읽는다. 계약이 바뀌면 명세를 먼저 고치고, 미구현 부분은 [기능 상태](docs/features.ko.md)에 표시한다.
- 주제마다 정본 문서를 하나 둔다. `docs/spec/`은 checklist ID, 진행 상태, 이력 없이 현재 계약을 정의한다. `docs/features.md`는 구현, 검증, 배포를 구분한다. `docs/operations/`는 현재 절차를, `CHANGELOG.md`는 실제 변경과 검증을 담는다.
- README는 소개, 최소 시작 절차, 문서 링크만 담는다. `docs/plans/`는 승인 대기 제안만 담고, 승인된 내용이 명세에 들어가면 지운다.
- 문서, 주석, 식별자, log, 오류, test 이름은 영어로 쓴다. 같은 변경에서 대응하는 `.ko.md`를 같은 정보로 갱신하며, 한국어 본문은 기술 용어를 영어로 두고 주변 문맥만 번역한다.
- 현재 동작과 실제 이유를 적는다. 개인 선호와 대화 맥락은 Git 밖의 memory에 둔다.
- 동작 이름을 직접 쓰고 주체와 대상을 밝힌다. 원인은 한 문장으로 쓴다. 주석, 문서, log, 커밋에 비유, 의인화, 구어체를 쓰지 않는다.
- 개념마다 용어를 하나만 쓴다. 새 개념은 쓰기 전에 용어 목록(kit의 `terms.json`, [용어](docs/spec/terms.ko.md))에 더한다.
- 기록(문서, 식별자, 주석, test 이름과 fixture, checklist, changelog, 커밋 메시지, 설정 파일의 설명)은 이 저장소의 사실만 적는다: 하는 일, 요구, 보장, 결함의 입력·동작·기대 동작, 변경과 이유. 요청·결정·발견한 사람, 정리나 재작성 방법, 로컬 환경, 로컬이나 개인 경로, commit id, pull request·CI run 번호는 적지 않는다. 다른 작업은 checklist ID로 가리킨다. 저장소가 복사하거나 fork한 외부 코드는 license 표시와 출처를 유지한다.
- 커밋 메시지는 [커밋 hook](docs/operations/examples.ko.md#커밋-hook)의 형식을 따른다. 꼬리말을 달지 않으며 작성자는 `min-0-max <max@blue.tools>`다.

## 검증

- CI와 release job은 toolchain, 의존성 획득, build, 검사를 소유하며 다른 저장소를 checkout하지 않는다([CI와 release 소유권](docs/spec/verification.ko.md#ci와-release-소유권)). end-to-end 검사는 로컬에서 make로만 실행한다.
- 긴 작업은 짧게 yield하고 live process나 session handle을 보존한다. 대기나 retry loop로 조율을 막지 않으며, 현재 단계를 보고하고 끝났다고 판단하기 전 같은 handle을 확인한다.
- 완료 기준, 항목 중 검사, 전체 모음 시점, 시간 상한, 진행 출력, 증거 규칙은 [에이전트 검증 규칙](docs/spec/verification.ko.md#에이전트-검증-규칙)에 있다. 네이티브와 예제 검사는 [예제 검증](docs/operations/examples.ko.md)을 따른다.
- 창 검사, 캡처, 녹화, 시각과 시간 증거, IME 검증은 [창 검사 운영](docs/operations/examples.ko.md#창-검사-운영)을 따른다.
- 모든 변경에 `make check-docs`를 실행하고 문서를 코드와 대조한다. 구조 검사는 의미를 검증하지 않는다. `make check-docs`는 모든 텍스트 파일의 문서 절 참조가 가리키는 문서와 anchor, 그리고 문서 링크의 모든 대상이 있는지 요구한다. 문서 절 참조 `docs/<path>.md#<anchor>`의 anchor는 글자, 숫자, `-`, `_`가 아닌 첫 문자에서 끝나므로, 참조 뒤의 한국어 조사에는 code span을 쓴다.
- 간헐 실패는 추적되는 반복 대상([간헐 실패 반복](docs/operations/examples.ko.md#간헐-실패-반복))으로만 수용한다.
- 대기와 보류 항목은 기록된 조건이 분명히 해소되기 전까지 작업 선정에서 제외하고, 그 구현이나 검증을 미리 실행하지 않는다.
- 독립 개발은 병렬로 할 수 있으나, 빌드와 검증 명령은 lead만 실행하고 일정도 정한다. 디스크와 정리 규칙은 [임시 폴더](docs/operations/examples.ko.md#임시-폴더)를 따른다.
- 확인한 사실, 실패 원인, 증거가 있는 아키텍처 결정, 해소되지 않은 검증 조건은 소유 명세, checklist, 변경 기록에 남긴다. 운영자의 말은 인용하지 않는다. 대화와 원문 실행 log는 지속 기록을 대신하지 않는다.
