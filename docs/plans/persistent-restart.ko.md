# 계속 연결하는 service의 재시작 한도

[English](persistent-restart.md)

F212.8a-4의 제안과 검증 기록이다. 규칙이 [터미널 런타임](../spec/terminal-runtime.ko.md)과 [사이드카](../spec/sidecars.ko.md)에 들어간 뒤 이 문서를 지운다.

## 문제

[터미널 런타임](../spec/terminal-runtime.ko.md)은 "연결이 끊길 때마다 한 번 재시작하고, 실패는 보고하며, 다음 전송이 같은 경로를 다시 시도한다"고 적는다. 부활할 때마다 곧 죽는 service는 끊길 때마다 다시 부활한다. 요청도 사람의 동작도 없이 재시작이 무한히 반복된다. [사이드카](../spec/sidecars.ko.md)의 `## Failure`는 이 재시작 한도가 계속 연결 transport를 덮지 않는다고 적는다.

## 제안

1. 재시작 한도가 세는 계속 연결 service의 실패는 다음 중 하나다.
   - 호스트가 sidecar를 멈추고 있지도 않고 그 sidecar의 교체도 진행 중이 아닐 때 service 프로세스가 끝나는 것. reader의 부활이 그 끝을 위해 돌 때 그 끝을 세고, 오래된 endpoint를 지운 뒤 또는 남은 것이 없을 때 단일 생성 경로로 service를 다시 낳는다. 아래의 멈춤이 그 spawn을 막아도 같다.
   - 생성 경로의 시작 실패: `the service did not print its endpoint within 30s`, `service exited before endpoint`, `the service did not answer hello within 5s`;
   - 호스트가 sidecar를 멈추고 있지 않을 때 protocol 위반으로 연결이 끝나는 것. [터미널 런타임](../spec/terminal-runtime.ko.md) `### Service transport`가 적는 이유 중 하나다. reader가 연결을 끝낼 때 그것을 세고, service는 계속 돈다.
   부활이 살아 있는 service에 다시 붙는 끊김은 실패가 아니다. 끊김 하나는 부활이 무엇을 시도했든 실패를 하나만 센다. 연결이 거부되어 다시 시도하는 부활은 그 재시도와 함께 한 번으로 세고, service를 다시 낳은 부활의 시작이 실패하면 그 시작 실패로 한 번만 센다. 전송이 시작한 생성은 자신의 실패를 따로 센다.
2. 세는 방식은 [사이드카](../spec/sidecars.ko.md) `## Failure`의 표준 입출력 규칙을 따른다. 각 실패가 도착한 시각으로 세고 timer는 없다. 새 실패보다 300초 앞선 실패는 세지 않는다. 300초 안의 네 번째 실패가 재시작을 멈추고 `error: sidecar <name>: restart limit: 4 failures within 300 s`를 log에 쓰고 수준 error로 `host.sidecar.restart-limit` `{sidecar}` event를 쓴다.
3. 멈춤은 네 번째 실패에서, 부활이나 전송이 생성 경로를 돌기 전에 시작한다. 네 번째 실패가 실패한 시작이면, 그 sidecar에 전송한 surface들은 어떤 실패한 시작과 같이 그 시작 오류를 담은 연결 알림을 받는다. service 프로세스의 끝이면 호스트는 그것을 세고 부활이 spawn하기 전에 멈추며, 전송한 surface들은 연결 알림 `{"event": "connection", "connected": false, "reason": "restart limit"}`을 받는다. service가 멈춘 동안 호스트는 부활도 생성도 하지 않는다. 전송은 `sidecar <name>: restart limit`으로 실패하고, 호스트는 `error: sidecar <name>: restart limit: request for <surface> refused`를 log에 쓰고, 전송한 surface는 연결 알림 `{"event": "connection", "connected": false, "reason": "restart limit"}`을 받는다. 멈춤을 풀 때까지 다른 연결 알림은 쓰지 않는다. 계속 연결 transport의 restart-limit 보고는 연결 알림으로만 간다. 멈춤은 `sidecar-failure` 전달을 더하지 않는다.
4. 사람이 surface를 열 때만 멈춤을 푼다. 표준 입출력 transport와 같다. `plugin.json`의 `dependencies`가 그 sidecar를 적는 plugin의 surface를 호스트가 만들면 실패 기록을 지우고 수준 debug로 `host.trace.sidecar.restart-reset` `{sidecar, surface}` event를 쓰고, 다음 전송이 생성 경로를 돈다. 이미 열려 있는 surface의 요청은 멈춤을 풀지 않는다. 멈춤은 application 프로세스가 돌아 있는 동안만 유지되며, 새 application 프로세스는 빈 실패 기록으로 시작한다.
5. [터미널 런타임](../spec/terminal-runtime.ko.md)은 끊김마다 한 번의 부활 시도를 유지하고 이 한도를 더한다. [사이드카](../spec/sidecars.ko.md) `## Failure`의 재시작 한도 문단은 첫 문장을, 재시작 한도가 두 transport의 sidecar에 적용되고 계속 연결 transport의 실패는 터미널 런타임이 적는 것이라는 문장으로 바꾸고, 계속 연결 한도를 정의하지 않았던 뒤의 문장을 지운다. 그리고 거부 문장의 `sidecar-failure` 전달은 표준 입출력 transport의 보고이며, 계속 연결 transport는 터미널 런타임이 적는 대로 거부된 전송을 연결 알림으로 보고한다는 것을 적는다. [이벤트](../spec/events.json)의 `host.sidecar.restart-limit` 설명은 "A sidecar of either transport failed for the fourth time within 300 seconds, so the host stopped its restarts (docs/spec/sidecars.md#failure)."가 된다.

