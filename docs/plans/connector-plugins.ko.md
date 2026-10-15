# Connector plugins

[English](connector-plugins.md)

## 문제

애플리케이션 표면([외부 애플리케이션 표면](external-app-surface.ko.md))은 embed 어댑터를 가진 애플리케이션을 `appview` 카드 안에 보이지만, 실행 파일과 인자는 사람이 카드 설정에 적는다. 애플리케이션은 registry에 자기 항목이 없어서 거기서 설치되거나 시작되지 않는다.

## 방식

각 애플리케이션은 연결 plugin으로 사람들에게 닿는다: 애플리케이션의 코드나 바이너리를 담지 않는 registry의 plugin이다. 그 plugin은 애플리케이션, 애플리케이션이 지원하는 플랫폼, 그리고 플랫폼마다 이미 설치된 애플리케이션을 찾는 방법과 애플리케이션 자신의 배포로 설치하는 레시피를 선언한다. soksak은 애플리케이션의 코드를 배포하지 않으므로, 애플리케이션의 라이선스는 그 자신의 배포가 지킨다.

연결 plugin을 설치할 때 설치기가 기계를 조사한다: 이미 설치된 애플리케이션은 연결하고 그 위치를 기록하며 아무것도 설치하지 않는다. 그렇지 않으면 레시피가 설치한다. 연결 plugin은 애플리케이션을 보이는 plugin `appview`에 의존하므로, 그것을 설치하면 표면과 애플리케이션 sidecar가 함께 설치된다.

## 계약: plugin.json의 `application`

core는 plugin을 이름하지 않으므로 레시피는 manifest의 범용 필드다:

```json
"application": {
  "id": "<application id>",
  "name": "<name shown>",
  "version": "<version of the application>",
  "platforms": {
    "darwin-arm64": {
      "locate": [{ "bundle": "<bundle id>" }, { "command": "<name on PATH>" }, { "path": "<absolute path>" }],
      "recipe": { "kind": "release", "url": "<address>", "sha256": "<hash>", "unpack": "zip" },
      "program": "<executable inside the installed folder>",
      "arguments": []
    }
  }
}
```

- `locate`는 설치된 애플리케이션을 찾는 방법을 차례로 시도할 순서대로 나열한다: darwin의 metadata 색인으로 찾는 bundle identifier, windows와 linux의 플랫폼 애플리케이션 식별자, `PATH`의 이름, 또는 존재하고 실행할 수 있는 절대 경로.
- `recipe`는 `release`(애플리케이션 저장소의 release를 내려받아 SHA-256을 비교하고 `zip`, `tar.gz`를 풀거나 그대로 둔다), `package`(플랫폼의 표준 패키지 관리자 — `brew`, `winget`, `flatpak` — 에게 선언한 cask나 formula로 그 package가 있는지 묻고, 설치한 뒤 locate 항목으로 찾는다), `source`(저장소를 ref에서 애플리케이션의 폴더로 clone하고 거기서 그 저장소의 build 명령을 실행한다) 중 하나다.
- `program`과 `arguments`가 애플리케이션을 시작한다.

## 설치

1. plugin release를 푼 뒤, 설치기는 자기가 실행되는 플랫폼의 `application` 항목을 고른다. 항목이 없는 플랫폼은 `application <id> does not support <platform>`으로 실패하고 아무것도 바뀌지 않는다.
2. `locate` 항목을 차례로 시도한다. 하나가 애플리케이션을 찾으면 설치기는 그 위치와 찾은 방법을 기록하고 아무것도 설치하지 않는다.
3. 아무것도 찾지 못하면 설치기는 레시피를 `<config-dir>/applications/<id>/<version>/`에 실행한다. 각 단계(내려받기, hash, 풀기, 각 명령)는 event다. 실패한 단계는 그 단계와 출력을 이름하는 오류로 설치를 멈추고, `installed.json`은 바뀌지 않는다.
4. 결과는 `plugins/applications.json`(format 1)에 `{id, version, path, how, method}`로 기록되며, `how`는 `located`나 `installed`다. 연결 plugin을 제거하면 `how`가 `installed`인 애플리케이션을 지우고, 찾아서 연결한 애플리케이션은 건드리지 않는다.

## 표면

`appview` 카드는 설정 `program`이 무언가를 이름하면 그 프로그램을, 아니면 카드의 연결 plugin에 대해 `applications.json`이 기록한 애플리케이션을 그 인자와 함께 시작한다.

## 순서

각 단계는 먼저 명세를 갱신하고, 실패했다가(Red) 변경 뒤 통과하는(Green) 단위 시험, 영문·한글 체인지로그, 자기 커밋을 가진다.

1. 명세: plugin 명세의 `application` 필드, 설치 명세의 조사·설치·기록·제거 규칙과 `applications.json` 형식. `validateManifest`가 그 필드를 검사한다.
2. 조사: 두 `sok` 구현이 같은 결과로 `locate`(bundle, command, path)를 시도한다.
3. 레시피 `release`: 내려받기, SHA-256, 풀기, 실패한 설치의 되돌림.
4. 레시피 `package`와 `source`.
5. `applications.json`의 기록과 제거.
6. 애플리케이션의 plugin 작업이 같은 단계를 실행하고 진행을 보고한다.
7. `appview`가 기록된 애플리케이션을 시작한다.
8. embed kit 시험 애플리케이션의 release를 레시피로 가진 시험용 연결 plugin과, 그것을 설치하고(없으면 설치, 있으면 연결) 카드에서 시작해 관문을 실행하는 창 검사.
9. 예시 애플리케이션의 자기 배포가 embed 어댑터가 든 build를 주면, 그것의 연결 plugin.
