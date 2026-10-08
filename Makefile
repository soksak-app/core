SHELL := /bin/sh

.PHONY: preflight prepare build verify browser-example-check registry-manifest-check docs-check records-check commits-check hooks boundaries platforms windows-build-check hosts-check e2e-check e2e-registry-tls exposure-check parity-check host-parity-check language-test release-check rust-tests-alone rust-repeat go-repeat node-repeat page-memory

docs-check:
	@node scripts/check-docs.mjs
	@node packages/plugin-api/records-check.js

# 문서와 설정 주석이 저장소에 관한 사실만 적는지 검사한다(AGENTS.md Documentation).
records-check:
	@node packages/plugin-api/records-check.js

# RANGE 의 커밋 메시지 형식을 검사한다. 예: make commits-check RANGE=origin/main..HEAD
commits-check:
	@test -n "$(RANGE)" || { echo "make commits-check RANGE=<revision range>" >&2; exit 2; }
	@node packages/plugin-api/commits-check.js "$(RANGE)"

# 이 checkout 의 git hook 폴더를 .githooks 로 정한다. commit-msg hook 이 커밋 메시지 형식을 검사한다.
hooks:
	@git config core.hooksPath .githooks

# release 빌드를 만들고, 스테이징된 프런트엔드와 release 실행 파일에 진단 코드가 없는지 검사한다.
release-check: wailsv3-build-release tauriv2-build-release registry-manifest-check
	@node scripts/check-release.mjs --macos-minimum $(MACOS_MINIMUM) --wailsv3-bundle "$(WAILS_RELEASE_BUNDLE)" --tauriv2-bundle "$(TAURI_RELEASE_BUNDLE)"

# Checks that the core of this checkout accepts the manifest of every plugin version of the public registry that it
# installs (docs/operations/examples.md).
registry-manifest-check:
	@node scripts/check-registry-manifests.mjs

# 실행 중인 애플리케이션의 main page process 메모리를 시작, 유휴, 다시 읽기 뒤에 잰다(docs/operations/examples.md).
# APP 은 wailsv3 또는 tauriv2, CONFIG 는 그 애플리케이션의 설정 폴더, BUILD 는 release(기본) 또는 debug 다.
page-memory:
	@case "$(APP)" in wailsv3|tauriv2) ;; *) echo "page-memory requires APP=wailsv3|tauriv2 CONFIG=DIR [BUILD=release|debug] [MINUTES=60] [RELOADS=20]" >&2; exit 2;; esac
	@case "$(CONFIG)" in '') echo "page-memory requires CONFIG=DIR" >&2; exit 2;; esac
	@case "$(BUILD)" in ''|release|debug) ;; *) echo "page-memory requires BUILD=release|debug" >&2; exit 2;; esac
	@node scripts/measure-page-memory.mjs --sok $(if $(filter debug,$(BUILD)),target/debug/soksak-$(APP).app,target/release/$(APP)/soksak.app)/Contents/MacOS/sok --config-dir "$(CONFIG)" --idle-minutes $(or $(MINUTES),60) --reloads $(or $(RELOADS),20)

# 코어, 플러그인, 사이드카가 서로의 이름을 코드에 적지 않았는지 검사한다.
boundaries:
	@node scripts/check-boundaries.mjs

# registry window check 의 TLS 인증서(docs/operations/examples.md). 검사 소유 인증 기관과 127.0.0.1 의 server 인증서를
# 만든다. 진단 build 의 check 애플리케이션은 --registry-ca <폴더>/ca.pem 으로 시작한다. 이미 있으면 바꾸지 않는다.
E2E_REGISTRY_TLS = $(or $(SOKSAK_CONFIG_ROOT),$(TMPDIR))/soksak-check-registry-tls
e2e-registry-tls:
	@test -n "$(or $(SOKSAK_CONFIG_ROOT),$(TMPDIR))" || { echo "e2e-registry-tls needs TMPDIR or SOKSAK_CONFIG_ROOT" >&2; exit 2; }
	@if [ -f "$(E2E_REGISTRY_TLS)/ca.pem" ]; then echo "$(E2E_REGISTRY_TLS)"; exit 0; fi; \
	  set -e; mkdir -p "$(E2E_REGISTRY_TLS)"; cd "$(E2E_REGISTRY_TLS)"; \
	  printf 'basicConstraints=CA:FALSE\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > server.ext; \
	  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=soksak check registry authority" \
	    -keyout ca-key.pem -out ca.pem -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign 2>/dev/null; \
	  openssl req -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" -keyout server-key.pem -out server.csr 2>/dev/null; \
	  openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 3650 -extfile server.ext -out server.pem 2>/dev/null; \
	  rm -f server.csr ca.srl server.ext; echo "$(E2E_REGISTRY_TLS)"

