SHELL := /bin/sh

.PHONY: preflight prepare build verify docs-check boundaries platforms hosts-check e2e-check exposure-check parity-check release-check

docs-check:
	@node scripts/check-docs.mjs

# release 빌드를 만들고, 스테이징된 프런트엔드와 release 실행 파일에 진단 코드가 없는지 검사한다.
release-check: wailsv3-build-release tauriv2-build-release
	@node scripts/check-release.mjs

# 코어, 플러그인, 사이드카가 서로의 이름을 코드에 적지 않았는지 검사한다.
boundaries:
	@node scripts/check-boundaries.mjs

# 창 검사가 엔드포인트의 선언된 항목과 네이티브 입력만 쓰는지 검사한다.
e2e-check:
	@node scripts/check-e2e.mjs

# UI 조작이 명령을 거치고, 표시한 이름이 모두 선언되고 등록되었는지 검사한다.
exposure-check:
	@node scripts/check-exposure.mjs

# 전체 소스·테스트 목록의 연결을 검사한다. 동작 검증 결과와 구분한다.
parity-check:
	@node scripts/check-test-parity.mjs

# 운영체제별 코드가 platform/<os>/ 아래에만 있는지 검사한다.
platforms:
	@node scripts/check-platforms.mjs

# 두 네이티브 호스트와 두 네이티브 앱의 파일 구조가 허용된 차이만 갖는지 검사한다.
hosts-check:
	@node scripts/check-hosts.mjs

preflight:
	@scripts/check-build-environment.sh

prepare: preflight
	@CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm install --frozen-lockfile

build: prepare
	@pnpm build

verify: prepare docs-check exposure-check parity-check
	@pnpm test
	@pnpm breaks
	@pnpm build
	@git diff --exit-code -- packages/soksak/dist

# 애플리케이션. 두 네이티브 앱과 사이드카 실행 파일은 target/{debug,release} 에 놓인다. 각 앱은 environment.json 으로 프런트엔드를 조립하고, 빌드 전에
# 프런트엔드를 앱 디렉터리에 스테이징한다. 두 네이티브 앱은 go:embed 와
# generate_context! 로 스테이징된 프런트엔드를 컴파일 시점에 포함한다.
#
# 각 앱은 debug 와 release 두 프로필로 빌드한다. release 는 각 도구의 표준 축소
# 옵션(cargo release 프로필, Go 의 -s -w -trimpath)을 사용한다. debug 는 진단 빌드(Go 태그·cargo
# 기능 diagnostics)이고 release 는 진단 메서드를 포함하지 않는다.
.PHONY: native-darwin sidecars-debug sidecars-release frontend-wailsv3 frontend-tauriv2 native-test \
        tauriv2 tauriv2-release tauriv2-build tauriv2-build-release \
        wailsv3 wailsv3-release wailsv3-build wailsv3-build-release \
        examples-verify examples-size

# rustup 은 cargo 를 여기에 설치하고 셸 프로필에 경로를 추가한다. make 의 셸은
# 프로필을 읽지 않는다.
export PATH := $(HOME)/.cargo/bin:$(PATH)

# 네이티브 앱의 최소 macOS 버전. 캡처 코드가 macOS 14.0 의 ScreenCaptureKit API 를
# 사용한다. Go 는 CGO_CFLAGS 로 모든 cgo 패키지에, 링커에는 -extldflags 로 전달한다.
# Rust 와 cc 는 MACOSX_DEPLOYMENT_TARGET 을 읽는다.
MACOS_MINIMUM = 14.0
export PKG_CONFIG_PATH := $(CURDIR)/native/darwin/build
# go build 는 cgo 가 링크하는 정적 라이브러리의 내용을 캐시 키에 넣지 않고 CGO_CFLAGS 는 넣는다.
# 라이브러리 해시를 CGO_CFLAGS 에 넣어 라이브러리가 바뀌면 cgo 패키지를 다시 컴파일하고 다시 링크한다.
GO_ENV       = CGO_CFLAGS="-O2 -g -mmacosx-version-min=$(MACOS_MINIMUM) -DSOKSAK_DARWIN_LIBRARY=$$(shasum -a 256 native/darwin/build/libsoksak-darwin.a | cut -c1-16)"
GO_LINK      = -extldflags=-mmacosx-version-min=$(MACOS_MINIMUM)
CARGO_ENV    = MACOSX_DEPLOYMENT_TARGET=$(MACOS_MINIMUM)

