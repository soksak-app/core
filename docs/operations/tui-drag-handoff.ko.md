# TUI 터미널 드래그 조사 인수인계

## 기준 시점

- 날짜: 2026-09-28 (Asia/Seoul).
- 저장소: `~/polyspec/soksak`.
- 브랜치: `fix/tui-repeat-drag`.
- 현재 HEAD: `809262e9 feat: count PTY child output bytes beside the unread input`과 이 증거 갱신이며 `.3.2.2` 실측은 아래 10번에 기록된다.
- `.3.2.1`·`.3.2.2` 계측과 실측(아래 9·10번)은 커밋됐다. `.3`/`.3.2`/`.3.2.1`/`.3.2.2`는 완료다. 첫 실패 경계가 양쪽 소스 수준에서 측정·설명됐다. 제품 수정은 아직 하지 않았다.
- 작업은 아직 진행 중이다. 정식 체크리스트 `V5-96-14-6-8-2-1`에서 다음 작업은 `.4`(소유 모듈 Red 뒤 native 포커스 보고 경계 수정)다. 어느 호스트도 요구된 60주기 수락 검사를 통과하지 않았다.

## 사용자 증상과 수락 조건

대상 증상은 실제 TUI 안에서 일반 마우스 드래그로 텍스트를 선택하는 동작이다. Shift 드래그는 요청된 동작을 대체하지 않는다. 실패는 간헐적이며 직전 상호작용에 따라 달라진다. 드래그가 되다가 TUI의 제3지점을 클릭한 뒤 드래그가 실패할 수 있고, 다른 카드를 클릭한 다음 돌아오면 일시적으로 다시 선택될 수 있다. 타우리와 웨일즈 모두에서 일반 드래그가 멱등적으로 동작해야 한다.

정식 체크리스트는 호스트별로 TUI 세션 하나를 유지하며 초기화 없는 60주기를 요구한다. 제3지점은 프롬프트, 같은 transcript 행, 빈 TUI 영역이며 드래그 속도는 일반·느림, 조합마다 열 번 반복한다. 각 주기는 최초 드래그, 제3지점 클릭, 직접 재시도를 포함한다. 직접 재시도 실패는 나중의 회복이 성공해도 실패로 남는다. 결과는 새 실제 입력, 대응하는 DOM·PTY ID, 터미널 선택 셀, 요청 속도로 녹화된 전체 시각 측정에 연결되어야 한다. 입력·프레임·상태·추적 용량이 누락되면 전체 검사는 실패다. Shift는 별도 대조군으로 유지한다.

## 확인된 사실