# 창 검사가 엔드포인트의 선언된 항목과 네이티브 입력만 쓰는지 검사한다.
# 스테이징한 브라우저 예제에서 프로젝트를 열고 페이지 오류가 없는지 headless Chrome 으로 검사한다.
browser-example-check: browser-frontend
	@pnpm -F @soksak/browser check

# 브라우저 예제는 host 가 없으므로 BROWSER_CONFIG 에 BROWSER_PLUGINS 를 설치하고, 스테이징이 그 설치를 host 처럼
# 제공한다(docs/spec/plugins.md 의 스테이징 배치).
BROWSER_CONFIG = target/browser-config
BROWSER_PLUGINS = terminal browser

browser-frontend: registry
	@rm -rf $(BROWSER_CONFIG)
	@target/debug/sok registry use $(REGISTRY)/index.json --config-dir $(BROWSER_CONFIG)
	@for id in $(BROWSER_PLUGINS); do target/debug/sok plugin install $$id --config-dir $(BROWSER_CONFIG) || exit 1; done
	@pnpm -F @soksak/browser exec soksak-stage build --installed $(CURDIR)/$(BROWSER_CONFIG)

browser-example: browser-frontend
	@python3 -m http.server 8749 -d apps/browser/build

e2e-check:
	@node scripts/check-e2e.mjs

# UI 조작이 명령을 거치고, 표시한 이름이 모두 선언되고 등록되었는지 검사한다.
exposure-check:
	@node scripts/check-exposure.mjs

# 전체 소스·테스트 목록의 연결을 검사한다. 동작 검증 결과와 구분한다.
parity-check:
	@node scripts/check-test-parity.mjs

# 두 호스트의 공개 API 면(호출 이름·연결·엔드포인트 메서드)이 같은지 기계로 검사한다(docs/spec/host-parity.md).
host-parity-check:
	@node scripts/check-host-parity.mjs

# JS/TS, Rust, Go, Objective-C, shell 테스트 케이스는 같은 관측 가능한 케이스 계약을 사용한다.
language-test: native-darwin
	@$(MAKE) -C native/darwin $(CURDIR)/native/darwin/build/appearance_test
	@node scripts/language-test-adapters.mjs scripts/language-test-cases.json

# Rust 패키지의 각 테스트를 새 프로세스에서 혼자 실행한다. 다른 테스트가 만든 상태나 시간 순서에 기대는 테스트를 찾는다.
# 첫 실패에서 테스트 이름을 보고한다. MANIFEST 는 패키지가 속한 작업 공간의 Cargo.toml 이고 FEATURES 는 cargo 의 --features 값이다.
MANIFEST ?= Cargo.toml
rust-tests-alone:
	@case "$(PACKAGE)" in '') echo "rust-tests-alone requires PACKAGE=<cargo package> [FEATURES=<features>] [MANIFEST=<Cargo.toml>]" >&2; exit 2;; esac
	@cargo test -q --manifest-path $(MANIFEST) -p $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) --no-run
	@names=$$(cargo test -q --manifest-path $(MANIFEST) -p $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) -- --list 2>/dev/null | sed -n 's/: test$$//p'); \
	  count=0; for name in $$names; do \
	    count=$$((count + 1)); \
	    cargo test -q --manifest-path $(MANIFEST) -p $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) -- --exact "$$name" > /dev/null 2>&1 \
	      || { echo "FAIL: $(PACKAGE) $$name fails when it runs alone (test $$count)" >&2; exit 1; }; \
	  done; \
	  [ $$count -gt 0 ] || { echo "rust-tests-alone found no tests in $(PACKAGE)" >&2; exit 1; }; \
	  echo "$(PACKAGE): $$count tests pass alone"

