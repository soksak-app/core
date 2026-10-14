# 실려 온 정의에 의한 저장 데이터 마이그레이션

이 제안은 대기 중이다. 승인된 내용은 `docs/spec/installation.md`, `docs/spec/plugins.md`, `docs/spec/host-contract.md`, `docs/spec/settings.md`, `docs/spec/projects.md`, agent 지침으로 옮겨 가고 제안은 그때 지운다(체크리스트 F188, F189).

## 배경

릴리즈 0.0.13은 같은 제품 계열의 이전 릴리즈가 쓴 `plugins/installed.json`을 가진 설정에서 시작을 거부한다: `installed plugins: <파일>: browser: unknown field package`. 항목에서 `package` field를 없안던 변경(plugin 어휘 변경, 2026-10-11)이 형식 번호를 올리지 않았고(`InstalledFormat`은 2에 그대로), 그래서 그 변경을 알리는 version 차이가 없었고 마이그레이션은 붙을 곳이 없었으며, migration을 금지하던 지침 아래에서 올바르던 reader는 사람에게 아무 길도 남기지 않았다. host가 시작에서 실패하므로 재설치 명령조차 돌지 않는다. `package` member만 지우면 저장 file은 시작한다(측정: 그 한 번의 편집 뒤 두 애플리케이션이 모두 시작했다). 범위 문법은 결함의 일부가 아니다.

검사 suite들은 이 전이를 만나지 못한다. 모든 검사가 현재 installer가 방금 쓴 설정에서 시작하고, 릴리즈 빌드를 실행하는 검사는 아예 없다. "이전 릴리즈의 데이터 + 새 binary" 전이에 coverage가 없다.

두 차례의 이전 마이그레이션(installed 형식 1→2 경로 변환, 저장 layout·settings 변환)은 며칠 앞서 migration 금지 지침 아래에서 일부러 지워졌다. 아래의 지침 개정은 그 기록된 이유에 답한다.

## 결정

저장 데이터는 package에 실려 온 정의에서 기계적으로 갱신된다. 계약은 설정 폴더의 모든 저장 file을 소유자, 형식 번호 보금자리, 분류(번호 있음, 일회, log, 외부, 가져온 것)와 함께 이름한다:

1. **형식 변경은 형식 번호를 올리고 마이그레이션 정의를 싣는다.** 정의는 engine에 한 번 구현되는, 이름 붙고 매개변수화된 연산의 순서 목록이다(처음에는 `setFormat`, `removeField`, `renameField`). 연산이 없는 변경은 engine에 연산 하나를 추가하는 deliberate 변경이다. 정의는 정확히 한 file만 이름한다(적재 때 검증). 폴더를 옮기거나 file을 넘는 변경은 schema에서 거부되고, 다른 이름 붙은 경로를 taken다.
2. **정의는 package와 함께 배포된다.** 코어의 정의는 이 저장소의 원본 하나(`packages/sok/migrations/*.json`)이고 두 `sok` build가 embed한다(`go:embed`, `include_str!`). plugin과 sidecar는 저장 file을 소유할 때 자기 release에 정의를 실고 manifest이 선언한다. 형식은 세 소유자가 같다. 정의는 자기 `engines.soksak` 범위가 요구하는 core의 연산만 쓰고, 모르는 연산은 정의·소유자·연산을 이름하며 거부된다. 공개된 plugin·section 식별자는 불변이다.
3. **마이그레이션은 언제나 코어가 수행한다.** engine은 하나(`packages/sok`의 Go/Rust 쌍둥이, 쓰기 동작 하나: 원자적 교체 앞에 sync, 둘째 file은 남기지 않음)이고, 계약 file을 읽는 모든 입구의 첫 읽기에서 정의를 적용한다: host 시작(event log 시작 뒤, 첫 catalog 읽기 전), host의 plugin 조작, 계약 file을 읽는 `sok` 입구(`plugin install|update|remove|enable|disable`, `app update`, `registry use`). engine은 없는 file을 만들지 않고, 다른 process가 설정을 소유 중이면 돌지 않는다(기존 소유 오류가 그것을 이름한다). file 안의 plugin 소유 값은 `convertData` 계약을 유지하고, plugin의 정의는 오늘 이름할 file이 없다. sidecar의 정의는 자기 `services/<이름>/` 아래 경로만 이름하고 서비스가 멈춰 있을 때 적용된다.
4. **engine은 멱등하고 범위가 정해져 있다.** 정의는 release 계열 안에 쌓인다. 사슬은 바닥(계열이 쓴 가장 오래된 형식)부터 현재까지 모든 형식을 갱신하고, 두 번 적용해도 같은 byte를 쓴다. 바닥보다 오래되거나 가장 새 대상보다 새 형식은 파일과 두 숫자를 이름하는 명시적 오류로 거부한다. reader는 계속 현재 형식만 받고, 이전 형식의 판독 code는 남지 않는다 — 정의와 engine이 그것을 대신한다.

