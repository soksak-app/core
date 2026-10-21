# 플러그인 호스트의 사이드카 경로

[English](plugin-host-routes.md)

F229의 결정과 검토 기록이다. [플러그인 호스트](../spec/plugin-host.md)에 결정이 들어가고 F229 구현 항목이 끝나면 이 문서를 제거한다.

## 문제

사이드바 섹션이 프로젝트 폴더에서 사이드카가 계산한 값을 보여주는 플러그인(예: 폴더 목록을 선언된 트리로 표시)은, 열린 뷰가 하나도 없을 때 그 값의 출처가 없다.

- [플러그인 호스트](../spec/plugin-host.md)는 선언된 상태의 두 번째 출처이지만, 채널은 등록 호출과 상태 호출만 제공한다. 그 밖의 호출에는 `plugin host call <name> is not served`로 응답하며, 사이드카 send가 없다([플러그인 호스트](../spec/plugin-host.md#channel)).
- 사이드카는 선언된 상태의 출처가 아니다. 선언된 상태의 출처는 상태를 등록하고 선언된 UI 스냅샷을 밀어 넣는 프로세스다([선언된 UI](../spec/declared-ui.md#declared-status)). 사이드카는 둘 다 하지 않는다.

## 범위

F229는 플러그인 호스트가 매니페스트에 선언된 사이드카에 송신하고 그 사이드카로부터 수신하는, 자기 플러그인 기준으로 검사되는 최소한의 일반 경로다. F229에는 이것 말고는 없다. 이 경로 밖의 동작은 검토 중 제기되었더라도 이 결정에 대한 이의가 아니라 별도 하위 항목(F229-n, 아래 목록)이다.

## 선택지

1. **플러그인 호스트에 사이드카 경로를 준다.** 호스트 페이지가 채널을 통해 자기 플러그인이 선언한 사이드카의 세션에 송신하고 구독한다. 메인 페이지가 이 호출에 답한다.
2. **사이드카가 선언된 값을 직접 공급한다.** 사이드카가 선언된 상태를 등록하고 스냅샷을 민다. 기각: 선언된 상태는 플러그인의 명령에 묶이며, 그 명령을 등록하는 프로세스가 필요하다. 따라서 사이드카를 출처로 삼아도 섹션의 명령마다 뷰나 플러그인 호스트가 여전히 필요하다. 사이드카 프로세스는 여러 창과 프로세스를 섬기며, 선언된 상태의 출처는 프로세스와 그 등록의 쌍이다. 그래서 [선언된 UI](../spec/declared-ui.md#declared-status)의 출처 전이에 두 번째 형식이 필요해진다. 또한 모든 사이드카가 자기 저장소에서 스냅샷 프로토콜을 구현해야 한다.

결정: 선택지 1.

## 경로

1. **제공하는 호출.** 플러그인 호스트의 채널은 등록 호출과 상태 호출에 더해 `runtime.sidecar.send`, `runtime.sidecar.on`, `runtime.sidecar.onFailure`를 제공한다. 호스트는 등록 호출을 전달하듯 각 호출을 `plugin-host-call {plugin, id, command, params}`로 메인 페이지에 전달한다. 그 밖의 이름, 모든 `core.` 이름을 포함해, `plugin host call <name> is not served`로 거절한다. 코어 명령은 F229의 일이 아니다(F229-5).
2. **메인 페이지의 검사.** 플러그인 호스트의 사이드카 호출은 표면이 아니라 호스트의 플러그인에 묶인 경로가 답한다. 사이드카 이름은 플러그인이 `plugin.json`의 `dependencies`에 나열한 것이어야 한다. 그 밖의 이름은 `plugin host <plugin> cannot use sidecar <name>`로 거절한다. 세션 id는 `plugin:<plugin id>:<project id>:<sidecar name>` 형식이며, 여기서 project id는 송신 창이 보유한 프로젝트의 id다. 창이 보유하지 않은 project id는 `plugin host <plugin>: project <id> is not held by this window`로 거절한다. 어떤 id에도 `:`이 없으므로(`packages/host/wailsv3/src/projects.go`의 `validProjectID`와 `packages/host/tauriv2/src/windows.rs` 786~792행의 인라인 검사) id는 분해된다. project id는 3번 규칙의 루트를 정한다. 프로젝트의 보유 창은 하나다(`projects.go`의 `h.owners`, 145행에서 설정). 따라서 세션 id는 한 시점에 보유 창이 하나다. 그 밖의 세션 id는 `plugin host <plugin> cannot use sidecar session <id>`로 거절한다. `plugin:`으로 시작하는 세션 id에 대한 뷰 호출은 뷰 경로가 `sidecar session <id> is reserved for a plugin host`로 거절한다. 창의 일반 `sidecarSend` 호출은 모든 `plugin:` 표면을 거절하므로, 뷰는 이 호출로 플러그인 세션에 닿을 수 없고, 플러그인 호스트는 3번의 호출로만 자기 세션에 닿는다.
3. **송신.** 플러그인 호스트의 송신은 Go와 Rust의 호스트 호출 `pluginHostSidecarSend {plugin, sidecar, id, body, cids}`다. 핸들러는 2번의 접두사와 플러그인을 검사한 뒤, 세션을 표면 id로 삼아 기존 사이드카 송신 경로를 실행한다. 사이드카의 기존 소유자 기록이 세션에 적용된다. 첫 송신이 창을 소유자로 기록하며, 다른 창의 송신은 기존 검사가 거절한다. 플러그인 세션은 자기 id가 명명한 프로젝트에 대해 창이 기록한 루트를 쓴다. `ProjectOpen`이 창에서 여는 각 프로젝트의 폴더 루트를 `owner.projects`(두 호스트 모두 프로젝트 id에서 루트로의 맵)에 기록하고, 송신 경로는 `owner.ProjectRoot()` 대신 그 루트를 넘긴다(`sidecars.go` 441행). 기록된 루트가 비어 있는 프로젝트로의 송신은 시작이나 기록 전에 `plugin host <plugin>: project <id> has no folder`로 거절하며, 빈 루트는 기록하지 않으므로 `Retain`은 빈 루트를 보지 않는다. 세션은 소유자가 닫을 때까지 그 루트를 유지한다. 프로젝트 변경을 넘는 이 루트의 수명은 F229-1이 정한다.
4. **이벤트.** 플러그인 세션의 사이드카 메시지나 실패는 기존 `sidecar-message`와 `sidecar-failure` 이벤트로 소유자 창에 도달한다. 메인 페이지는 호스트 페이지가 그 세션과 사이드카를 구독한 경우에만 `pluginHostEvent {plugin, event, sidecar, id, body}` 또는 `{..., reason}`로 호스트 페이지에 전달한다. 호스트 페이지는 뷰 브리지의 `runtime.sidecar(name).on(id, listener)`와 `.onFailure(id, listener)`로 구독하고, 메인 페이지가 그 구독을 기록해 답한다. 구독이 없는 플러그인 세션의 메시지나 실패는 버리고 `warn`으로 `plugin host <plugin>: sidecar <name> <event> for <session> dropped: no subscription`이라고 기록한다. 사이드카가 만든 데이터를 페이지가 받지 못했기 때문이다(`docs/spec/logging.md`: `warn`은 손실). 호스트 페이지로의 전송 실패는 5번의 오류다. `packages/workbench/host.js`의 `listenSidecarFailures`에는 현재 `plugin:` 분기가 없다. 핸들러가 없는 실패마다 `ErrorEvent`를 보낸다(149~153행). F229는 그 발송 앞에 `plugin:` 실패를 호스트 페이지의 구독으로 보내는 분기를 추가하므로, 플러그인 세션에 경고가 뜨지 않는다. 실패는 5번처럼 로그에 남긴다.
5. **오류.** 거절된 호출은 1번이 제공하지 않는 호출을 포함해 호출한 호스트 페이지에 오류 문구로 답하고, `error: plugin host <plugin>: <reason>`로 애플리케이션 로그에 `error`로 쓴다. 오류 문구는 1번부터 3번까지의 것과 기존 사이드카 검사의 소유자 거절 문구 `surface <id> belongs to another window`(`sidecars.go` 482행)다. 호스트가 거절한 전송(준비된 문서가 없거나 문서가 거절)은 이유와 함께 `error`로 쓴다.
6. **실패와 재시작 한도.** 실패한 사이드카로의 송신은 사이드카 실패 계약([사이드카](../spec/sidecars.md#failure))이 모든 세션에 대해 정한 대로 끝나며, 사이드카의 재시작 한도는 이를 다른 실패와 같이 센다. 실패 기록은 사이드카 이름별이므로 플러그인 세션은 같은 사이드카의 다른 모든 세션과 기록을 공유한다. 한도 아래에서는 호스트 페이지의 다음 요청이 새 프로세스를 시작하고, 호스트 페이지는 세션을 다시 연다. 한도가 사이드카를 정지시킨 뒤에는 그 사이드카의 모든 요청이 `sidecar <name>: restart limit`으로 거절된다. `restartRefused`(`sidecars.go` 254~260행)가 거절된 요청마다 `error`로 쓰고, 소유자에게는 사유 `restart limit`의 `sidecar-failure`로 전달된다. 거절된 요청은 세지 않는다. 정지는 [사이드카](../spec/sidecars.md#failure)가 정한 대로, `dependencies`에 그 사이드카를 나열한 플러그인의 표면이 생겨야 풀린다. 플러그인 호스트는 표면을 만들지 않으므로 그 요청만으로는 정지가 풀리지 않는다(플러그인 호스트 정지 규칙은 F229-6). 호스트 페이지의 실패 핸들러는 아무것도 보내지 않으므로 거절에 재송신이 없다. 메인 페이지는 스스로 송신하지 않는다. 사이드카 송신은 모두 호스트 페이지의 요청에 대한 답이다.

## 명세 변경

- `docs/spec/plugin-host.md` 59행의 "플러그인 호스트에는 사이드카 send가 없다"는 문장을 1번의 제공 호출과 2번의 검사로 바꾼다.
- `docs/spec/plugin-host.md` 48행에서 어떤 코드도 주입하지 않는 호스트 페이지의 동기 `project` 값을 제거한다(프로젝트 값은 F229-1이 소유한다).
- `docs/spec/sidecars.md`에 플러그인 세션 id 형식, `pluginHostSidecarSend` 호출, 플러그인 세션의 공유 실패 기록을 적는다.
- `docs/spec/declared-ui.md`에 플러그인 호스트의 선언된 섹션이 호스트 페이지가 민 스냅샷을 그린다고 적는다.
- `docs/spec/host-contract.md` 837행(`plugin-host.channel.call-served-set`)은 1번의 제공 집합을 나열한다. `pluginHostSidecarSend`와 세 `runtime.sidecar` 호출의 계약 사례를 두 호스트에 추가한다.
- `docs/spec/declared-ui.md`와 `docs/spec/plugins.md`: 브리지는 `runtime.sidecar(name)`이며, 뷰 브리지는 `sidecar` 매개변수를 얻고, `packages/plugin-api/view.js`가 그 변경을 나열한다. 그 테스트도 함께 바뀐다.
- 바뀐 명세 파일의 한국어 번역은 같은 변경의 일부다.
- `docs/features.md`와 `docs/features.ko.md`에 F229와 F230을 F212 아래에 등록한다.

## F229 밖의 하위 항목

아래는 검토에서 제기되었지만 경로 밖의 동작에 관한 이의다. 각각 증거와 함께 별도 항목으로 등록하며, F229 결정에 속하지 않는다.

- **F229-1** 창의 표시 프로젝트와 프로젝트 변경을 넘는 플러그인 세션의 수명. 증거: `ProjectOpen`은 로컬 분기에서 `owner.root`를 바꾸고 `{Local}`만 반환한다(`packages/host/wailsv3/src/projects.go` 96~132행; `packages/host/tauriv2/src/windows.rs` 약 796~815행). `activateInTurn`은 이벤트 없이 창의 프로젝트를 바꾼다(`packages/workbench/projects.js` 339~352행). `ProjectRelease`는 남은 프로젝트가 없을 때만 루트를 지운다(`projects.go` 172~192행).
- **F229-2** 플러그인 호스트가 끝날 때, 페이지 시작 때, 새로 고침 때 플러그인 세션을 닫기. 증거: 페이지 시작 때의 폐기(`packages/host/wailsv3/src/start.go` 74~82행; `packages/host/tauriv2/src/windows.rs` 984~991행)는 `plugin-host-ended`를 내지 않는다.
- **F229-3** `closeSurface`는 실행 중인 모든 사이드카에 `closed`를 보낸다(`packages/host/wailsv3/src/sidecars.go` 591~629행). 한 세션의 닫기는 그 세션을 가진 사이드카에만 가야 한다.
- **F229-4** 소유자가 없는 세션의 응답은 `dropMessage`가 `info`로 쓴다(`sidecars.go` 2064~2067행). 그 수준은 로깅 계약과 대조해야 한다.
- **F229-5** 플러그인 호스트의 코어 명령 경로. 말한 문제에는 플러그인 호스트의 코어 명령이 필요 없다. 별도의 결정과 검토가 필요하다.
- **F229-6** 재시작 정지 해제 규칙. 사이드카 정지는 그 사이드카에 의존하는 임의 플러그인의 표면이 생기면 풀린다(`sidecars.md`). 플러그인 호스트 정지는 자기 플러그인의 표면이 생겨야 풀린다(`plugin-host.md` 80행). 두 규칙을 합치는 결정은 별도다.
- **F229-7** 창의 retain은 프로세스가 보낸 모든 세션을 유지하는데, 두 호스트 모두 서비스를 시작하기 전에 `keep` 목록을 만든다(`sidecars.go` 945~972행; `packages/host/tauriv2/src/sidecars.rs` 약 1576~1612행). 시작 중에 처음 보낸 세션이 목록에서 빠진다.
- **F229-8** `state:<plugin id>:<project id>` 세션은 F229-1과 같은 수명 결함이 있다.

## 검토 기록

### 1~3차 (요약)

세션 닫기(R1-1), 프로젝트별 세션(R1-2), 첫 송신의 루트 읽기(R2-1), 진행 중 닫기(R2-2), 프로젝트 읽기(R2-3), 구독 수명(R2-4), 표시 프로젝트 id(R3-1), 대기 중 닫기와 재열기(R3-2), 뷰 경로(R3-3), 명세 문장(R3-4)은 수용되어 당시 설계에 반영되었다. 프로젝트 변경 뒤의 이벤트 순서(R3-5)는 기각했다. 응답은 페이지 자신의 요청에 대한 답이며 세션 id로 전달된다.

### 4~8차 (요약)

각 차수는 수용된 이의를 냈고, 그 버전의 규칙으로 답했다. 주된 내용은 표시 프로젝트, 그 응답 형식과 잠금, 재로드와 페이지 시작, 닫기와 retain, 코어 명령 경로였다. 8차부터 코어 명령 경로를 뺐고(F229-5), 프로젝트 상태와 닫기 수명을 별도 항목(F229-1, F229-2)으로 나눴다. 이 차수들의 전문은 이 파일의 git 기록에 있다.

### 9차

설계 8차에 대해 새 감사자 두 명이 검토했다. 감사자 A는 범위 변경 전에 결과를 냈다. 이의 O1(프로젝트를 로컬로 바꾸면 이벤트가 없어 1번 6의 트리거가 이를 덮지 못함)과 O2(메인 페이지의 초기 표시 값이 정의되지 않음)는 모두 표시 프로젝트에 관한 것이며 F229-1이다. 감사자 B의 결과는 범위 변경 시점에 도착하지 않았고, 이 차수의 이의로 답하지 않는다.

감독자 결정(9차): 검토가 수렴하지 않았다. 설계가 프로젝트 소유, 표시 상태, 재로드, 창 기록으로 커졌다. F229는 1~6번 규칙의 사이드카 경로로 범위를 좁힌다. 경로 밖의 동작은 하위 항목 F229-1~F229-8이며, 각각 증거와 함께 별도 항목이다.

### 10차

두 명의 새 감사자가 1~6번 규칙을 코드와 대조해 검토했다. 감사자들은 일곱 개의 서로 다른 이의를 냈고, 같은 검사에서 하나가 더 발견되었다. 모든 이의는 코드에서 확인하고 수용했으며, 반박은 없었다.

1. 2번 규칙은 project id의 이유로 "같은 프로젝트를 가진 두 창"을 들었다. `projects.go` 145행에서 `h.owners`는 프로젝트마다 보유 창을 하나만 둔다. 그래서 그 이유는 일어나지 않는다. project id는 이제 3번 규칙의 루트를 정한다. 수용.
2. 3번 규칙은 창의 루트(`owner.ProjectRoot()`, `sidecars.go` 441행)를 썼다. 이 루트는 창마다 하나(`projects.go` 143~145행)이며, id가 명명한 프로젝트의 루트가 아니다. 3번 규칙은 이제 프로젝트별로 기록된 루트를 쓰고, 2번 규칙은 창이 보유하지 않은 프로젝트를 거절한다. 수용.
3. 4번 규칙은 `info`의 선례로 `dropMessage`를 들었다. `dropMessage`는 소유 창이 없는 메시지를 다루며(`sidecars.go` 2064행), 구독이 없는 메시지가 아니고, 그 수준은 열린 항목 F229-4다. 4번 규칙은 이제 `logging.md`의 `warn` 뜻, 즉 버려진 사이드카 메시지는 손실이라는 근거를 쓴다. 이는 9차의 `info` 수준을 대체한다. 수용.
4. 4번 규칙은 `listenSidecarFailures`가 이미 `plugin:` 실패를 보낸다고 했다. 이 함수에는 그런 분기가 없다(`host.js` 144~158행). 4번 규칙은 이제 그 분기를 F229가 하는 변경으로 적는다. 수용.
5. 5번 규칙은 2번과 3번의 문구만 다뤘다. 1번의 거절(`plugin_host_channel.rs` 249~256행)은 로그에 남지 않고, 소유자 거절 문구도 나열되지 않았다. 5번 규칙은 이제 둘 다 다룬다. 수용.
6. 6번 규칙은 `restartRefused`가 한 번 기록한다고 했다. 실제로는 거절된 요청마다 기록한다(`sidecars.go` 254~260행). 수용.
7. 6번 규칙은 호스트 페이지의 다음 요청이 세션을 다시 연다고 했다. 재시작 한도 정지 뒤에는 의존 플러그인의 표면만 정지를 푼다(`sidecars.go` 232~250행; `sidecars.md`). 그래서 그 요청은 거절된다. 6번 규칙은 두 경우를 모두 적는다. 정지 해제 규칙 자체는 F229-6에 남는다. 수용.

이의: 감사자 7개, 검사에서 1개. 한 감사자의 여섯 번째 이의는 수집된 출력이 잘려 복구되지 않았다. 11차가 1~6번 규칙을 두 명의 새 감사자로 다시 검토한다.