# Rust 패키지의 테스트를 COUNT 번 차례로 실행한다. TEST 를 주면 그 이름의 테스트만 실행한다.
# 간헐 실패를 재현하고 수용하는 대상이다. 첫 실패에서 실행 번호, 시스템 부하, 그 실행의 출력을 보고한다.
rust-repeat:
	@case "$(PACKAGE)" in '') echo "rust-repeat requires PACKAGE=<cargo package> COUNT=<n> [TEST=<name>] [FEATURES=<features>] [MANIFEST=<Cargo.toml>]" >&2; exit 2;; esac
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "rust-repeat requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@cargo test -q --manifest-path $(MANIFEST) -p $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) --no-run
	@output=$$(mktemp); trap 'rm -f "$$output"' EXIT; \
	  run=1; while [ $$run -le $(COUNT) ]; do \
	    if [ -n "$(TEST)" ]; then cargo test -q --manifest-path $(MANIFEST) -p $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) -- --exact "$(TEST)" > "$$output" 2>&1; \
	    else cargo test -q --manifest-path $(MANIFEST) -p $(PACKAGE) $(if $(FEATURES),--features $(FEATURES)) > "$$output" 2>&1; fi \
	      || { cat "$$output"; echo "FAIL: $(PACKAGE) $(TEST) run $$run of $(COUNT); load $$(sysctl -n vm.loadavg)" >&2; exit 1; }; \
	    if [ -n "$(TEST)" ] && ! grep -q "1 passed" "$$output"; then cat "$$output"; echo "FAIL: $(PACKAGE) has no test named $(TEST)" >&2; exit 1; fi; \
	    run=$$((run + 1)); \
	  done; \
	  echo "$(PACKAGE) $(TEST): $(COUNT) of $(COUNT) runs pass"

# Go 패키지의 테스트를 COUNT 번 차례로 실행한다. TEST 는 go test -run 정규식이고 TAGS 는 go test -tags 값이다.
# 빌드된 테스트 파일이 없거나(build tag) 이름이 맞는 테스트가 없는 실행은 실패다.
# 간헐 실패를 재현하고 수용하는 대상이다. 첫 실패에서 실행 번호, 시스템 부하, 그 실행의 출력을 보고한다.
go-repeat:
	@case "$(PACKAGE)" in '') echo "go-repeat requires PACKAGE=<go package path> COUNT=<n> [TEST=<regexp>] [TAGS=<tags>]" >&2; exit 2;; esac
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "go-repeat requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@output=$$(mktemp); trap 'rm -f "$$output"' EXIT; \
	  run=1; while [ $$run -le $(COUNT) ]; do \
	    $(GO_ENV) go test -count=1 $(if $(TAGS),-tags '$(TAGS)') -ldflags "$(GO_LINK)" $(if $(TEST),-run '$(TEST)') $(PACKAGE) > "$$output" 2>&1 \
	      || { cat "$$output"; echo "FAIL: $(PACKAGE) $(TEST) run $$run of $(COUNT); load $$(sysctl -n vm.loadavg)" >&2; exit 1; }; \
	    if grep -q "no tests to run" "$$output"; then cat "$$output"; echo "FAIL: $(PACKAGE) has no test matching $(TEST)" >&2; exit 1; fi; \
	    if grep -q "no test files" "$$output"; then cat "$$output"; echo "FAIL: $(PACKAGE) has no test files built with tags '$(TAGS)'" >&2; exit 1; fi; \
	    run=$$((run + 1)); \
	  done; \
	  echo "$(PACKAGE) $(TEST): $(COUNT) of $(COUNT) runs pass"

