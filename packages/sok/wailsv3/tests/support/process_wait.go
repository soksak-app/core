package support

import (
	"bytes"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// RunProcessWait runs the declared CLI command with the current platform implementation.
func RunProcessWait(args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := sok.Run(args, &stdout, &stderr, sok.Options{
		Identifier:  "com.soksak.test",
		CoreVersion: "0.0.21",
	})
	return code, stdout.String(), stderr.String()
}
