# 녹화 상태 사례

`decisions.json`은 diagnostic 녹화의 상태가 녹화기와 파일 시스템의 답에서 내리는 결정의 사례표다([host contract](../../host-contract.ko.md)의 `recording.*` 사례). Go host(`packages/host/go/tests/recording_test.go`)와 Rust host(`packages/host/rust/tests/recording_test.rs`)가 같은 표를 재생하므로 두 host는 같은 문구로 결정하고 보고한다.

각 목록은 host의 결정 함수 하나를 가리킨다.

| 목록 | 함수 (Go / Rust) | 입력 | 결과 |
| --- | --- | --- | --- |
| `refuseStart` | `RefuseStart` / `refuse_start` | 녹화나 그 정리가 소유한 폴더 | 거부 문구, 소유자가 없으면 null |
| `refuseFinish` | `RefuseFinish` / `refuse_finish` | 소유한 폴더와 native 녹화가 끝났는지 | 거부 문구, 녹화를 끝낼 수 있으면 null |
| `needsStop` | `NeedsStop` / `needs_stop` | 소유한 폴더와 native 녹화가 끝났는지 | abort가 녹화를 중지하는지 |
| `stopFailure` | `StopFailure` / `stop_failure` | 실패한 중지의 오류 | 보고하는 문구 |
| `settleCleanup` | `SettleCleanup` / `settle_cleanup` | 제거로 이끈 오류(`cause`, 없으면 null)와 제거 오류(`removal`, 성공한 제거는 null) | 녹화가 폴더를 유지하는지(`retainOwner`)와 보고하는 문구(`error`) |

답을 내는 것은 녹화기이고, 녹화기는 display에 그려진 창의 image가 필요하므로 `e2e/capture-state.test.mjs`가 end-to-end 단계에서 판정한다. 사례의 제거 오류는 파일 시스템이 내는 문구다. host 시험은 권한을 없앤 폴더의 제거를 거부하는 실제 파일 시스템의 제거 오류로도 같은 함수를 판정한다.
