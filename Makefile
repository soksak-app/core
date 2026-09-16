SHELL := /bin/sh

.PHONY: preflight prepare build verify docs-check

docs-check:
	@node scripts/check-docs.mjs

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
.PHONY: native-darwin frontend-wails frontend-tauri \
        tauri tauri-release tauri-build tauri-build-release \
        wails wails-release wails-build wails-build-release \
        examples-verify examples-size

# rustup 은 cargo 를 여기에 설치하고 셸 프로필에 경로를 추가한다. make 의 셸은
# 프로필을 읽지 않는다.
export PATH := $(HOME)/.cargo/bin:$(PATH)

# native/darwin 라이브러리의 헤더와 링크 옵션은 pkg-config 로 찾는다.
export PKG_CONFIG_PATH := $(CURDIR)/native/darwin/build

TAURI_DEBUG   = apps/tauri/src-tauri/target/debug/soksak-tauri
TAURI_RELEASE = apps/tauri/src-tauri/target/release/soksak-tauri
WAILS_DEBUG   = apps/wails/bin/wails
WAILS_RELEASE = apps/wails/bin/wails-release

native-darwin:
	@$(MAKE) -C native/darwin

frontend-wails: build
	@pnpm -F @soksak/wails run frontend

frontend-tauri: build
	@pnpm -F @soksak/tauri run frontend

# generate_context! 가 프런트엔드를 포함하므로 크레이트를 다시 빌드하게 한다.
tauri-build: native-darwin frontend-tauri
	@touch apps/tauri/src-tauri/src/main.rs
	@cd apps/tauri/src-tauri && cargo build

tauri-build-release: native-darwin frontend-tauri
	@touch apps/tauri/src-tauri/src/main.rs
	@cd apps/tauri/src-tauri && cargo build --release

wails-build: native-darwin frontend-wails
	@go build -C apps/wails -o bin/wails .

wails-build-release: native-darwin frontend-wails
	@go build -C apps/wails -trimpath -ldflags "-s -w" -o bin/wails-release .

tauri: tauri-build
	@./$(TAURI_DEBUG)

tauri-release: tauri-build-release
	@./$(TAURI_RELEASE)

wails: wails-build
	@./$(WAILS_DEBUG)

wails-release: wails-build-release
	@./$(WAILS_RELEASE)

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