## 검증 범위

- 범위 안: 어떤 event가 실패로 세이는지, 멈춤이 무엇을 하는지, 멈춤을 푸는 규칙, 세는 방식, 오류와 event 글, 명세의 문장.
- 범위 밖: 한도 값 300초와 4회(두 transport 모두 F212.8a가 정했다), session 보존과 닫기 의미, 갱신과 교체 흐름, reader가 연결 끝을 알아내는 방법, 시작 한계 30초와 5초.

## 검증 기록

### 1차

- R1-1: 끊김 하나가 실패 둘로 세일 수 있었다. 부활은 연결이 거부되면 다시 시도하고, service를 다시 낳은 부활은 자기 시작이 실패할 수 있다. 수용: 끊김 하나는 실패를 하나만 세고, 전송이 시작한 생성은 자신의 실패를 따로 센다.
- R1-2: 멈춘 service의 연결 알림은 알릴 때가 없었다. 멈춘 동안 부활이 돌지 않아 새 끊김이 없고, 두 호스트 모두 알림에 시작 오류를 담는다. 판정과 함께 수용: 네 번째 실패의 알림은 시작 오류를 담는다. 표준 transport도 네 번째 실패에 원인을 밝히므로 같다. 멈춘 뒤 거부된 전송은 알림과 전송 오류와 거부 log 줄에 `restart limit`을 담는다. 다른 알림은 쓰지 않는다.
- R1-3: 실패 기록은 호스트 메모리에 있어서 새 application 프로세스는 빈 기록으로 시작한다. 수용: 멈춤은 application 프로세스가 돌아 있는 동안만 유지된다.
- R1-4: events.json의 `host.sidecar.restart-limit` 설명이 표준 입출력 transport만 적는다. 수용: 설명이 두 transport를 적는다.
- R1-5: 표준 transport의 거부 log 줄이 빠져 있었다. 수용: 거부된 전송은 `error: sidecar <name>: restart limit: request for <surface> refused`를 쓴다.

### 2차

- R2-1: 네 번째 실패가 service 프로세스의 끝일 수 있었다. 부활이 다시 낳을 것이 남아 있어 실패한 시작도 시작 오류도 없고, 산 연결을 닫을지 두 호스트가 달라질 수 있었다. 수용: 멈춤은 네 번째 실패에서 생성 경로가 돌기 전에 시작한다. 실패한 시작은 시작 오류를 담은 알림을, service의 끝은 spawn 전에 멈추고 `restart limit`을 담은 알림을 낸다. 끝은 부활이 그것을 위해 돌 때 세고, 멈춤이 spawn을 막아도 같다.
- R2-2: 끝날 때 자기 endpoint를 지우는 service는 부활을 endpoint 없는 spawn 경로에 두고, 첫 실패 조항의 글자로는 아무것도 세지 않아 죽고-치우는 반복이 무한히 재시작되었다. 수용: 부활은 오래된 endpoint를 지운 뒤 또는 남은 것이 없을 때 단일 생성 경로로 다시 낳는다.
- R2-3: 사이드카 명세 재시작 한도 문단의 첫 문장이 여전히 표준 입출력만 적는다. 수용: 첫 문장을 바꾸고 정의하지 않았다는 뒤의 문장을 지운다.
- R2-4: 계속 연결 transport는 protocol 위반 때 `sidecar-failure`를 전달하므로, 통째로 남긴다는 문장이 명세와 어긋났다. 수용: restart-limit 보고만 연결 알림으로 가고, 멈춤은 `sidecar-failure` 전달을 더하지 않는다.

### 3차

- R3-1: 재시작 한도 문단의 거부 문장이 `sidecar-failure` 전달을 명하므로, 첫 문장을 두 transport로 만들면 R2-4의 답과 어긋나게 계속 연결 거부 전송에도 전달을 명하게 된다. 수용: 명세 변경은 거부 문장의 `sidecar-failure` 전달이 표준 입출력 transport의 보고이고 계속 연결 transport는 거부된 전송을 연결 알림으로 보고한다고 적는다.
- R3-2: protocol 위반으로 끝나는 연결은 프로세스의 끝도 시작 실패도 아니어서, 위반하는 계속 연결 service가 한 없이 재접속하고 실패한다. 같은 결함이 표준 transport에서는 네 번째에 멈춘다. 수용: protocol 위반 연결 끝을 실패로 센다. reader가 연결을 끝낼 때 세고 service는 계속 돌며, 위반의 `sidecar-failure` 전달은 그대로 둔다.

4차가 열려 있다.
