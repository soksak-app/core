# Plugin 설치 형식

[English](installation.md)

Plugin 설치가 쓰는 형식이다. [`@soksak/plugin-api/install`](../../packages/plugin-api/install.js)이 이 형식을 정의하고 검증한다. 모든 검증은 알 수 없는 필드를 거부하고 틀린 필드를 밝힌다. Host와 workbench가 plugin을 설치하고 불러오는 방식은 [설치형 plugin](../plans/plugin-installation.ko.md)에서 대기 중이다.

## Version과 범위

Version은 숫자 부분으로 된 `x.y.z`이며 앞자리 0을 쓰지 않고, 숫자로 비교한다. 범위는 다음 중 하나다.

| 범위 | Version |
| --- | --- |
| `x.y.z` | 그 version만 |
| `^x.y.z` | `x.y.z`부터 첫 0이 아닌 자리가 바뀌기 전까지: `^1.2.3`은 `2.0.0` 미만, `^0.2.3`은 `0.3.0` 미만, `^0.0.2`는 `0.0.3` 미만 |
| `~x.y.z` | `x.y.z`부터 `x.(y+1).0` 미만 |
| `>=x.y.z <a.b.c` | `x.y.z`부터 `a.b.c` 미만이며, 빈 범위는 거부한다 |

`*`, `latest`, pre-release 접미사 같은 다른 형식은 거부한다.

## Plugin package

Plugin package는 plugin 파일의 archive `<id>-<version>.tgz`다. 그 `package.json`은 다음을 선언한다.

| 필드 | 뜻 |
| --- | --- |
| `name` | Package 이름이며, 설치한 파일은 `/modules/<name>/`에서 제공된다 |
| `version` | Plugin version |
| `engines.soksak` | Plugin이 지원하는 core API version 범위 |
| `soksak.sidecars` | 선택. `plugin.json` `sidecars`가 가리키는 sidecar마다 version 범위를 정하며, 정확히 그 sidecar만 담는다 |
| `files` | Archive가 담는 package 안의 경로이며 `plugin.json`을 포함한다 |

`package.json`의 다른 필드는 package 도구의 것이므로 읽지 않는다.

## Sidecar release asset

Sidecar version은 플랫폼마다 archive 하나 `<file name>-<version>-<platform>.tar.gz`로 release된다. Sidecar `@scope/name`의 file name은 `scope-name`이고, scope가 없는 이름은 그대로 쓴다. 플랫폼은 `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `windows-arm64`, `windows-x64` 중 하나다.

## Registry index

Registry index `index.json`은 `format` 1과 다음 목록을 가진다.

| 필드 | 항목 |
| --- | --- |
| `plugins` | `{ id, package, name, description, license, repository, versions }`. 각 version은 `{ version, package: { url, sha256 }, engines: { soksak }, sidecars }`이며, `sidecars`는 sidecar 이름마다 범위를 정하고 sidecar가 없는 plugin은 `{}`다 |
| `sidecars` | `{ name, repository, versions }`. 각 version은 `{ version, protocol: 1, assets }`이며, `assets`는 플랫폼마다 `{ url, sha256 }`을 정한다 |
| `packs` | `{ name, description, plugins }`: 함께 설치하는 plugin id |
| `revoked` | `{ plugins: [{ id, version, reason }], sidecars: [{ name, version, reason }] }` |

`url`은 `file:` 또는 `https:` URL이고, `sha256`은 소문자 16진수 64자리다. 설명은 1자에서 200자다. Index 검사는 이 밖에도 plugin id, package, sidecar, pack, version의 중복, 알 수 없는 plugin을 가리키는 pack, 알 수 없는 sidecar나 어떤 sidecar version도 채우지 않는 범위가 필요한 plugin version, 목록에 없는 revoked version을 거부한다.

## Version 선택

Core version과 플랫폼에 맞춰 plugin을 설치하면, `engines.soksak`이 core version을 포함하고 revoked가 아닌 가장 새 plugin version을 고른다. 한 설치에서 sidecar는 version 하나이며, 그 sidecar를 지정한 설치된 plugin이 모두 함께 쓴다. 고른 plugin version의 sidecar마다, 범위는 그 version의 범위와 그 sidecar를 지정한 다른 설치된 plugin의 범위다. 쓰고 있는 version이 모든 범위를 채우고 revoked가 아니며 그 플랫폼 asset이 있으면 그대로 두고, 아니면 모든 범위를 채우고 revoked가 아니며 그 플랫폼 asset이 있는 가장 새 sidecar version을 고른다. 고를 것이 없으면 설치는 plugin, version이나 범위, core version이나 플랫폼을 밝혀 실패하며, sidecar의 경우 각 plugin과 범위를 밝힌다.

## 설치 배치

설정 폴더 안에서 `<id>`의 plugin version `<version>`은 `plugins/<id>/<version>`에, sidecar version의 플랫폼 asset은 `sidecars/<file name>/<version>/<platform>`에 푼다. `plugins/installed.json`은 `format` 1, `plugins`, `sidecars`를 가진다. `plugins`는 plugin id마다 `{ package, version, enabled, sidecars, previous? }`를 정한다. 각각 package 이름, 쓰는 version, 불러올지 여부, 그 version의 sidecar 범위, 되돌리기가 복원할 version이다. 한 package는 한 번만 나온다. `sidecars`는 설치된 plugin이 지정한 sidecar마다 쓰는 version을 정하며, 그 version은 그 sidecar를 지정한 모든 설치된 plugin의 범위를 채운다. 어느 설치된 plugin도 지정하지 않은 sidecar는 나오지 않는다.