TAURI_DEBUG   = target/debug/soksak-tauriv2
TAURI_RELEASE = target/release/soksak-tauriv2
WAILS_DEBUG   = target/debug/soksak-wailsv3
WAILS_RELEASE = target/release/soksak-wailsv3

native-darwin:
	@$(MAKE) -C native/darwin

# 사이드카. 빌드할 패키지는 선언에서 나온다(environment.json 의 플러그인 → plugin.json 의
# 사이드카 → sidecar.json 의 helpers). 각 패키지의 build 스크립트는 SOKSAK_PROFILE 을 읽고,
# 스테이징이 그 실행 파일을 애플리케이션 실행 파일 옆에 복사한다.
SIDECAR_PACKAGES = $(shell node scripts/sidecar-packages.mjs)

sidecars-debug:
	@$(GO_ENV) SOKSAK_PROFILE=debug pnpm $(SIDECAR_PACKAGES) run build

# 릴리스는 기호와 빌드 경로를 빼고 재현 가능한 산출물을 만든다. 각 패키지의 build 스크립트가
# 자기 언어의 플래그 변수를 읽는다.
sidecars-release:
	@$(GO_ENV) SOKSAK_PROFILE=release SOKSAK_GO_FLAGS="-trimpath -ldflags=-s -ldflags=-w" \
		SOKSAK_CARGO_FLAGS=--release pnpm $(SIDECAR_PACKAGES) run build

# 프런트엔드와 사이드카 실행 파일을 배치한다. 첫 인자는 실행 파일 디렉터리(앱 디렉터리
# 기준), 둘째 인자는 추가 플래그다. debug 는 페이지 진단 모듈을 넣고(--diagnostics),
# release 는 넣지 않는다.
stage-wailsv3 = pnpm -F @soksak/wailsv3 exec soksak-stage src/frontend --executables $(1) $(2)
stage-tauriv2 = pnpm -F @soksak/tauriv2 exec soksak-stage src/frontend --executables $(1) $(2)

frontend-wailsv3: build sidecars-debug
	@$(call stage-wailsv3,../../target/debug,--diagnostics)

frontend-tauriv2: build sidecars-debug
	@$(call stage-tauriv2,../../target/debug,--diagnostics)

# generate_context! 가 프런트엔드를 포함하므로 크레이트를 다시 빌드하게 한다.
tauriv2-build: native-darwin frontend-tauriv2
	@touch apps/tauriv2/src/main.rs
	@$(CARGO_ENV) cargo build -p soksak-tauriv2 --features diagnostics

tauriv2-build-release: native-darwin build sidecars-release
	@$(call stage-tauriv2,../../target/release)
	@touch apps/tauriv2/src/main.rs
	@$(CARGO_ENV) cargo build --release -p soksak-tauriv2

wailsv3-build: native-darwin frontend-wailsv3
	@$(GO_ENV) go build -C apps/wailsv3 -tags diagnostics -ldflags "$(GO_LINK)" -o ../../$(WAILS_DEBUG) ./src

wailsv3-build-release: native-darwin build sidecars-release
	@$(call stage-wailsv3,../../target/release)
	@$(GO_ENV) go build -C apps/wailsv3 -trimpath -ldflags "-s -w $(GO_LINK)" -o ../../$(WAILS_RELEASE) ./src

tauriv2: tauriv2-build
	@./$(TAURI_DEBUG)

tauriv2-release: tauriv2-build-release
	@./$(TAURI_RELEASE)

wailsv3: wailsv3-build
	@./$(WAILS_DEBUG)

wailsv3-release: wailsv3-build-release
	@./$(WAILS_RELEASE)

# 네이티브 코드의 단위 검사. 공용 입력 검사, Wails 와 Tauri 호스트 검사를 실행한다.
native-test: native-darwin frontend-wailsv3 frontend-tauriv2
	@$(MAKE) -C native/darwin test
	@node scripts/verify-vt-recovery.mjs target/debug/soksak-vt-alacritty
	@$(GO_ENV) go test -ldflags "$(GO_LINK)" ./packages/host/wailsv3/... ./sidecars/shell/... ./sidecars/ptyd/...
	@$(GO_ENV) go test -tags diagnostics -ldflags "$(GO_LINK)" ./packages/host/wailsv3/...
	@$(CARGO_ENV) cargo test --manifest-path sidecars/Cargo.toml --workspace
	@$(CARGO_ENV) cargo test -p soksak-host-tauriv2
	@$(CARGO_ENV) cargo test -p soksak-host-tauriv2 --features diagnostics

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
