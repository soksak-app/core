//go:build diagnostics

package sok

// 진단 build 의 명령(docs/spec/cli.md). 일반 build 의 sok 에는 진단 method 가 없다.

func init() {
	diagnosticBuild = true
	captureRequest = func(window string) (request, error) {
		return request{method: "diagnostics.capture.still", params: compact("window", window)}, nil
	}
}
