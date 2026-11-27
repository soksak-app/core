# Plugin 설치 형식

[English](installation.md)

다음은 plugin 설치가 쓰는 형식이다. [명령줄 `sok`](cli.ko.md)의 두 구현이 이 형식을 검증하며, host contract case `install.*`가 규칙마다 정한다([host contract](host-contract.ko.md)). 모든 검사는 알 수 없는 필드를 거부하고 틀린 필드를 밝힌다. 필드는 정해진 순서로 검사하므로, 오류가 여럿인 파일도 두 구현이 같은 오류를 보고한다. Version의 각 자리는 4294967295 이하다. [설치된 plugin 제공](#설치된-plugin-제공)은 host와 workbench가 이 plugin을 불러오는 방식을 정한다.

## Version과 범위

Version은 숫자 부분으로 된 `x.y.z`이며 앞자리 0을 쓰지 않고, 숫자로 비교한다. 범위는 다음 중 하나다.

| 범위 | Version |
| --- | --- |
| `*` | `>=0.0.0`: 모든 version |
| `x.y.z` | 그 version만 |
| `^x.y.z` | `x.y.z`부터 다음 major version 미만이며, major 자리가 0이면 다음 minor version 미만: `^1.2.3`은 `2.0.0` 미만, `^0.2.3`은 `0.3.0` 미만, `^0.0.2`는 `0.1.0` 미만. patch release는 `0.0`에서도 호환 release다 |
| `~x.y.z` | `x.y.z`부터 `x.(y+1).0` 미만 |
| `>=x.y.z` | `x.y.z`와 그 뒤의 모든 version |
| `>=x.y.z <a.b.c` | `x.y.z`부터 `a.b.c` 미만이며, 빈 범위는 거부한다 |
| `<range> \|\| <range>` | 부분들의 합집합: 한 부분이 포함하는 version은 범위 안이다. 각 부분은 위 형식 중 하나이며, 부분 사이는 `^0.0.39 \|\| ^0.1.0`처럼 정확히 공백 하나, 세로 막대 둘, 공백 하나로 잇는다 |

`latest`, `**`, pre-release 접미사 같은 다른 형식은 거부한다. 빈 부분이 있거나 `\|\|` 둘레의 공백이 다른 합집합도 거부한다.

## Core release identity

`@soksak/plugin-api`의 version은 plugin을 빌드할 때 쓴 core manifest와 설치 contract를 식별한다. 공개한 contract를 바꾸면 새 core version을 쓴다. 개발 checkout은 다른 contract에 immutable public release의 version을 재사용하지 않는다. Checkout은 다음 release candidate를 게시 전에 선언할 수 있지만, tag와 asset을 게시하기 전까지 그 candidate는 public release가 아니다. Plugin의 `engines.soksak` 범위는 이 core version으로 설치 대상을 고르므로, 하나의 version은 하나의 공개 contract를 식별한다.

## Plugin release

Plugin release는 plugin에 대해 `pnpm pack`이 쓰는 파일이다. Package `@<scope>/<name>`이면 `<scope>-<name>-<version>.tgz`다. 이것은 gzip tar이며, entry는 `package/package.json`과 `package.json`의 `files`가 적는 각 파일의 `package/<path>`다. 모든 entry가 `package/`로 시작하지 않는 release는 `<release>: entry <path> is outside package/`로 거부한다. 그 `package.json`은 다음을 선언한다.

| 필드 | 뜻 |
| --- | --- |
| `name` | 설치한 파일을 `/modules/<name>/`에서 제공하는 이름 |
| `version` | Plugin version |
| `engines.soksak` | Plugin이 지원하는 core API version 범위 |
| `files` | Release가 담는 plugin 안의 경로이며, `plugin.json`을 포함한다 |

`package.json`의 다른 필드는 package 도구의 것이므로 읽지 않는다. 다만 `soksak`은 거부한다. 플러그인의 sidecar와 그 범위는 `plugin.json`의 `dependencies`다([plugins](plugins.ko.md#pluginjson)).

plugin 저장소는 한 core release의 `@soksak/plugin-api`로 빌드한다. 그 `engines.soksak`은 모든 core version이 만족하는 `*`, 그 release와 그 뒤의 patch release가 만족하는 `@soksak/plugin-api`의 `^<version>`, 또는 그 core release와 이후의 모든 release가 만족하는, 하한이 그 version을 넘지 않는 `>=<x.y.z>`다. Core가 어떤 release에서 더한 manifest 필드를 쓰는 plugin은 그 release로 `>=`를 선언한다. 각 plugin 저장소는 자기 test에서 이를 검사한다.

`sok plugin install`은 `plugin.json`을 reader(`@soksak/plugin-api`)의 `validateManifest`의 모든 규칙으로, reader의 순서대로 검사하고, reader가 거부하는 manifest는 모두 거부한다. 이때 `plugin.json`의 위치와 reader의 오류 문구로 실패하며 아무것도 쓰지 않는다. 또한 page의 binary 저장소가 예약한 경로인 `.binary` segment 아래의 파일을 담은 release를 거부하며([네이티브 표면](native-surfaces.ko.md#문서-영역)), `plugin.json`이 불러오는 surface module이나 view page가 없는 release도 거부한다. Reader는 각 객체의 member를 정렬된 키 순서로 검사하며, install도 그렇게 검사한다. 그래서 거부되는 첫 member는 파일 안의 member 순서와 관계없이 같다. 사례표 `docs/spec/cases/manifest-validation.json`이 manifest와 결과를 나열한다. Reader와 두 `sok` 구현의 install이 이 표를 재생하며, 한 구현이라도 다르면 그 사례가 실패한다.

## Sidecar release

Sidecar version은 플랫폼마다 release 하나로 낸다. `<file name>-<version>-<platform>.tgz`다. 이것은 빌드한 sidecar 폴더에 대해 `npm pack`이 쓰는 파일이다. Entry는 `package/package.json`과 `package.json`의 `files`가 적는 각 파일의 `package/<path>`이며, 파일마다 mode를 담은 gzip tar다. `pnpm pack`은 파일의 실행 비트를 보존하지 않으므로, sidecar release는 `npm pack`으로 쓴다. 모든 entry가 `package/`로 시작하지 않는 release는 `<release>: entry <path> is outside package/`로 거부한다. `sidecar.json`이 지정한 `executable`이나 `replay.executable`을 담지 않은 release는 `<release>: sidecar.json: <field> <path> is not in the release`로 거부한다. Sidecar `@scope/name`의 file name은 `scope-name`이며, scope가 없는 이름은 그대로 쓴다. 플랫폼은 `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-arm64`, `windows-x64` 가운데 하나다. 이 검사 밖에서 installer는 sidecar release를 풀고 실행하기 전에 registry 항목의 `sha256`으로만 검사한다. 제3자가 만든 것을 포함해, sidecar는 애플리케이션이 서명하거나 다른 방법으로 검토하지 않는다.

## Registry index

Registry index `index.json`은 `format` 3과 다음 목록을 가진다.

| 필드 | 항목 |
| --- | --- |
| `plugins` | `{ id, package, name, description, license, repository, maker, categories, updated, versions }`. `maker`와 `categories`는 가장 새로 나열된 version의 `plugin.json`의 `maker`와 `categories`이고, `updated`는 그 version을 처음 나열한 build의 UTC 날짜(`YYYY-MM-DD`)다. 각 version은 `{ version, release: { url, sha256 }, engines: { soksak }, sidecars, plugins }`이다. `sidecars`는 그 version의 `plugin.json`의 sidecar 의존을 범위에 대응시키고, `plugins`는 plugin 의존을 범위에 대응시킨다. 의존이 없으면 각각 `{}`다 |
| `sidecars` | `{ name, repository, versions }`. 각 version은 `{ version, protocol: 1, releases }`이며, `releases`는 플랫폼마다 `{ url, sha256 }`을 정한다 |
| `core` | 선택 항목이다. 없는 index는 core release를 나열하지 않는다. `{ versions }`이며, 각 version은 `{ version, releases }`다. `releases`는 `<platform>-<host>`마다 `{ url, sha256 }`을 정한다. 이것은 그 플랫폼과 host(`wailsv3`, `tauriv2` 또는 `mygo`)의 애플리케이션 번들 zip이다. 예: `darwin-arm64-wailsv3`([애플리케이션 업데이트](#애플리케이션-업데이트)) |
| `packs` | `{ name, description, plugins }`: 함께 설치하는 plugin id |
| `revoked` | `{ plugins: [{ id, version, reason }], sidecars: [{ name, version, reason }], core: [{ version, reason }] }` |

`url`은 게시된 release의 `https:` URL이거나 로컬 release의 절대 `file:` URL이다([받기](#받기)). `sha256`은 소문자 16진수 64자리다. 설명은 1자에서 200자(Unicode code point)다. Index 검사는 이 밖에도 plugin id, package, sidecar, pack, version의 중복을 거부한다. 알 수 없는 plugin을 가리키는 pack, 알 수 없는 sidecar를 가리키는 plugin version, 어떤 sidecar version도 채우지 않는 범위가 필요한 plugin version을 거부한다. 목록에 없는 revoked version도 거부한다. `sok registry build`는 각 plugin의 `plugin.json`도 읽는다. 의존이 목록의 plugin도 목록의 sidecar도 가리키지 않거나, plugin 의존의 범위를 채우는 목록의 version이 없으면 실패한다. 이월된 version은 기록된 `plugins`와 `sidecars`를 유지하며, 같은 검사로 판정된다([build](registry.ko.md#build)). `format`이 3이 아니거나, plugin 항목에 `maker`, `categories`, `updated`가 없거나, plugin version에 `plugins`가 없는 index는 index와 발견한 내용을 밝힌 오류로 거부한다.

## 애플리케이션 업데이트

애플리케이션 업데이트는 실행 중인 애플리케이션의 번들을 더 새로운 core release의 번들로 바꾼다. Registry index는 `core`에 core release를 나열하며, `revoked.core`는 version을 철회한다.

후보는 `core`에서 실행 중인 core보다 새롭고, `revoked.core`에 없으며, 실행 중인 애플리케이션의 `<platform>-<host>` release를 가진 가장 새 version이다. 애플리케이션은 plugin과 마찬가지로 시작할 때와 창이 활성이 될 때 index를 읽는다([plugin 상태와 명령](#plugin-상태와-명령)).

| Host 호출 | 뜻 |
| --- | --- |
| `appUpdateState()` | `{ version, available }`을 돌려준다. `version`은 실행 중인 core의 version이고, `available`은 후보의 `{ version, release: { url, sha256 } }` 또는 `null`이다. Index의 오류로 거부한다 |
| `appUpdateStage({ version })` | 후보 `version`의 release를 받고 `sha256`을 검사한다. `<config-dir>/updates/<version>/`을 지운 뒤 `ditto -x -k`로 그 안에 zip을 풀고, `Contents/Info.plist`의 `CFBundleShortVersionString`이 `version`인 `<name>.app` 하나를 담았는지 확인한다. 그리고 그 번들의 경로 `{ bundle }`을 돌려준다. 실패하면 단계를 밝힌 메시지로 거부한다 |
| `appUpdateApply({ bundle })` | 실행 중인 애플리케이션의 `sok` 실행 파일을 `<config-dir>/updates/sok`에 복사한다. `sok app update --wait <pid> --bundle <bundle> --target <running bundle>`을 새 세션에서 시작하며, 애플리케이션의 표준 오류와 event `host.update.start`([logging](logging.ko.md#입구))를 쓴다. 그 뒤 `host.quit`처럼 애플리케이션을 종료한다. 이 종료는 상주 service와 그 세션을 계속 실행한다 |

`sok app update --wait <pid> --bundle <path> --target <path> [-- <argument>...]`는 프로세스 `<pid>`가 끝날 때까지 기다린다. 그리고 `<target>`을 `<target>.previous`로 옮기고, `<bundle>`을 `<target>`으로 옮기고, `<target>.previous`를 지운 뒤, `--` 뒤의 인자로 `<target>`을 시작한다. `<target>`을 옮긴 뒤 한 단계가 실패하면 `<target>.previous`를 되돌리고 그 번들을 시작한 뒤, 그 단계의 메시지로 실패한다.

`core.app.update`는 macOS가 App Translocation용으로 만든 폴더에서 실행되는 executable을, `appUpdateStage`가 내려받기 전과 `appUpdateApply`가 `sok`을 복사하거나 종료를 요청하기 전에 거절한다. Host는 setup이 쓰는 경로 규칙([애플리케이션 안의 agent](cli.md#agents-in-the-application))으로 그 폴더를 찾는다. executable 경로에 폴더 요소 `/AppTranslocation/`이 있으면 translocated로 본다. 거절은 오류 `application update: <executable path> runs from a translocated location of macOS, so the application bundle must be moved out of quarantine and started again`이며, `<config-dir>/updates/` 아래 파일을 만들지 않고 종료를 요청하지 않으므로 애플리케이션은 계속 실행된다.

설정 탭의 설치됨 페이지는 업데이트 목록 맨 위에 core 업데이트를 `core: <running> → <available>`로 나열한다. 그 version의 release 페이지 링크와 업데이트 동작(`core.app.update` 실행)도 함께 보인다. Release 페이지는 release URL `https://<host>/<owner>/<repository>/releases/download/<tag>/<file>`에서 `https://<host>/<owner>/<repository>/releases/tag/<tag>`로 얻는다. 다른 형태의 release URL은 release 페이지가 없으므로 행에 링크가 없다. 링크는 `core.app.release`를 실행하며, 이 명령은 페이지를 기본 애플리케이션으로 연다. `core.app.update`는 `appUpdateStage`, `appUpdateApply` 순으로 실행한다. Status `core.app`은 동작을 `staging`, `applying`, `failed`로 보고하며, 실패한 경우 version과 실패한 단계의 오류를 함께 보고한다. 행은 그 단계와 오류를 보여 준다. 창은 시작할 때, 활성이 될 때, registry가 바뀔 때, 설치됨 페이지를 열 때 후보를 읽는다. 설치된 version의 `engines.soksak`이 후보를 포함하지 않는 설치된 plugin은 업데이트 전에 행 아래에 `<id> <installed> (<range>)`로 나열한다. 그 plugin의 가장 새 version 가운데 범위가 후보를 포함하고 철회되지 않은 것을 함께 보인다. 그런 version이 없으면 없다는 표시를 보인다. 설치된 version을 index가 나열하지 않는 plugin은 판단하지 않는다. Status `core.app`은 이 목록을 `incompatible`로 담는다.


## 받기

Registry index와 release는 위치에서 읽는다. 위치는 `https:` URL, 절대 `file:` URL, 또는 명령이 경로를 받는 곳에서는 파일 경로다. 그 밖의 URL은 `<url>: the URL must be https: or an absolute file: URL`로 실패한다. `https:` URL은 다음 규칙으로 읽으며, 두 구현은 같은 문장으로 이 규칙을 따른다.

- 연결은 운영체제가 신뢰하는 인증 기관으로 TLS를 쓴다.
- Redirect는 대상이 `https:` URL일 때 최대 5번 따라간다. 다른 scheme으로의 redirect는 `<url>: redirect to <target> is not https`로, 여섯 번째 redirect는 `<url>: more than 5 redirects`로 실패한다.
- 200이 아닌 응답은 `<url>: HTTP <status>`로 실패한다. 단, 조건부 index 요청(아래)에 대한 304 응답은 예외다.
- 연결부터 마지막 byte까지 한 요청은 index에 60초, release에 600초 안에 끝나야 한다. 더 느린 요청은 `<url>: timed out after <seconds> s`로 실패한다. 그 밖의 요청은 자기 event에서 끝난다. 곧 응답의 마지막 byte, 연결의 오류, 또는 연결 닫힘이다. 연결을 열어 둔 채 아무것도 보내지 않는 server는 event를 주지 않으며, TCP는 그런 peer의 끝을 알리지 않는다. 그래서 이 한도가 server가 끝내지 않는 요청의 끝이다.
- Index는 최대 8 MiB, release는 최대 256 MiB다. 더 큰 본문은 `<url>: larger than <bytes> bytes`로 실패한다.
- 연결하거나 읽지 못하면 `<url>: cannot connect: <reason>`으로 실패하며, reason은 network 라이브러리의 문장이다.

한 process는 모든 `https:` 위치를 HTTP client 하나로 읽는다. 이 client는 요청 사이에 연결을 열어 두므로, 첫 읽기 뒤의 읽기는 다시 연결하고 TLS를 협상하지 않는다. 디스크에는 아무것도 쓰지 않는다. 각 명령과 각 plugin 작업은 필요한 index와 release를 다시 읽으며, release는 풀기 전에 `sha256`과 비교한다. 애플리케이션은 창이 활성화될 때마다 index를 읽는다([plugin 작업](#애플리케이션-안의-plugin-작업)). 그래서 바뀌지 않은 index를 찾는 읽기는 본문을 전송하지 않는다.

- Process는 index URL마다 마지막 200 응답의 본문을 그 `ETag`, `Last-Modified` header와 함께 memory에 둔다. 응답에 둘 중 하나가 있을 때다. 그 URL의 다음 요청은 이것을 `If-None-Match`, `If-Modified-Since`로 보낸다. 304 응답은 둔 본문을 주며, 이 본문은 index로 다시 검사한다. 200 응답은 둔 본문을 바꾸며, 두 header가 모두 없는 응답은 아무것도 두지 않는다. Validator를 보내지 않은 요청에 대한 304 응답은 `<url>: HTTP 304`로 실패한다.
- 같은 URL의 읽기가 진행 중일 때 시작한 index URL 읽기는 그 읽기의 결과를 받으며 요청을 보내지 않는다. 그래서 창이 활성화될 때 읽는 plugin 상태와 애플리케이션 업데이트 상태는 요청 하나를 나눈다.
- Release는 두지 않는다. Release는 설치마다 한 번 읽고 `sha256`과 비교하기 때문이다.

## Version 선택

Core version과 플랫폼에 맞춰 plugin을 설치하면, `engines.soksak`이 core version을 포함하고 revoked가 아닌 가장 새 plugin version을 고른다. 한 설치에서 sidecar는 version 하나이며, 그 sidecar를 지정한 설치된 plugin이 모두 함께 쓴다. 고른 plugin version의 sidecar마다 범위는 그 version의 범위와, 그 sidecar를 지정한 다른 설치된 plugin의 범위다. 쓰고 있는 version이 모든 범위를 채우고 revoked가 아니며 그 플랫폼 release가 있으면 그대로 둔다. 아니면 모든 범위를 채우고 revoked가 아니며 그 플랫폼 release가 있는 가장 새 sidecar version을 고른다. 고를 것이 없으면 설치는 plugin, version이나 범위, core version이나 플랫폼을 밝혀 실패한다. Sidecar의 경우에는 각 plugin과 범위를 밝힌다.

고른 version의 `plugin.json` 의존 가운데 index의 plugin을 가리키는 것은 plugin 의존이다. 설치는 아무것도 풀기 전에 받은 release에서 `plugin.json`을 읽는다. Plugin을 설치하면 각 plugin 의존을 같은 규칙으로 재귀적으로 설치한다. 설치된 제공자의 version이 그것을 가리키는 모든 설치된 plugin의 범위를 채우면 그대로 둔다. 아니면 모든 범위, `engines.soksak`, revoked 규칙을 채우는 가장 새 제공자 version을 고른다. 설치되었지만 켜지지 않은 제공자는 켠다. Index의 plugin도 sidecar도 가리키지 않는 의존은 `<plugin> <version>: dependency <package> is neither a plugin nor a sidecar of the registry`로 실패한다. 순환은 `plugin dependency cycle: <id> -> <id> -> <id>`로 실패한다. `sok plugin update`는 제공자를 가리키는 모든 설치된 plugin의 범위를 채우는 제공자 version만 고른다. 켜진 설치 plugin이 그 package를 가리키면 `sok plugin remove`와 `sok plugin disable`은 `plugin <id> is required by <dependent> <range>`로 실패한다. 이때 `installed.json`과 폴더는 바뀌지 않는다.

## 설치 배치

설정 폴더 안에서 `<id>`의 plugin version `<version>`은 `plugins/<id>/<version>`에 풀고, sidecar version의 플랫폼 release는 `sidecars/<file name>/<version>/<platform>`에 푼다. 설치는 이미 있는 version 폴더를 그 version으로 읽는다. 그래서 `plugins/installed.json`을 쓰기 전에 거부되거나 멈춘 설치는 자기가 푼 각 version 폴더를 지운다.

`plugins/installed.json`은 `format` 3, `plugins`, `sidecars`를 가진다. `plugins`는 plugin id마다 `{ version, path, enabled, sidecars }`를 정한다. 각각 쓰는 version, 설치가 그 version을 푼 폴더 `plugins/<id>/<version>`, 불러올지 여부, 그 version의 sidecar 범위다. 이전 version을 복원하는 operation이 없으므로, 설치는 쓰는 version의 폴더만 남긴다. Plugin의 이름은 기록된 `path`의 `package.json`의 `name`이며, host와 `sok`은 거기서 읽는다. `installed.json`은 이름을 담지 않는다. `sidecars`는 설치된 plugin이 지정한 sidecar마다 `{ version, path }`를 정한다. 쓰는 version은 그 sidecar를 지정한 모든 설치된 plugin의 범위를 채운다. `path`는 설치가 그 플랫폼 release를 푼 폴더 `sidecars/<file name>/<version>/<platform>`이다. 어느 설치된 plugin도 지정하지 않은 sidecar는 목록에 나오지 않는다. 각 `path`는 설정 폴더에 대한 상대 경로이며, 이 규칙이 정하는 폴더와 같아야 한다. 그래서 설정 폴더를 옮길 수 있다([projects](projects.ko.md#저장)). 설치는 release를 풀 때 각 `path`를 기록한다. Host와 `sok`은 기록된 경로에서만 파일을 읽으며, 그 경로는 설정 폴더에 대해 풀어서 쓴다.

`format`이 3이 아닌 파일은 `<file>: plugins/installed.json: format must be 3`로 실패한다. 현재 형식의 파일이지만 plugin이 `package` 필드를 가지면 `<file>: plugins/installed.json <id>: unknown field package`로 실패한다. Plugin이 `previous` 필드를 가지면 `<file>: plugins/installed.json <id>: unknown field previous`로 실패한다. 이때 파일은 바뀌지 않는다. Format 2 파일도 같은 방식으로 같은 오류 문구로 거부된다([저장 데이터 형식](#저장-데이터-형식)). `plugin.json`의 `id`가 설치 기록의 id와 다른 release는 아무것도 풀기 전에 거부한다. 설치는 `plugin.json id <a> differs from the installed plugin <b>`로 실패하며 아무것도 쓰지 않는다. `plugins/installed.json`을 읽을 때도, 기록된 폴더의 `plugin.json`이 다른 id를 밝히면 같은 문구로 실패한다. `plugins/installed.json`이 없는 설정 폴더에는 아무것도 설치되어 있지 않다. 이 파일은 첫 설치가 쓰기 전까지 없다. 그래서 설치된 sidecar를 읽는 쪽은 아무것도 읽지 않으며, 파싱되지 않는 파일은 오류다.

## 저장 데이터 형식

계약의 저장 파일은 각자 표가 이름하는 member에 자기 형식을 싣는다. Reader는 자기 파일의 현재 번호만 받는다. Member가 다른 번호를 담고 있거나 member가 없는 파일은 `<file>: <name>: format must be <n>`으로 실패한다. 여기서 `<file>`은 파일의 경로, `<name>`은 표의 이름, `<n>`은 현재 번호다. 이때 파일은 바뀌지 않는다. 거부된 파일은 애플리케이션의 시작을 막지 않는다. 시작은 그 파일을 빼고 오류를 보인다. 예를 들어 거부된 `plugins/installed.json`은 plugin을 설치하지 않으며, 거부된 `projects.json`이나 `settings.json`은 workspace snapshot에서 보고된다([projects](projects.ko.md#설정)). 거부된 파일에 쓰는 모든 동작은 그 오류로 실패한다. 파싱되지 않는 파일은 그 파일을 밝히는 오류로 실패한다. 저장 파일의 형태를 바꾸는 release는 그 파일의 형식 번호를 올리고, 변경을 changelog에 기록한다. 0.0.x release version인 동안 그런 release는 마이그레이션을 싣지 않는다. 정의를 데이터로도 코드로도 싣지 않으며, 어떤 reader도 이전 형태를 변환하지 않는다. 폴더를 옮기거나 파일을 넘나드는 변경은 replacement change다. 그 release가 문서화하며, 재설치가 수행한다.

계약의 저장 파일과 그 소유자, 형식 번호를 싣는 member, 파일 class는 다음과 같다.

| File | 소유자 | 번호 | file class |
| --- | --- | --- | --- |
| `plugins/installed.json` | 코어 | `format` | numbered |
| `plugins/starter.json` | 코어 | `format` | numbered |
| `plugins/registry.json` | 코어 | `format` | numbered |
| `log-policy.json` | 코어 | `schema` | numbered |
| `settings.json`, `<project root>/.soksak/settings.json` | 코어 | `format` | numbered |
| [사용자 `agent-setup.json`](cli.ko.md#사용자-path-등록) | 코어 | `format` | numbered |
| `projects.json` | 코어 | `format` | numbered |
| `plugin-data.json` | 코어 | `format` | numbered |
| `tab-state.json` | 코어 | `format` | numbered |
| `tab-sessions/<tab>.json` | 코어 | `format` | numbered |
| `roles.json` | 코어 | `format` | numbered |
| `agents/<surface>/role.md`, `agents/<surface>/identity.txt` | 코어 | host가 launch와 역할 변경마다 다시 쓴다 | transient |
| `logs/<role>-<boot>.jsonl`과 그 색인 | 코어 | 파일마다(`log.open`, 색인 머리) | log |
| `endpoint.json`, `process.lock`, `performance` | 코어 | 실행마다 다시 쓴다 | transient |
| `plugins/<id>/<version>/`, `sidecars/<file name>/`, `updates/` | release 내용 | 경로의 version | external |
| `services/<name>/` | sidecar | sidecar가 정한다 | external |
| 가져온 registry index | registry | 그 `format` | fetched |

모든 reader는 각 계약 파일의 공유 reader 입구에서 파일을 읽을 때 member를 검사한다. 그래서 모든 process의 모든 reader는, 즉 시작 때와 그 뒤의 모든 읽기에서의 host, 그 파일을 읽는 모든 `sok` 입구는 현재가 아닌 형태를 거부한다. Reader는 없는 파일을 만들지 않는다. 없는 파일은 현재 형식의 빈 상태다. 각 writer는 현재 형태만 쓴다.

Plugin은 설정 폴더의 저장 파일을 소유하지 않는다. Plugin이 남기는 값은 `projects.json`의 key로, plugin 전용 key는 `plugin-data.json`의 key로 저장된다. 그 per-key 형식은 [프로젝트 데이터](plugins.ko.md#프로젝트-데이터) 검사가 읽는다. Plugin이 쓰는 탭 상태는 코어가 소유하는 `tab-state.json`에 산다. 형식은 plugin이 `surface.unload`에 선언한 대로다([메모리 절약](plugins.ko.md#메모리-절약)). Sidecar는 자기 `services/<name>/` 트리의 파일을 소유하며 그 형태를 스스로 정한다. 공개된 plugin과 settings section의 식별자는 한 번 공개되면 바꾸지 않는다. 이름을 바꾸면 저장된 참조가 해석되지 않는다.

## 설치된 plugin 제공

두 host는 설정 폴더에서 다음 경로를 제공하며, 요청마다 `plugins/installed.json`을 읽는다. 그래서 변경 뒤에 불러온 page는 그 변경을 본다. 애플리케이션 frontend가 가진 `/modules/` 아래 파일은 이 경로에 들지 않는다. Frontend가 그 파일을 제공하며, 그 요청은 설치에서 아무것도 읽지 않는다. 그래서 어떤 plugin도 core 파일을 대신하지 않는다. 그 밖의 `/modules/` 아래 요청은 켜진 plugin의 `package.json`을 id 순서로, 자기 package의 plugin까지 읽는다. 읽을 수 없는 `package.json`은 어떤 package도 가리키지 않으며, 그 오류는 `/installed-plugins.json`이 담는다. `/modules/`나 `/shared/` 아래 요청은 자기가 가리키는 plugin의 `plugin.json`만 읽으며, 다른 plugin의 것은 읽지 않는다.

| 경로 | 내용 |
| --- | --- |
| `/installed-plugins.json` | `{ "plugins": [{ id, package, version, folder, manifest, sidecars?, diagnostics? }] }`. `installed.json`의 켜진 plugin을 id 순서로 담는다. `folder`는 설정 폴더 안의 기록된 `path`의 절대 경로이고, `manifest`는 설치된 `plugin.json`의 내용이다. `sidecars`는 plugin의 sidecar 의존마다, sidecar 이름 아래 그 sidecar의 `sidecar.json`의 `message` 필드를 담는다. Sidecar 의존이 없는 plugin에는 `sidecars`가 없다. 진단 build에서 `diagnostics`는 설치된 package가 `diagnostics.json`을 담을 때 그 내용이다. Release build는 이를 보내지 않는다. `installed.json`이 없으면 `{ "plugins": [] }`다. `installed.json`, `plugin.json`, `diagnostics.json`을 읽거나 검사할 수 없으면 문서는 `{ "error": "<message>" }`다 |
| `/modules/<package>/<path>` | 애플리케이션 frontend가 가진 파일은 frontend에서 온다. 그 밖에 켜진 설치 plugin의 package는 그 plugin의 기록된 `path` 안의 `<path>` 파일이다. 빈 segment, `.`, `..`가 있는 경로나 없는 파일은 찾을 수 없다. 다른 package는 애플리케이션 frontend에서 온다 |
| `/shared/<plugin id>.<point>/<specifier>.js` | 켜진 설치 plugin `<plugin id>`의 `extends.<point>.modules`가 `<specifier>`에 대응시킨 파일로, 그 plugin의 기록된 `path` 안에 있다. 제공자는 연결된 contributor가 없어도 자기가 선언한 module을 읽을 수 있다. 다른 page는 item range가 provider point의 version을 포함해야 한다. `.js`로 끝나지 않는 경로, 켜진 plugin이 선언하지 않은 point, point가 대응시키지 않은 specifier, 없는 파일은 찾을 수 없다 |

Workbench는 `/installed-plugins.json`을 JSON module로 가져오며, 받아들인 각 plugin을 `manifest`로 등록한다. Workbench가 entry나 manifest를 거부한 plugin은 빠지며, 그 오류는 애플리케이션 로그에 쓰는 오류 표시로 보인다. 거부된 manifest는 `installed plugin <id> <version> (<package>): <reason>`으로 보인다. `error` 문서는 plugin을 등록하지 않은 채 `installed plugins: <error>`로 보인다. 다른 plugin과 page는 시작하며, page는 준비되었다고 보고한다. 빠진 plugin의 tab은 불러오지 않은 plugin의 placeholder로 열린다. `plugins/installed.json`을 읽을 수 없으면 host는 `/installed-plugins.json`을 `error` 문서로 제공한다. 설치된 plugin을 가리킬 수 없으므로, host는 `/modules/` 아래 모든 경로를 bundled frontend에서 제공한다. Core module이 불러와지고 page가 시작한다. 다른 형식의 문서나, 받아들인 plugin 둘이 같은 id나 package를 가진 문서는 host의 오류다. Main page는 plugin을 등록하기 전에 오류 표시를 설치하고 창 버튼 영역을 비운다. 그래서 그런 문서는 그 오류를 보이고 애플리케이션 로그에 쓴 채 page 시작을 멈춘다. Page는 준비되었다고 보고하지 않으며, `host.window.reload`가 다시 시작한다. Plugin의 staged page는 받아들인 plugin 가운데에서 자기 plugin을 찾는다. 그래서 다른 plugin의 거부가 그 page를 멈추지 않는다. 자기 plugin이 거부되면 그 오류가 거부 내용을 밝힌다.

Host는 시작할 때 켜진 설치 plugin의 `plugin.json` `dependencies`가 지정한 sidecar를, 설치된 plugin의 package는 빼고 이름 순서로 읽는다. Sidecar는 `installed.json`이 그것에 기록한 `path`에서 실행되며, 실행 파일은 그 폴더의 `sidecar.json`의 `executable` 경로다. 애플리케이션이 실행 중에 설치하거나 켠 plugin은 변경 뒤에 불러온 page에 제공된다. 성공한 `pluginsRun` install, update, enable은, 켜진 설치 plugin의 sidecar 가운데 host가 아직 선언하지 않은 것을 선언한다. 그래서 그 뒤에 불러온 page, 예를 들어 첫 실행이 다시 불러온 page는 그 sidecar를 시작한다. Host는 `pluginsRun` 작업마다, 이미 선언한 sidecar에 변경을 [변경 적용](#변경-적용)대로 적용한다.

## 애플리케이션 안의 plugin 작업

두 host는 각자 명령줄의 installer 라이브러리(`packages/sok`)로 plugin 작업을 실행한다. 그래서 애플리케이션 안의 작업과 같은 `sok plugin` 명령은 설정 폴더를 똑같이 바꾼다. Runtime adapter는 다음 host 호출과 event를 제공한다.

| Host 호출 또는 event | 의미 |
| --- | --- |
| `pluginsState()` | `{ core, registry, index, installed, firstRun, starter, held }`를 돌려준다. `core`는 실행 중인 core의 version이며 설치는 이것으로 plugin version을 고른다. 기존 필드는 뜻을 유지한다. `held`는 각 plugin의 마지막 보류된 작업([persistent services](persistent-services.ko.md#updates))을 plugin 순으로 `{plugin, action, version, error, sidecars: [{sidecar, planned, running, sessions}]}`로 나열한다. `version`은 계획한 plugin version, `error`는 보류된 작업의 오류, `sessions`는 `outdated`가 세는 방식으로 센 service의 `sessions` 수다. Layout의 첫 목록 전에는 `null`이다. `starter`는 starter job이 없으면 `null`이고, 있으면 현재 `{ format: 1, state, pack, registry, plugins }` job이다. 상태 파일을 읽지 못하면 경로와 메시지를 포함해 호출을 거부한다 |
| `pluginsStarter({ state, pack, registry, plugins })` | `installed.json`이 없을 때만 `state: "pending"`인 starter job을 만든다. 또는 모든 plugin이 설치된 뒤, 정확히 일치하는 pending job을 `complete`로 바꾼다. 요청한 registry URL은 설정된 registry와 같아야 한다. 기존 job은 같은 pack, registry, 순서가 같은 plugin 목록만 허용한다. 다른 전이는 두 상태 파일을 바꾸지 않고 거부한다. 같은 pending이나 complete 전이를 반복하면 결과가 같다. Complete job을 pending으로 되돌릴 수 없다. Complete는 나열된 plugin이 모두 `installed.json`에 있어야 하며, enabled 여부는 요구하지 않는다. Host는 이 호출을 다른 plugin 작업과 직렬화하며, 파일은 원자적으로 교체한다. 쓰기가 실패하면 호출자는 job의 시작이나 완료를 진행하지 않는다 |
| `pluginsRun({ action, plugin, end? })` | Plugin id에 대해 `install`, `update`, `remove`, `enable`, `disable`을 애플리케이션의 core version과 platform으로 실행하고, 같은 `sok plugin` 명령의 출력을 돌려준다. `end: true`는 보류된 `install`, `update`, `enable`을 실행하고, 그 작업을 보류시킨 service를 끝낸다([persistent services](persistent-services.ko.md#updates)). 그 밖의 경우 `end`는 없다. 다른 `action`, 비어 있지 않은 문자열이 아닌 plugin id, `true`가 아닌 `end`는 아무것도 바꾸지 않고 호출을 거부한다. 실패한 작업은 같은 명령의 message로 호출을 거부하며, `installed.json`은 그 명령이 정한 대로 남는다 |
| `pluginsUseRegistry({ index })` | `sok registry use <index>`처럼 registry index를 정하고, 그 출력 `{ index }`를 돌려준다. 비어 있지 않은 문자열이 아닌 `index`는 `index must be a non-empty string`으로 거부한다 |
| `plugins-changed` | `pluginsRun`이 `installed.json`을 바꾼 뒤 모든 창에 `{ action, plugin }`과 함께 보낸다 |
| `window-active` | 창이 key window가 될 때마다 그 창에 보낸다. 원격 registry는 변경 event를 보내지 않으므로, 설정 탭은 plugin 상태와 애플리케이션 업데이트를 다시 읽는다. 창이 이미 보이는 상태와 failure를 찾은 읽기는 아무것도 그리지 않는다. 그래서 key window가 바뀌어도 그 때문에 다시 그려지는 창은 없다 |
| `sidecarsOutdated()` | `host.sidecars`의 `outdated` 목록 `[{sidecar, running, installed, sessions, surfaces}]`을 sidecar 순으로 돌려준다([persistent services](persistent-services.ko.md#updates)) |
| `sidecarsReplace({ sidecar })` | [persistent services](persistent-services.ko.md#updates)가 정한 대로 sidecar의 오래된 상주 service를 교체한다. 다른 version의 service가 실행 중이 아니면 그 sidecar를 밝히는 오류로 거부한다 |
| `sidecars-changed` | `host.sidecars`가 바뀌면 모든 창에 값 없이 보낸다 |

Host는 작업을 한 번에 하나만 실행한다. 다른 작업이 실행 중일 때 `pluginsRun`을 호출하면 `another plugin operation is running`으로 거부한다. `sok` 명령줄의 쓰기 명령은 쓰는 동안 `process.lock`으로 설정 폴더를 소유한다([저장 데이터 형식](#저장-데이터-형식)). 실행 중인 host 옆의 명령은 host의 소유 오류로 거부되며, 두 명령이 경쟁할 수 없다. 애플리케이션의 plugin 작업은 host의 소유 안에서 실행되며, 자기 lock을 잡지 않는다. Host는 `sok` process가 만든 변경을 관측하지 않는다. 다음 `pluginsState` 호출과 나중에 불러온 page가 그 변경을 읽는다. `pluginsRun` 작업의 변경은 [변경 적용](#변경-적용)대로 바로 적용된다. `sok` process가 만든 변경은 나중에 불러온 page에 적용되며, sidecar에는 애플리케이션이 시작할 때 적용된다. Browser 애플리케이션에는 host가 없으므로 plugin 작업이 없다.

### 변경 적용

`pluginsRun` 작업이 성공하면 host는 호출에 답하고 `plugins-changed`를 보내기 전에, 그 변경을 자기 sidecar에 적용한다.

- 켜진 설치 plugin이 지정한 sidecar를 `installed.json`이 기록한 폴더로 선언한다. 기록된 폴더가 바뀐 표준 입출력 sidecar는 교체된다. Host는 실행 중인 process를 [sidecar](sidecars.ko.md#선언과-시작)의 중지 규칙대로 멈추며, 다음 send가 새 폴더의 실행 파일을 시작한다. 켜진 설치 plugin이 더 이상 지정하지 않는 sidecar는 멈추고 선언에서 빠진다. 그래서 그 sidecar로의 send는 선언되지 않은 sidecar로의 send처럼 실패한다.
- 실행 중인 service의 version이 `installed.json`의 기록과 다른 persistent sidecar는 [persistent services](persistent-services.ko.md#updates)대로 보고하고 교체한다. Live service가 있는 sidecar에 다른 version을 주게 될 install, update, enable은 무엇이든 쓰기 전에 보류된다. 그래서 어떤 작업도 그런 service를 만들지 않는다([plugin 작업](persistent-services.ko.md#updates)).

`plugins-changed`를 받은 창은 워크벤치를 저장된 상태에서 다시 시작한다. 그래서 `installed.json`이 나열한 plugin을 불러오며, 새 시작은 창 주소의 project를 보인다. 주소는 창이 보이는 project를 담는다. 창이 프로젝트 홈을 보이는 동안에는 보일 project 대신 `library=<id>`를 담는다. 이 id는 창이 가진 project이며, 프로젝트 홈이 돌아갈 project다. 그래서 프로젝트 홈에 있던 창은 프로젝트 홈에 머문다. 그 작업 화면으로 돌아가기는, 어떤 창이 그 project를 열고 있는 동안 시작에서 그 project를 그리지 않고 활성화한다. 메인 페이지가 있는 host는 host 호출 `pageReload`로 그 페이지를 다시 불러오며([page 다시 읽기](native-host.ko.md#page-다시-읽기)), mygo host는 native 워크벤치를 다시 만든다. 새 시작 전에 창의 수정된 탭마다 묻는다. 탭에서 선택 layer `<name> 탭에 저장하지 않은 변경이 있습니다`를 띄운다. 저장하고 적용(`surface.save`가 있을 때만)은 저장 명령을 실행하며, 탭이 더 이상 수정되지 않았으면 계속한다. 저장하지 않고 적용은 계속하며 새 시작과 함께 변경을 버린다. 적용하지 않기나 layer 닫기는 그 창의 워크벤치를 유지한다. 실패한 저장은 탭을 닫을 때처럼([plugins](plugins.ko.md)) 그 오류를 탭의 오류로 보고하며, 워크벤치를 유지한다. 유지된 워크벤치에서는 그 창의 plugin이 불러온 그대로 남는다. 바뀐 plugin의 카드는 `core.plugins.apply`가 같은 질문을 거친 뒤 워크벤치를 다시 시작할 때까지 상태 `reload`를 보인다. `core.plugins.apply`는 새 시작 전에 `{reloaded}`로 답한다. mygo 워크벤치는 apply가 다시 시작하기로 정하기 전에 전달된 요청의 응답을, `core.plugins.apply`의 응답을 포함해, host가 모두 받은 뒤 다시 시작한다. 그 뒤에 전달된 요청은 시작을 늦추지 않으며, 시작은 그 요청을 1003으로 끝낸다([page 끝](hosts.ko.md#프로세스-생명주기)). 새 시작이 실패한 창은 그 오류를 오류 표시로 보인다. 워크벤치는 project를 초기화한 뒤에만 `plugins-changed`를 따른다. Apply가 project를 저장하기 때문이다. 워크벤치는 먼저 구독하고, 그 뒤 plugin 상태를 한 번 읽는다. 설치된 plugin이 불러온 plugin과 다르면 변경을 적용한다. 그래서 구독 전에 생긴 변경도 적용되며, 이후의 변경은 event를 보낸다. Apply는 한 번에 하나만 실행된다. 실행 중인 apply 동안 event가 오면 apply를 하나 더 예약한다. 그 apply는 앞의 apply가 끝난 뒤 상태를 다시 읽고 실행된다. 그래서 더 새로운 변경을, 앞의 상태를 읽은 apply가 맡지 않는다.

### 시작 때 업데이트

Host가 시작할 때마다 registry index를 읽은 뒤 한 번, 실행 중인 core가 설치된 그대로는 쓸 수 없는 설치 plugin을 업데이트한다. 설치 plugin이 다음 중 하나에 해당하면 후보다.

- 설치된 `plugin.json`이 reader의 `validateManifest`에 거부된다([plugin release](#plugin-release)의 검사).
- 설치된 version이 받아들여지는 가장 새 version보다 오래되었다.

받아들여지는 가장 새 version은 index의 version 가운데 철회되지 않았고 `engines.soksak`이 실행 중인 core를 포함하는 가장 새 것이다. Index가 나열하지 않은 version을 설치한 plugin은 거부된 경우에만 후보다.

시작은 plugin id 순서로 다음을 실행한다.

- Registry가 설정되지 않았으면 아무것도 업데이트하지 않고, info record `plugins: no registry is configured`를 남긴다.
- Index를 읽지 못하면 아무것도 업데이트하지 않고, error record `plugins update: <error>`를 남긴다.
- 거부된 plugin에 설치된 version보다 새롭고 받아들여지는 version이 없으면 그대로 두고, error record `plugin update <id>: <reason>`를 남긴다. `<reason>`은 설치된 `plugin.json`에 대한 reader의 오류 문장이다.
- 업데이트가 보류된 후보([persistent services](persistent-services.ko.md#updates))는 그대로 두고, info record `plugin update <id>: <error>`를 남긴다. `pluginsState`의 `held`가 그 후보를 나열한다.
- 그 밖의 후보는 그 id에 대해 [pluginsRun](#애플리케이션-안의-plugin-작업)의 동작 `update`를 실행한다. 이는 `core.plugins.update`와 같은 설치 호출이며, 같은 [변경 적용](#변경-적용)과 같은 `plugins-changed` event를 쓴다. 성공하면 `info` 수준의 event `host.plugins.update`(`plugin`, `from`, `to`)를 남긴다. 실패하면 error record `plugin update <id>: <error>`를 남기고, 다음 후보를 실행한다.

시작 업데이트의 실패는 host가 종료할 때까지 보관한다. `pluginsState`는 이를 `startUpdate`로 알린다. `{where, text}`의 목록이며, `where`는 각 기록의 자리(`plugins update` 또는 `plugin update <id>`), `text`는 그 내용이다. 각 창은 상태를 읽을 때 `startUpdate`의 항목마다 오류 표시로 보여 준다. 그래서 사람은 애플리케이션 로그를 읽지 않아도 실패를 본다. 시작 업데이트가 도는 동안 host가 종료하면, 시작 업데이트는 다음 plugin을 시작하지 않는다. 아직 `plugins/installed.json`을 쓰지 않은 설치는 아무것도 쓰지 않는다. 종료가 시작된 뒤에는 release를 풀지 않고, `installed.json`을 쓰지 않으며, 적용 단계를 실행하지 않는다. 종료 전에 쓴 `installed.json`은 쓴 그대로 남는다. 시작 업데이트는 그 중단을 error record `plugin update <id>: the host is shutting down`으로 남긴다.

시작은 다른 plugin 작업이 실행 중이어도 후보를 거부하지 않는다. 그 작업이 끝날 때까지 기다린다. 시작은 자기 thread에서 실행하므로, 창은 registry를 기다리지 않고 열린다. 시작은 host의 setup이 plugins와 sidecars 상태를 추가한 뒤, setup의 끝에서 시작한다. Plugins 상태 없이 업데이트를 시작하면 오류로 거부되며 thread를 시작하지 않는다. 설치된 plugin이 모두 받아들여지고 받아들여지는 가장 새 version을 가지면, 다시 시작해도 아무것도 바뀌지 않는다. Index를 읽는 실패를 포함한 각 실패는 애플리케이션 로그의 error record다. Registry 오류는 설정 탭이 [plugin 상태와 명령](#plugin-상태와-명령)대로 보여 준다.

## Plugin 상태와 명령

설정 탭은 plugin을 설치됨과 찾아보기 페이지, 그리고 plugin마다 있는 plugin 페이지에 보여 준다. 설치 전과 설치 후로 나누어 보여 준다. [설정](settings.ko.md#플러그인)이 그 페이지, 검색, 배치, 글을 정한다. 이 절은 그 페이지가 실행하는 plugin 상태, status, 명령을 정한다.

Plugin 목록은 창이 불러온 plugin, `installed.json`이 나열한 plugin, 철회되지 않은 version을 registry index가 나열한 plugin을 담으며, id 순서로 정렬한다. Registry index가 철회된 version만 나열한 plugin은 설치되었거나 불러온 경우가 아니면 목록에 없다.

### Plugin states

Plugin마다 상태가 하나 있다.

| 상태 | 글 | 조건 |
| --- | --- | --- |
| `loaded` | 사용 중 | 창이 plugin을 불러왔고, `installed.json`이 같은 version을 켜진 상태로 나열한다 |
| `disabled` | 사용 안 함 | `installed.json`이 plugin을 꺼진 상태로 나열하고, 창은 그 plugin을 불러오지 않았다 |
| `available` | 설치 안 됨 | Registry index만 plugin을 나열한다 |
| `reload` | 창을 다시 불러오면 적용 | 수정된 탭을 유지하여 창이 워크벤치를 유지했으므로, `installed.json`이 창이 불러온 것과 다르다([변경 적용](#변경-적용)) |
| `refused` | 불러오지 못함 | `installed.json`이 plugin을 켜진 상태로 나열하고, 창이 그 entry나 manifest를 거부했다([설치된 plugin 제공](#설치된-plugin-제공)). 다시 불러와도 불러오지 않으므로, 이 상태는 page가 다시 불러오기를 기다리게 하지 않는다 |
| `requires` | 필요한 플러그인 없음 | `installed.json`이 plugin을 켜진 상태로 나열하고, 창에 불러온 켜진 plugin 가운데 그 plugin이 요구하는 category의 plugin이 없다([plugin categories](plugins.ko.md#plugin-categories)). 그 category의 plugin을 설치하거나 켠 뒤 다시 불러오면 불러온다 |

Plugin마다 다음을 보여 준다.

- 불러온 manifest의 설명, 없으면 registry 항목의 설명. [plugins](plugins.ko.md)와 [registry index](#registry-index)가 설명을 요구한다. `installed.json`만 나열한 plugin은 설명이 없으며 id를 이름으로 보여 준다.
- 버전 줄. 설치된 버전 <version>과 최신 버전 <version>을 있을 때 보여 준다. 최신 버전은 설치가 실행 중인 core에 고르는 버전이다([version 선택](#version-선택)). Plugin이 `incompatible`이면 core <version>에 맞는 버전 없음을 보여 준다.
- 사이드카 줄. 사이드카 뒤에 plugin이 지정한 사이드카를 이름 순서로 나열한다. 각 사이드카는 `installed.json`의 `sidecars`에 있는 설치된 버전을 보여 준다. 없으면 plugin이 선언한 범위를 보여 준다. 사이드카와 범위의 출처는 순서대로 다음과 같다. 설치된 plugin이면 `installed.json` 항목, 아니면 설치가 실행 중인 core에 고르는 registry 버전, 아니면 불러온 manifest의 `dependencies`다. 사이드카가 없는 plugin은 사이드카 없음을 보여 준다. 설치되지도 불러오지도 않은 `incompatible` plugin은 이 출처가 모두 없으므로 사이드카 줄을 보이지 않는다.
- 동작. 각 동작은 자기 명령에 묶인다. 설치 `core.plugins.install`은 plugin에 `latest` version이 있고 설치되지 않았을 때 보인다. 업데이트 `core.plugins.update`는 설치되었고 그 `latest` version이 설치된 version보다 새로울 때 보인다. 적용 `core.plugins.apply`는 상태가 `reload`일 때 보인다. 사용 `core.plugins.enable` 또는 사용 안 함 `core.plugins.disable`은 설치되었을 때 보이며, `enabled` 값에 따라 고른다. 제거 `core.plugins.remove`는 설치되었을 때 보인다. 작업이 실행되는 동안 모든 plugin의 모든 동작은 비활성이며, 그 plugin은 "<plugin> <action> 진행 중"을 보여 준다. 작업이 실패하면 plugin은 그 오류를 보여 준다. `held`가 나열한 plugin은 그 오류와 함께, 항목의 `action`에 따라 세션 <n>개를 끝내고 업데이트, 세션 <n>개를 끝내고 설치, 또는 세션 <n>개를 끝내고 사용 동작을 보여 준다. 이 동작은 `{plugin, end: true}`와 함께 자기 명령에 묶인다. `<n>`은 그 sidecar들의 `sessions` 합이다. `sessions`가 `null`인 동안에는 이 동작이 없다.

설정 탭은 plugin 페이지를 보일 때, `plugins-changed` event를 받을 때, `sidecars-changed` event를 받을 때마다 `pluginsState`로 plugin 상태를 읽고 `sidecarsOutdated`로 오래된 sidecar를 읽는다. 설정 탭이 가진 값과 같은 값을 읽으면 plugin 상태와 애플리케이션 업데이트 listener를 부르지 않는다. 그래서 아무것도 그리지 않는다. `core.plugins`는 오래된 sidecar를 `outdated`로 보고한다. 설치됨 페이지는 각 오래된 sidecar를 plugin 목록 위에 `<running> → <installed>`와 함께 보여 준다. 동작은 세션 <sessions>개를 끝내고 적용이며 `core.plugins.replace {sidecar}`에 묶인다. 더 이상 선언되지 않은 sidecar면 세션 <sessions>개를 끝내고 종료 동작을 보여 준다. `<sessions>`는 그 service에 보낸 적 있는 모든 plugin의 surface 수다([persistent services](persistent-services.ko.md#updates)). Registry index를 읽지 못하면 plugin 목록 위에 "레지스트리를 읽지 못했습니다: <message>"를 보이며, 페이지는 불러온 plugin과 설치된 plugin을 유지한다. 잘못된 `installed.json`처럼 plugin 상태를 읽지 못하면 "플러그인 상태를 읽지 못했습니다: <message>"를 보이며, plugin 항목은 없다. 브라우저 애플리케이션처럼 host가 없으면 설정 탭에는 불러온 plugin만 있으며, 각각 `loaded` 상태이고 동작은 없다.

`updates`가 비어 있지 않은 동안 설치됨 페이지는 `updates`의 plugin 행마다 배지 `업데이트 <latest>`, 필터 선택지 `업데이트 <n>`, `core.plugins.update-all`에 묶인 버튼 `모두 업데이트 (<n>)`을 보인다([설정](settings.ko.md)). `core.plugins.update-all`은 `updates`의 plugin마다 id 순서로, 차례로 host 호출 `pluginsRun`에 동작 `update`를 실행한다. 매번 실행 뒤 plugin 상태를 다시 읽으며, 첫 실패에서 host 오류로 멈춘다. 매개변수가 없다. Host가 없거나 다른 작업이 실행 중이면 "plugin operations need a native host" 등 해당 오류로 실패한다. `updates`가 비어 있으면 아무것도 하지 않는다. 동작은 `core.settings-tab.plugins.update-all`이다. `core.plugins.show-updates`는 설정 탭을 필터 `updates`의 설치됨 페이지로 연다.

`core.plugins.registry`는 `{index}`를 받아 host 호출 `pluginsUseRegistry`를 실행하고, plugin 상태를 다시 읽는다. `index`가 비어 있지 않은 문자열이 아니면 -32602(invalid params)로 실패한다. Index를 읽거나 검사하지 못하면 host 오류로 실패한다. `core.plugins.install`, `core.plugins.update`, `core.plugins.remove`, `core.plugins.enable`, `core.plugins.disable`은 `{plugin}`을 받고, 자기 action으로 host 호출 `pluginsRun`을 실행한다. `core.plugins.install`, `core.plugins.update`, `core.plugins.enable`은 `end: true`도 받아 `pluginsRun`에 넘긴다. `plugin`이 비어 있지 않은 문자열이 아니거나, `end`가 있는데 `true`가 아니면 -32602(invalid params)로 실패한다. 작업이 실패하거나 다른 작업이 실행 중이면 host 오류로 실패한다. Host가 없으면 "plugin operations need a native host"로 실패한다. 명령은 host를 호출하기 전에 작업을 `core.plugins`에 기록하고, 호출 뒤에 결과를 기록한다. `core.plugins.apply`는 창의 수정된 탭마다 묻고, [변경 적용](#변경-적용)대로 워크벤치를 다시 시작한다. 새 시작 전에 `{reloaded: true}`로 답한다. 탭을 유지하면 `{reloaded: false}`로 답한다. `core.plugins.replace`는 `{sidecar}`를 받아 host 호출 `sidecarsReplace`를 실행한다([persistent services](persistent-services.ko.md#updates)). `sidecar`가 비어 있지 않은 문자열이 아니면 -32602(invalid params)로 실패한다. 교체가 실패하면 host 오류로 실패한다. `core.plugins.browse`는 설정 탭을 열고 그 설치됨 페이지를 고른다.

`core.settings-tab`은 `query`, `listed`, `actions`를 보고한다. 설치된 plugin 검색 문구, 보이는 항목의 plugin id를 순서대로, 항목의 동작 버튼을 문서 순서의 `{plugin, action, disabled}`로 담는다. 동작 버튼의 위치는 element 이름 `core.settings-tab.plugins.action`의 index다. `listed`와 `actions`는 설치됨과 찾아보기 이외의 페이지에서 `[]`다. 설명이 있는 plugin의 설명 줄은 element 이름 `core.settings-tab.plugins.about`이다. Plugin의 각 기여 줄, 즉 상태든 오류든 그 줄은 element 이름 `core.settings-tab.plugins.contribution`이다. 둘 다 문서 순서다. `core.plugins`는 다음을 보고한다.

| 필드 | 값 |
|---|---|
| `core` | `pluginsState`가 보고하는 실행 중인 core의 version. 상태를 읽기 전, 읽지 못했을 때, host가 없을 때는 `null` |
| `registry` | Registry index URL 또는 `null` |
| `error` | Registry index 오류 또는 plugin 상태 오류, 또는 `null` |
| `plugins` | 목록의 plugin마다 id 순서로 `{id, name, description, state, composition, installed, latest, incompatible, sidecars}`. `composition`은 이 창에 불러온 manifest의 surface composition kind다. Surface 선언을 불러오지 않았으면 `null`이다. 열린 tab의 유무와 관계없다. `installed`는 `{version, enabled}` 또는 `null`이다. `latest`는 registry index가 나열하고 철회되지 않았으며 `engines.soksak`이 실행 중인 core를 포함하는 가장 새 version 또는 `null`이다. `incompatible`은 registry index가 철회되지 않은 plugin version을 나열하지만 그중 어느 것도 실행 중인 core를 포함하지 않으면 `true`다. `sidecars`는 이름 순서의 `{name, range, version}` 목록이다. 설치되지도 불러오지도 않은 `incompatible` plugin이면 `null`이다. 모르는 `range`와 `version`은 `null`이다 |
| `operation` | 첫 작업 전에는 `null`이다. 그 뒤에는 마지막 작업의 `{action, plugin, state, error}`다. `state`는 `running`, `done`, `failed` 중 하나이며, `error`는 실패한 작업의 message 또는 `null`이다 |
| `reload` | 상태가 `reload`인 plugin이 있으면 `true`다. 상태가 `refused`인 plugin은 이 값을 바꾸지 않는다 |
| `updates` | `latest` version이 설치된 version보다 새로운 설치 plugin을 id 순서로 나열한다: `{id, installed, latest}` |
| `held` | `pluginsState`의 `held` 목록. 상태를 읽기 전과 host가 없을 때는 `[]`다 |

완료 기준:

- 설정 탭의 설치됨과 찾아보기 페이지는 불러온 plugin, 설치된 plugin, registry plugin을 이름, 설명, 상태, 버전, 사이드카와 함께 나열하며, 검색으로 거른다. `core.plugins.browse`는 어느 창에서든 설치됨 페이지를 연다.
- 항목에서 plugin을 설치, 업데이트, 끄기, 켜기, 제거하면 같은 `sok plugin` 명령처럼 `installed.json`이 바뀐다. 작업은 `core.plugins`에 보고되며, 변경은 sidecar에 적용된다. 수정된 탭을 유지하지 않은 모든 창의 page는 다시 불러온다. 그래서 창은 애플리케이션을 다시 시작하지 않아도 바뀐 plugin을 보여 준다.

## 첫 실행

`environment.json`의 `starter`가 starter pack을 정한다. `plugins/installed.json`과 starter job이 모두 없는 첫 실행에서, workbench는 첫 plugin을 설치하기 전에 pack 이름, 현재 registry URL, 순서가 있는 plugin ID를 `plugins/starter.json`의 pending job으로 기록한다. 파일은 `{ "format": 1, "state": "pending" | "complete", "pack": "<name>", "registry": "<url>", "plugins": ["<id>", ...] }`다. `format`은 1이어야 하고, state는 `pending` 또는 `complete`여야 한다. Pack, registry, 각 plugin ID는 비어 있지 않은 문자열이어야 한다. Plugin ID는 중복되지 않고 순서를 유지해야 한다. 다른 필드는 허용하지 않는다. Reader는 잘못된 필드나 값을 파일과 함께 보고한다. 파일이 없으면 pending job이 없는 상태이며, `installed.json`에서 변환하지 않는다.

각 `pluginsRun` 성공은 다음 plugin을 시작하기 전에 installed 상태를 쓴다. 그래서 재시작은 pending job의 installed 상태에 없는 ID만 재개한다. 설치가 실패하면 job은 pending으로 남는다. 나열된 모든 ID가 설치되면, workbench는 일치하는 job을 complete로 바꾼다. 설치가 `installed.json`을 바꾸었다면 page를 다시 불러와 plugin을 로드한다. 완료된 job은 다시 강제하지 않는다. 그래서 사용자가 나중에 plugin을 제거하거나 끈 선택을 보존한다. Pending job은 저장된 pack과 plugin 목록을 재개한다. 그 registry URL은 여전히 설정된 registry와 같아야 한다. Registry가 다르면 job은 pending으로 남고, 설정된 registry를 바꾸거나 다른 index에서 설치하지 않은 채 오류를 보고한다.

`installed.json`은 있지만 job 파일이 없으면 대기 중인 job이 없다는 뜻이며, starter 설치를 시작하지 않는다. 그래서 사용자가 제거한 plugin이 기존 profile에 다시 설치되지 않는다. 이 job 계약 이전에 생긴 부분 starter 설치는, 설치 완료 뒤 사용자가 plugin을 제거한 상태와 구분되지 않는다. 그래서 이 모호함은 자동 복구하지 않는다. `environment.json`이 `registry`에 기본 registry를 정하고 `pluginsState`가 registry가 없다고 보고하면, workbench는 먼저 `pluginsUseRegistry`로 registry를 정한 뒤 상태를 다시 읽는다. Registry가 없거나, registry index나 starter pack을 읽지 못하면, 창은 pack을 설치하지 않은 채 시작한다. 이때 `first run: the starter pack <name> was not installed: <error>`를 기록하고, 애플리케이션 오류 `시작 플러그인 묶음 <name>을 설치하지 못했습니다 · <error>.`를 보인다. Job은 만들지 않으므로, 다음 첫 실행에서 다시 시도할 수 있다. Pending job을 쓴 뒤 plugin 설치가 실패해도 같은 메시지를 보인다. 이때 `installed.json`이 이미 있더라도, pending job은 다음 시작에서 재개된다. 표시되는 문구는 `<error>`를 그대로 보존하며, 실패의 원인이나 해결 방법을 단정하지 않는다. `starter`가 없는 environment나 host가 없는 환경은 아무것도 설치하지 않는다.
