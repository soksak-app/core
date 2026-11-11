//go:build diagnostics

package host

// The stall dumps (docs/spec/logging.md#test-marks): when a host does not answer, the window check samples the threads of its
// processes into a file of the logs folder, and the host stores the path as an event so the dump is found from the log. The event
// names the host calls of every window that have not returned, and the host writes the stacks of its goroutines beside the dump:
// a goroutine that waits on a channel is parked and shows in no thread of the sample.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime/pprof"
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

// StallDump writes the stacks of every goroutine into `<path>.goroutines.txt`, stores the event `host.stall.dump` with path, the
// running host calls of every window in calls at now and the file of the stacks, waits until the event is in the log, and returns
// the reply: the boot identifier of the log, the seq of the line and the running calls of window, `none` without one.
func StallDump(path, window string, calls *RunningCalls, now time.Time) (map[string]any, error) {
	goroutines := path + ".goroutines.txt"
	if err := writeGoroutineStacks(goroutines); err != nil {
		return nil, err
	}
	boot, seq, err := EmitHostPlaced(LevelWarn, "host.stall.dump", map[string]any{
		"path": path, "running": calls.All(now), "goroutines": goroutines,
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"boot": boot, "seq": seq, "running": calls.Of(window, now)}, nil
}

// writeGoroutineStacks writes the stack of every goroutine, each with its wait state, into the file at path.
func writeGoroutineStacks(path string) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("goroutine stacks: %w", err)
	}
	written := pprof.Lookup("goroutine").WriteTo(file, 2)
	if err := file.Close(); written == nil && err != nil {
		written = err
	}
	if written != nil {
		return fmt.Errorf("goroutine stacks %s: %w", path, written)
	}
	return nil
}
