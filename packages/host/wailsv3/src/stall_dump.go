//go:build diagnostics

package host

// The stall dumps (docs/spec/logging.md#test-marks): when a host does not answer, the window check samples the threads of its
// processes into a file of the logs folder, and the host stores the path as an event so the dump is found from the log.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// ParseStallDump reads the parameters of `diagnostics.stall.dump`: the absolute path of an existing file. Anything outside the
// contract is an invalid-params error.
func ParseStallDump(params json.RawMessage) (string, error) {
	var fields map[string]any
	if err := decode(params, &fields); err != nil {
		return "", err
	}
	path, ok := fields["path"].(string)
	if !ok || path == "" {
		return "", rpcError(codeInvalidParams, "path must be a non-empty string")
	}
	if !filepath.IsAbs(path) {
		return "", rpcError(codeInvalidParams, "path must be absolute")
	}
	if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
		return "", rpcError(codeInvalidParams, "path does not name a file: %s", path)
	}
	return path, nil
}

// EmitStallDump stores the event `host.stall.dump`, waits until it is in the log, and returns the boot identifier of the log and
// the seq of the line.
func EmitStallDump(path string, deadline time.Duration) (string, uint64, error) {
	return EmitHostPlaced(LevelWarn, "host.stall.dump", map[string]any{"path": path}, deadline)
}
