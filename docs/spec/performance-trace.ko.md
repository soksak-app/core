# 성능 트레이스

[English](performance-trace.md)

성능 트레이스는 [진단](diagnostics.ko.md)의 기록 중 event 형태다. 애플리케이션이 시간과 메모리를 무엇에 쓰는지 기록하는 영구 장치다. 모든 빌드에 있고 사용 후 제거되지 않는다. 스위치는 선언된 설정 `diagnostics.performance`([설정](settings.md))이고, false 인 동안 어떤 계층도 기록 일을 하지 않는다 — 파일이 만들어지지 않고 포맷팅이 돌지 않는다.

페이지는 비활성 상태나 활성화 응답 대기 중에 이벤트를 구성·중계하지 않는다. 페이지의 이벤트는 [이벤트 계약](logging.ko.md#writer)의 event `page.trace.<event>`다. 페이지는 그것을 기다리지 않고 큐에 넣고, 한 턴의 event를 host 호출 `log` 한 번의 배치로 host에 중계하며, host는 그것을 event log `logs/host-<boot>.jsonl`에 저장한다. 스위치 요청은 순서를 유지한다. 비활성화는 새 이벤트를 즉시 중단하고 이미 수락한 event가 중계될 때까지 기다린 뒤 실행된다. 스위치 실패는 설정 동작을 거부하고, 중계 실패는 측정한 명령의 결과를 바꾸지 않고 배치의 event 수와 함께 명시적으로 보고한다.

## 출력

trace의 모든 event는 [event 계약](logging.ko.md)의 event다. page는 `page.trace.<event>`, host는 `host.trace.<event>`, 표본 추출은 `host.sampler.<event>`를 event log `logs/host-<boot>.jsonl`에 모두 level `debug`로 저장하고, event 이름은 필드가 아니라 event 이름에 둔다. sidecar는 `sidecar.<name>.<event>`를 `logs/` 아래 자기 event 파일에 저장한다([sidecars](sidecars.ko.md)). [debug 화면](debug.ko.md)의 타임라인 하나가 이 파일들을 함께 읽는다. 스위치가 켜질 때 host는 event `host.trace.on`을, 꺼지기 전에 `host.trace.off`를 저장한다. trace 파일도, 표식 줄도, 자체 회전도 없다. event 파일은 계약의 규칙대로 회전한다.

## 생산자

모든 계층이 생산자다; 트레이스는 어느 한 계층으로 정의되지 않는다.

- **페이지** — registry 명령(`page.command`), host 호출(`page.call`: `exposureChanged`인 exposure 감시 통지, composition 게시와 클립 갱신, 설정과 프로젝트 저장, 표면 문서 attach), 문서마다의 시작(`page.start`, 시계의 `time_origin`과 주소를 담고, reload는 새 문서를 시작한다)은 trace가 켜져 있든 아니든 각 [entrance](logging.ko.md#입구)가 기록한다. trace는 `page.trace.command`(모든 `core.*`와 plugin 명령의 이름·시간·결과 등급), `layout`(큐의 대기와 대체), `surface.registration`(문서 `timeOrigin`, `hasPort`, 이벤트 순간의 등록 `names`를 담는 단계 `pending`, `registered`, `closed`, `disposed`), `focus`, 값을 담은 사용자 행위 마커(`action`: 창 리사이즈는 크기를, 탭 전환은 id를, 카드 포커스는 카드를, 프로젝트 열기는 root를 담는다)를 더하고, 모든 이벤트는 JS heap 값 `jsHeapMB`를 담는다. 페이지는 파일시스템이 없으므로 이벤트는 host 호출 `log`의 batch로 나간다.
- **호스트**(양호스트 패리티 짝) — 모든 엔드포인트 메서드의 이름·시간·결과 등급; 그림 영역 frame 에 대한 모든 답을 `image.frame` 이벤트 `{surface, name, response}`로(`response`는 `consumed` 답이나 그 까닭을 담은 거절); 창 이벤트는 창과 kind를 담은 `host.window.event`이고([entrance](logging.ko.md#입구)는 그 밖의 값을 기록하지 않으며, 리사이즈의 크기는 페이지의 action 마커다); 표면 생명주기는 이벤트 `surface` `{phase, surface}`이고 `phase`는 host가 네이티브 view를 만들면 `created`, view의 frame을 정하면 `placed`(이벤트가 `x`, `y`, `w`, `h`, `visible`을 더한다), 페이지의 목록에 표면이 더는 없으면 `destroyed`다; 표시 장벽 대기시간을 포함한 문서·이미지·합성 연산; 그림 영역의 래스터 결정마다 `image.raster` 이벤트 `{surface, name, phase, from, width, height, scale}`을 남기며, `phase`는 host가 사이드카에 보낼 크기를 정했으면 `configured`, 영역의 표면이 아직 네이티브 크기를 갖지 않으면 `deferred`, host가 그 구성을 사이드카 연결에 넘겼으면 `sent`이고, `from`은 `composition`, `refresh`, `reconnect` 중 하나다(`sent`는 `sidecar`); 어긋난 값 그대로를 담은 프로토콜 거부; host가 시작하거나 연결한 모든 사이드카 process를 이벤트 `process` `{role, name, pid}`로 적는 프로세스 등록부(process나 그 연결이 끝나면 등록부를 떠난다); 사이드카 시작·종료는 `host.sidecar.*` entrance.
- **사이드카**(`vt-core`, `files`, `shell`) — 요청 처리의 연산·시간·결과. `vt-core` 는 요청마다 `request` 이벤트 `{operation, surface, owner, connection, idle_us, us}`(`us`는 요청을 읽은 때부터 다음 요청을 읽기 전까지의 시간, `idle_us`는 입력 루프가 그 요청을 기다린 시간, `connection`은 서비스가 받은 연결의 순번)를, 연결의 읽기가 1초 이상 기다린 뒤 데이터를 받으면 `read_wait` 이벤트 `{waited_us, pending_polls, since_last_poll_us, bytes}`(깨어나지 않은 작업은 시도 한 번, 읽을 것이 없다고 들은 읽기는 여러 번)를, 출력 한 줄을 host 에 쓰는 데 10 ms 이상 걸리면 `output_blocked` 이벤트 `{us, bytes}` 를 남긴다. host 가 읽기를 멈추면 출력 채널이 찬 뒤 사이드카의 입력 루프도 멈추기 때문이다. `vt-core` 는 프레임을 그린 이유(`output`, `blink`, `resize`, `metrics`, `selection`)와 그리기·전송·consumed 대기 시간을 각각의 필드로, 래스터 크기를 담은 프레임 이벤트; PTY 읽기 바이트 수와 앞뒤 격자를 담은 PTY 재조정; 세션 생명주기를 더한다.
- **샘플러** — 5초마다 host의 상주 크기(`rss_host_kb`)와 등록부가 이름 붙인 모든 process의 상주 크기(`role`, `name`, `pid`, `rss_kb`)를 이벤트 `host.sampler.memory` 하나씩으로 기록해, 메모리 판독이 스스로 귀속된다. 크기를 얻지 못한 판독은 크기 대신 `error`를 기록한다.

## 스위치

host 프로세스가 스위치를 가진다. 파일이 스위치를 갖지 않고 sidecar에 닿는 flag도 없다. page는 이미 읽은 설정에서 `diagnostics.performance`를 읽어 host 호출 `performance`로 host에 알린다. 설정이 true가 되면 `on`, false가 되면 `off`, 저장된 설정이 이미 true이면 시작할 때 한 번 `on`이다. 이 호출은 동작 `on`과 `off`만 받고 다른 동작은 오류로 거절하며, 스위치를 바꾸지 않는 요청은 아무것도 저장하지 않는다. trace를 켜면 `host.trace.on`을 저장하고 표본 추출을 시작한다. 표본 추출은 trace가 켜진 동안 5초마다 `host.sampler.memory`를 저장한다. 끄면 `host.trace.off`를 저장하고 표본 추출을 끝내며, 다시 켜면 새로 시작한다. 프로세스는 언제나 trace를 끈 채 시작한다. 수동 계측은 측정한 동작의 결과를 바꾸지 않고 실패를 보고한다.

## 읽기

파일은 NDJSON 이라 도구로 곧바로 답한다: 대기 터미널의 프레임 이유(`select(.event=="frame") | group_by(.reason)`), 붕괴를 지나는 끌기가 만든 래스터 값(`select(.event=="configure")`), 탭 전환이 웹뷰를 재생성했는가(`select(.event=="surface")`), 사용자 행위 주변에서 메모리가 무엇을 했는가(`select(.event=="action")`).
