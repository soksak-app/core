# 실려 온 정의에 의한 저장 데이터 마이그레이션

이 제안은 대기 중이다. 승인된 내용은 `docs/spec/installation.md`, `docs/spec/plugins.md`, agent 지침으로 옮겨 가고 제안은 그때 지운다(체크리스트 F188, F189).

## 배경

릴리즈 0.0.13은 같은 제품 계열의 이전 릴리즈가 쓴 `plugins/installed.json`을 가진 설정에서 시작을 거부한다: `installed plugins: <파일>: browser: unknown field package`. 항목에서 `package` field와 npm식 `^` 범위를 없안던 변경(plugin 이름 어휘 변경, 2026-10-08)이 형식 번호를 올리지 않았고(`InstalledFormat`은 2에 그대로), 그래서 그 변경을 알리는 version 차이가 없었고 마이그레이션은 붙을 곳이 없었으며, migration을 금지하던 지침 아래에서 올바르던 reader는 사람에게 아무 길도 남기지 않았다. host가 시작에서 실패하므로 재설치 명령조차 돌지 않는다.

검사 suite들은 이 전이를 만나지 못한다. 모든 검사가 현재 installer가 방금 쓴 설정에서 시작하고, 릴리즈 빌드를 실행하는 검사는 아예 없다. "이전 릴리즈의 데이터 + 새 binary" 전이에 coverage가 없다.

## 결정

저장 데이터는 package에 실려 온 정의에서 기계적으로 갱신된다. 저장 데이터의 모든 소유자(코어, plugin, sidecar)가 같은 계약을 지킨다:

1. **형식 변경은 형식 번호를 올리고 마이그레이션 정의를 싣는다.** 정의는 코드가 아니라 데이터다: `from`, `to`, 기계적 연산(field 제거, 이름 변경, 값 형식 변환).
2. **정의는 package와 함께 배포된다.** 코어의 정의는 이 저장소의 원본 file(`packages/sok/migrations/*.json`)이고 두 `sok` build가 embed한다(`go:embed`, `include_str!`) — 원본 하나, 두 host가 같다. plugin과 sidecar는 자기 release에 정의를 실고 manifest(`plugin.json`, `sidecar.json`)이 선언한다. 정의의 형식은 세 소유자가 같다.
3. **마이그레이션은 언제나 코어가 수행한다.** engine은 하나(`packages/sok`의 Go/Rust 쌍둥이)이고, 새 package가 설정 폴더를 소유하는 순간 정의를 읽어 기계적으로 적용한다. 코어 소유 file은 host 시작에서, 나머지는 `sok`의 plugin·sidecar 명령에서다. plugin과 sidecar는 migration 코드를 갖지 않는다.
4. **engine은 멱등하고 범위가 정해져 있다.** 저장된 형식 번호를 읽고 정의를 단계별로 적용한다(2→3→…). 이미 현재 형식인 file은 그대로 두고, 두 번 적용해도 같은 byte를 쓴다. 직전 릴리즈 형태보다 오래된 형식이나 판독 불가한 file은 파일과 그 내용을 이름하는 명시적 오류로 거부한다. reader는 계속 현재 형식만 받고, 이전 형식의 판독 code는 남지 않는다 — 정의와 engine이 그것을 대신한다.

migration을 금지하던 지침 문장은 그대로는 틀린 것으로 밝혀졌고 이 결정과 함께 바뀐다: 저장 형식의 변경은 형식 번호를 올리고 정의를 싣는다. reader는 현재 형식만 받는다.

## 첫 적용 (F188)

- `plugins/installed.json`이 형식 3이 된다(현재 항목 모양, `package` 없음). 첫 정의 `2→3`은 모든 항목에서 `package` member를 제거하고, sidecar 범위의 `^x.y.z`를 npm caret 의미의 유한 범위로 바꾸고, 형식 번호를 3으로 한다. `enabled`, `previous` 등 나머지는 그대로 지나간다.
- 두 `sok` package에 engine `MigrateInstalled`. 적용 지점: 두 host의 시작과 `sok plugin *` 명령.

## 검사 (F189)

- 소유 test(두 언어)가 릴리즈됐던 형식 2로 각 host를 시작한다: engine이 갱신하고 host가 시작하며 file이 형식 3이 되고, 두 번째 시작은 아무것도 쓰지 않는다. 형식 1이나 불량 file은 이름을 밝히는 오류로 거부한다.
- 선언된 릴리즈 단계가 형식 2 상태에서 릴리즈로 빌드된 host를 한 번 실행해 갱신과 첫 host log 줄을 요구하고, workflows test가 그 단계를 검사한다.

## 적대 검증

이 결정은 agent들의 적대 검증을 거친다. 각 이의는 증거로 답하거나 계획을 바꾸며, 남는 이의가 없을 때까지 반복한다. 이의와 답변은 여기에 기록한다.

_대기 중: 세 검토자가 다음을 조사한다. (a) 정의 형식이 이 저장소 역사의 모든 형식 변경을 담는지, (b) runtime 모델의 실패 경로(부분 쓰기, 동시 실행, translocation, version skew, 악의적 정의), (c) 표준 대안들과 `installed.json` 너머의 결함 class._