## 첫 적용 (F188)

- `plugins/installed.json`이 형식 3이 된다. 정의 `2→3`은 모든 항목에서 `package` member를 제거하고 형식 번호를 3으로 한다. 그 외에는 아무것도 바뀌지 않는다.
- 두 `sok` package에 engine `MigrateInstalled`. 적용 지점은 교정된 anchor다: Wails `host.go`의 event log 시작과 `ApplyPluginEventClasses` 사이, Tauri `host.rs`의 event log 시작과 `apply_plugin_event_classes` 사이, 위의 `sok` 입구들.
- `settings.json`과 `projects.json`은 형식 번호와 engine coverage를 하위 항목으로 등록해 받는다(F188.4, F188.5). 두 file 모두 이전 릴리즈에서 사람을 두 번 막았고 오늘 번호가 없다.

## 검사 (F189)

- 소유 test(두 언어): 릴리즈됐던 형식 2가 갱신되고 host가 시작하며 file이 형식 3이 되고, 두 번째 시작은 아무것도 쓰지 않고, 다시 읽기는 현재 형식을 읽는다. 없는 file은 없는 채로 남고, 가장 새 대상보다 새 형식과 불량 file은 파일과 숫자를 이름하며 거부된다.
- 선언된 릴리즈 단계가 형식 2 상태에서 릴리즈로 빌드된 host를 한 번 실행해 갱신과 첫 host log 줄을 요구하고, 같은 fixture로 릴리즈 `sok`를 실행한다. workflows test가 그 단계를 검사한다.
- spec과 test의 installed 형식 번호 언급이 `InstalledFormat`과 다르면 보고하는 기계적 check.
- spec 교정이 같은 변경에 함께 간다: `installation.md`(file 없을 때 기본값), `host-contract.md`(형식 1 기본값 줄, 절대 `path` 줄, 바뀌는 installed case들), 두 언어의 지침 개정 — 두 차례 제거의 기록된 이유에 답함을 적는다: 정의는 배포에 실려 설치 순간에 한 번 적용되는 데이터이고, 적용 뒤에는 평범한 현재 형식 데이터이며, 이전 형식의 판독 code는 남지 않는다.

## 적대 검증

세 검토자가 조사했다: (a) 정의 형식이 이 저장소의 실제 형식 변경을 담는지, (b) runtime 실패 경로, (c) 대안들과 `installed.json` 너머의 결함 class. 1회차는 통합 21개 이의를 냈고, 위 결정이 답을 흡수했다. 받아들인 교정: 정확한 적용 anchor(원래 적은 지점보다 앞에서 installed.json을 읽는다), host 전에 계약 file을 읽는 `sok` 입구, 정의는 한 file, 두 쌍둥이의 하나의 내구 쓰기, 없는 file을 만들지 않음, 가장 새 대상보다 새 형식의 명시적 거부, caret 변환 제외(문법이 오늘 `^`를 받는다), 정직한 연산 어휘, `settings.json`·`projects.json`을 등록하는 저장 file 목록, plugin data 계약으로 `convertData` 유지, 공개 식별자 불변, 오래된 spec 줄, 제거 기록에 대한 답.

2회차(최대 5회차)는 새 검토자를 쓴다. 매 회차는 그 전 회차에 참여하지 않은 agent가 감사하여, 어느 검토자도 자기 이의를 스스로 확인하지 않게 한다. 새 검토자는 먼저 이 수정된 결정을 판정하는 기준을 밝히고, 기준은 감사 시작 전에 맞추며, 회차는 감사가 남는 이의를 남기지 않을 때 끝난다. 1회차에서 해결된 세 갈등을 새 검토자가 독립적으로 판정한다: 정의는 바닥을 둔 계열 내 축적(한 단계 가지치기에 반대), `settings.json`·`projects.json`은 하위 항목으로 합류(거부만 유지에 반대), `sok` 경로의 소유 규칙(살아 있는 process가 설정을 소유 중이면 거부; plugin 명령의 잠금 없는 읽기-수정-쓰기 경쟁은 별도 결함으로 등록).
