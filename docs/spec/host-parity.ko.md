# 호스트 동일성

[English](host-parity.md)

두 애플리케이션 호스트(`tauriv2`, `wailsv3`)는 같은 제품을 구현한다. 각 호스트는 language host library(`packages/host/rust`, `packages/host/go`)와 그 framework adapter(`packages/host/tauriv2`, `packages/host/wailsv3`), 그리고 애플리케이션으로 이루어진다([네이티브 호스트](hosts.ko.md)). 호스트 사이의 동일성은 검토 의견이 아니다. 아래의 각 명제는 `make host-parity-check`(`scripts/check-host-parity.mjs`)가 판정한다. 도구는 두 호스트의 소스를 읽고 차이가 있으면 실패한다. 정당한 차이는 명제를 늦추는 것이 아니라, 수정과 함께 이 문서의 명제 자체를 바꾸는 것이다.

## 명제

1. **공개 바인딩은 같은 집합이다.** 각 호스트가 등록하는 페이지 대상 명령면 — Tauri framework adapter의 Rust `bindings!` 블록이 정의하고 등록하는 명령의 이름과 Go language host library의 내보낸 `Host` 메서드, snake case 로 비교 — 이 하나의 집합이다. 한쪽에만 있는 명령은 검사를 실패시킨다.
2. **엔드포인트 메서드는 같은 집합이다.** 각 빌드가 선언하는 [엔드포인트](endpoint.ko.md) 메서드 이름 — 기본 메서드, 구독 메서드, 진단 빌드 전용 추가 — 이 같은 빌드 맛에서 두 호스트 하나의 집합이다. 호스트가 선언하는 진단 빌드 전용 메서드는 각각 [진단 빌드](endpoint.ko.md#진단-빌드) 표의 행이고, 그 표의 각 행은 어느 호스트가 선언하는 메서드다.
3. **애플리케이션 메뉴는 선언된 계약이다.** 두 호스트의 메뉴 바는 [호스트 계약](host-contract.ko.md)의 메뉴 계약 표대로 같은 항목을 같은 순서·같은 단축키로 담는다. 검사는 실행 중인 호스트의 실제 메뉴 바를 열거하고, 한쪽에만 있는 항목은 실패시킨다.
4. **단일 호스트 면제는 여전히 참이어야 한다.** 호스트 계약 사례 표의 모든 `<host> only: <이유>` 행은 관측이 여전히 확인하는 차이를 인용한다. 인용한 차이가 더 참이 아니면 면제는 낡았고, 사례가 `all` 이 될 때까지 검사는 실패한다.
5. **검사는 그 기능이 있는 곳에, 모든 언어가 같은 수준으로 둔다.** 제품 폴더는 같은 트리에 소유 검사를 두고 모든 언어의 모음이 같은 게이트에서 돈다. 검사는 폴더별·게이트별로 비교한다. 다른 언어보다 낮게 연결된 언어나 소유자에게서 떨어진 검사는 실패한다.
6. **모든 플랫폼 메서드는 호출하는 곳이 있다.** Rust 플랫폼 interface(`packages/host/rust/src/platform/platform.rs`)의 모든 trait과 Go 플랫폼 interface(`packages/host/go/src/platform/platform.go`)의 모든 interface의 각 메서드는 그 language host library의 `src/platform` 밖 제품 소스가 부른다. Rust에서는 `.name(`이나 `::name(`으로, Go에서는 `.Name(`이나 메서드 값 `.Name`으로 부른다. test file(`_test.rs`, `_test.go`), test build만 compile하는 Rust 소스의 item(`#[cfg(test)]`와 `#[cfg(all(test, ...))]`), 주석 줄은 호출하는 곳이 아니다. free function 안의 호출은 제품이 그 function에 닿을 때만 센다. 그 function이 진입점(`main`, Go `init`, `#[tauri::command]`, cgo `//export` function)이거나, 그 language host library의 소스나 library를 link하는 framework adapter와 애플리케이션의 소스(`packages/host/tauriv2/src`, `packages/host/wailsv3/src`, `apps/tauriv2/src`, `apps/wailsv3/src`)에서 세는 호출이 그 이름을 부를 때다. 그래서 test만 부르는 function은 호출하는 곳이 아니고, 서로만 부르는 function들도 아니다. method, impl, package 수준 값 안의 호출은 센다. 호출하는 곳이 없는 메서드는 검사를 실패시키고 그 구현과 함께 제거한다. 어떤 build 검사도 쓰이지 않는 trait 메서드와 내보낸 Go interface 메서드를 보고하지 않기 때문이다.

검사의 출력이 차이 보고서다. 수정은 같은 도구로 Red(수정 전 트리에서 실패)와 Green(수정 뒤 통과)을 밟는다.