# 저장소 루트에서 Node 테스트 파일의 이름 패턴에 맞는 테스트를 COUNT 번 차례로 실행한다.
# 간헐 실패를 재현하고 수용하는 대상이다. 첫 실패에서 실행 번호, 시스템 부하, 그 실행의 출력을 보고한다.
# 실행한 테스트는 기계 형식인 TAP 결과에서 센다. 사람이 읽는 출력은 환경에 따라 색 코드가 붙고, 이름이 맞는 테스트가
# 없으면 파일 자체가 통과 결과 하나로 보고되므로 제목이 이름 패턴에 맞고 건너뛰지 않은 결과만 센다.
node-repeat: SHELL := /bin/bash -o pipefail
node-repeat:
	@case "$(FILE)" in '') echo "node-repeat requires FILE=<test file> NAME=<test name pattern> COUNT=<n>" >&2; exit 2;; esac
	@case "$(COUNT)" in ''|*[!0-9]*|0) echo "node-repeat requires COUNT=<n> with n >= 1" >&2; exit 2;; esac
	@output=$$(mktemp); trap 'rm -f "$$output"' EXIT; \
	  run=1; while [ $$run -le $(COUNT) ]; do \
	    echo "START: $(FILE) $(NAME) run $$run of $(COUNT)"; \
	    node --test --experimental-test-module-mocks --test-reporter=tap --test-name-pattern='$(NAME)' $(FILE) 2>&1 | tee "$$output" \
	      || { echo "FAIL: $(FILE) $(NAME) run $$run of $(COUNT); load $$(sysctl -n vm.loadavg)" >&2; exit 1; }; \
	    sed -nE 's/^[[:space:]]*ok [0-9]+ - //p' "$$output" | grep -v '# SKIP' | grep -qE -- '$(NAME)' \
	      || { echo "FAIL: no test in $(FILE) matched $(NAME)" >&2; exit 1; }; \
	    run=$$((run + 1)); \
	  done; \
	  echo "$(FILE) $(NAME): $(COUNT) of $(COUNT) runs pass"

# 운영체제별 코드가 platform/<os>/ 아래에만 있는지 검사한다.
platforms:
	@node scripts/check-platforms.mjs

# 두 네이티브 호스트의 원본을 Windows 대상으로 기본 build 와 진단 build 로 컴파일한다. platforms 와 hosts-check 의
# 파일 배치 검사는 Windows 구현(platform/windows/)과 공용 코드의 운영체제 API 사용을 확인하지 않으므로 이 검사가
# 컴파일로 확인한다. 호스트 테스트는 macOS 에서만 실행하므로(docs/spec/host-contract.md) 컴파일 대상이 아니다.
WINDOWS_GOARCH      = arm64
windows-build-check:
	@echo "START: wailsv3 host go vet GOOS=windows GOARCH=$(WINDOWS_GOARCH)"
	@cd packages/host/wailsv3 && GOOS=windows GOARCH=$(WINDOWS_GOARCH) go vet ./src/...
	@echo "PASS: wailsv3 host for windows/$(WINDOWS_GOARCH)"
	@echo "START: wailsv3 host go vet -tags diagnostics GOOS=windows GOARCH=$(WINDOWS_GOARCH)"
	@cd packages/host/wailsv3 && GOOS=windows GOARCH=$(WINDOWS_GOARCH) go vet -tags diagnostics ./src/...
	@echo "PASS: wailsv3 diagnostics host for windows/$(WINDOWS_GOARCH)"

# 두 네이티브 호스트와 두 네이티브 앱의 파일 구조가 허용된 차이만 갖는지 검사한다.
hosts-check: windows-build-check
	@node scripts/check-hosts.mjs

preflight:
	@scripts/check-build-environment.sh

prepare: preflight
	@CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm install --frozen-lockfile

build: prepare
	@pnpm build

verify: prepare docs-check exposure-check parity-check host-parity-check
	@pnpm test
	@$(MAKE) language-test
	@pnpm breaks
	@pnpm build
	@git diff --exit-code -- packages/soksak/dist

