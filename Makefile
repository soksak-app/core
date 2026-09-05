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
# dist/, and both embed it at compile time, so the frontend is regenerated and
# the build is forced on every run.
.PHONY: example-frontend tauri wails

example-frontend:
	@examples/sync-frontend.sh

tauri: example-frontend
	@touch examples/tauriv2/src-tauri/src/main.rs
	@cd examples/tauriv2/src-tauri && cargo build && ./target/debug/soksak-tauri

wails: example-frontend
	@go build -C examples/wailsv3 -o bin/wailsv3 . && ./examples/wailsv3/bin/wailsv3