1. 기존 수락 판정기에는 실제 결함이 있었다. 오래된 mouse-up이 새 입력의 결과로 인정될 수 있었고, 이후 회복 성공으로 직접 재시도 실패를 덮을 수 있었다. 소유 fixture를 잘못된 조건에서 Red로 실행했고 판정기를 고친 뒤 Green으로 통과시켰다. 현재 집중 판정기 테스트는 9/9 통과한다.
2. 추적 대상 실제 TUI 검사는 실제 네이티브 포인터 입력, 완전한 화면 녹화, DOM down/move/up 및 capture 이벤트, 연결된 터미널 포인터 쓰기·응답, 터미널 선택 상태, `header` 여섯 셀의 픽셀을 기록한다. 측정 증거를 추출한 뒤 원본 녹화를 지우며, 호스트별 JSON 결과는 시스템 임시 폴더에 남긴다.
3. TUI과 재빌드한 타우리·웨일즈에서 최초 드래그가 여섯 셀 모두를 선택한 사례가 있다. 실패 제스처도 예상한 8개 SGR 보고와 완전한 DOM 포인터 순서를 보인 적이 있다. 같은 호스트에서 성공·실패 제스처의 SGR 바이트 시퀀스는 같았다.
4. 실패는 간헐적이고 제3지점 클릭으로만 한정되지 않는다. 기록된 타우리 진단은 직접 재시도 3/3 실패, 뒤이은 주기 2·3의 최초 드래그 실패, 회복 세 번 모두 선택 셀 0개였다. 웨일즈의 짧은 진단 두 번은 결과가 달랐다. 첫 실행은 1·3주기가 통과하고 2주기는 최초·직접 제스처가 실패했다. 다음 실행은 세 주기 모두 실패했고 회복 하나는 여섯 셀 모두, 두 개는 0개였다. 이 변동 자체가 증거이며 어느 실행도 수락 통과가 아니다.
5. 포커스는 별도로 측정된 간헐 요인이지만 선택 손실을 단독으로 설명하지 못한다. 웨일즈는 대상 native responder가 확인된 회복 성공과 실패를 모두 보였다. 타우리 회복 중 WebView가 20초 동안 첫 responder 소유권을 유지한 사례도 있다. 포커스만 설정하면 고쳐진다고 추론하지 않는다.
6. 직접 재시도의 시각 검사는 기존 선택을 새 선택으로 오인하지 않도록 강화했고 새 터미널 선택 상태를 최대 1000ms 기다린다. 이에 따라 녹화는 마우스-up 뒤 약 1.13초까지 지속된다. 최근 짧은 진단의 실패는 계속 선택 셀 0개였고 terminal 상태 대기가 시간 초과됐다. 새 시간초과·기존 선택 assertion을 넣기 전 집중 판정기 Red는 7/9였고, 수정 후 Green은 9/9다.
7. macOS의 `dtruss`는 System Integrity Protection 활성화 상태와 추가 추적 권한 요구로 연결할 수 없었다. 이는 이 환경에서 해당 관측 수단을 사용할 수 없다는 뜻일 뿐 제품 결함의 설명은 아니다.
8. 자식 입력 수신은 이제 사이드카 소유 계측으로 잰다(`.3.2.1` 완료). vt-core는 열린 세션의 `pty.pending` 연산에 마스터가 쓰고 자식이 아직 읽지 않은 바이트 수를 FIONREAD로 답한다. macOS는 마스터와 슬레이브가 tty 하나를 공유하므로 마스터 fd가 그 공유 입력 큐를 읽는다. TIOCOUTQ는 자식의 출력 큐를 읽음을 측정으로 기각했다. 소유 fixture로 읽지 않는 raw 자식의 잔량, 읽는 자식의 드레인, 생산 write 경로의 정확한 자식 수신을 증명했다(사이드카 모음 172/172). 세션이 없는 경우를 포함한 오류 응답도 같은 `pty.pending` 이벤트 표식을 실으며, 진단 빌드는 `terminal.pty.pending` 명령을 단일 요청 상관과 5초 제한으로 노출한다(플러그인 모음 115/115). 한 번도 실행하지 않은 호스트 측 Perl 수신기는 폐기했다. canonical 모드에서 아직 조립 전인 줄은 세지 않으므로 raw 모드 자식이 측정 계약이고, 큐가 비었다는 사실은 자식에 대한 전달은 증명해도 프로그램이 바이트를 해석했음은 증명하지 않는다.
9. 그 계측의 첫 실측(2026-09-28, 재빌드 호스트)이 전달 경로를 무죄로 만들었다. 두 짧은 진단 모두 3주기 전부 실패했다 — 타우리는 첫 제스처 하나가 여섯 셀을 선택했고 직접 재시도는 전 주기에서 실패했으며, 웨일즈는 전 제스처가 0셀이었다 — 그리고 성공·실패 무관하게 모든 제스처의 `terminal.pty.pending` 표본 두 개가 모두 0이었다(제스처 직후 2–6ms와 선택 정착 대기 뒤). 측정 오류는 없었다. 터미널의 mouse mode(`click: false, drag: false, motion: true`)와 `selecting`, `selectionReleases`도 성공·실패 제스처에서 동일했다. 따라서 최초 분기는 자식이 읽은 뒤, 수신한 SGR 시퀀스의 파싱 또는 선택 렌더링(TUI 내부)에 있다. 다음 관측 대상은 실패 제스처에서 mouse-up 뒤 자식 출력이 있는지다.
10. `.3.2.2` 측정과 TUI 소스 검토로 최초 분기를 특정했다(2026-09-28, 재빌드 호스트, TUI). 어떤 실패 제스처도 mouse-up 뒤 자식 출력을 내지 않는다. `written` 표본 두 개가 모든 실패 제스처에서 동일하고 드래그 창 자체는 고정 약 30바이트만 자라며 제스처 사이의 제3지점 클릭은 출력을 만든다. 모든 실패 제스처의 포인터 추적은 mouse-down과 mouse-up 사이의 native 영역 포커스 전이를 기록한다(down 약 13ms 뒤 상실, 약 30ms 뒤 회복). vt-core가 이를 ?1004를 켠 자식에게 press와 motion 보고 사이에 ESC[O/ESC[I로 전달한다. TUI는 `FocusLost`에서 transcript 드래그를 끝내고(the program source의 `transcript_view.end_drag()` 가드), `end_drag`는 최신을 따르는 중이면 막 시작된 빈 선택을 버리며 이후 `extend_selection`(`transcript_view/input.rs`)은 모든 `Drag`를 조용히 무시한다. 포커스 시퀀스는 mouse 시퀀스가 아니므로 mouse SGR 바이트는 성공·실패에서 동일하고 이전 바이트 비교가 절대 갈라지지 않은 이유다. 짧은 진단 15회 135제스처 전부 미드드래그 포커스 전이와 함께 실패했고 이전의 간헐적 성공은 영역 포커스가 안정된 시점과 일치한다. 실패 경계는 호스트 쪽이다. native 영역이 앱 안의 responder 변동을 터미널 포커스 상실로 보고하고(`native/darwin/src/image_region.m`, 모든 전이에서 보고하는 `become/resignFirstResponder`), 페이지는 카드 pointerdown마다 표면 포커스를 요청한다(`packages/workbench/plane.js`, 이미 포커스된 카드도 `focusSurface`를 호출).

## PTY 측정 계측 상태

이전 인수인계가 지시했던 Perl 수신기는 실행 전 폐기했으므로 다시 만들지 않는다. 대체 구현은 완료·검증·문서화됐다:

- `sidecars/vt-core`는 열린 세션의 `{operation: "pty.pending"}`에 측정 왕복 한 번으로 `{event: "pty.pending", pending, written}`을 답한다(`sidecars/vt-core/src/pty.rs`). `pending`은 마스터가 쓰고 자식이 아직 읽지 않은 입력 바이트 수의 FIONREAD 값이고, `written`은 세션 reader가 지금까지 읽은 자식 출력 누적 바이트 수로 `read_output`에서 출력을 broadcast하기 전에 증가한다. 세션이 없는 경우를 포함한 모든 오류 응답에 같은 이벤트 표식을 실어 답이 자기 요청을 밝힌다(`src/protocol.rs`, `tests/serve_contract.rs`).
- 소유 fixture는 읽지 않는 raw 자식, 드레인하는 자식, 생산 write 경로, 출력하는 자식의 정확한 출력 바이트 수(`stty -opost; printf MEASURED` → 8)를 다룬다(`tests/pty_lifecycle.rs`).
- 진단 빌드는 `plugins/terminal/diagnostics.json`, `ui/terminal-diagnostics.js`, `ui/terminal.js`의 단일 슬롯 resolver로 `terminal.pty.pending`을 노출하며 이 명령은 `{pending, written}`으로 해소되고 사이드카의 명시적 오류와 한쪽이라도 빠진 응답을 거절한다(`test/terminal.test.mjs`, `test/manifest.test.mjs`).
- `e2e/real/tui-drag.test.mjs`는 제거한 probe 대신 제스처마다 두 값을 모두 실은 `terminal.pty.pending` 표본 두 개 — 제스처 직후와 선택 정착 대기 뒤 — 와 `ptyPendingError`를 기록한다. 커널 큐는 알림이 없어 이 시점의 샘플이 유일한 관측이며, e2e 소스 감사가 고정 대기 폴링을 거부하므로 25ms 폴링은 제거했고 모든 제스처(최초·직접·회복)가 선택 정착 대기를 사용해 두 번째 표본의 시점을 제한한다.
- 계약은 `docs/spec/terminal-runtime.md`(쌍동 `.ko.md`)에 정의돼 있다.

남은 것은 `.3.2`의 추가 측정이 아니라 `.4` 수정이다. 고칠 경계: 터미널 안의 클릭이 PTY로 터미널 포커스 상실 보고를 만들어서는 안 된다. 측정된 결함은 pointerdown 전후의 native 영역 `become/resignFirstResponder` 변동(양쪽 호스트)이 `focus` 입력으로 전달되어 제스처 중에 ESC[O/ESC[I로 기록되는 것이다. 소유 모듈 Red는 창 키나 소유권 변화 없이 pointerdown 전후의 영역 포커스 out/in 쌍을 재현하고 표면에 포커스 상실 보고가 닿지 않음을 확인해야 한다. 수정은 영역의 포커스 보고가 일시적 responder 정리가 아니라 실제 입력 소유권(예: 창 키 상태와 표면의 키보드 입력 청구)을 반영하게 만든다. 이후 짧은 진단과 60주기 수용을 다시 실행하고, 미드드래그 `ptyPending`·포커스 흔적 없이 양쪽 호스트에서 드래그가 통과하면 Green이다.

## 현재 파일과 증거

- `e2e/real/tui-drag.test.mjs`: 실제 TUI 준비, 3지점 진단 주기, 네이티브 포인터 입력·녹화, 최초·직접·회복 결과 분리 기록, 제스처별 PTY 측정 표본 두 개(`pending`·`written`).
- `e2e/tui-drag-measurement.mjs`: 새 선택 확인과 release 뒤 대기를 포함한 엄격한 제스처 결과 assertion.
- `e2e/test/tui-drag-measurement.test.mjs`: 오판 fixture와 새 선택 대기 규칙.
- `sidecars/vt-core`: `pty.pending` 측정(`pending`·`written`), 프로토콜 오류 표식, 소유 수명주기·serve 계약 검사.
- `plugins/terminal`: `terminal.pty.pending` 진단 선언, 모듈 연결, 플러그인 검사.
- `docs/features.md`, `docs/features.ko.md`: 단일 기준 체크리스트. `.3`부터 `.3.2.2`까지 완료. `.4`에서 계속하고 완료한 항목은 다시 열지 않는다.
- `CHANGELOG.md`, `CHANGELOG.ko.md`: 현재까지 확인된 증거 기록. 다음 검증 결과가 생기면 쌍으로 갱신한다.
- 현재 JSON 증거: `${TMPDIR}/soksak-tui-drag-tauriv2.json`, `${TMPDIR}/soksak-tui-drag-wailsv3.json` (실제 시스템 임시 경로는 `/var/folders/.../T` 아래)은 2026-09-28 재빌드 호스트 진단이며 모든 제스처의 `ptyPending` 표본 두 개를 담고 있다. 프레임 원본은 측정 뒤 제거됐다. 임시 파일이 사라지기 전 필요한 요약을 이 문서로 옮긴다.
- `docs/operations/tui-drag-handoff.md` 및 `.ko.md`: 이 인수인계 문서. 조사 진행에 따라 영문·한글 내용을 함께 유지한다.

마지막으로 관측한 프로세스 목록(2026-09-28 측정 세션 뒤)에는 재빌드 실행 파일을 사용자 설정 디렉터리에서 실행하는 Tauri 하나와 Wails 하나가 있었고, 진단용 임시 인스턴스는 `normal-shutdown`으로 닫았다. 이후에는 PID나 endpoint가 아직 유효하다고 가정하지 말고 매번 다시 확인한다. 실행 세션 종료 시 사용자 경로 앱을 호스트별 하나씩 남기고 임시 앱은 선언된 정상 종료 경로로 닫는다.

## 재개 절차

1. 이 문서, `AGENTS.md`, `docs/features.md`의 `V5-96-14-6-8-2-1`, 현재 diff를 읽는다. `git status`, 브랜치·HEAD, `pgrep -alf 'soksak-(tauriv2|wailsv3)'`, 각 endpoint의 PID·실행파일·설정 디렉터리와 실행파일 hash를 확인한다. 이전 프로세스가 현재 빌드를 실행한다고 가정하지 않는다.
2. `.3.2.1`·`.3.2.2` 계측과 실측은 커밋됐다(`59c34ae5`, `809262e9`와 그 뒤의 증거 커밋). 작업 트리에 새 미커밋 변경이 있으면 검토한 뒤 해당 게이트 — `make docs-check`, `pnpm test`, `make boundaries`, `make exposure-check`, `pnpm -F @soksak/e2e test`, Rust 변경에 대해 `make native-test` — 를 실행하고 명시적 경로를 하나의 단위로 커밋한다. `git add -A`는 쓰지 않는다.
3. 집중 단위 검사를 실행한다.

   ```sh
   node --test e2e/test/tui-drag-measurement.test.mjs
   ```

4. 현재 checkout에서 진단 번들 둘을 빌드한다.

   ```sh
   make -B tauriv2-build wailsv3-build
   ```

5. 60주기 수락 검사 전에 두 호스트에서 짧은 진단을 실행한다. pending·written 질문 모두 2026-09-28에 재빌드 호스트 양쪽에서 완료했다 — 위 9·10번 참조. 새 빌드(`.4` 수정 뒤)에만 다시 실행한다. 진단 검사는 한 주기라도 실패하면 의도적으로 nonzero 종료한다. 이를 Red 그대로 보존하고 전체 JSON과 녹화에서 추출한 측정을 본다. Tauri 예시:

   ```sh
   SOKSAK_APP=tauriv2 \
   SOKSAK_CONFIG_DIR=/tmp/soksak-check-tui-repeat-tauriv2 \
   SOKSAK_TUI_DRAG_DIAGNOSTIC=1 \
   node --test --test-concurrency=1 e2e/real/tui-drag.test.mjs
   ```

   Wails는 `SOKSAK_APP=wailsv3`, `/tmp/soksak-check-tui-repeat-wailsv3`를 사용한다. 검사 전에 일치하는 재빌드 앱을 해당 임시 설정으로 한 번 실행한다. `e2e/app.mjs`는 이미 실행 중인 endpoint에 연결하며 앱을 띄우지 않는다. 사용자 기본 설정은 보존한다. Wails 사용자 경로 프로세스를 잠시 교체해야 하면 정확한 설정 경로를 `SOKSAK_APP=wailsv3`, `SOKSAK_CONFIG_DIR`로 지정해 `node e2e/normal-shutdown.mjs`를 실행한다. 임시 인스턴스를 시작해 검사하고 정상 종료한 뒤 사용자 경로 앱 하나를 복원한다.
6. JSON 결과를 열어 각 시도를 확인한다. 현재 `inputId`, 연결된 포인터 응답, phase, trace overflow, DOM capture/focus, host/window responder, mouse mode, 입력 전·직후·최대 1000ms 뒤 선택 셀, 녹화 frame 수·간격과 대상 글자 셀 픽셀, `ptyPending` 표본 두 개(`pending`·`written`)와 `ptyPendingError`를 확인한다. 두 번째 표본의 `pending`이 0인 것은 자식에 대한 전달은 증명해도 TUI 선택 결과가 아니며, 0이 아니거나 명시적 오류가 나는 것 자체가 발견이다. 표본 사이 `written` 증가가 자식 출력 관측이다. 성공·실패 제스처에서 비교한다. 기계 비교가 없는 정지화면·영상은 통과 결과가 아니다.
7. 첫 실패 경계는 측정됐다(10번). pointerdown 전후의 native 영역 포커스 out/in 쌍이 제스처 중에 ESC[O/ESC[I로 자식에 닿고 TUI가 드래그를 취소한다. 전달이나 TUI 파싱을 다시 조사하지 말고 `.4`로 진행한다. 포커스 보고 경계의 소유 모듈 Red를 추가하고 수정한 뒤 같은 진단과 수용 검사를 다시 실행한다. 새로운 모순이 나타나면 `.3.2`를 다시 열지 말고 체크리스트 항목을 분기한다.
8. 최초 실패 경계를 측정한 뒤 소유 모듈 Red를 추가하고 변경 전 구현에서 실패시킨다. 해당 경계를 수정한 뒤 동일 테스트 Green과 추적 반복을 실행한다. 양쪽 호스트가 모든 주기·화면·입력·추적·Shift 조건을 통과하기 전까지 항목을 진행 상태로 유지한다.
9. 새 사실이 확인될 때마다 다른 업무로 넘어가기 전에 활성 `.3.2` 체크리스트와 쌍을 이룬 체인지로그를 갱신한다. 다음 작업자가 최신 프로세스나 증거 상태를 모르게 될 때 이 문서도 함께 갱신한다. 구현 후 `make docs-check`, 소유 테스트, 적용되는 workspace 검사, `make boundaries`, `make exposure-check`를 실행한다. 항목과 증거를 마친 뒤에만 커밋한다. 상위 작업은 `.3`–`.6` 완료와 사용자 경로 양쪽 앱의 검증된 실행 파일 복구 전에는 완료가 아니다.

## 검사 명령의 의미와 경계

- `SOKSAK_TUI_DRAG_DIAGNOSTIC=1`은 제3지점별 한 주기를 실행하고 모든 실패를 기록한 뒤 nonzero 종료한다. 원인 조사 명령이며 60주기 수락 검사가 아니다.
- 해당 환경변수 없이 실행하면 추적 검사는 호스트별 60주기(속도 2 × 제3지점 3 × 반복 10)를 실행하고 직접 재시도 실패 즉시 전체를 실패시킨다.
- 기계 JSON은 OS 임시 폴더에 남고 추출이 끝난 원본 영상은 지운다. 임시 JSON이 사라지기 전에 필요한 요약을 이 문서/체크리스트로 옮긴다. 구체적인 측정 이유 없이 큰 영상 원본을 보관하지 않는다.
- 네이티브 포인터 helper는 실제 HID를 사용하며 신뢰 권한이 필요하다. 권한·앱·상태·응답·프레임 누락을 통과나 skip으로 바꾸지 않는다.
- `terminal.pty.pending`은 `diagnostics.json`에 선언되어 진단 빌드에만 있다. `pending` 값은 전송 수준 증거로 큐가 비었다는 사실은 자식에 대한 전달은 증명해도 프로그램이 바이트를 해석했음은 증명하지 않는다. `written` 값은 reader가 읽은 자식 출력 누적이며 표본 사이 증가는 mouse-up 뒤 자식 출력의 관측이지 선택 결과는 아니다.
- 계측은 제품 수정이 아니다. 측정된 제품 수정, Red→Green, 반복 검사, 양쪽 호스트 전체 수락, 사용자에게 연 실행 파일이 검증 빌드와 일치하기 전까지 완료로 보고하지 않는다.