# 애플리케이션. 두 네이티브 앱과 사이드카 실행 파일은 target/{debug,release} 에 놓인다. 각 앱은 environment.json 으로 프런트엔드를 조립하고, 빌드 전에
# 프런트엔드를 앱 디렉터리에 스테이징한다. 두 네이티브 앱은 go:embed 와
# generate_context! 로 스테이징된 프런트엔드를 컴파일 시점에 포함한다.
#
# 각 앱은 debug 와 release 두 프로필로 빌드한다. release 는 각 도구의 표준 축소
# 옵션(cargo release 프로필, Go 의 -s -w -trimpath)을 사용한다. debug 는 진단 빌드(Go 태그·cargo
# 기능 diagnostics)다. While the declared release version is 0.0.x, release is a diagnostic build too, so a defect on a
# user's machine is recorded when it appears (AGENTS.md); a later version series builds release without diagnostics.
COMMA := ,
# The declared release version is the RELEASE constant of scripts/check-versions.mjs.
DIAGNOSTIC_RELEASE := $(filter 0.0.%,$(shell sed -n 's/^export const RELEASE = "\(.*\)";$$/\1/p' scripts/check-versions.mjs))
.PHONY: native-darwin registry install-plugins browser-frontend browser-example frontend-wailsv3 frontend-tauriv2 native-test host-contract-check rust-format-check rust-clippy-check go-format-check \
        tauriv2 tauriv2-release tauriv2-build tauriv2-build-release \
        wailsv3 wailsv3-release wailsv3-build wailsv3-build-release \
        examples-verify examples-size

# rustup 은 cargo 를 여기에 설치하고 셸 프로필에 경로를 추가한다. make 의 셸은
# 프로필을 읽지 않는다.
export PATH := $(HOME)/.cargo/bin:$(PATH)

# 네이티브 앱의 최소 macOS 버전. 캡처 코드가 macOS 14.4 의
# getCurrentProcessShareableContentWithCompletionHandler API 를
# 사용한다. Go 는 CGO_CFLAGS 로 모든 cgo 패키지에, 링커에는 -extldflags 로 전달한다.
# Rust 와 cc 는 MACOSX_DEPLOYMENT_TARGET 을 읽는다.
MACOS_MINIMUM = 14.4
export PKG_CONFIG_PATH := $(CURDIR)/native/darwin/build
# go build 는 cgo 가 링크하는 정적 라이브러리의 내용을 캐시 키에 넣지 않고 CGO_CFLAGS 는 넣는다.
# 라이브러리 해시를 CGO_CFLAGS 에 넣어 라이브러리가 바뀌면 cgo 패키지를 다시 컴파일하고 다시 링크한다.
GO_ENV       = CGO_CFLAGS="-O2 -g -mmacosx-version-min=$(MACOS_MINIMUM) -DSOKSAK_DARWIN_LIBRARY=$$(shasum -a 256 native/darwin/build/libsoksak-darwin.a | cut -c1-16)"
GO_LINK      = -extldflags=-mmacosx-version-min=$(MACOS_MINIMUM)
CARGO_ENV    = MACOSX_DEPLOYMENT_TARGET=$(MACOS_MINIMUM)

# macOS 의 알림 센터는 번들에서 실행된 프로세스만 받으므로 애플리케이션은 번들에서 실행한다
# (docs/spec/hosts.md). 사이드카도 번들의 Contents/MacOS 에 둔다.
TAURI_DEBUG_BUNDLE   = target/debug/soksak-tauriv2.app
TAURI_RELEASE_BUNDLE = target/release/tauriv2/soksak.app
WAILS_DEBUG_BUNDLE   = target/debug/soksak-wailsv3.app
WAILS_RELEASE_BUNDLE = target/release/wailsv3/soksak.app
TAURI_DEBUG   = $(TAURI_DEBUG_BUNDLE)/Contents/MacOS/soksak-tauriv2
TAURI_RELEASE = $(TAURI_RELEASE_BUNDLE)/Contents/MacOS/soksak-tauriv2
WAILS_DEBUG   = $(WAILS_DEBUG_BUNDLE)/Contents/MacOS/soksak-wailsv3
WAILS_RELEASE = $(WAILS_RELEASE_BUNDLE)/Contents/MacOS/soksak-wailsv3

