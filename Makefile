SHELL := /bin/sh

.PHONY: preflight prepare build verify docs-check boundaries

docs-check:
	@node scripts/check-docs.mjs

# 코어, 플러그인, 사이드카가 서로의 이름을 코드에 적지 않았는지 검사한다.
boundaries:
	@node scripts/check-boundaries.mjs

preflight:
	@scripts/check-build-environment.sh

prepare: preflight
	@CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm install --frozen-lockfile

build: prepare
	@pnpm build

verify: prepare docs-check
	@pnpm test
	@pnpm breaks
	@pnpm build
	@git diff --exit-code -- packages/soksak/dist

# 애플리케이션. 각 앱은 environment.json 으로 프런트엔드를 조립하고, 빌드 전에
# 프런트엔드를 앱 디렉터리에 스테이징한다. 두 네이티브 앱은 go:embed 와
# generate_context! 로 스테이징된 프런트엔드를 컴파일 시점에 포함한다.
#
# 각 앱은 debug 와 release 두 프로필로 빌드한다. release 는 각 도구의 표준 축소
# 옵션(cargo release 프로필, Go 의 -s -w -trimpath)을 사용한다.
.PHONY: native-darwin sidecars frontend-wails frontend-tauri native-test \
        tauri tauri-release tauri-build tauri-build-release \
        wails wails-release wails-build wails-build-release \
        examples-verify examples-size

# rustup 은 cargo 를 여기에 설치하고 셸 프로필에 경로를 추가한다. make 의 셸은
# 프로필을 읽지 않는다.
export PATH := $(HOME)/.cargo/bin:$(PATH)

# 네이티브 앱의 최소 macOS 버전. 캡처 코드가 macOS 14.0 의 ScreenCaptureKit API 를
# 사용한다. Go 는 CGO_CFLAGS 로 모든 cgo 패키지에, 링커에는 -extldflags 로 전달한다.
# Rust 와 cc 는 MACOSX_DEPLOYMENT_TARGET 을 읽는다.
MACOS_MINIMUM = 14.0
export PKG_CONFIG_PATH := $(CURDIR)/native/darwin/build
GO_ENV       = CGO_CFLAGS="-O2 -g -mmacosx-version-min=$(MACOS_MINIMUM)"
GO_LINK      = -extldflags=-mmacosx-version-min=$(MACOS_MINIMUM)
CARGO_ENV    = MACOSX_DEPLOYMENT_TARGET=$(MACOS_MINIMUM)

TAURI_DEBUG   = apps/tauri/src-tauri/target/debug/soksak-tauri
TAURI_RELEASE = apps/tauri/src-tauri/target/release/soksak-tauri
WAILS_DEBUG   = apps/wails/bin/wails
WAILS_RELEASE = apps/wails/bin/wails-release

native-darwin:
	@$(MAKE) -C native/darwin

# 사이드카. 각 사이드카 패키지의 build 스크립트가 실행 파일을 만들고, 스테이징이 플러그인이
# 의존하는 사이드카의 실행 파일을 애플리케이션 실행 파일 옆에 복사한다.
sidecars:
	@$(GO_ENV) pnpm --filter "./sidecars/*" run build

# 프런트엔드와 사이드카 실행 파일을 배치한다. 인자는 실행 파일 디렉터리(앱 디렉터리 기준)다.
stage-wails = pnpm -F @soksak/wails exec soksak-stage frontend --executables $(1)
stage-tauri = pnpm -F @soksak/tauri exec soksak-stage frontend --executables $(1)

frontend-wails: build sidecars
	@$(call stage-wails,bin)

frontend-tauri: build sidecars
	@$(call stage-tauri,src-tauri/target/debug)

# generate_context! 가 프런트엔드를 포함하므로 크레이트를 다시 빌드하게 한다.
tauri-build: native-darwin frontend-tauri
	@touch apps/tauri/src-tauri/src/main.rs
	@cd apps/tauri/src-tauri && $(CARGO_ENV) cargo build

tauri-build-release: native-darwin build sidecars
	@$(call stage-tauri,src-tauri/target/release)
	@touch apps/tauri/src-tauri/src/main.rs
	@cd apps/tauri/src-tauri && $(CARGO_ENV) cargo build --release

wails-build: native-darwin frontend-wails
	@$(GO_ENV) go build -C apps/wails -ldflags "$(GO_LINK)" -o bin/wails .

wails-build-release: native-darwin frontend-wails
	@$(GO_ENV) go build -C apps/wails -trimpath -ldflags "-s -w $(GO_LINK)" -o bin/wails-release .

tauri: tauri-build
	@./$(TAURI_DEBUG)

tauri-release: tauri-build-release
	@./$(TAURI_RELEASE)

wails: wails-build
	@./$(WAILS_DEBUG)

wails-release: wails-build-release
	@./$(WAILS_RELEASE)

# 네이티브 코드의 단위 검사. 공용 입력 검사, Wails 와 Tauri 호스트 검사를 실행한다.
native-test: native-darwin frontend-wails frontend-tauri
	@$(MAKE) -C native/darwin test
	@$(GO_ENV) go test -C apps/wails -ldflags "$(GO_LINK)" ./...
	@cd apps/tauri/src-tauri && $(CARGO_ENV) cargo test

# 이미 실행 중인 앱의 창을 순차 검사한다. 하네스는 앱을 실행하지 않는다.
examples-verify: docs-check
	@pnpm -F @soksak/e2e run verify

# 두 앱의 두 프로필 빌드와 각 크기.
examples-size: tauri-build tauri-build-release wails-build-release wails-build
	@printf "%-10s %10s %10s\n" "" debug release
	@printf "%-10s %9.1fM %9.1fM\n" tauri \
	  $$(echo "$$(stat -f%z $(TAURI_DEBUG))/1048576" | bc -l) \
	  $$(echo "$$(stat -f%z $(TAURI_RELEASE))/1048576" | bc -l)
	@printf "%-10s %9.1fM %9.1fM\n" wails \
	  $$(echo "$$(stat -f%z $(WAILS_DEBUG))/1048576" | bc -l) \
	  $$(echo "$$(stat -f%z $(WAILS_RELEASE))/1048576" | bc -l)
