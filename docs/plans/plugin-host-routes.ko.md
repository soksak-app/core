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

3. **상태 모듈이 선언된 상태를 공급한다.** 13차에 기각. 상태 모듈의 상태는 `exposure.status(name, read, subscribe)`(`docs/spec/plugins.md`, plugin state)이며, `seq`, 확인 응답, `skipped`가 없는 pull과 구독이다. 선언된 상태는 뷰와 플러그인 호스트 두 송신자만 가진 스냅샷 프로토콜이다(`docs/spec/declared-ui.md` 상태 매핑, `packages/workbench/declared-source.js`의 출처 분기와 `hostRegistrant`, `packages/workbench/exposure.js` 528~531행). 따라서 상태 경로는 세 번째 출처 종류, 어댑터, 확인 응답 경로가 필요하며 더 작은 변경이 아니다.

결정: 선택지 1.

## 경로

1. **제공하는 호출.** 플러그인 호스트의 채널은 등록 호출과 상태 호출에 더해 `runtime.sidecar.send`, `runtime.sidecar.on`, `runtime.sidecar.onFailure`를 제공한다. 호스트는 등록 호출을 전달하듯 각 호출을 `plugin-host-call {plugin, id, command, params}`로 메인 페이지에 전달한다. 메인 페이지는 `runtime.sidecar.on`과 `runtime.sidecar.onFailure`에 구독을 기록한 뒤 `{result: null}`로 답하고, `runtime.sidecar.send`에는 `pluginHostSidecarSend`의 결과로 답한다. `packages/workbench/plugin-host.js`의 `servedPluginHostCall`(20행)은 세 호출을 나열해야 한다(오늘은 두 개). 그 밖의 이름, 모든 `core.` 이름을 포함해, `plugin host call <name> is not served`로 거절한다. 코어 명령은 F229의 일이 아니다(F229-5). `runtime.sidecar.*` 세 호출은 `packages/host/tauriv2/src/plugin_host_channel.rs`(68~73행)의 `forwarded_call`과 Go 전달기에 더해지고, `packages/workbench/plugin-host.js`의 `answer`는 노출 분기 앞에서 그 세 호출을 보낸다. `docs/spec/host-contract.md` 837행이 그 호출을 나열한다.
2. **메인 페이지의 검사.** 플러그인 호스트의 사이드카 호출은 표면이 아니라 호스트의 플러그인에 묶인 경로가 답한다. 호스트 호출 `pluginHostSidecarSend`는 Go에서 `PluginHostReply`와 나란한 메인 페이지 바인딩의 메서드(`packages/host/wailsv3/src/bindings.go`)이며, 표면 호출 경로 `runNative`의 항목이 아니다. 따라서 표면 문서는 이 호출을 할 수 없다. Rust에서는 `authorize_main_caller`(`packages/host/tauriv2/src/exposure.rs` 702~709행)로만 받는다. `plugin` 매개변수는 메인 페이지가 답하는 `plugin-host-call`의 플러그인이다. 사이드카 이름은 플러그인이 `plugin.json`의 `dependencies`에 나열한 것이어야 한다. 그 밖의 이름은 `plugin host <plugin> cannot use sidecar <name>`로 거절한다. 세션 id는 `plugin:<plugin id>:<project id>:<sidecar name>` 형식이며, 여기서 project id는 송신 창이 보유한 프로젝트의 id다. 창이 보유하지 않은 project id는 `plugin host <plugin>: project <id> is not held by this window`로 거절한다. 어떤 id에도 `:`이 없으므로(`packages/host/wailsv3/src/projects.go`의 `validProjectID`와 `packages/host/tauriv2/src/windows.rs` 786~792행의 인라인 검사) id는 분해된다. project id는 3번 규칙의 루트를 정한다. 프로젝트의 보유 창은 하나다(`projects.go`의 `h.owners`, 145행; Rust에서는 `Windows.owners`, `windows.rs` 163행). 따라서 세션 id는 한 시점에 보유 창이 하나다. 그 밖의 세션 id는 `plugin host <plugin> cannot use sidecar session <id>`로 거절한다. 플러그인 세션은 3번 규칙의 호출로만 닿는다. 창의 일반 `sidecarSend`는 호출자가 뷰든 메인 페이지든 `plugin:` 표면을 `sidecar session <id> is reserved for a plugin host`로 거절한다. 이 거절은 이 결정이 두 호스트에 더하는 변경이다(Go `sidecarSendFrom`, `packages/host/wailsv3/src/surfaces.go` 359~363행; Rust `sidecar_send`, `packages/host/tauriv2/src/bindings.rs` 326~340행).
3. **송신.** 플러그인 호스트의 송신은 Go와 Rust의 호스트 호출 `pluginHostSidecarSend {plugin, sidecar, id, body, cids}`다. 핸들러는 2번의 접두사와 플러그인을 검사한 뒤, 세션을 표면 id로 삼아 기존 사이드카 송신 경로를 실행한다. 사이드카의 기존 소유자 기록이 세션에 적용된다. 첫 송신이 창을 소유자로 기록하며, 다른 창의 송신은 기존 검사가 거절한다. 플러그인 세션은 표면이 창의 루트를 쓰는 것처럼 첫 송신 때 자기 프로젝트의 루트를 쓴다. 창은 보유한 각 프로젝트의 폴더 루트를 기록한다. Go에서 이 기록은 `Surfaces.projects`(`surfaces.go` 251행)이며, 집합에서 프로젝트 id에서 루트로의 맵으로 바뀐다. `ProjectOpen`이 두 분기(`projects.go` 119~124행과 141~144행) 모두에서 쓰고, `ProjectRelease`(`projects.go` 172~192행)가 해제된 id를 지운다. Rust에서는 `Windows.owners`(`packages/host/tauriv2/src/windows.rs` 163행)가 프로젝트 id에서 창 라벨로 보유를 나타낸다. `WindowData`는 `projects: Mutex<HashMap<String, String>>`(프로젝트 id에서 루트로)를 얻고, `project_open_on_main`이 두 분기 모두에서 쓰며(`windows.rs` 786~820행), `project_release`가 해제된 id를 지운다(`windows.rs` 878~898행). 송신 경로는 루트를 인수로 받는다. 표면 송신은 지금처럼 창의 루트를 넘기고, 플러그인 송신은 창의 루트 대신 자기 프로젝트의 기록된 루트를 넘긴다(Go `sidecars.go` 436~441행; Rust `sidecars.rs`의 `send` 1149행). 기록된 루트가 비어 있는 프로젝트로의 송신은 시작이나 기록 전에 `plugin host <plugin>: project <id> has no folder`로 거절하며, 빈 루트는 기록하지 않으므로 `Retain`은 빈 루트를 보지 않는다. 세션은 소유자가 닫을 때까지 그 루트를 유지한다. 해제는 해제된 창의 맵에서 id를 지우며, 호출한 창의 맵은 건드리지 않는다. 프로젝트 변경을 넘는 기록의 수명은 F229-1이 정한다.
4. **이벤트.** 플러그인 세션의 사이드카 메시지나 실패는 기존 `sidecar-message`와 `sidecar-failure` 이벤트로 소유자 창에 도달한다. 호스트 페이지는 그 세션으로 첫 송신을 하기 전에 뷰 브리지의 `runtime.sidecar(name).on(id, listener)`와 `.onFailure(id, listener)`로 구독한다. 구독이 없는 송신의 답은 버려지기 때문이다(아래). 뷰 브리지(`packages/plugin-api/view.js`)는 `sidecar()`에서 `sidecar(name)`으로 바뀌며, `on`, `onFailure`와 함께 `send(id, body, cids)`를 제공하고, 요청은 `{id, sidecar}`를 싣는다(명세 변경 목록). 메인 페이지는 각 구독을 `packages/workbench/plugin-host.js`에 플러그인, 사이드카, 세션 id의 조합으로 기록하고, 맞는 메시지나 실패를 `pluginHostEvent {plugin, event, sidecar, id, body}` 또는 `{..., reason}`로 호스트 페이지에 보낸다. 메인 페이지는 `plugin-host-ended {plugin}`을 받으면 그 플러그인의 구독을 등록과 함께 지운다(`docs/spec/plugin-host.md` 62행). `plugin-host.js`는 구독 레지스트리를 내보내고, `packages/workbench/host.js`가 그것을 가져온다(`plugin-host.js`는 호스트 모듈을 가져오지 않으므로 순환이 생기지 않는다). `plugin:`으로 시작하는 표면의 `sidecar-message`나 `sidecar-failure`는 `host.js`가 레지스트리에 넘기고, `windowSidecar`(183행)와 실패 발송(`listenSidecarFailures`, 146~154행) 앞에서 반환한다. 그래서 플러그인 세션에 경고가 뜨지 않는다. 구독이 없는 플러그인 세션의 메시지나 실패는 버리고 `warn`으로 `plugin host <plugin>: sidecar <name> <event> for <session> dropped: no subscription`이라고 기록한다. 사이드카가 만든 데이터를 페이지가 받지 못했기 때문이다(`docs/spec/logging.md`: `warn`은 손실). 호스트 페이지로의 전송 실패는 5번처럼 기록한다. 사이드카 실패는 사이드카 프로세스의 기존 `failed:` 오류가 한 번 기록하며(`sidecars.go` 1610행), 이 경로는 줄을 더하지 않는다.
5. **오류.** 거절된 호출은 1번이 제공하지 않는 호출을 포함해 호출한 호스트 페이지에 오류 문구로 답하고, `error: plugin host <plugin>: <reason>`로 애플리케이션 로그에 `error`로 쓴다. 오류 문구는 1번부터 3번과 7~8번의 것(`pluginHostSidecarSend`와 `pluginHostSidecarClose`의 호출자 거절 `error: plugin host <plugin>: caller is not the main window`, 8번의 본문과 작업 거절 `plugin host <plugin>: body is not a JSON object`와 `plugin host <plugin>: operation is missing or not a string`, 그리고 제공하지 않는 모든 작업의 `plugin host <plugin>: operation <op> is not served`로 작업 중 8번 규칙이 제공하지 않는 작업을 포함한다)과 송신 경로가 반환하는 모든 오류다(`sidecars are stopped`, `sidecar <name> is not declared by any plugin`, 소유자 거절 `surface <id> belongs to another window`, 프로세스 시작 오류, `sidecar <name> is not keeping up`; `sidecars.go` 476~518행). 이들은 호스트 페이지에 변경 없이 전달한다. 재시작 한도 거절은 예외다. `restartRefused`가 거절된 요청마다 쓰고 6번이 이를 정하므로, 이 규칙은 다시 쓰지 않는다. 호스트가 거절한 전송(준비된 문서가 없거나 문서가 거절)은 이유와 함께 `error`로 쓴다.
6. **실패와 재시작 한도.** 표준 입출력 사이드카에서 실패한 사이드카로의 송신은 사이드카 실패 계약([사이드카](../spec/sidecars.md#failure))이 모든 세션에 대해 정한 대로 끝나며, 재시작 한도는 이를 다른 실패와 같이 센다. 지속 사이드카의 재시작 한도는 명세가 정하지 않으므로 이 규칙은 적용되지 않는다. 실패 기록은 사이드카 이름별이므로 플러그인 세션은 같은 사이드카의 다른 모든 세션과 기록을 공유한다. 한도 아래에서는 호스트 페이지의 다음 요청이 새 프로세스를 시작하고, 호스트 페이지는 세션을 다시 연다. 한도가 사이드카를 정지시킨 뒤에는 그 사이드카의 모든 요청이 `sidecar <name>: restart limit`으로 거절된다. `restartRefused`(`sidecars.go` 254~260행)가 거절된 요청마다 `error`로 쓰고, 소유자는 사유 `restart limit`의 `sidecar-failure`를 받는다. 거절된 요청은 세지 않는다. 정지는 [사이드카](../spec/sidecars.md#failure)가 정한 대로, `dependencies`에 그 사이드카를 나열한 플러그인의 표면이 생겨야 풀린다. 플러그인 호스트는 표면을 만들지 않으므로 그 요청만으로는 정지가 풀리지 않는다(플러그인 호스트 정지 규칙은 F229-6). 호스트 페이지의 실패 핸들러는 아무것도 보내지 않으므로 거절에 재송신이 없다. 메인 페이지는 스스로 송신하지 않는다. 사이드카 송신은 모두 호스트 페이지의 요청에 대한 답이다.

7. **세션 종료.** 플러그인 세션은 호스트, 프로젝트, 창과 함께 끝난다. 메인 페이지는 `plugin-host-ended {plugin}`을 받으면(4번 규칙과 `docs/spec/plugin-host.md` 62행) 호스트 호출 `pluginHostSidecarClose {plugin}`을 부르며, 이 호출은 호출한 창이 가진 세션만 닫는다. 나머지 닫기는 페이지가 아니라 호스트가 한다. 메인 페이지가 다시 불러와지기 전에 페이지 시작이 그 이벤트 없이 호스트 웹 뷰를 폐기하므로(`packages/host/wailsv3/src/start.go` 82~86행, `InvokeSync` 블록 뒤; `packages/host/tauriv2/src/windows.rs` 984~991행; F229-2) 호스트는 그 시점에 창이 가진 플러그인 세션을 모두 닫는다. Go에서는 닫기가 `startPage`의 `InvokeSync` 블록 뒤에 실행되고, 소유자 id는 `c.mu` 아래에서 모은 뒤 잠금을 풀고 각 `closeSurface`를 부른다(`closeSurface`가 스스로 잠그기 때문이다). `ProjectRelease`(`packages/host/wailsv3/src/projects.go` 172~192행)와 `project_release`(`packages/host/tauriv2/src/windows.rs` 878~898행)는 프로젝트 id를 이름에 담고 그 프로젝트를 쥔 창(Go의 `h.owners[id]`, Rust의 해제된 라벨)이 소유한 플러그인 세션을 모두 닫는다. 호출한 창의 세션은 닫지 않는다. 창이 닫힐 때는 그 창의 플러그인 세션을 모두 닫는다. 각 닫기는 기존 사이드카 세션 닫기다. Go는 `closeSurface`(`sidecars.go` 591~612행), Rust는 같은 경로이며, 실행 중인 각 사이드카에 `{surface, closed: true}`를 보내고 응답이 올 때까지 닫힘 목록에 둔다(`docs/spec/sidecars.md`의 프로토콜, 42행과 50행). retain의 유지 목록은 사이드카 프로세스를 시작한 뒤 같은 잠금 블록 안에서 다시 만든다. 따라서 시작 중에 처음 송신된 플러그인 세션도 유지된다(F229-7; Go `Retain`은 소유자가 아니라 `c.roots`를 읽는 `sidecars.go` 945~972행이며, `packages/host/tauriv2/src/sidecars.rs` 1576~1620행). 이 경로는 `closeSurface`가 실행 중인 모든 사이드카에 보내는 방송을 이어받는다(F229-3). 사이드카는 받은 모든 `closed`에 답한다. 세션 닫기는 사이드카 상태의 소유자 기록(Go의 `c.owners`, Rust의 `State.owners`, `sidecars.rs` 767행; `Windows.owners`는 프로젝트에서 창으로 가므로 쓰지 않는다)을 `plugin:<plugin>:` 접두사와 닫기가 가리키는 창(호출한 창, 또는 해제된 프로젝트를 쥔 창) 소유로 열거하고, 각각에 `closeSurface`를 부른다. 플러그인 id에는 `:`가 없다(프로젝트 id와 같다). 매니페스트 읽기는 `:`가 든 플러그인 id를 거절하며, 이것은 이 경로가 더하는 변경이다. 소유자가 없는 세션은 닫지 않는다.
8. **작업.** `dependencies`의 각 사이드카에 대해, 경로는 플러그인 매니페스트가 `plugin.json`의 `hostOperations` 필드에 선언한 작업만 정확히 제공한다. 키는 사이드카의 `package.json` 이름이다(`docs/spec/plugins.md` 매니페스트, `docs/spec/sidecars.md` 11행). 사이드카는 플러그인 호스트가 부를 수 있는 작업을 `sidecar.json`의 `hostReadOperations`에 나열하며, 선언된 모든 작업은 그 목록에 있어야 한다. `@soksak/plugin-api`의 `validatePlugin`은 그렇지 않은 선언을 거절하므로, 플러그인 호스트는 사이드카가 읽기 전용으로 선언한 작업만 지정할 수 있다. `hostReadOperations`가 없는 사이드카의 모든 작업은 거절당한다. 각 사이드카는 자기 메시지 형식도 `sidecar.json`에 선언한다(`message: {form, operationField}`; `form`은 오늘 있는 한 형식인 `json-object`다). 호스트는 본문을 중계하고 해석하지 않으므로(`docs/spec/sidecars.md` 41행) 검사는 메인 페이지가 본문에서 한다. 메인 페이지는 본문을 선언된 형식으로 파싱하고, `operationField` 필드에 문자열을 요구하며, 없거나 문자열이 아니면 거절한다. 검사한 값과 사이드카가 읽는 값이 같도록 원본 바이트가 아니라 다시 직렬화한 객체를 넘긴다. 메시지 형식을 선언하지 않은 사이드카의 모든 작업은 `plugin host <plugin>: sidecar <name> declares no message form`으로 거절한다. 선언되지 않은 나머지 작업은 `plugin host <plugin>: operation <op> is not served`로 거절한다. 따라서 호스트 페이지는 사이드카가 읽기 전용으로 선언하지 않은 작업을 쓰지도 감시하지도 않는다. 쓰기와 감시는 현재와 같이 플러그인의 표면을 통해서만 제공된다. Go 호스트 호출 `pluginHostSidecarSend`는 Rust의 `authorize_main_caller`(`packages/host/tauriv2/src/exposure.rs` 702~709행)처럼 호출자가 메인 웹 뷰인지 검사하며, 메서드의 위치에 기대지 않는다. 새 호스트 메서드 `pluginHostSidecarSend`와 `pluginHostSidecarClose`는 호출자를 같은 방식으로 검사한다. Go는 호출한 창을 메인 창과 비교하고, Rust의 명령 본문은 `authorize_main_caller`를 직접 부른다(선례 `post_from_main`, `packages/host/tauriv2/src/plugin_host_channel.rs` 583~591행). `apps/tauriv2/capabilities/default.json`이 표면 웹 뷰에 애플리케이션 명령을 주기 때문이다. 기존 `sidecar_send`(`packages/host/tauriv2/src/bindings.rs` 326~339행)는 본문에 `plugin:` 거절을 얻는다. 허용 목록의 키는 사이드카의 `package.json` 이름이다(`docs/spec/sidecars.md` 11행). `environment.js`가 플러그인의 사이드카 목록(`sidecars: manifestSidecars(manifest, pluginNames)`, 95행; `packages/plugin-api/index.js` 215~218행의 `manifestSidecars`는 `dependencies`의 사이드카만 돌려주고 126행의 원본 맵은 아니다)을 주고, 플러그인 호스트 레지스트리가 그것을 매개변수로 받는다. `packages/workbench/plugin-host.js`는 지금 매니페스트를 읽지 않기 때문이다. 감시에 의존하는 선언된 상태는 호스트 페이지가 당겨 갈 때 갱신되며, 폴더가 바뀔 때는 그 플러그인의 뷰가 열릴 때까지 갱신되지 않는다. 이것은 경로의 명시된 한계다.

## 명세 변경

- `docs/spec/plugin-host.md` 59행의 "플러그인 호스트에는 사이드카 send가 없다"는 문장을 1번의 제공 호출과 2번의 검사로 바꾼다.
- `docs/spec/plugin-host.md` 48행에서 어떤 코드도 주입하지 않는 호스트 페이지의 동기 `project` 값을 제거한다(프로젝트 값은 F229-1이 소유한다).
- `docs/spec/sidecars.md`에 플러그인 세션 id 형식, `pluginHostSidecarSend` 호출, 플러그인 세션의 공유 실패 기록, `plugin:` 표면에 대한 `sidecarSend`의 거절을 적는다.
- `docs/spec/declared-ui.md`에 플러그인 호스트의 선언된 섹션이 호스트 페이지가 민 스냅샷을 그린다고 적는다.
- `docs/spec/host-contract.md` 837행(`plugin-host.channel.call-served-set`)은 1번의 제공 집합을 나열한다. `pluginHostSidecarSend`와 세 `runtime.sidecar` 호출의 계약 사례를 두 호스트에 추가한다.
- `docs/spec/declared-ui.md`와 `docs/spec/plugins.md`: 브리지는 `runtime.sidecar(name)`이며, 뷰 브리지는 `sidecar` 매개변수와 `send`를 얻고, 구독은 첫 송신보다 먼저 온다. `packages/plugin-api/view.js`가 그 변경을 나열한다. 그 테스트도 함께 바뀐다.
- `docs/spec/plugin-host.md` 5행은 호스트 논리가 옮겨 갈 수 있는 곳으로 상태 모듈을 더한다(오늘은 명명하지 않는다). 7행은 플러그인 코드가 아니라 플러그인 호스트 코드가 워크벤치 페이지에서 돌지 않는다고 적는다(상태 모듈은 워크벤치가 가져오는 플러그인 코드다, [plugins](../spec/plugins.ko.md#플러그인-상태)). 59행은 사이드카 송신 금지를 8번 규칙이 제공하는 작업과 7번 규칙의 세션 종료로 바꾼다. 그 밖의 작업은 제공되지 않는다.
- `docs/spec/plugins.md` 58행은 플러그인 호스트를 선언된 사이드카의 사용자로 적고, 그 경우 `surface`, `state` 또는 `host`를 요구한다.
- `docs/spec/declared-ui.md` 145행은 상태 모듈 등록을 제외하는 이유를 더한다(오늘은 이유가 없다). 상태 등록은 스냅샷 프로토콜이 없는 읽기와 구독 항목이며, 선언된 스냅샷 프로토콜의 송신자는 뷰와 플러그인 호스트 둘뿐이다.
- `docs/spec/sidecars.md`는 2번 규칙의 플러그인 세션 식별자와 7번 규칙의 닫기를 닫기 규칙 아래에 적고, `sidecar session <id> is reserved for a plugin host` 거절은 `sidecarSend`의 표면 호출자에게 돌려주며, 플러그인 호스트의 실패는 6번 규칙의 공유 사이드카 기록에 든다고 적는다. 71행은 바뀌지 않는다(15차가 14차의 창 불러오기 해제를 철회한다). 180행은 `closed` 행의 "응답 없음"을 응답으로 바꾼다. 8번 규칙의 읽기 범위는 호스트 페이지가 승인된 범위로 적는다.
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
- **F229-9** 상태 모듈 옵션이 비교되지 않았다. 상태 모듈은 워크벤치 페이지에서 실행되며, 선언된 사이드카 하나에 대해 `sidecar.send`, `on`, `onFailure`를 가지고 세션은 `state:<plugin id>:<project id>`다(`docs/spec/plugins.md` 113~117행). `docs/spec/declared-ui.md` 145행은 상태 모듈의 등록을 이유 없이 선언된 UI에서 제외한다. 필요: 상태 모듈이 선언된 상태를 제공하게 하는 가장 작은 변경을 옵션 1과 비교하고, 145행 제외의 이유를 적거나 바꾼 뒤 고른다.
- **F229-10** `docs/spec/plugin-host.md` 59행은 플러그인 호스트의 사이드카 send를 금지하고, 5행은 로직을 사이드카나 뷰로 옮길 수 없을 때만 호스트를 만든다. 필요: 호스트가 필요로 하는 플러그인 로직이 사이드카로 옮겨질 수 없음을 보이거나, 금지를 유지한다.
- **F229-11** 플러그인 세션의 수명. 3번 규칙은 소유자가 세션을 닫을 때까지 세션의 루트를 유지하지만, 1번 규칙은 닫기 호출을 제공하지 않으며, F229-2(호스트가 끝날 때 닫지 않음)와 F229-7(시작 중에 처음 보낸 세션을 retain이 버림)은 바로 이 세션을 누수시키거나 잃게 한다. 필요: 닫기 경로(제공하는 닫기 호출, 또는 호스트 종료 시 닫기)를 정하고 F229-2와 F229-7을 F229로 가져오거나, 경로가 그것 없이도 건전함을 보인다.
- **F229-12** `docs/spec/plugins.md` 58행은 선언된 사이드카의 사용자를 페이지 표면과 상태 모듈로만 적고 `surface` 또는 `state`를 요구한다. `host`와 `sections`만 있고 둘 다 없는 플러그인은 그 사이드카를 선언할 수 없다. 필요: 58행에 플러그인 호스트와 호스트 전용 경우를 적고, 명세 목록에 추가한다.
- **F229-13** 작업 범위. 경로는 선언된 사이드카의 모든 작업에 대해 일반적이므로, 사이드카의 `write`와 `watch` 작업(`docs/spec/sidecars.md`)이 열린 표면 없는 숨은 페이지에 닿는다. 필요: 호스트가 받는 작업을 정하고 `sidecars.md`의 표면 열림 규칙에 비추어 정당화하거나, 제한한다.

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

### 11차

두 명의 새 감사자가 1~6번 규칙을 코드와 대조해 검토했다. 10차의 답을 배경으로 주었다. 이의는 아홉 개의 서로 다른 것이었고 모두 2~6번 규칙에 대한 것이었다. 1번 규칙에는 없었다. 모든 이의는 코드에서 확인했고, 반박은 없었으며 수용한다.

1. 3번 규칙은 `owner.projects`를 두 호스트 모두에서 프로젝트 id에서 루트로의 맵이라고 했다. Go에는 집합이 있다(`surfaces.go` 251행, `projects.go` 141행에서 기록). Rust에는 창별 프로젝트 기록이 없고, 보유는 프로젝트 id에서 창으로 가는 전역 맵이다(`windows.rs` 163행). 다시 열기 분기(`projects.go` 119~124행)는 창 루트만 쓴다. 3번 규칙은 두 호스트의 기록을 적고 두 분기 모두에서 쓰도록 바꾼다. 수용.
2. 3번 규칙은 루트가 송신 경로에 도달하는 방법을 적지 않았다. `SendWithCids`는 루트 인수가 없고, `SidecarOwner`는 창 루트만 준다(`sidecars.go` 135~137행). 3번 규칙은 기록된 루트를 송신 인수로 넘긴다. 수용.
3. 4번 규칙은 뷰 브리지를 이미 있는 것처럼 적었다. `packages/plugin-api/view.js` 108~110행의 `sidecar()`에는 이름이 없고 `send`도 없다. 브리지 변경은 4번 규칙과 명세 변경 목록에 적는다. 수용.
4. 4번 규칙은 구독 기록과 메시지 경로의 파일을 적지 않았다. 기록은 `packages/workbench/plugin-host.js`에 두며, 이 파일은 이미 `plugin-host-call`을 받는다. `host.js`는 `plugin:` 이벤트를 그리로 넘긴다. 수용.
5. 4번 규칙은 실패를 "5번처럼" 기록한다고 했는데, 5번에는 실패의 수준이 정해져 있지 않다. 사이드카는 이미 `failed:`를 `error`로 기록한다(`sidecars.go` 1610행). 경로는 줄을 더하지 않는다. 수용.
6. 5번과 6번은 재시작 한도 거절 하나를 두 형식으로 두 번 기록하게 했다. 5번은 이제 재시작 한도 거절을 `restartRefused`에 남긴다. 수용.
7. 5번은 송신 경로의 오류를 충분히 나열하지 않았다(`sidecars.go` 476~518행). 5번은 이제 송신 경로가 반환하는 모든 오류를 변경 없이 전달한다. 수용.
8. 6번은 재시작 한도를 모든 사이드카에 적용했다. 한도는 표준 입출력 사이드카에만 정해져 있다(`sidecars.md`). 6번은 범위를 적는다. 수용.
9. 2번 규칙: `pluginHostSidecarSend`의 `plugin` 인수는 호출자가 준다. 그런데 노출 검사는 메인 웹뷰 라벨을 받는다. 이제 호스트 호출은 메인 페이지 검사(`authorize_main_caller`, `exposure.rs` 698~709행)로 메인 웹뷰에만 열리고, 그 플러그인은 전달된 `plugin-host-call`의 플러그인이다. 수용.

이의: 서로 다른 아홉 개. 한 감사자의 출력은 네 번째 이의 안에서 끊겼으므로, 다섯 번째 이의가 있었다면 기록되지 않았다. 12차가 1~6번 규칙을 두 명의 새 감사자로 다시 검토한다.

### 11차 정정

두 명의 새 감사자가 1~6번 규칙을 코드와 대조해 검토했다. 10차와 11차의 답을 배경으로 주었다. 각 출력은 네 번째 이의 안에서 끊겼으므로 그 뒤의 이의는 기록되지 않았다. 서로 다른 일곱 개의 이의를 냈고, 모두 코드에서 확인해 수용했다. 반박은 없었다. 일곱 개 모두 경로를 적는 방식에 관한 것이다.

1. 2번 규칙은 `pluginHostSidecarSend`의 메인 페이지 검사를 Rust에만 적었다. Go에서 `PluginHostReply`(`bindings.go` 270~279행)는 `h.surface`를 쓰고 메인 페이지 검사가 없으며, `runNative`(`bindings.go` 569~599행)의 항목이면 표면 문서가 호출할 수 있다. 2번 규칙은 Go 메서드를 메인 페이지 바인딩에 둔다. 수용.
2. 2번 규칙은 `plugin:` 표면에 대한 `sidecarSend` 거절을 이미 있는 것으로 적었다. 두 호스트 모두 없다. `sidecarSendFrom`(`surfaces.go` 359~363행)과 `sidecar_send`(`bindings.rs` 326~340행)는 접두사를 검사하지 않는다. 2번 규칙은 이 거절을 두 호스트의 변경으로 적는다. 수용.
3. 3번 규칙은 Rust 기록의 제거를 적지 않았다. `Windows.owners`(`windows.rs` 163행)가 이미 프로젝트를 보유하고 `release_owner`가 지운다(878~898행). 창별 맵도 `project_release`에서 같이 지워야 한다. 3번 규칙은 이를 적는다. 수용.
4. 1번과 4번 규칙은 메인 페이지가 세 `runtime.sidecar` 호출에 어떻게 답하는지 적지 않았다. `servedPluginHostCall`(`plugin-host.js` 20행)은 등록 호출 두 개만 나열하고, 답 경로는 나머지를 거절한다. 1번 규칙은 답과 목록을 적는다. 수용.
5. 4번 규칙은 구독과 첫 송신의 순서를 정하지 않았다. 뷰 브리지는 `send`와 `on`을 어느 순서로든 받으므로, 답이 구독보다 먼저 와서 버려질 수 있다. 4번 규칙과 `docs/spec/plugins.md`는 순서를 적는다. 정의되지 않은 용어 "kind"는 "event kind"로 바꾼다. 수용.
6. 4번 규칙은 `plugin-host-ended`에서 플러그인 호스트의 등록과 함께 구독을 지우지 않았다(`docs/spec/plugin-host.md` 62행). 4번 규칙은 그 지우기를 적는다. 페이지 시작의 경우는 F229-2에 남는다. 수용.
7. 4번 규칙은 `host.js`에서 `plugin-host.js`로 넘기는 경계를 적지 않았다. `host.js`는 `plugin-host.js`를 가져오지 않는다(`host.js` 9~14행). 4번 규칙은 레지스트리 내보내기와 가져오기를 적는다. 수용.

이의: 서로 다른 일곱 개이며 모두 경로를 적는 방식에 관한 것이다. 두 감사자 출력이 네 번째 이의에서 끊겼으므로, 그 뒤의 이의가 있었다면 기록되지 않았다. 12차는 결정 자체를 두 명의 새 감사자로 검토한다.

### 12차 (결정)

두 명의 새 감사자가 결정만 검토했다. 플러그인 호스트가 매니페스트에 선언된 사이드카에 자기 플러그인 기준으로 검사되는 경로를 통해 송신하고 수신하며, 코어에는 플러그인별 코드가 없다는 결정이다. 서로 다른 다섯 개의 이의를 냈고, 각각 명세와 대조해 결정의 열린 질문으로 기록한다. 상태 모듈 옵션(F229-9), `plugin-host.md` 59행의 경계(F229-10), 세션 수명(F229-11), `plugins.md` 58행의 매니페스트 규칙(F229-12), 작업 범위(F229-13)다.

### 13차

두 명의 새 감사자(Haiku)가 다섯 이의를 코드와 명세에 대조했다. 후보는 F229-9와 F229-10에 답하는 상태 모듈 경로였다. 두 감사자 모두 상태 모듈 경로를 결정으로 기각했다. 각 이의는 그 감사자의 근거로 답하며, 그 답을 코드에서 다시 확인했다.

- 상태 모듈은 선언된 상태를 공급할 수 없다. 상태의 `exposure.status(name, read, subscribe)`(`docs/spec/plugins.md` 113~115행)는 `seq`, 확인 응답, `skipped`가 없는 pull과 구독이다. 선언된 상태는 뷰와 플러그인 호스트 두 송신자만 가진 스냅샷 프로토콜이다(`docs/spec/declared-ui.md` 141행과 153행; `packages/workbench/declared-source.js`의 뷰와 호스트 분기; `hostRegistrant`, `packages/workbench/exposure.js` 528~531행). 상태 경로는 세 번째 출처 종류, 어댑터, 확인 응답 경로가 필요하다.
- `show()`는 표시 중인 프로젝트에만 상태 모듈을 마운트한다(`packages/workbench/plugin-states.js`). 라이브러리를 보이는 창에는 상태가 없다. 이는 상태 경로의 틈이며, 플러그인 호스트 경로는 창마다 있어 틈이 없다.
- `plugin-host.md` 59행은 뷰가 열리지 않은 선언된 상태가 필요로 하는 사이드카 송신을 금한다. 상태 모듈이 선언된 상태를 공급할 수 없으므로(F229-9), 호스트가 보내지 않으면 그 상태에는 출처가 없다. 금지는 플러그인의 선언된 상태에 한해 바뀐다.

답:

- **F229-9** `declared-ui.md` 145행의 제외는 그 이유를 적은 채 남는다. 상태 등록에는 스냅샷 프로토콜이 없고, 선언된 스냅샷 프로토콜의 송신자는 둘뿐이다. 상태 경로는 필요한 세 번째 출처 종류 때문에 기각된다. 선택지 1은 남는다. `plugin-processes.md`의 R15-3 기록에도 같은 이유를 적는다.
- **F229-10** 59행은 플러그인의 선언된 상태에 대해 바뀐다(8번과 7번 규칙). 5행은 호스트 논리가 옮겨 갈 수 있는 곳으로 상태 모듈을 든다. 호스트는 그 논리가 옮겨 갈 수 없을 때만 생긴다(F229-9의 상태). 7행은 바뀐다. 플러그인 호스트 코드는 워크벤치 페이지에서 돌지 않으며, 상태 모듈은 워크벤치가 가져오는 플러그인 코드다.
- **F229-11** 닫기는 7번 규칙의 호스트 작업이다. 페이지는 호출하지 않는다. 메인 페이지는 호스트가 끝나거나, 창이 다시 불러와지거나, 프로젝트가 해제될 때 플러그인 세션을 닫고, 호스트는 창이 닫힐 때 그 창의 세션을 닫는다. F229-2와 F229-7은 7번 규칙으로 F229에 들어온다.
- **F229-12** `plugins.md` 58행은 플러그인 호스트를 적고 `surface`, `state` 또는 `host`를 요구하도록 바뀐다. `host`와 `sections`만 있고 surface와 state가 없는 플러그인은 이 변경 없이는 사이드카를 선언할 수 없다.
- **F229-13** 경로는 매니페스트가 선언하고 사이드카가 읽기 전용으로 선언한 작업만 제공한다(8번 규칙). 메인 페이지는 다른 작업을 거절하므로 호스트 페이지는 쓰지도 감시하지도 않는다. 쓰기와 감시는 표면에 남는다. 한계로 기록한다. 감시에 의존하는 상태는 뷰가 열릴 때까지 당겨 갈 때 갱신된다.

전체 경로 이의:

1. 플러그인 호스트만 쓰는 사이드카의 재시작 중단은 그 사이드카를 나열한 플러그인의 표면이 열려야 풀린다(`sidecars.md` 71행). 따라서 호스트만 있고 표면이 없는 플러그인은 풀 수 없다. 이는 표면이 없는 플러그인의 중단 규칙을 소유하는 F229-6의 규칙이다. 여기서는 명시된 한계로 둔다. 중단은 다음 애플리케이션 시작까지 남는다.
2. `packages/workbench/plugin-states.js` 97행의 사이드카 한 개 제한은 상태 모듈에만 적용된다. 경로는 선언된 사이드카마다 제공하며 그 제한을 쓰지 않는다.
3. 플러그인 호스트 경로가 더 작다고 주장하지 않는다. 상태 경로는 비용 때문이 아니라 필요한 출처 종류 때문에 기각된다.

이의: 결정 답 5개, 전체 경로 항목 3개. ### 15차

두 명의 새 감사자(Haiku)가 b4ced853의 14차 답을 검토했다. 감사자 A는 결정 수준 이의 하나와 아래 규칙 결함을, 감사자 B는 결정 수준 이의 없이 같은 규칙 결함을 냈다. 각각 답한다.

- **창 불러오기 해제(14차), 결정 수준.** 철회한다. `SurfaceOpened`가 실패 기록 전체를 지우므로(`sidecars.go` 242~246행; `sidecars.rs` 1096~1109행), 창을 불러올 때마다 횟수가 다시 시작되어 네 번의 실패가 더 허용된다. 14차의 "다시 불러와도 루프를 돌 수 없다"는 주장은 틀렸다. 의존 검사는 플러그인별이고(`dependents[name]`, `sidecars.go` 238~240행), 창별 사이드카 추적은 어느 코드에도 없어서 "그 창의 플러그인 호스트만 쓴다"는 구현의 근거가 없다. 두 호스트에 새 훅이 필요하다. 결정: 재시작 정지는 `sidecars.md` 71행이 말하는 대로만 풀린다(플러그인의 표면이 열려야 한다). 플러그인 호스트만 쓰는 사이드카의 정지는 앱을 다시 시작할 때까지 남는다. 이것은 명시된 한계이며, 공동 해제 규칙은 F229-6이 소유한다. 71행은 바뀌지 않는다.
- **다른 창의 해제(7번 규칙).** 다른 창의 해제는 보유 창의 세션을 열린 채 둔다. 답: 호스트가 해제된 프로젝트 id를 이름에 담고 그 프로젝트를 쥔 창(Go의 `h.owners[id]`, Rust의 해제된 라벨)이 소유한 세션을 닫는다. 호출한 창의 세션이 아니다. 수용.
- **Go의 시점과 잠금.** 페이지 시작의 닫기는 `startPage`(`packages/host/wailsv3/src/start.go` 63~82행)의 `InvokeSync` 블록 뒤에서 실행되며, 소유자 id는 `c.mu` 아래에서 모은 뒤 잠금을 풀고 각 `closeSurface`를 부른다. `closeSurface`가 `c.mu`를 스스로 잠그기 때문이다(`sidecars.go` 592~593행). 수용.
- **소유자 원천과 id.** 소유자 맵은 사이드카 상태의 것(Go의 `c.owners`, Rust의 `State.owners`, `sidecars.rs` 767행)이다. `Windows.owners`는 프로젝트에서 창으로 가므로 아니다. 플러그인 id에는 `:`가 없다. 매니페스트 읽기는 `:`가 든 id를 거절하며, 이것은 이 경로가 더하는 변경이다. 수용.
- **호출자 검사.** 새 호스트 메서드마다 호출자를 검사한다. Go는 호출한 창을 메인 창과 비교하고, Rust의 명령 본문은 `authorize_main_caller`를 직접 부른다(`exposure.rs` 702~709행). `sidecar_send`(`bindings.rs` 326~339행)에는 본문에 `plugin:` 거절이 들어간다. 수용.
- **패키지 이름 원천.** 키는 `package.json`의 이름이다(`sidecars.md` 11행). `environment.js`가 플러그인의 사이드카 목록을 준다(`manifestSidecars` 95행; `dependencies` 126행). 플러그인 호스트 레지스트리가 그것을 받는다. 수용.
- **1번 규칙 문구.** `servedPluginHostCall`과 `forwarded_call`은 지금 두 호출을 나열하므로, 규칙 1은 코드가 세 호출을 나열해야 한다고 적는다. 수용.
- **3번 규칙.** 해제는 해제된 창의 맵에서 id를 지운다. 수용.

이의: 15차 결정 수준 이의 하나는 철회로 답했고, 위의 규칙 결함은 모두 답했다. ### 16차

두 명의 새 감사자(Haiku)가 48fbb189의 15차 답을 검토했다. 감사자 A는 결정 수준 이의가 없었고, 감사자 B는 하나를 냈다. F229-9의 비교가 이루어지지 않았다는 것이다. 아래의 인용과 거절 문구 결함도 함께 냈다.

- **철회와 정지(6번 규칙, `sidecars.md` 66~74행).** 수용. `SurfaceOpened`가 기록을 지우는 유일한 경로다(`sidecars.go` 246행; `sidecars.rs` 1109행). 호출자는 `surfaces.go` 1072행과 `surfaces.rs` 991행이다. 플러그인 호스트의 실패는 공유 사이드카 기록에 든다. 다른 플러그인의 표면이 그 정지를 푼다. 6번 규칙과 `sidecars.md` 변경에 적는다.
- **비교(F229-9), 결정 수준, 답함.** 선택지 1(플러그인 호스트)이 건드리는 것: `plugin-host.js`와 `host.js`(served 호출, 구독 레지스트리, 해제); `declared-source.js`(호스트 분기, 이미 있음); Go 전달기, `bindings.go`, `start.go`, `projects.go`, `sidecars.go`, `surfaces.go`(새 호스트 메서드, 닫기 경로, retain); Rust의 대응 파일 `plugin_host_channel.rs`, `windows.rs`, `sidecars.rs`, `exposure.rs`, `bindings.rs`; `environment.js`(사이드카 목록); 규칙 1~8의 명세. 선택지 3(상태 모듈)이 건드리는 것: `declared-source.js`(읽기, 구독 어댑터, 합성 `seq`, 확인 응답 경로를 가진 셋째 분기); `sidecar-sections.js`와 `exposure.js`(출처 선택에 상태 등록); `declared-ui.md` 145행. 상태 모듈 경로도 세션을 위해 7번 규칙의 닫기 경로가 필요하므로 Go와 Rust의 닫기·retain 변경은 둘에 공통이다. 선택지 1이 파일 수로는 더 크다. 그래도 세 이유로 고른다. 이유는 diff 크기가 아니라 코드에서 온다. (i) 상태 모듈 경로는 프로젝트가 표시되는 동안에만 상태를 낸다(`packages/workbench/plugin-states.js`의 `show()`). 라이브러리를 보이는 창에는 출처가 없다. 선택지 1은 창별이다. (ii) 상태 모듈에는 사이드카 한 개 제한이 있다(`plugin-states.js` 97행). 선택지 1에는 없다. (iii) 상태는 스냅샷 프로토콜이 없는 읽기와 구독 항목이다. 상태 경로는 새 출처 종류와 새 확인 응답 경로가 필요하고, 선택지 1은 이미 있는 프로토콜을 쓴다.
- **5번 규칙의 거절.** `pluginHostSidecarSend`와 `pluginHostSidecarClose`의 호출자 거절, 8번 규칙의 본문과 작업 거절에는 문구가 있고 `error`로 로그에 남는다. 수용.
- **인용.** 7번 규칙은 `start.go` 82~86행(`InvokeSync` 뒤)을 인용하고, 잠금은 `sidecars.go` 592~593행이다. 사이드카 목록은 `environment.js` 95행의 `manifestSidecars`(`packages/plugin-api/index.js` 215~218행)이며 126행이 아니다. 수용.
- **명세 목록 문구.** `plugin-host.md` 5행과 `declared-ui.md` 145행은 새 문구를 더한다. 오늘은 상태 모듈을 명명하지 않고 이유도 없기 때문이다. 수용.
- **표면 호출자에 대한 거절.** `sidecar session <id> is reserved for a plugin host`는 `sidecarSend`의 표면 호출자에게 돌려준다. 수용. `sidecars.md` 변경에 든다.
- **레지스트리 제거.** 4번 규칙의 구독은 `plugin-host-ended`에서 지운다. 7번 규칙의 닫기는 항목을 그대로 두며, 세션으로 키가 정해지고 다시 불러오면 초기화된다. 적힌 대로 수용.

이의: 16차 결정 수준 이의는 하나이며 위의 비교로 답했고, 나머지 결함도 모두 답했다. 결정 상태: 16차 답 적용, 17차가 두 명의 새 감사자로 검토한다. 결정 수준 이의가 없이 차수가 닫히기 전에는 F229의 명세와 구현을 시작하지 않는다.

### 14차

두 명의 새 감사자(Haiku)가 9b41677c의 바뀐 규칙을 검토했다. 둘 다 F229-9(145행의 이유), F229-10(조건부 수용), F229-12(문구)를 수용했다. 나머지는 그대로는 안 된다고 했고, 모두 코드로 확인되었다.

- 페이지가 낸 닫기는 강제되지 않는다. 다른 창의 해제는 `ProjectRelease`(`projects.go` 172~184행)가 소유자를 호출자 검사 없이 지우므로 세션이 남고, 다시 불러와도 닫기가 없다. 답: 호스트가 닫는다(7번 규칙). 페이지 호출 `pluginHostSidecarClose {plugin}`은 호출한 창의 세션만 닫는다. 결정 수준, 수용.
- 세션 열거가 없었고 소유자 필터가 없으면 한 창이 다른 창의 세션을 닫는다. 답: 7번 규칙이 접두사와 호출자로 `c.owners`를 열거한다.
- retain 유지 목록은 시작 전 `c.mu` 아래에서 만들어지며, Go `Retain`은 소유자가 아니라 `c.roots`를 읽는다. 답: 시작 뒤 잠근 블록 안에서 다시 만든다(7번 규칙). 수용.
- `sidecars.md` 180행의 파일 사이드카 행은 "응답 없음"이라 하는데 모든 `closed`에 답하라는 요구(42행, 50행)와 어긋난다. 답: 180행을 바꾼다. 수용.
- 8번 규칙의 허용 목록이 모든 사이드카에 적용되었고 본문을 해석하지 않았다. 답: 패키지 이름으로 키를 두고, 본문을 파싱해 다시 직렬화하며, Go 호출자를 Rust처럼 검사한다. 수용.
- 59행의 "선언된 상태에 한해"는 2번 규칙이 `dependencies`만 보므로 코드가 강제할 수 없다. 답: 59행은 8번 규칙이 제공하는 작업(매니페스트가 선언하고 사이드카가 읽기 전용으로 선언한 작업)만 적는다.
- 호스트 페이지의 읽기 범위(표면 없이 프로젝트의 모든 파일)는 숨은 범위가 아니라 명시된 범위다. 답: `sidecars.md`에 적는다. 수용.
- 결정 수준, 두 감사자 모두(15차에 철회됨, 그 기록 참조): 호스트만 쓰는 플러그인은 표면이 없으므로 `sidecars.md` 71행과 `plugin-host.md` 80행에 정지를 푸는 경로가 없고, 사이드카 정지는 앱을 다시 시작할 때까지 간다. 결정: 창의 불러오기가 정지를 푼다. 창의 메인 페이지가 플러그인 호스트를 만들고(`plugin-host.md` 수명), 창을 여는 사람의 행위는 표면을 여는 것과 같은 행위다. `sidecars.md` 71행에 이 해제 사건을 더한다. 상한은 같다. 300초 안에 네 번 실패하면 다시 멈춘다.

이의: 14차 결정 수준 이의 2개(호스트만 쓰는 정지, 페이지가 낸 닫기), 둘 다 위에서 답했다.

### 17차와 결정 닫기

감사자 A(실행 98a94b29)는 환경 인용까지 전부 답했고, 마지막 부분은 기록되지 않았다. 16차의 세 이유 (i)~(iii)를 코드에서 확인했다. (i) `packages/workbench/plugin-states.js` 127~142행: 창이 프로젝트를 보이지 않으면 `show()`가 마운트를 풀고 상태 모듈이 마운트되기 전에 돌아간다. (ii) `plugin-states.js` 97행과 104~112행: 사이드카 한 개 제한. (iii) `plugin-states.js`에는 스냅샷, `seq`, 수신 확인 코드가 없고 선언된 프로토콜은 `declared-source.js`(호스트 분기 32~57행, 뷰 분기 58~83행)에 있다. 또한 파일 이름 `sidecar-sections.js`를 거절했다. 파일은 `packages/workbench/sidebar-sections.js`이며 `createDeclaredSource`만 부른다. 원천 선택은 `exposure.js`에 있다(`hosts` 맵, 호스트 등록과 조회, `preferred()`). 인용은 맞다. `start.go` 82~85행은 `InvokeSync` 블록이고, `sidecars.go` 592~593행은 `closeSurface`의 잠금이다. 감사자 B(실행 3c9cf60f)는 10분 한도를 넘겨 닫기 전에 답하지 않았고, 닫기는 그것 없이 이루어졌다. 이를 여기에 기록한다.

**감독자 정정, 17차(구속력 있음, 닫기 커밋 전에 적용).** 17차 본문은 8번 규칙과 `plugin-host.md` 59행에서 실제 플러그인의 사이드카를 명명했다. core는 실제 플러그인이나 사이드카를 명명하지 않는다. 공통 기능은 core에, 기능은 플러그인에 둔다. 이 계획의 모든 곳에서 그 이름을 지웠다. 일반 규칙은 다음과 같다. 플러그인 매니페스트는 호스트의 사이드카 의존마다 호스트가 부를 수 있는 작업을 `hostOperations`로 선언한다. 사이드카는 그 가운데 읽기 전용인 작업을 `sidecar.json`의 `hostReadOperations`로, 메시지 형식을 `message`로 선언한다. 호스트 경로는 선언된 작업만 제공하고, 본문을 선언된 형식으로 파싱하며, 그 밖의 모든 작업을 이름 있는 오류로 거절한다. 픽스처 이름은 `probe`와 `fixture-*`만 쓴다. 결정: 이 정정을 기록하고 결정을 닫는다. 더 검토 차수는 열지 않는다.

결정 닫기, 17차:

- **F229-9** 닫힘. 1번 옵션(플러그인 호스트 경로)을 유지한다. 상태 경로는 (i)~(iii) 이유로 거절한다. `declared-ui.md` 145행에 이유를 더한다.
- **F229-10** 닫힘. `plugin-host.md` 59행은 8번 규칙이 제공하는 작업과 7번 규칙의 세션 종료로 바뀐다. 5행은 상태 모듈을 더한다. 7행은 플러그인 호스트 코드로 바뀐다.
- **F229-11** 닫힘. 7번 규칙이 닫기 경로다. 호스트가 닫기를 수행하고, 페이지 호출 `pluginHostSidecarClose`는 그 창의 세션만 닫는다.
- **F229-12** 닫힘. `plugins.md` 58행은 플러그인 호스트를 명명하고, `surface`, `state` 또는 `host`를 요구한다.
- **F229-13** 닫힘. 8번 규칙은 매니페스트가 선언하고 사이드카가 읽기 전용으로 선언한 작업만 제공하며, 본문을 파싱하고, 그 밖의 작업을 거절한다.
- **호스트 전용 사이드카 정지.** 명시된 한계다. 정지는 앱을 다시 시작할 때까지 간다(15차). 공동 해제 규칙은 F229-6이 소유하며 지금은 결정 항목이 아니다.

결정 항목이 아닌 방법 확인은 하위 항목으로 등록한다.

- **F229-14** 호스트 호출 표면: `plugin_host_channel.rs`의 `forwarded_call`과 Go 전달자, `plugin-host.js`의 `answer` 분기, `servedPluginHostCall`, `docs/spec/host-contract.md` 837행.
- **F229-15** 호스트 닫기와 retain 경로: Go `startPage`(82~86행)와 잠금 순서, `ProjectRelease`와 `project_release`, retain의 유지 목록(`sidecars.go` 945~972행; `sidecars.rs` 1576~1620행).
- **F229-16** 레지스트리 입력과 매니페스트 검사: `environment.js` 95행의 사이드카 목록 매개변수, 매니페스트 읽기에서 `:`를 가진 플러그인 id 거절.

결정 상태: 17차에 닫힘. F229의 명세와 구현은 이 커밋된 닫기에서만 시작하며, 이 레인에서는 시작하지 않는다.

### F229-1부터 F229-8까지의 상태 (fix/host-route-followups-F229-n)

- **F229-2** 동작 변경 없이 근거로 닫음. 페이지 시작은 두 호스트 모두에서 창의 plugin host 세션을 닫고(`startPage`, `page_started`), 이전 페이지의 등록이 그와 함께 끝나므로 `plugin-host-ended`를 보내지 않는다(rule 7). 호스트 종료와 호스트 실패는 `plugin-host-ended`를 보낸다. 두 호스트 테스트의 계약 `plugin-host.sidecar.page-start-close`.
- **F229-3** 닫음. `closed`는 그 surface에 요청을 받은 사이드카 프로세스에만 보낸다(`sidecars.md`). 두 호스트에서 변경 전 코드 Red, 변경 후 Green. 계약 `sidecars.close.reaches-holding-sidecar`.
- **F229-4** 닫음. 버려진 사이드카 메시지는 `warn`으로 기록한다(`logging.md`는 이를 손실로 정의). 호스트 기록 경로와 `events.json`은 `host.record.<level>`에 `warn`을 받는다. 두 호스트에서 Red, 변경 후 Green.
- **F229-7** 근거로 닫음. 두 호스트 모두 retain의 keep 목록을 서비스가 시작한 뒤에 읽으므로 시작 중 처음 보낸 세션이 유지된다. 시작 훅을 retain 경로 밖으로 옮기는 변이에서 Go 테스트가 실패한다. 계약 `sidecars.retain.keeps-session-first-sent-during-start`를 두 호스트에 선언.
- **F229-5** 결정: 코어 명령 경로를 만들지 않는다. plan이 필요로 하는 plugin host 호출은 규칙 1~8의 사이드카 경로로 가며, 명령 종류의 경로는 이를 제공하지 않는다.
- **F229-1** [o] 결정으로 닫음. 창이 보여 주는 project를 해제하면 다른 project를 보유 중이어도 그 창의 보여 주는 root를 즉시 지운다(`projects.go`의 `ProjectRelease`, `windows.rs`의 `project_release`). 페이지가 `ProjectOpen`으로 project를 열기 전까지 창은 project를 보여 주지 않으며, project가 보이지 않는 동안의 `pluginHostSidecarSend`는 `plugin host <plugin>: no project is shown`으로 거부된다. 이유: 표면 send의 root는 창의 root이고, 기존 코드는 project가 하나도 남지 않았을 때만 root를 지워서 해제된 폴더가 다른 project를 보유하는 동안 root로 남았다. 보여 주는 project는 root 옆에 기록한다(`Surfaces.shown`, `WindowData.shown`). Go Red: 해제 지우기를 되돌리면 `TestReleasingTheShownProjectClearsTheWindowAtOnce`가 `the shown root after the release of the shown project is "/fixture/other", want none`로 실패했다. Rust: 보여 주는 project 기록과 새 `plugin_send_root` 인자는 변경 전 코드에서 빌드되지 않으므로 Rust의 Red는 assertion이 아니라 빌드 실패다. 계약 `plugin-host.sidecar.release-shown-project`를 두 호스트 테스트에 선언. Green: 두 호스트의 plugin host sidecar 테스트.
- **F229-8** [o] 닫음. `state:<plugin>:<project>` 세션은 그 project를 소유한 창에서 project가 해제되면 plugin 세션과 같은 close로 끝난다(Go `closeProjectSessions`, Rust `is_project_session`). Go Red: state 분기를 끄면 `TestProjectReleaseClosesTheStateSessionOfThatProject`가 `the state session state:probe:project-a of the released project is still owned`로 실패했다. Rust: `a_release_ends_the_plugin_and_state_sessions_of_that_project`는 변경 전 코드에서 빌드되지 않는다. 계약 `plugin-host.sidecar.release-state-session`을 두 호스트 테스트에 선언.
- **F229-6** [o] 결정으로 닫음(joint 규칙). 멈춤 기록마다 해제 트리거는 하나이고 [sidecars](../spec/sidecars.ko.md#실패)에 한 번만 적는다. 사람이 `dependencies`에 사이드카를 적은 plugin의 표면을 여는 것은 그 사이드카 멈춤을 지우고, 같은 plugin의 표면을 여는 것은 그 plugin host 멈춤을 지운다([plugin host](../spec/plugin-host.ko.md#재시작)). 두 해제는 표면 열기 훅의 같은 단계에서 실행된다(열린 표면에 대한 `surfaces.go`, `plugin_host_channel::surface_opened`를 부르는 `surfaces.rs`). 해제된 plugin host가 다시 여는 세션은 그 plugin이 사이드카를 적었으므로 해제된 사이드카 멈춤을 만나고, 그 세션의 사이드카 멈춤은 host 멈춤과 함께 지워진다. 한도 안의 plugin host 자동 재시작은 사이드카 멈춤을 지우지 않으므로 사람의 열기 없이 프로세스가 다시 시작되지 않는다. 명시된 한계: host는 있고 표면이 없는 plugin에는 여는 행위가 없어서 그 멈춤은 애플리케이션이 시작될 때까지 남는다. 이는 항목의 제약("도달 가능한 세션이 해제 방법 없이 멈추지 않는다")과 맞지 않는 잔여이며, 사람의 plugin 작업을 트리거로 추가하면 두 호스트에 새 트리거가 생기므로 F229 밖이다. 계약 `plugin-host.restart.stop-clear-joint`: Go `TestOneSurfaceOpenClearsTheHostStopAndTheSidecarStopOfItsPlugin`(`plugin_host_sidecar_test.go`), Rust `surface_open_clears_the_restart_limit`(`tests/sidecars_test.rs`, 계약 표기 추가). Go 테스트는 고정(pin)이다. Red는 `Sidecars.SurfaceOpened`가 의존 plugin을 건너뛰게 한 변이로 확인한다. 훅 자체의 Red는 창이 필요하므로 쓰지 않았다.
- **F229 후속 상위 항목** [o]: F229-1, F229-6, F229-8은 여기서 닫는다. F229-2, F229-3, F229-4, F229-5, F229-7은 이 문서에서 먼저 닫았다.
