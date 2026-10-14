package sok

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

// ownConfiguration acquires the process lock of the configuration directory for the duration of a write: the file
// process.lock is created exclusively with the pid of this process, a lock of a live process refuses with the error the
// hosts use, and a lock of an ended process is removed and retried once (docs/spec/installation.md,
// docs/spec/hosts.md#application-log). The returned release removes the lock and is nil on failure.
func ownConfiguration(configDir string) (func(), error) {
	path := filepath.Join(configDir, "process.lock")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return nil, fmt.Errorf("configuration directory %s: %w", configDir, err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			if _, err := fmt.Fprintf(file, "%d", os.Getpid()); err != nil {
				return nil, errors.Join(err, file.Close(), os.Remove(path))
			}
			if err := file.Sync(); err != nil {
				return nil, errors.Join(err, file.Close(), os.Remove(path))
			}
			if err := file.Close(); err != nil {
				return nil, errors.Join(err, os.Remove(path))
			}
			return func() {
				if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
					fmt.Fprintf(os.Stderr, "sok: configuration directory %s: release: %v\n", configDir, err)
				}
			}, nil
		}
		if !errors.Is(err, os.ErrExist) || attempt != 0 {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		contents, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil, fmt.Errorf("%s: %w", path, readErr)
		}
		pid, parseErr := strconv.Atoi(strings.TrimSpace(string(contents)))
		if parseErr != nil || pid <= 0 {
			return nil, fmt.Errorf("%s: invalid process lock", path)
		}
		current, err := platform.Current()
		if err != nil {
			return nil, err
		}
		if running := current.ProcessRunning(pid); running == nil {
			return nil, fmt.Errorf("configuration directory %s is already owned by process %d", configDir, pid)
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("could not acquire process lock %s", path)
}
