# 설치형 plugin (0.0.2)

[English](plugin-installation.md)

상태: version 0.0.2 제안이며 구현은 대기 중이다. 정식 작업 checklist는 [features](../features.ko.md)의 R1 항목이다. 승인된 내용은 spec으로 옮기고 이 제안은 삭제한다.

## 목표

확장을 품는 편집기처럼 plugin을 실행 중에 설치, 업데이트, 끄기, 제거한다. Registry가 누구나 설치할 수 있는 plugin을 나열하며, 제3자는 registry repository에 pull request를 보내 plugin을 추가한다. Sidecar는 플랫폼별로 release되고 그것이 필요한 plugin과 함께 설치된다. Version 0.0.2는 이 개념을 정의하고 local에서 돌린다. Registry, plugin package, sidecar release는 local 폴더와 local release archive에 있고, 나중의 GitHub 흐름은 같은 형식을 쓴다.

## 바뀌는 것

지금 애플리케이션은 build 때 plugin을 고정한다. `environment.json`이 plugin을 나열하고, `soksak-stage`가 그 파일을 frontend에 복사하며, host는 애플리케이션 bundle에서 sidecar 실행 파일을 실행한다. 이 변경 뒤에는 다음과 같다.

- Workbench는 `environment.json`의 목록 대신 설정 폴더에서 설치된 plugin 목록을 읽는다. `environment.json`은 새 space의 배치와 스타터팩 이름을 유지한다.
- Host는 설치된 plugin의 파일을 `<config-dir>/plugins/<id>/<version>/`에서 `/modules/<package>/`로 제공한다.
- Host는 sidecar 실행 파일을 `<config-dir>/sidecars/<name>/<version>/<os>-<arch>/`에서 실행한다.
- 애플리케이션은 plugin을 담지 않고, 첫 실행에서 스타터팩을 설치한다.

## Registry

Registry는 plugin마다, pack마다 파일 하나를 두는 repository다.

| 경로 | 내용 |
| --- | --- |
| `plugins/<id>.json` | `id`, `name`, `description`, `license`, `repository`, `versions`: 각 항목은 `{ version, package: { url, sha256 }, engines: { soksak: <range> }, sidecars: { <name>: <range> } }` |
| `sidecars/<name>.json` | `name`, `repository`, `versions`: 각 항목은 `{ version, protocol, assets: { "<os>-<arch>": { url, sha256 } } }` |
| `packs/<name>.json` | `name`, `description`, `plugins`: 함께 설치하는 plugin id |
| `revoked.json` | 설치하거나 실행하면 안 되는 plugin과 sidecar version |

Registry repository의 check는 모든 pull request에서 항목 형식, id 중복, 내려받은 package의 `sha256`, `@soksak/plugin-api`로 package의 `plugin.json`, 각 sidecar version을 검증한다. Reviewer가 pull request를 병합한다. 그 뒤 check가 애플리케이션이 읽는 파일 하나인 `index.json`을 만든다. 0.0.2에서 registry는 local repository이고 `url`은 local release archive의 `file:` URL이며, 같은 check를 local에서 실행한다.

스타터팩은 plugin `browser`, `terminal`, `files`를 담은 `packs/starter.json`이다.

## Plugin package

Plugin package는 `package.json`, `plugin.json`, `package.json` `files`에 적은 파일을 담은 archive `<id>-<version>.tgz` 하나다.

- `package.json` `version`은 plugin version이고, `engines.soksak`은 plugin이 지원하는 core API 범위이며, `soksak.sidecars`는 sidecar package 이름마다 version 범위를 정한다.
- Page module은 `PAGE_IMPORTS` 이름과 상대 경로만 import한다. 제3자 library는 지금처럼 고정 version으로 `ui/vendor`에 묶으며, 실행 중 npm에서 설치하는 것은 없다.
- `@soksak/plugin-api`의 도구 `soksak-plugin pack`이 manifest, published import, import 규칙을 검증하고 archive와 그 `sha256`을 만든다.

Plugin repository는 core git tag(예: `v0.0.2`)의 `@soksak/plugin-api`에 의존하므로, plugin은 고정된 core API로 build하고 test한다. 도구는 tag에서 package를 찾으며, 작업 중인 checkout은 의존 대상이 아니다.

## Sidecar release

Sidecar release는 플랫폼마다 archive `<name>-<version>-<os>-<arch>.tar.gz` 하나(실행 파일, `sidecar.json`, helper)와 `SHA256SUMS` 파일을 담는다. 0.0.2에서는 현재 macOS 아키텍처용으로 local에서 build하며, 이름 규칙은 이미 다른 플랫폼도 담는다. Host는 archive를 풀어 실행하기 전에 `sha256`을 검증한다. 0.0.2는 hash만 확인하며, 제3자 sidecar의 서명과 신뢰 정책은 나중에 정한다.

## 설치

- 설치는 실행 중인 core API version을 `engines.soksak`에 포함하는 plugin version을 고르고, 그 범위가 허용하는 sidecar version을 고른 뒤, archive를 내려받아 hash를 검증하고 설정 폴더에 푼다. 한 단계가 실패하면 이전 설치를 그대로 두고 그 단계와 이유를 보고한다.
- 업데이트는 새 version을 이전 version 옆에 설치하고 전환하며, 되돌리기는 다시 전환한다. 제거는 plugin을 더 이상 불러오지 않은 뒤 파일을 지운다.
- 끄기는 파일을 두고 plugin을 불러오지 않는다.
- 저장 데이터 형식을 바꾼 plugin은 AGENTS.md 규칙대로 이전 형식의 데이터를 읽을 때 변환하며, 이 변환은 state module의 선언된 변환으로 한다.
- 설치되지 않은 plugin의 tab을 가진 저장 space는 실패하지 않고, 그 plugin 이름과 설치 제안을 보이는 대체 card로 열린다.
- 각 동작은 선언된 command(`core.plugins.install`, `core.plugins.update`, `core.plugins.remove`, `core.plugins.enable`, `core.plugins.disable`)이며, status가 설치된 version과 각 동작의 진행과 결과를 보고한다. 설정 창에 registry index를 검색하고 이 command를 실행하는 plugin page가 생긴다.
- 개발 option은 압축하지 않은 plugin 폴더를 pack 없이 불러온다(`--plugin-dev <directory>`).

## Repository

| 폴더 | Repository |
| --- | --- |
| `core` | Core: library, workbench, plugin-api, host, 애플리케이션, spec, window check |
| `../plugins/<id>` | Plugin 하나: `browser`, `terminal`, `files`, `shell`, 이후 `db-studio` 같은 다른 plugin |
| `../sidecars/<name>` | Sidecar 하나: `vt`(지금의 `vt-core`와 `vt-alacritty`), `files`, `shell` |
| `../registry` | Registry(`~/Projects/soksak/registry`) |

`shell` plugin과 그 sidecar `@soksak/sidecar-shell`은 자기 repository로 옮기지만 registry에는 올리지 않으며, 새 space 배치는 shell card 자리에 terminal card를 쓴다. 각 repository는 자기 checklist와 test를 둔다. Core의 window check는 local archive를 담은 registry fixture에서 plugin을 설치하며 network를 쓰지 않는다.

## Version

모든 core package는 0.0.2가 된다. 분리 뒤 plugin과 sidecar는 각자의 version을 가지며, 그때 `scripts/check-versions.mjs`는 core package만 검사한다. `engines.soksak`이 가리키는 core API version은 core release version이다.