# 번들의 Info.plist 와 Dock 아이콘을 쓴다. 첫 인자는 번들, 둘째 인자는 애플리케이션이다. 앱 이름은
# Info.plist 의 CFBundleDisplayName 이 정한다(지원 언어는 같은 plist 의 CFBundleLocalizations 선언).
# 이름을 언어마다 다르게 주게 되는 날에는 그 언어의 .lproj/InfoPlist.strings 를 그때 다시 둔다.
# 번들의 Contents 는 build 마다 새로 만든다. 이전 build 가 넣은 파일(bundle 에 더 이상 넣지 않는 sidecar 등)이
# 남으면 bundle 이 지금의 build 와 달라지기 때문이다.
bundle-info = rm -rf $(1)/Contents && mkdir -p $(1)/Contents/MacOS $(1)/Contents/Resources \
	&& cp apps/$(2)/platform/darwin/Info.plist $(1)/Contents/Info.plist \
	&& cp apps/$(2)/platform/darwin/AppIcon.icns $(1)/Contents/Resources/AppIcon.icns
# 디버그 번들은 release 애플리케이션 옆에서 실행되도록 Info.plist 의 release 식별자에 .dev 를 붙이고 번들 이름을
# 실행 파일 이름으로 쓴다(docs/spec/hosts.md#frontend-and-executables). 첫 인자는 번들, 둘째 인자는 애플리케이션이다.
bundle-dev = plutil -replace CFBundleIdentifier -string "$$(plutil -extract CFBundleIdentifier raw $(1)/Contents/Info.plist).dev" $(1)/Contents/Info.plist \
	&& plutil -replace CFBundleName -string soksak-$(2) $(1)/Contents/Info.plist
# 번들 안의 실행 파일과 Info.plist 를 ad hoc 서명으로 봉인하고 LaunchServices 에 다시 등록한다. Dock 은
# 등록된 번들 정보로 아이콘을 보이며, 번들 안의 파일만 바뀌면 LaunchServices 는 등록을 새로 읽지 않는다.
LSREGISTER = /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
bundle-sign = codesign --sign - --force --deep $(1) && $(LSREGISTER) -f $(1)

# command line sok(docs/spec/cli.md)을 build 해 번들의 실행 파일 옆에 둔다. 첫 인자는 번들, 둘째 인자는 profile 이다.
sok-wailsv3 = go build -C packages/sok/wailsv3 $(if $(filter release,$(2)),-trimpath -ldflags "-s -w") $(if $(filter debug,$(2)),-tags "diagnostics dev",$(if $(DIAGNOSTIC_RELEASE),-tags diagnostics)) -o ../../../$(1)/Contents/MacOS/sok ./src/cmd/sok
sok-tauriv2 = cargo build -p soksak-sok-tauriv2 $(if $(filter release,$(2)),--release) $(if $(filter debug,$(2)),--features diagnostics$(COMMA)dev,$(if $(DIAGNOSTIC_RELEASE),--features diagnostics)) && cp target/$(2)/sok $(1)/Contents/MacOS/sok

native-darwin:
	@$(MAKE) -C native/darwin

# 워크스페이스 registry. scripts/workspace-registry.json 이 선언한 sibling plugin repository 를 진단 package 로 pack
# 하고, 그 plugin 이 쓰는 sidecar 를 선언된 sidecar repository 에서 build 해 현재 플랫폼으로 release 한 뒤
# target/registry 에 index.json 을 만든다(docs/spec/plugins.md#repositories). 진단 build 와 window check 가 여기서
# 설치한다.
REGISTRY = target/registry

registry:
	@cargo build -p soksak-sok-tauriv2
	@node scripts/workspace-registry.mjs --sok target/debug/sok --out $(REGISTRY) --diagnostics

