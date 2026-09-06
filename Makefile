SHELL := /bin/sh

.PHONY: preflight prepare build verify

preflight:
	@scripts/check-build-environment.sh

prepare: preflight
	@CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm install --frozen-lockfile

build: prepare
	@pnpm build

verify: prepare
	@pnpm test
	@pnpm build
	@git diff --exit-code -- dist

# Example apps. The frontend of each is generated from examples/browser/ and
# dist/, and both embed it at compile time, so the frontend is regenerated
# before every build.
#
# Each app builds in two profiles, to the same two places, so the artifacts can
# be compared. The release flags are the ones each toolchain uses to strip a
# binary: cargo's release profile, and -s -w -trimpath for Go.
.PHONY: example-frontend \
        tauri tauri-release tauri-build tauri-build-release \
        wails wails-release wails-build wails-build-release \
        examples-verify examples-size

# rustup puts cargo here and adds it to the shell profile, which make's shell
# does not read.
export PATH := $(HOME)/.cargo/bin:$(PATH)

TAURI_DEBUG   = examples/tauriv2/src-tauri/target/debug/soksak-tauri
TAURI_RELEASE = examples/tauriv2/src-tauri/target/release/soksak-tauri
WAILS_DEBUG   = examples/wailsv3/bin/wailsv3
WAILS_RELEASE = examples/wailsv3/bin/wailsv3-release

# The page is copied whole: go:embed cannot reach outside its module, so it has
# to sit inside the app. Nothing is rewritten and nothing is added — the page
# asks framework/ which runtime is holding it, so one copy serves every app.
example-frontend:
	@for app in wailsv3 tauriv2; do \
	  out="examples/$$app/frontend"; \
	  rm -rf "$$out"; mkdir -p "$$out/dist"; \
	  cp -R examples/browser/. "$$out/"; \
	  cp dist/*.js "$$out/dist/"; \
	done

# generate_context! embeds the frontend, so the crate is forced to rebuild.
tauri-build: example-frontend
	@touch examples/tauriv2/src-tauri/src/main.rs
	@cd examples/tauriv2/src-tauri && cargo build

tauri-build-release: example-frontend
	@touch examples/tauriv2/src-tauri/src/main.rs
	@cd examples/tauriv2/src-tauri && cargo build --release

wails-build: example-frontend
	@go build -C examples/wailsv3 -o bin/wailsv3 .

wails-build-release: example-frontend
	@go build -C examples/wailsv3 -trimpath -ldflags "-s -w" -o bin/wailsv3-release .

tauri: tauri-build
	@./$(TAURI_DEBUG)

tauri-release: tauri-build-release
	@./$(TAURI_RELEASE)

wails: wails-build
	@./$(WAILS_DEBUG)

wails-release: wails-build-release
	@./$(WAILS_RELEASE)

# Runs the examples and looks at what they drew. Each app is started, a boundary
# is shaken, and the window is recorded while that runs.
examples-verify: wails-build tauri-build
	@node --test examples/test

# Both apps in both profiles, and what each one weighs.
examples-size: tauri-build tauri-build-release wails-build-release wails-build
	@printf "%-10s %10s %10s\n" "" debug release
	@printf "%-10s %9.1fM %9.1fM\n" tauri \
	  $$(echo "$$(stat -f%z $(TAURI_DEBUG))/1048576" | bc -l) \
	  $$(echo "$$(stat -f%z $(TAURI_RELEASE))/1048576" | bc -l)
	@printf "%-10s %9.1fM %9.1fM\n" wails \
	  $$(echo "$$(stat -f%z $(WAILS_DEBUG))/1048576" | bc -l) \
	  $$(echo "$$(stat -f%z $(WAILS_RELEASE))/1048576" | bc -l)
