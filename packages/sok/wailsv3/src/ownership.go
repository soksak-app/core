package sok

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

// lockOwner is the owner that process.lock holds: the process identifier and the boot identifier of the run, in the form that
// the host writes (docs/spec/endpoint.md#discovery).
type lockOwner struct {
	PID  int    `json:"pid"`
	Boot string `json:"boot"`
}

// lockReportBytes is the number of bytes of a lock content that a refusal reports.
const lockReportBytes = 256

// parseLockOwner reads the owner that the contents of a lock file name: one JSON object with a positive pid and a non-empty
// boot, and no other member. Another form is not an owner.
func parseLockOwner(contents []byte) (lockOwner, bool) {
	var owner lockOwner
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&owner); err != nil {
		return lockOwner{}, false
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return lockOwner{}, false
	}
	return owner, owner.PID > 0 && owner.Boot != ""
}

// ownConfiguration acquires the process lock of the configuration directory for the duration of a write: the file
// process.lock is created exclusively with the owner of this process in the form of the host, a lock of a live process refuses
// with the error the hosts use, a lock of an ended process is removed and retried once, and a lock in another form refuses with
// its content (docs/spec/endpoint.md#discovery, docs/spec/installation.md). The returned release removes the lock and is nil on
// failure.
func ownConfiguration(configDir string) (func(), error) {
	path := filepath.Join(configDir, "process.lock")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return nil, fmt.Errorf("configuration directory %s: %w", configDir, err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			// The boot identifier of a sok run is the one of its event file: the start time in seconds and the process identifier.
			contents, err := json.Marshal(lockOwner{PID: os.Getpid(), Boot: fmt.Sprintf("%d-%d", time.Now().Unix(), os.Getpid())})
			if err != nil {
				return nil, errors.Join(err, file.Close(), os.Remove(path))
			}
			if _, err := file.Write(contents); err != nil {
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
		owner, ok := parseLockOwner(contents)
		if !ok {
			// A lock of another form is refused and kept: its owner is unknown, so it is not removed.
			report := string(contents[:min(len(contents), lockReportBytes)])
			return nil, fmt.Errorf("%s: process.lock is not the current form: %s", path, strings.ToValidUTF8(report, "�"))
		}
		current, err := platform.Current()
		if err != nil {
			return nil, err
		}
		if running := current.ProcessRunning(owner.PID); running == nil {
			return nil, fmt.Errorf("configuration directory %s is already owned by process %d", configDir, owner.PID)
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	}
	return nil, fmt.Errorf("could not acquire process lock %s", path)
}
