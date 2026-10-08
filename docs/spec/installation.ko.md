# Plugin 설치 형식

[English](installation.md)

Plugin 설치가 쓰는 형식이다. [Command line `sok`](cli.ko.md)의 두 구현이 이 형식을 검증하며, host contract case `install.*`가 규칙마다 정한다([host contract](host-contract.ko.md)). 모든 검사는 알 수 없는 필드를 거부하고 틀린 필드를 밝힌다. 필드는 정해진 순서로 검사하므로 오류가 여럿인 파일도 두 구현이 같은 오류를 보고한다. Version의 각 자리는 4294967295 이하다. Host와 workbench가 plugin을 불러오는 방식은 [설치된 plugin 제공](#설치된-plugin-제공)이 정한다.

## Version과 범위

Version은 숫자 부분으로 된 `x.y.z`이며 앞자리 0을 쓰지 않고, 숫자로 비교한다. 범위는 다음 중 하나다.

| 범위 | Version |
| --- | --- |
| `*` | `>=0.0.0`: 모든 version |
| `x.y.z` | 그 version만 |
| `^x.y.z` | `x.y.z`부터 첫 0이 아닌 자리가 바뀌기 전까지: `^1.2.3`은 `2.0.0` 미만, `^0.2.3`은 `0.3.0` 미만, `^0.0.2`는 `0.0.3` 미만 |
| `~x.y.z` | `x.y.z`부터 `x.(y+1).0` 미만 |
| `>=x.y.z` | `x.y.z`와 그 뒤의 모든 version |
| `>=x.y.z <a.b.c` | `x.y.z`부터 `a.b.c` 미만이며, 빈 범위는 거부한다 |

`latest`, `**`, pre-release 접미사 같은 다른 형식은 거부한다.

## Plugin release

Plugin release는 `sok plugin pack`이 쓰는, plugin 파일을 담은 파일 `<id>-<version>.tgz`다. 그 `package.json`은 다음을 선언한다.

| 필드 | 뜻 |
| --- | --- |
| `name` | 설치한 파일을 제공하는 `/modules/<name>/`의 이름이다 |
| `version` | Plugin version |
| `engines.soksak` | Plugin이 지원하는 core API version 범위 |
| `files` | Release가 담는 plugin 안의 경로이며 `plugin.json`을 포함한다 |

`package.json`의 다른 필드는 package 도구의 것이므로 읽지 않는다. 다만 `soksak`은 거부한다. 플러그인의 sidecar와 그 범위는 `plugin.json`의 `dependencies`다([플러그인](plugins.ko.md#pluginjson)).

plugin 저장소는 한 core release의 `@soksak/plugin-api`로 빌드한다. 그 `engines.soksak`은 모든 core version이 만족하는 `*`, 그 release만 만족하는 그 `@soksak/plugin-api`의 `^<version>`, 또는 그 core release와 이후의 모든 release가 만족하는, 하한이 그 version을 넘지 않는 `>=<x.y.z>`이다. core가 어떤 release에서 더한 manifest 필드를 쓰는 plugin은 그 release로 `>=`를 선언한다. `@soksak/plugin-api`의 명령 `soksak-engines`가 plugin 저장소에서 이를 검사하고 `package.json: engines.soksak <range> must be *, ^<version> or >= a version up to <version>, the @soksak/plugin-api version`으로 실패한다. 각 plugin 저장소는 `make test`에서 이를 실행한다.

## Sidecar release

Sidecar version은 플랫폼마다 release 하나 `<file name>-<version>-<platform>.tar.gz`로 release된다. Sidecar `@scope/name`의 file name은 `scope-name`이고, scope가 없는 이름은 그대로 쓴다. 플랫폼은 `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-arm64`, `windows-x64` 중 하나다. Installer는 sidecar release를 풀고 실행하기 전에 registry 항목의 `sha256`으로만 검사한다. 제3자의 것을 포함해 sidecar는 애플리케이션이 서명이나 다른 방법으로 검토하지 않는다.

## Registry index

Registry index `index.json`은 `format` 1과 다음 목록을 가진다.

| 필드 | 항목 |
| --- | --- |
| `plugins` | `{ id, package, name, description, license, repository, versions }`. 각 version은 `{ version, release: { url, sha256 }, engines: { soksak }, sidecars }`이며, `sidecars`는 그 version의 `plugin.json`의 sidecar 의존마다 범위를 정하고 sidecar가 없는 plugin은 `{}`다. plugin 의존은 index에 적지 않는다 |
| `sidecars` | `{ name, repository, versions }`. 각 version은 `{ version, protocol: 1, releases }`이며, `releases`는 플랫폼마다 `{ url, sha256 }`을 정한다 |
| `packs` | `{ name, description, plugins }`: 함께 설치하는 plugin id |
| `revoked` | `{ plugins: [{ id, version, reason }], sidecars: [{ name, version, reason }] }` |

`url`은 게시된 release의 `https:` URL이거나 local release의 절대 `file:` URL([받기](#받기))이고, `sha256`은 소문자 16진수 64자리다. 설명은 1자에서 200자(Unicode code point)다. Index 검사는 이 밖에도 plugin id, package, sidecar, pack, version의 중복, 알 수 없는 plugin을 가리키는 pack, 알 수 없는 sidecar나 어떤 sidecar version도 채우지 않는 범위가 필요한 plugin version, 목록에 없는 revoked version을 거부한다. `sok registry build`는 각 plugin의 `plugin.json`도 읽어, 의존이 목록의 plugin도 목록의 sidecar도 가리키지 않거나 plugin 의존의 범위를 채우는 목록의 version이 없으면 실패한다.

## 받기

Registry index와 release는 위치에서 읽는다. 위치는 `https:` URL, 절대 `file:` URL, 또는 명령이 경로를 받는 곳에서는 파일 경로다. 그 밖의 URL은 `<url>: the URL must be https: or an absolute file: URL`로 실패한다. `https:` URL은 다음 규칙으로 읽으며, 두 구현은 같은 문장으로 이 규칙을 따른다.

- 연결은 운영체제가 신뢰하는 인증 기관으로 TLS를 쓴다.
- redirect는 대상이 `https:` URL일 때 최대 5번 따라간다. 다른 scheme으로의 redirect는 `<url>: redirect to <target> is not https`로, 여섯 번째 redirect는 `<url>: more than 5 redirects`로 실패한다.
- 200이 아닌 응답은 `<url>: HTTP <status>`로 실패한다.
- 연결부터 마지막 byte까지 한 요청은 index는 60초, release는 600초 안에 끝나야 한다. 더 느린 요청은 `<url>: timed out after <seconds> s`로 실패한다.
- index는 최대 8 MiB, release는 최대 256 MiB다. 더 큰 본문은 `<url>: larger than <bytes> bytes`로 실패한다.
- 연결하거나 읽지 못하면 `<url>: cannot connect: <reason>`으로 실패하며, reason은 network library의 문장이다.

아무것도 저장해 두지 않는다. 각 명령과 각 plugin 작업은 필요한 index와 release를 다시 읽고, release는 풀기 전에 `sha256`과 비교한다.

## Version 선택

Core version과 플랫폼에 맞춰 plugin을 설치하면, `engines.soksak`이 core version을 포함하고 revoked가 아닌 가장 새 plugin version을 고른다. 한 설치에서 sidecar는 version 하나이며, 그 sidecar를 지정한 설치된 plugin이 모두 함께 쓴다. 고른 plugin version의 sidecar마다, 범위는 그 version의 범위와 그 sidecar를 지정한 다른 설치된 plugin의 범위다. 쓰고 있는 version이 모든 범위를 채우고 revoked가 아니며 그 플랫폼 release가 있으면 그대로 두고, 아니면 모든 범위를 채우고 revoked가 아니며 그 플랫폼 release가 있는 가장 새 sidecar version을 고른다. 고를 것이 없으면 설치는 plugin, version이나 범위, core version이나 플랫폼을 밝혀 실패하며, sidecar의 경우 각 plugin과 범위를 밝힌다.

고른 version의 `plugin.json` 의존 가운데 index의 plugin을 가리키는 것은 plugin 의존이다. 설치는 아무것도 풀기 전에 받은 release에서 `plugin.json`을 읽는다. plugin을 설치하면 각 plugin 의존을 같은 규칙으로 재귀적으로 설치한다. 설치된 제공자의 version이 그것을 가리키는 모든 설치된 plugin의 범위를 채우면 그대로 두고, 아니면 모든 범위, `engines.soksak`, revoked 규칙을 채우는 가장 새 제공자 version을 고른다. 설치되었지만 켜지지 않은 제공자는 켠다. index의 plugin도 sidecar도 가리키지 않는 의존은 `<plugin> <version>: dependency <package> is neither a plugin nor a sidecar of the registry`로, 순환은 `plugin dependency cycle: <id> -> <id> -> <id>`로 실패한다. `sok plugin update`는 제공자를 가리키는 모든 설치된 plugin의 범위를 채우는 제공자 version만 고른다. `sok plugin remove`와 `sok plugin disable`은 켜진 설치 plugin이 그 package를 가리키면 `plugin <id> is required by <dependent> <range>`로 실패하며, `installed.json`과 폴더는 바뀌지 않는다.

## 설치 배치

설정 폴더 안에서 `<id>`의 plugin version `<version>`은 `plugins/<id>/<version>`에, sidecar version의 플랫폼 release는 `sidecars/<file name>/<version>/<platform>`에 푼다. `plugins/installed.json`은 `format` 2, `plugins`, `sidecars`를 가진다. `plugins`는 plugin id마다 `{ package, version, path, enabled, sidecars, previous? }`를 정한다. 각각 plugin `package.json`의 `name`, 쓰는 version, 설치가 그 version을 푼 폴더 `plugins/<id>/<version>`, 불러올지 여부, 그 version의 sidecar 범위, 되돌리기가 복원할 version이다. 한 `name`은 한 번만 나온다. `sidecars`는 설치된 plugin이 지정한 sidecar마다 `{ version, path }`를 정한다. 쓰는 version은 그 sidecar를 지정한 모든 설치된 plugin의 범위를 채우며, `path`는 설치가 그 플랫폼 release를 푼 폴더 `sidecars/<file name>/<version>/<platform>`이다. 어느 설치된 plugin도 지정하지 않은 sidecar는 나오지 않는다. 각 `path`는 설정 폴더에 대한 상대 경로이며 이 규칙이 정하는 폴더와 같아야 하므로 설정 폴더를 옮길 수 있다([projects](projects.ko.md#저장)). 설치는 release를 풀 때 각 `path`를 기록하고, host와 `sok`은 설정 폴더에 대해 푼 기록된 경로에서만 파일을 읽는다. `format`이 2가 아닌 파일은 `<file>: plugins/installed.json: format must be 2`로 실패하고 바뀌지 않는다.

## 설치된 plugin 제공

두 host는 설정 폴더에서 다음 경로를 제공하며, 요청마다 `plugins/installed.json`을 읽으므로 변경 뒤에 불러온 page는 그 변경을 본다.

| 경로 | 내용 |
| --- | --- |
| `/installed-plugins.json` | `{ "plugins": [{ id, package, version, manifest, diagnostics? }] }`: `installed.json`의 켜진 plugin을 id 순서로 담고, `manifest`는 설치된 `plugin.json`의 내용이다. 진단 build에서 `diagnostics`는 설치된 package가 `diagnostics.json`을 담을 때 그 내용이며, release build는 보내지 않는다. `installed.json`이 없으면 `{ "plugins": [] }`다. `installed.json`, `plugin.json`, `diagnostics.json`을 읽거나 검사할 수 없으면 문서는 `{ "error": "<message>" }`다 |
| `/modules/<package>/<path>` | 켜진 설치 plugin의 package는 그 plugin의 기록된 `path` 안의 `<path>` 파일이다. 빈 segment, `.`, `..`가 있는 경로나 없는 파일은 찾을 수 없다. 다른 package는 애플리케이션 frontend에서 온다 |
| `/shared/<plugin id>.<point>/<specifier>.js` | 켜진 설치 plugin `<plugin id>`의 `extends.<point>.modules`가 `<specifier>`에 대응한, 그 plugin의 기록된 `path` 안의 파일. `.js`로 끝나지 않는 경로, 켜진 plugin이 선언하지 않은 지점, 그 지점이 대응하지 않은 specifier, 없는 파일은 찾을 수 없다 |

Workbench는 `/installed-plugins.json`을 JSON module로 가져와 각 plugin을 `manifest`로 등록하고, 문서에 `error`가 있으면 그 텍스트로 불러오기를 실패한다. Workbench가 거부한 manifest는 `installed plugin <id> <version> (<package>): <이유>`로 보고된다. Main page는 plugin을 등록하기 전에 오류 표시를 설치하고 창 버튼 영역을 비우므로, 거부된 manifest나 `error` 문서는 그 오류를 보이고 애플리케이션 로그에 쓴 채로 page 시작을 멈춘다. page는 준비를 보고하지 않으며, `host.window.reload`가 다시 시작한다.

Host는 시작할 때 켜진 설치 plugin의 `plugin.json` `dependencies`가 지정한 sidecar를 설치된 plugin의 package를 빼고 이름 순서로 읽는다. Sidecar는 `installed.json`이 그것에 기록한 `path`에서 실행되며, 실행 파일은 그 폴더의 `sidecar.json`의 `executable` 경로다. 애플리케이션 실행 중에 설치하거나 켠 plugin은 변경 뒤에 불러온 page에 제공된다. 성공한 `pluginsRun` install, update, enable은 켜진 설치 plugin의 sidecar 중 host가 아직 선언하지 않은 것을 선언하므로, 그 뒤에 불러온 page는 첫 실행이 다시 불러온 page처럼 그 sidecar를 시작한다. host는 `pluginsRun` 작업마다 이미 선언한 sidecar에 변경을 [변경 적용](#변경-적용)대로 적용한다.

## 애플리케이션 안의 plugin 작업

두 host는 각자 command line의 installer library(`packages/sok`)로 plugin 작업을 실행한다. 그래서 애플리케이션 안의 작업과 같은 `sok plugin` 명령은 설정 폴더를 똑같이 바꾼다. Runtime adapter는 host 호출 둘과 event 하나를 제공한다:

| Host 호출 또는 event | 의미 |
| --- | --- |
| `pluginsState()` | `{ registry, index, installed, firstRun }`을 돌려준다. `registry`는 `plugins/registry.json`의 `index` URL이고 없으면 `null`이다. `index`는 검사한 registry index이고, registry가 없으면 `null`, 읽거나 검사하지 못하면 `{ "error": "<message>" }`다. `installed`는 `plugins/installed.json`의 내용이고, 없으면 `{ "format": 1, "plugins": {}, "sidecars": {} }`다. `firstRun`은 `plugins/installed.json`이 없는 동안 `true`다. `installed.json`을 읽지 못하면 그 message로 호출을 거부한다 |
| `pluginsRun({ action, plugin })` | Plugin id에 대해 `install`, `update`, `remove`, `enable`, `disable`을 애플리케이션의 core version과 platform으로 실행하고, 같은 `sok plugin` 명령의 출력을 돌려준다. 다른 `action`이나 비어 있지 않은 문자열이 아닌 plugin id는 아무것도 바꾸지 않고 호출을 거부한다. 실패한 작업은 같은 명령의 message로 호출을 거부하고, `installed.json`은 그 명령이 정한 대로 남는다 |
| `pluginsUseRegistry({ index })` | `sok registry use <index>`처럼 registry index를 정하고 그 출력 `{ index }`를 돌려준다. 비어 있지 않은 문자열이 아닌 `index`는 `index must be a non-empty string`으로 거부한다 |
| `plugins-changed` | `pluginsRun`이 `installed.json`을 바꾼 뒤 모든 창에 `{ action, plugin }`과 함께 보낸다 |
| `window-active` | 창이 key window가 될 때마다 그 창에 보낸다. 원격 registry는 변경 event를 보내지 않으므로 page가 plugin 상태를 다시 읽는다 |
| `sidecarsOutdated()` | `host.sidecars`의 `outdated` 목록 `[{sidecar, running, installed, sessions}]`을 sidecar 순으로 돌려준다([terminal runtime](terminal-runtime.ko.md#updates)) |
| `sidecarsReplace({ sidecar })` | [terminal runtime](terminal-runtime.ko.md#updates)이 정한 대로 sidecar의 오래된 상주 service를 교체하고, 다른 version의 service가 실행 중이지 않으면 그 sidecar를 밝히는 오류로 거부한다 |
| `sidecars-changed` | `host.sidecars`가 바뀌면 모든 창에 값 없이 보낸다 |

Host는 작업을 한 번에 하나만 실행한다. 다른 작업이 실행 중일 때 `pluginsRun`을 호출하면 `another plugin operation is running`으로 거부한다. Host는 `sok` process가 만든 변경을 관찰하지 않는다. 다음 `pluginsState` 호출과 나중에 불러온 page가 그 변경을 읽는다. `pluginsRun` 작업의 변경은 [변경 적용](#변경-적용)대로 바로 적용된다. `sok` process가 만든 변경은 나중에 불러온 page에, sidecar에는 애플리케이션이 시작할 때 적용된다. Browser 애플리케이션은 host가 없으므로 plugin 작업이 없다.

### 변경 적용

`pluginsRun` 작업이 성공하면 host는 호출에 답하고 `plugins-changed`를 보내기 전에 그 변경을 자기 sidecar에 적용한다.

- 켜진 설치 plugin이 지정한 sidecar를 `installed.json`이 기록한 폴더로 선언한다. 기록된 폴더가 바뀐 표준 입출력 sidecar는 교체된다. host는 실행 중인 process를 [sidecar](sidecars.ko.md#선언과-시작)의 중지 규칙대로 멈추고, 다음 send가 새 폴더의 실행 파일을 시작한다. 켜진 설치 plugin이 더 이상 지정하지 않는 sidecar는 멈추고 선언에서 빠지므로, 그 sidecar로의 send는 선언되지 않은 sidecar로의 send처럼 실패한다.
- 실행 중인 service의 version이 `installed.json`의 기록과 다른 persistent sidecar는 [terminal runtime](terminal-runtime.ko.md#updates)대로 보고하고 교체한다.

`plugins-changed`를 받은 창은 page를 다시 불러와 `installed.json`이 나열한 plugin을 불러온다. 다시 불러오기 전에 창의 수정된 탭마다 그 탭에서 선택 layer `<name> 탭에 저장하지 않은 변경이 있습니다`로 묻는다. 저장하고 적용(`surface.save`가 있을 때만)은 저장 명령을 실행하고 탭이 더 이상 수정되지 않았으면 계속한다. 저장하지 않고 적용은 계속하고 다시 불러오기로 변경을 버린다. 적용하지 않기나 layer 닫기는 그 창의 page를 유지한다. 실패한 저장은 탭을 닫을 때처럼([plugins](plugins.ko.md)) 그 오류를 탭의 오류로 보고하고 page를 유지한다. 유지한 page: 그 창의 plugin은 불러온 그대로이고, 바뀐 plugin의 카드는 `core.plugins.apply`가 같은 질문 뒤에 page를 다시 불러올 때까지 상태 `reload`를 보인다. page 다시 불러오기가 실패한 창은 오류 표시로 그 오류를 보인다.

## Plugin 화면

창의 라이브러리 화면([프로젝트](projects.ko.md#프로젝트-식별))에는 머리줄 앞의 탭으로 고르는 두 페이지, 프로젝트와 플러그인이 있다. 탭은 `projects` 또는 `plugins`로 `core.library.page {page}`를 실행한다. 플러그인이 plugin 화면이다. 이 화면은 plugin을 그 설명과 함께 나열하고 plugin 작업을 실행한다. 설정 창은 불러온 plugin의 설정만 담는다([설정 창](settings.ko.md#플러그인)). `core.plugins.browse`는 설정 창이 열려 있으면 닫고, 창이 작업 화면을 보이면 라이브러리를 보이고, 플러그인을 고른다. `core.projects.browse`는 프로젝트를 고른다. 창은 작업 화면을 보이는 동안에도 plugin 검색어를 유지한다.

페이지는 검색 칸과, 창이 불러온 plugin, `installed.json`이 나열한 plugin, registry index가 나열한 plugin마다 카드 하나를 id 순서로 보여 준다. 검색 칸은 `core.library.plugins.search {query}`를 실행한다. 페이지는 id, 이름, 설명에 검색어가 들어 있는 plugin을 대소문자 구분 없이 보여 주며, 빈 검색어는 모든 plugin을 보여 준다. 맞는 plugin이 없으면 "찾는 플러그인이 없습니다."를 보여 준다.

카드는 다음을 보여 준다.

- 이름, plugin id, 상태 하나:

| 상태 | 글 | 조건 |
| --- | --- | --- |
| `loaded` | 사용 중 | 창이 plugin을 불러왔고, `installed.json`이 같은 버전을 켠 상태로 나열한다 |
| `disabled` | 사용 안 함 | `installed.json`이 plugin을 끈 상태로 나열하고, 창이 불러오지 않았다 |
| `available` | 설치 안 됨 | Registry index만 plugin을 나열한다 |
| `reload` | 창을 다시 불러오면 적용 | 수정된 탭을 유지해 창이 page를 유지했으므로 `installed.json`이 창이 불러온 것과 다르다([변경 적용](#변경-적용)) |

- 불러온 manifest의 설명, 없으면 registry 항목의 설명([plugins](plugins.ko.md)와 [registry index](#registry-index)가 설명을 요구한다). `installed.json`만 나열한 plugin은 설명이 없고 id를 이름으로 보여 준다.
- 설치된 버전 <version>과 최신 버전 <version>(registry index가 나열한 가장 새 버전)을 있을 때 보여 주는 버전 줄.
- 사이드카 줄: 사이드카 뒤에 plugin이 이름을 댄 사이드카를 이름 순서로 보여 준다. 각 사이드카는 `installed.json` `sidecars`의 설치된 버전을, 없으면 plugin이 선언한 범위를 보여 준다. 사이드카와 범위는 설치된 plugin이면 `installed.json` 항목에서, 아니면 가장 새 registry 버전에서, 아니면 불러온 manifest의 `dependencies`에서 온다. 사이드카가 없는 plugin은 사이드카 없음을 보여 준다.
- 동작: 각각 자기 명령에 연결된 버튼이다. 설치 `core.plugins.install`은 registry가 plugin을 나열하고 설치되지 않았을 때, 업데이트 `core.plugins.update`는 설치되었고 registry가 설치된 것보다 새 version을 나열할 때, 적용 `core.plugins.apply`는 상태가 `reload`일 때, 사용 `core.plugins.enable` 또는 사용 안 함 `core.plugins.disable`은 설치되었을 때 `enabled` 값에 따라, 제거 `core.plugins.remove`는 설치되었을 때 보인다. 작업이 실행되는 동안 모든 카드의 모든 동작은 비활성이고 그 plugin의 카드는 "<plugin> <action> 진행 중"을 보여 준다. 작업이 실패하면 카드는 그 오류를 보여 준다.

페이지는 보일 때, `plugins-changed` event를 받을 때, `sidecars-changed` event를 받을 때마다 `pluginsState`로 plugin 상태를, `sidecarsOutdated`로 오래된 sidecar를 읽는다. `core.plugins`는 오래된 sidecar를 `outdated`로 보고하고, plugin 화면은 각각을 카드 위에 `<running> → <installed>`와 `core.plugins.replace {sidecar}`에 묶인 동작 터미널 <sessions>개를 끝내고 적용과 함께 보인다. Registry index를 읽지 못하면 카드 위에 "레지스트리를 읽지 못했습니다: <message>"를 보여 주고, 페이지는 불러온 plugin과 설치된 plugin을 유지한다. 잘못된 `installed.json`처럼 plugin 상태를 읽지 못하면 "플러그인 상태를 읽지 못했습니다: <message>"를 보여 주고 카드는 없다. Browser 애플리케이션처럼 host가 없으면 페이지에는 불러온 plugin만 모두 `loaded`로 있고 동작은 없다.

`updates`가 비어 있지 않은 동안 plugin 화면은 카드 위에 업데이트 목록을 보인다. `updates`의 plugin마다 `<id>: <installed> → <latest>` 행 하나와 `core.plugins.update-all`에 묶인 모두 업데이트 동작이다. `core.plugins.update-all`은 `updates`의 plugin마다 id 순서로 차례로 host 호출 `pluginsRun`에 동작 `update`를 실행하고, 매번 뒤에 plugin 상태를 다시 읽으며, 첫 실패에서 host 오류로 멈춘다. 매개변수가 없고, host가 없거나 다른 작업이 실행 중이면 "plugin operations need a native host" 등 해당 오류로 실패하며, `updates`가 비어 있으면 아무것도 하지 않는다. 행의 dom 이름은 `core.library.plugins.updates`, 동작의 dom 이름은 `core.library.plugins.update-all`이다. `updates`가 비어 있지 않은 동안 모든 창은 창 막대의 동작 줄 맨 앞에 업데이트 N 컨트롤(N은 `updates`의 길이, dom 이름 `core.chrome.updates`)을 보인다. 이 컨트롤은 `core.plugins.show-updates`를 실행하고, 이 명령은 설정 창을 닫고 library의 plugin 페이지를 보이며 업데이트 목록이 보이도록 스크롤한다. `updates`가 비면 컨트롤은 막대에서 사라진다.

`core.plugins.registry`는 `{index}`를 받아 host 호출 `pluginsUseRegistry`를 실행하고 plugin 상태를 다시 읽는다. `index`가 비어 있지 않은 문자열이 아니면 -32602(invalid params)로, index를 읽거나 검사하지 못하면 host 오류로 실패한다. `core.plugins.install`, `core.plugins.update`, `core.plugins.remove`, `core.plugins.enable`, `core.plugins.disable`은 `{plugin}`을 받고 자기 action으로 host 호출 `pluginsRun`을 실행한다. `plugin`이 비어 있지 않은 문자열이 아니면 -32602(invalid params)로, 작업이 실패하거나 다른 작업이 실행 중이면 host 오류로, host가 없으면 "plugin operations need a native host"로 실패한다. 명령은 host를 호출하기 전에 작업을 `core.plugins`에 기록하고, 호출 뒤에 결과를 기록한다. `core.plugins.apply`는 창의 수정된 탭마다 묻고 [변경 적용](#변경-적용)대로 page를 다시 불러온다. 탭을 유지하면 `{reloaded: false}`로 답한다. `core.plugins.replace`는 `{sidecar}`를 받아 host 호출 `sidecarsReplace`를 실행한다([terminal runtime](terminal-runtime.ko.md#updates)). `sidecar`가 비어 있지 않은 문자열이 아니면 -32602(invalid params)로, 교체가 실패하면 host 오류로 실패한다.

`core.library`는 `page`(`projects` 또는 `plugins`)와 `plugins` `{query, shown, actions}`를 보고한다. plugin 검색어, 보이는 카드의 plugin id를 순서대로, 카드의 동작 버튼을 문서 순서의 `{plugin, action, disabled}`로 담으며, 그 위치가 dom 이름 `core.library.plugins.action`의 index다. 페이지가 보이지 않는 동안 `shown`과 `actions`는 `[]`이다. `core.plugins`는 다음을 보고한다:

| 필드 | 값 |
|---|---|
| `registry` | Registry index URL 또는 `null` |
| `error` | Registry index 오류 또는 plugin 상태 오류, 또는 `null` |
| `plugins` | 카드마다 id 순서로 `{id, name, description, state, installed, latest, sidecars}`. `installed`는 `{version, enabled}` 또는 `null`, `latest`는 registry index가 나열한 가장 새 버전 또는 `null`, `sidecars`는 이름 순서의 `{name, range, version}` 목록이며 모르는 `range`와 `version`은 `null`이다 |
| `operation` | 첫 작업 전에는 `null`, 그 뒤에는 마지막 작업의 `{action, plugin, state, error}`. `state`는 `running`, `done`, `failed`이고, `error`는 실패한 작업의 message 또는 `null`이다 |
| `reload` | 상태가 `reload`인 plugin이 있으면 `true` |
| `updates` | registry index가 더 새 version을 나열하는 설치 plugin을 id 순으로: `{id, installed, latest}` |

완료 기준:

- 라이브러리의 플러그인 페이지는 불러온 plugin, 설치된 plugin, registry plugin을 이름, 설명, 상태, 버전, 사이드카와 함께 검색으로 걸러 나열하고, `core.plugins.browse`는 작업 화면과 설정 창에서 이 페이지를 보여 준다.
- 카드에서 plugin을 설치, 업데이트, 끄기, 켜기, 제거하면 같은 `sok plugin` 명령처럼 `installed.json`을 바꾸고, 작업을 `core.plugins`에 보고하며, 변경을 sidecar에 적용하고 수정된 탭을 유지하지 않은 모든 창의 page를 다시 불러온다. 그래서 창은 애플리케이션을 다시 시작하지 않고 바뀐 plugin을 보인다.

## 첫 실행

`environment.json`의 `starter`가 starter pack을 정한다. 창이 시작할 때 `pluginsState`가 `firstRun`을 보고하면, workbench는 space를 만들기 전에 registry index에서 그 pack의 모든 plugin을 pack의 순서대로 `pluginsRun`으로 설치하고, 설치한 plugin을 불러오도록 page를 다시 불러온다. 첫 설치가 `installed.json`을 쓰므로, 이후의 시작은 모든 plugin을 지운 뒤라도 아무것도 설치하지 않는다. `environment.json`이 `registry`에 기본 registry를 정하고 `pluginsState`가 registry가 없다고 보고하면, workbench는 먼저 `pluginsUseRegistry`로 그 registry를 정하고 상태를 다시 읽는다. 두 registry가 모두 없으면 창은 plugin 없이 시작하고 `first run: no registry is set; the starter pack <name> was not installed`를 기록하며, plugin이 없는 창이 그 이유를 밝히도록 애플리케이션 오류 `플러그인 레지스트리가 없어 시작 플러그인 묶음 <name>을 설치하지 못했습니다. sok registry use 로 레지스트리를 정한 뒤 다시 시작하세요.`를 보인다. 읽지 못한 registry index나 그 pack이 없는 index는 그 오류로 시작을 실패시킨다. `starter`가 없는 environment나 host가 없는 환경은 아무것도 설치하지 않는다.

