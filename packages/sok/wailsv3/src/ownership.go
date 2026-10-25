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

// lockAttempts is how many times the acquisition opens the lock file again after the file that it opened was replaced.
const lockAttempts = 8

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

// lockReport is the first bytes of a lock content for a refusal, with an invalid sequence replaced.
func lockReport(contents []byte) string {
	return strings.ToValidUTF8(string(contents[:min(len(contents), lockReportBytes)]), "�")
}

// heldRefusal is the refusal of a command beside a live owner, which holds the advisory lock: the owner's pid when the content is
// the current form, and the content otherwise, as the hosts report it (docs/spec/endpoint.md#discovery).
func heldRefusal(configDir string, contents []byte) error {
	if owner, ok := parseLockOwner(contents); ok {
		return fmt.Errorf("configuration directory %s is already owned by process %d", configDir, owner.PID)
	}
	if len(bytes.TrimSpace(contents)) == 0 {
		return fmt.Errorf("configuration directory %s is already owned by a live process", configDir)
	}
	return fmt.Errorf("configuration directory %s is already owned by a live process; process.lock is not the current form: %s", configDir, lockReport(contents))
}

// namedFile reports whether file is the file that path names now. A missing path names no file.
func namedFile(file *os.File, path string) (bool, error) {
	opened, err := file.Stat()
	if err != nil {
		return false, err
	}
	named, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return os.SameFile(opened, named), nil
}

// ownConfiguration acquires the process lock of the configuration directory for the duration of a write. The lock is the advisory
// lock (flock) on process.lock, the lock that the host takes, and it is held until the returned release runs: a held lock refuses
// the command with the owner's pid, and a free lock file is taken over and rewritten with the owner of this command. The release
// removes the file while it still holds the lock, then unlocks (docs/spec/endpoint.md#discovery). It is nil on failure.
func ownConfiguration(configDir string) (func(), error) {
	path := filepath.Join(configDir, "process.lock")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return nil, fmt.Errorf("configuration directory %s: %w", configDir, err)
	}
	system, err := platform.Current()
	if err != nil {
		return nil, err
	}
	for attempt := 0; attempt < lockAttempts; attempt++ {
		file, err := system.OpenProcessLockFile(path)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		locked, err := system.TryLockFile(file)
		if err != nil {
			return nil, errors.Join(err, file.Close())
		}
		if !locked {
			// The owner removes the file before it unlocks, so a file that is gone now was released.
			contents, readErr := os.ReadFile(path)
			if errors.Is(readErr, os.ErrNotExist) {
				if err := file.Close(); err != nil {
					return nil, err
				}
				continue
			}
			if readErr != nil {
				return nil, errors.Join(readErr, file.Close())
			}
			return nil, errors.Join(heldRefusal(configDir, contents), file.Close())
		}
		// The file at path was replaced after this open, so the lock is on a file that no longer names the lock.
		named, err := namedFile(file, path)
		if err != nil {
			return nil, errors.Join(err, file.Close())
		}
		if !named {
			if err := file.Close(); err != nil {
				return nil, err
			}
			continue
		}
		// The owner of this command is written in the form of the host. The boot identifier is the one of the event file of a sok run:
		// the start time in seconds and the process identifier.
		contents, err := json.Marshal(lockOwner{PID: os.Getpid(), Boot: fmt.Sprintf("%d-%d", time.Now().Unix(), os.Getpid())})
		if err != nil {
			return nil, errors.Join(err, file.Close())
		}
		if err := file.Truncate(0); err != nil {
			return nil, errors.Join(err, file.Close())
		}
		if _, err := file.WriteAt(contents, 0); err != nil {
			return nil, errors.Join(err, file.Close())
		}
		if err := file.Sync(); err != nil {
			return nil, errors.Join(err, file.Close())
		}
		return func() {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				fmt.Fprintf(os.Stderr, "sok: configuration directory %s: release: %v\n", configDir, err)
			}
			if err := file.Close(); err != nil {
				fmt.Fprintf(os.Stderr, "sok: configuration directory %s: release: %v\n", configDir, err)
			}
		}, nil
	}
	return nil, fmt.Errorf("could not acquire process lock %s", path)
}
