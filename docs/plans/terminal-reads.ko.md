# 터미널 화면과 기록 읽기

[English](terminal-reads.md)

이 제안은 사람이나 agent가 보이는 화면보다 더 많은 내용을 읽는 데 필요한 읽기 명령을 추가한다. 두 터미널 plugin인 `terminal`(sidecar `vt-alacritty`)과 `term`(sidecar `alacritty`)에 모두 적용하며, 두 sidecar 모두에 적용한다. 각 명령은 두 plugin에서 같은 이름, 같은 parameter, 같은 결과를 가지며, 각 sidecar는 같은 공유 계약 case를 검사한다. 그래서 변경이 두 터미널에 같은 방식으로 적용된다.

## 현재 코드에서 확인한 사실

- `terminal.screen.read`와 `term.screen.read`는 viewport만 돌려준다. 현재 display offset의 grid `screen_lines` 행이다(`sidecars/alacritty/alacritty/src/engine.rs`, `fn screen`). viewport 위의 행을 데이터로 돌려주는 명령은 없다.
- `terminal.scrollback.set`과 `term.scrollback.set`은 display offset을 바꾸고, sidecar는 이를 세션 status의 `scrollback.offset`과 `scrollback.history`로 보고한다. offset은 텍스트를 돌려주지 않는다.
- `alacritty` sidecar는 이미 OSC 133 셸 마크(`A`, `B`, `C`, `D`)를 파싱하고, 절대 행 번호(`dropped + history + line`)를 계산한다. 기록이 유지되는 동안 이 번호는 안정적이다(`engine.rs`, `fn absolute`). 이를 노출하는 명령은 없다.
- `vt` sidecar와 `vt-core`의 OSC 133 처리는 아직 확인하지 않았다(미확인 항목 V1).
- 스크롤했는데 같은 화면이 돌아온 보고가 한 번 관찰되었고 재현되지 않았다. 수정 전에 V2에서 재현한다.

## 방안과 결과

각 방안은 명령이다. 결과는 한정된다. 모든 읽기는 `count`를 받고 상한이 있으며, 상한을 넘는 읽기는 명시적 오류로 실패한다.

1. **viewport 조각**(`screen.read {from, count}`). viewport의 `from`부터 `from + count`행을 돌려준다. parameter 없는 기존 호출의 결과는 그대로 둔다.
2. **평문**(`screen.text {from, count}`와 `history.text {from, count}`). 각 행을 뒤쪽 공백을 뺀 글자로 돌려주고 `wrapped` 표시를 붙여서, 읽는 쪽이 cell을 파싱하지 않게 한다. cell 형식은 방안 1로 계속 쓸 수 있다.
3. **절대 행 번호로 기록 읽기**(`history.read {from, count, format}`). 유지되는 기록의 행을 절대 행 번호로 읽는다. 결과는 `first`(가장 오래된 유지 행), `last`(가장 새 행), `dropped`를 담는다. 기록을 지우기 전까지 절대 번호는 의미가 바뀌지 않으며, 지워진 양은 `dropped`가 보고한다.
4. **검색**(`history.find {pattern, from, limit}`). 일치하는 항목의 절대 행 번호와 일치한 글자를 최대 `limit`개까지 돌려준다. pattern은 정규식이며, 잘못된 pattern은 오류 글을 담아 실패한다.
5. **셸 마크로 명령 출력 읽기**(`command.list {limit}`와 `command.read {index, format, from, count}`). 명령 하나는 `C` 마크와 다음 `D` 마크 사이의 행이며, `D`의 종료 코드를 가진다. `command.list`는 각 명령의 index, 절대 시작과 끝, 종료 코드를 준다. 셸 통합이 없는 터미널은 빈 목록을 돌려주고, `command.list`는 마크를 본 적이 없다고 밝힌다.
6. **원시 출력 로그**(`transcript.read {offset, bytes}`). 고정된 바이트 상한의 로그에서 세션의 PTY 출력 바이트를 offset부터 돌려준다. 구현 전에 메모리 상한 결정이 필요하다(결정 D1).

모든 읽기는 멱등하다. 상태를 바꾸지 않으며, 내용이 바뀌기 전까지 같은 요청은 같은 결과를 돌려준다. 결과는 `generation`을 가지며, sidecar는 내용이 바뀔 때마다 이를 증가시킨다. 호출자는 이로써 결과가 오래되었는지 알 수 있다.

## 각 방안이 놓이는 곳

- Sidecar: 방안 1부터 5까지는 `vt`와 `alacritty` 두 sidecar에 모두 구현한다. 방안 5는 `vt`의 OSC 133 처리(V1)가 필요하다. `vt`가 마크를 파싱하지 않으면 명령 목록은 비어 있고, 그 명세가 그렇게 밝힌다.
- Plugin: `terminal`과 `term`은 각 명령을 schema와 함께 선언하고, 같은 status와 명령 이름으로 노출한다. 각 plugin은 자기 sidecar의 공유 계약 case를 검사한다. plugin 테스트는 다른 plugin의 파일을 읽지 않는다.
- Core: 변경 없음. 명령은 plugin의 선언된 노출을 쓴다.

## 버전과 release 순서

1. sidecar `alacritty`와 sidecar `vt`가 각자 버전으로 명령을 release한다.
2. plugin `term`과 `terminal`이 각각 명령을 가진 sidecar release로 의존 버전을 올리고 release한다.
3. Core는 이 제안으로 바뀌지 않는다.

버전은 각 부분을 소유한 repository의 규칙에 따라 release 때 정한다.

## 검증

- 각 방안은 소유 sidecar의 Red 테스트를 가진다. 변경 전에 실패한 assertion을 기록한다.
- 공유 계약 case는 두 sidecar와 두 plugin에서 모두 실행한다.
- 방안 3과 5는 유지 기록을 넘는 긴 세션으로 검사하고, 변경 전후의 절대 번호를 비교한다.
- 읽기 비용(시간과 메모리)의 측정은 개발이 끝난 뒤 소유 repository의 계획대로 한다.

## 미정 항목

- V1: `vt`가 OSC 133 마크를 어떻게 처리하는지 확인한다(`sidecars/vt`, `vt-core`).
- V2: 스크롤 보고를 현재 `term` plugin에서 재현한 뒤 스크롤을 바꾼다.
- D1: 방안 6의 로그 바이트 상한을 구현 전에 정한다.
- D2: `history.find`가 글자만 검색할지, cell의 스타일도 검색할지 정한다.
