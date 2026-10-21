# 계속 연결하는 service의 재시작 한도

[English](persistent-restart.md)

F212.8a-4의 제안과 검증 기록이다. 규칙이 [터미널 런타임](../spec/terminal-runtime.ko.md)과 [사이드카](../spec/sidecars.ko.md)에 들어간 뒤 이 문서를 지운다.

## 문제

[터미널 런타임](../spec/terminal-runtime.ko.md)은 "연결이 끊길 때마다 한 번 재시작하고, 실패는 보고하며, 다음 전송이 같은 경로를 다시 시도한다"고 적는다. 부활할 때마다 곧 죽는 service는 끊길 때마다 다시 부활한다. 요청도 사람의 동작도 없이 재시작이 무한히 반복된다. [사이드카](../spec/sidecars.ko.md)의 `## Failure`는 이 재시작 한도가 계속 연결 transport를 덮지 않는다고 적는다.

## 제안

1. 재시작 한도가 세는 계속 연결 service의 실패는 다음 중 하나다.
   - 호스트가 sidecar를 멈추고 있지 않을 때 service 프로세스가 끝나는 것. reader의 부활이 단일 생성 경로의 죽은 service 가지를 밟는다(오래된 endpoint를 지운 뒤).
   - 생성 경로의 시작 실패: `the service did not print its endpoint within 30s`, `service exited before endpoint`, `the service did not answer hello within 5s`.
   부활이 살아 있는 service에 다시 붙는 끊김은 실패가 아니다.
2. 세는 방식은 [사이드카](../spec/sidecars.ko.md) `## Failure`의 표준 입출력 규칙을 따른다. 각 실패가 도착한 시각으로 세고 timer는 없다. 새 실패보다 300초 앞선 실패는 세지 않는다. 300초 안의 네 번째 실패가 재시작을 멈추고 `error: sidecar <name>: restart limit: 4 failures within 300 s`를 log에 쓰고 수준 error로 `host.sidecar.restart-limit` `{sidecar}` event를 쓴다.
3. service가 멈춘 동안 호스트는 부활도 생성도 하지 않는다. 끊김은 연결이 끊긴 채로 두고, 그 sidecar에 전송한 각 surface는 연결 알림 `{"event": "connection", "connected": false, "reason": "restart limit"}`을 받는다. 전송은 `sidecar <name>: restart limit`로 실패한다. 계속 연결 transport는 이 일을 연결 알림으로만 알린다. `sidecar-failure` event는 표준 입출력 transport에 그대로 둔다.
4. 사람이 surface를 열 때만 멈춤을 푼다. 표준 입출력 transport와 같다. `plugin.json`의 `dependencies`가 그 sidecar를 적는 plugin의 surface를 호스트가 만들면 실패 기록을 지우고 수준 debug로 `host.trace.sidecar.restart-reset` `{sidecar, surface}` event를 쓰고, 다음 전송이 생성 경로를 돈다. 이미 열려 있는 surface의 요청은 멈춤을 풀지 않는다.
5. [터미널 런타임](../spec/terminal-runtime.ko.md)은 끊김마다 한 번의 부활 시도를 유지하고 이 한도를 더한다. [사이드카](../spec/sidecars.ko.md) `## Failure`의, 계속 연결 한도를 정의하지 않았다는 문장을, 계속 연결 transport가 같은 한도를 가지고 그 실패 event가 터미널 런타임이 적는 것이라는 한 문장으로 바꾼다.

## 검증 범위

- 범위 안: 어떤 event가 실패로 세이는지, 멈춤이 무엇을 하는지, 멈춤을 푸는 규칙, 세는 방식, 오류와 event 글, 명세의 두 문장.
- 범위 밖: 한도 값 300초와 4회(두 transport 모두 F212.8a가 정했다), session 보존과 닫기 의미, 갱신과 교체 흐름, reader가 연결 끝을 알아내는 방법, 시작 한계 30초와 5초.

## 검증 기록

1차가 열려 있다.