# CONFIG 설정 폴더에 workspace registry 의 plugin 을 모두 설치한다. 애플리케이션은 bundle 에 plugin 을 담지 않으므로
# window check 와 개발 실행은 애플리케이션을 시작하기 전에 이것으로 설치한다. 워크스페이스 plugin 은 version 을 바꾸지
# 않고 고치므로, 같은 version 이 이미 설치되어 있으면 설치가 아무것도 바꾸지 않는다. 그래서 설치된 plugin 을 먼저
# 지우고 다시 설치한다.
install-plugins: registry
	@test -n "$(CONFIG)" || { echo "make install-plugins CONFIG=<configuration directory>" >&2; exit 2; }
	@target/debug/sok registry use $(REGISTRY)/index.json --config-dir "$(CONFIG)"
	@for id in $$(node -e 'const f = "$(CONFIG)/plugins/installed.json"; const fs = require("fs"); console.log(fs.existsSync(f) ? Object.keys(JSON.parse(fs.readFileSync(f, "utf8")).plugins).join(" ") : "")'); do \
		target/debug/sok plugin remove $$id --config-dir "$(CONFIG)" || exit 1; done
	@for id in $$(node -e 'console.log(JSON.parse(require("fs").readFileSync("$(REGISTRY)/index.json", "utf8")).plugins.map((p) => p.id).join(" "))'); do \
		target/debug/sok plugin install $$id --config-dir "$(CONFIG)" || exit 1; done

# 프런트엔드를 배치한다. 인자는 추가 플래그다. debug 는 페이지 진단 모듈을 넣고(--diagnostics), release 는 넣지
# 않는다. plugin 과 sidecar 는 bundle 에 넣지 않으며 설정 폴더에 설치한다(make install-plugins).
stage-wailsv3 = pnpm -F @soksak/wailsv3 exec soksak-stage src/frontend $(1)
stage-tauriv2 = pnpm -F @soksak/tauriv2 exec soksak-stage src/frontend $(1)

# 배치는 bundle 을 건드리지 않는다. bundle 은 build target 만 다시 만든다. 검사가 쓰는 debug 앱의 실행 파일이
# native-test 같은 검사 target 의 배치로 지워지지 않게 하기 위해서다.
frontend-wailsv3: build
	@$(call stage-wailsv3,--diagnostics)

frontend-tauriv2: build
	@$(call stage-tauriv2,--diagnostics)

# generate_context! 가 프런트엔드를 포함하므로 크레이트를 다시 빌드하게 한다.
tauriv2-build: native-darwin frontend-tauriv2
	@$(call bundle-info,$(TAURI_DEBUG_BUNDLE),tauriv2)
	@$(call bundle-dev,$(TAURI_DEBUG_BUNDLE),tauriv2)
	@touch apps/tauriv2/src/main.rs
	@$(CARGO_ENV) cargo build -p soksak-tauriv2 --features diagnostics,dev
	@cp target/debug/soksak-tauriv2 $(TAURI_DEBUG)
	@$(call sok-tauriv2,$(TAURI_DEBUG_BUNDLE),debug)
	@$(call bundle-sign,$(TAURI_DEBUG_BUNDLE))

tauriv2-build-release: native-darwin build
	@$(call bundle-info,$(TAURI_RELEASE_BUNDLE),tauriv2)
	@$(call stage-tauriv2,$(if $(DIAGNOSTIC_RELEASE),--diagnostics))
	@touch apps/tauriv2/src/main.rs
	@$(CARGO_ENV) cargo build --release -p soksak-tauriv2 $(if $(DIAGNOSTIC_RELEASE),--features diagnostics)
	@cp target/release/soksak-tauriv2 $(TAURI_RELEASE)
	@$(call sok-tauriv2,$(TAURI_RELEASE_BUNDLE),release)
	@$(call bundle-sign,$(TAURI_RELEASE_BUNDLE))

wailsv3-build: native-darwin frontend-wailsv3
	@$(call bundle-info,$(WAILS_DEBUG_BUNDLE),wailsv3)
	@$(call bundle-dev,$(WAILS_DEBUG_BUNDLE),wailsv3)
	@$(GO_ENV) go build -C apps/wailsv3 -tags "diagnostics dev" -ldflags "$(GO_LINK)" -o ../../$(WAILS_DEBUG) ./src
	@$(call sok-wailsv3,$(WAILS_DEBUG_BUNDLE),debug)
	@$(call bundle-sign,$(WAILS_DEBUG_BUNDLE))

