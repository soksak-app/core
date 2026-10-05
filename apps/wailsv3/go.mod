module github.com/soksak-app/core/apps/wailsv3

go 1.25.0

require (
	github.com/soksak-app/core/packages/host/wailsv3 v0.0.0
	github.com/wailsapp/wails/v3 v3.0.0-beta.27 // indirect
)

require (
	github.com/adrg/xdg v0.5.3 // indirect
	github.com/coder/websocket v1.8.14 // indirect
	github.com/go-ole/go-ole v1.3.0 // indirect
	github.com/godbus/dbus/v5 v5.2.2 // indirect
	github.com/mattn/go-colorable v0.1.14 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/soksak-app/core/packages/sok/wailsv3 v0.0.0 // indirect
	golang.org/x/sys v0.46.0 // indirect
)

// Wails 의 HTTP transport 는 page 에 돌려주는 오류를 로그에도 써서 실패 한 번을 두 번 기록한다. fork 의
// soksak/http-error-log 가 그 기록을 지운다(docs/features.md F70).
replace github.com/wailsapp/wails/v3 => github.com/min-median-max/wails/v3 v3.0.0-20261005084317-e8da589ca4b7
