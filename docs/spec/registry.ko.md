# 공개 registry

[English](registry.md)

공개 registry는 저장소 `soksak-app/registry`다. 이 저장소는 [registry index](installation.ko.md#registry-index)의 항목마다 파일 하나를 두고, 누구나 pull request로 항목이나 version을 더한다. 검사가 각 pull request를 확인하고, registry 관리자가 검토해 merge하며, `main`으로의 각 push가 애플리케이션의 기본 registry인 `https://soksak-app.github.io/registry/index.json`에 `index.json`을 게시한다([첫 실행](installation.ko.md#첫-실행)).

## 파일

| 경로 | 내용 | 바꾸는 사람 |
| --- | --- | --- |
| `plugins/<id>.json` | index의 plugin 항목 하나 | 항목 저장소의 소유자 |
| `sidecars/<file name>.json` | index의 sidecar 항목 하나 | 항목 저장소의 소유자 |
| `packs/<name>.json` | index의 pack 하나 | registry 관리자 |
| `core.json` | index의 `core`: core release이며 `<platform>-<host>`마다 애플리케이션 번들 zip | registry 관리자 |
| `revoked.json` | index의 `{ plugins, sidecars, core }` | registry 관리자 |
| `.github/`, `scripts/`, `test/`, `CODEOWNERS` | 검사와 workflow | registry 관리자 |

이 파일들이 index의 원천이다. `index.json`은 이 파일들로 `sok registry build`가 만들며([command line](cli.ko.md#release-registry)) commit하지 않는다. `CODEOWNERS`는 관리자만 바꾸는 모든 경로에 registry 관리자를 지정한다. core window check와 개발은 형제 checkout으로 `make registry`가 만드는 로컬 registry를 쓴다([repository](plugins.ko.md#repository)). 공개 registry에는 로컬 build가 없다.

## 항목 규칙

plugin이나 sidecar 항목은 [registry index](installation.ko.md#registry-index)와 다음 규칙을 따른다.

- `repository`는 항목의 release를 게시하는 저장소 `https://github.com/<owner>/<repo>`다.
- 모든 `url`은 `repository`의 `<owner>`와 `<repo>`, 그리고 그 항목의 version을 쓴 `https://github.com/<owner>/<repo>/releases/download/v<version>/<file>`이다. `<file>`은 plugin version이면 `<id>-<version>.tgz`, platform의 sidecar release이면 `<file name>-<version>-<platform>.tar.gz`다([설치](installation.ko.md)).
- `core.json`의 모든 `url`은 `https://github.com/soksak-app/core/releases/download/v<version>/soksak-<version>-<platform>-<host>.zip`이다.
- 게시한 index에 있는 version은 바뀌지 않는다. 그 `url`, `sha256`, `engines`, `sidecars`, `protocol`, release는 그대로이며 지워지지 않는다. version은 `revoked.json` 항목으로만 거둔다.
- plugin id, `package.json`의 plugin 이름, sidecar 이름은 항목 하나에만 속한다.

## 소유자

pull request는 작성자 자신의 항목만 바꾼다. 항목의 `repository`가 작성자의 계정에 속하거나, 작성자가 공개 member인 조직에 속하면(`GET https://api.github.com/orgs/<owner>/public_members/<author>`가 204로 답함) 작성자가 그 항목의 소유자다. 새 항목은 그 소유자에게서 받고, 기존 항목의 변경은 작성자가 base branch의 항목과 pull request의 항목을 모두 소유할 때 받는다.

## 검사

pull request의 검사는 base branch의 script로 pull request의 파일을 데이터로 읽으며, pull request의 파일은 하나도 실행하지 않는다. 다음 경우 파일과 항목을 밝혀 실패한다.

- pull request가 `plugins/`와 `sidecars/`의 항목 파일이 아닌 경로, 곧 관리자만 바꾸는 경로를 바꾼다.
- 파일 이름이 항목과 맞지 않거나 파일이 올바른 JSON이 아니다.
- 항목이 항목 규칙을 어긴다.
- pull request가 더하거나 바꾸는 항목을 작성자가 소유하지 않는다.
- pull request의 registry 전체에서 `sok registry build`가 실패한다. 모든 release를 https로 읽어 `sha256`과 비교하고, 각 plugin release는 그 항목의 `plugin.json`과 `package.json`을 담아야 한다.

## Merge와 게시

- `validate.yml`은 `pull_request`에서 읽기 권한만으로 검사를 실행하므로, 관리자는 그 결과와 함께 pull request를 검토한다.
- registry 관리자는 검사가 통과하고 검토를 마친 pull request를 merge한다.
- `publish.yml`은 `main`으로의 각 push에서 index를 게시한다. `sok registry build`로 `index.json`을 만들고 GitHub Pages로 배포한다.

검사와 게시의 `sok`은 workflow가 지정한 core release의 `sok`이다.

## soksak component의 release

soksak plugin과 sidecar는 registry 관리자가 관리한다. 저장소가 release를 게시한 뒤, 관리자는 registry의 `scripts/add-version.mjs`로 새 version을 항목에 쓰고 그 항목 파일을 `main`에 push하며, 그 push가 게시한다. release가 항목과 맞지 않으면 게시가 실패한다.