wailsv3-build-release: native-darwin build
	@$(call bundle-info,$(WAILS_RELEASE_BUNDLE),wailsv3)
	@$(call stage-wailsv3,$(if $(DIAGNOSTIC_RELEASE),--diagnostics))
	@$(GO_ENV) go build -C apps/wailsv3 -trimpath $(if $(DIAGNOSTIC_RELEASE),-tags diagnostics) -ldflags "-s -w $(GO_LINK)" -o ../../$(WAILS_RELEASE) ./src
	@$(call sok-wailsv3,$(WAILS_RELEASE_BUNDLE),release)
	@$(call bundle-sign,$(WAILS_RELEASE_BUNDLE))

tauriv2: tauriv2-build
	@./$(TAURI_DEBUG)

tauriv2-release: tauriv2-build-release
	@./$(TAURI_RELEASE)

wailsv3: wailsv3-build
	@./$(WAILS_DEBUG)

wailsv3-release: wailsv3-build-release
	@./$(WAILS_RELEASE)

# 네이티브 코드의 단위 검사. 공용 입력 검사와 두 호스트의 테스트를 실행하는 호스트 계약 검사를 실행한다.
# sidecar 의 검사는 각 sidecar repository 가 실행한다.
native-test: native-darwin frontend-wailsv3 frontend-tauriv2
	@$(MAKE) rust-format-check
	@$(MAKE) rust-clippy-check
	@$(MAKE) go-format-check
	@$(MAKE) -C native/darwin test
	@$(GO_ENV) $(CARGO_ENV) node scripts/check-host-contract.mjs --go-ldflags "$(GO_LINK)"

# 저장소가 추적하는 모든 Go 파일이 gofmt 형식인지 검사한다. 형식이 다른 파일을 모두 보고하고 실패한다.
go-format-check:
	@files=$$(git ls-files '*.go'); \
	  unformatted=$$(gofmt -l $$files) || exit 1; \
	  if [ -n "$$unformatted" ]; then echo "Go files not in gofmt format:" >&2; echo "$$unformatted" >&2; exit 1; fi; \
	  echo "Go format check passed: $$(echo $$files | wc -w | tr -d ' ') files"

# Rust 워크스페이스의 모든 패키지와 test 를 진단 build 와 일반 build 에서 clippy 경고 없이 검사한다.
rust-clippy-check: native-darwin
	@$(CARGO_ENV) cargo clippy --workspace --tests --features soksak-host-tauriv2/diagnostics -- -D warnings
	@$(CARGO_ENV) cargo clippy --workspace --tests -- -D warnings
	@echo "Rust clippy check passed: 1 workspace, diagnostics and default builds"

# Rust 워크스페이스의 모든 패키지가 rustfmt 형식인지 검사한다.
rust-format-check:
	@cargo fmt --all --check
	@echo "Rust format check passed: 1 workspace"

# 두 호스트의 테스트를 기본 구성과 진단 구성으로 실행하고, 호스트 계약 사례(docs/spec/host-contract.md)를
# 같은 수준으로 실행하는지 결과로 검사한다.
host-contract-check: native-darwin frontend-wailsv3 frontend-tauriv2
	@$(GO_ENV) $(CARGO_ENV) node scripts/check-host-contract.mjs --go-ldflags "$(GO_LINK)"

# 이미 실행 중인 앱의 창을 로컬 엔드포인트로 순차 검사한다. 하네스는 앱을 실행하지 않는다.
examples-verify: docs-check e2e-check exposure-check
	@pnpm -F @soksak/e2e run verify

# 두 앱의 두 프로필 빌드와 각 크기.
examples-size: tauriv2-build tauriv2-build-release wailsv3-build-release wailsv3-build
	@printf "%-10s %10s %10s\n" "" debug release
	@printf "%-10s %9.1fM %9.1fM\n" tauriv2 \
	  $$(echo "$$(stat -f%z $(TAURI_DEBUG))/1048576" | bc -l) \
	  $$(echo "$$(stat -f%z $(TAURI_RELEASE))/1048576" | bc -l)
	@printf "%-10s %9.1fM %9.1fM\n" wailsv3 \
	  $$(echo "$$(stat -f%z $(WAILS_DEBUG))/1048576" | bc -l) \
	  $$(echo "$$(stat -f%z $(WAILS_RELEASE))/1048576" | bc -l)
