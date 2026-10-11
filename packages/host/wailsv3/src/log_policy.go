package host

// The policy file of the event log (docs/spec/logging.md#classes-and-policy).
//
// The policy and the gate are part of the writer (sok.EventLog). The host writes the policy to `<config-dir>/log-policy.json` from the
// setting `diagnostics.log`, and every process watches the file through file system events and applies the policy that it holds.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// Class is the class of an event; the catalog declares it for each event name.
type Class = sok.Class

// The classes of the contract.
const (
	ClassLifecycle = sok.ClassLifecycle
	ClassInput     = sok.ClassInput
	ClassCall      = sok.ClassCall
	ClassIo        = sok.ClassIo
	ClassFrame     = sok.ClassFrame
)

// LogPolicy says for each class the least severe level that is stored.
type LogPolicy = sok.LogPolicy

// DefaultLogPolicy stores every level of every class.
func DefaultLogPolicy() LogPolicy { return sok.DefaultLogPolicy() }

// ParseLogPolicy reads the text of a policy file.
func ParseLogPolicy(file string, data []byte) (LogPolicy, error) {
	return sok.ParseLogPolicy(file, data)
}

// activeLog is the writer of the records of the host, whose gate the producers of the host ask.
var activeLog atomic.Pointer[EventLog]

// GateEvent is Gate on the writer of the host. Without a writer every event waits in the start buffer, so every gate is open.
func GateEvent(class Class, level Level) bool {
	if log := activeLog.Load(); log != nil {
		return log.Gate(class, level)
	}
	return true
}

// setLogPolicy is the action `policy` of the call `log`: the page sends the policy of its setting `diagnostics.log` as `classes`, and
// the host checks it with the rules of the file and writes the file, which every watcher applies (docs/spec/logging.md#classes-and-policy).
func setLogPolicy(log *EventLog, request map[string]any) error {
	if log.PolicyPath() == "" {
		return errors.New("this event writer has no policy file")
	}
	data, err := json.Marshal(map[string]any{"schema": sok.LogPolicySchema, "classes": request["classes"]})
	if err != nil {
		return fmt.Errorf("the classes of the policy cannot be serialized: %w", err)
	}
	policy, err := ParseLogPolicy("the call log", data)
	if err != nil {
		return err
	}
	return WriteLogPolicy(log.PolicyPath(), policy)
}

// WriteLogPolicy writes the policy file as a new file renamed over the path, so a watcher never reads half a policy.
func WriteLogPolicy(path string, policy LogPolicy) error {
	data, err := policy.JSON()
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".log-policy-*")
	if err != nil {
		return err
	}
	_, writeErr := temporary.Write(data)
	closeErr := temporary.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return errors.Join(err, os.Remove(temporary.Name()))
	}
	if err := os.Rename(temporary.Name(), path); err != nil {
		return errors.Join(err, os.Remove(temporary.Name()))
	}
	return nil
}

// StartLogPolicy applies the policy file of the writer and watches the file: a creation, a write, a replacement or a removal puts the
// policy of the file (or the default policy, when there is no file) in force. The watch is a file system event of the platform, and no
// timer reads the file. A file that breaks the format is reported as an error record of the place `log policy` and the policy in force stays.
// applied, when it is not nil, is called after each load with `default`, `file` or `error`. The result stops the watch.
func StartLogPolicy(log *EventLog, applied func(source string)) (stop func(), err error) {
	if log.PolicyPath() == "" {
		return nil, errors.New("the event writer has no policy file")
	}
	system, err := platform.Current()
	if err != nil {
		return nil, err
	}
	var mu sync.Mutex
	// last is what the previous load found; a notification that leaves it as it was is a repeat of one that led to a read.
	var last string
	load := func() {
		mu.Lock()
		defer mu.Unlock()
		source := "file"
		data, readErr := os.ReadFile(log.PolicyPath())
		var policy LogPolicy
		var failure string
		switch {
		case errors.Is(readErr, os.ErrNotExist):
			policy, source = DefaultLogPolicy(), "default"
		case readErr != nil:
			source, failure = "error", fmt.Sprintf("%s: %v", log.PolicyPath(), readErr)
		case len(bytes.TrimSpace(data)) == 0:
			// silent: an empty file is a file that a writer truncated and is writing; its completion is the next notification.
			return
		default:
			parsed, parseErr := ParseLogPolicy(log.PolicyPath(), data)
			if parseErr != nil {
				source, failure = "error", parseErr.Error()
			} else {
				policy = parsed
			}
		}
		state := source + ":" + failure
		if failure == "" {
			text, err := policy.JSON()
			if err != nil {
				LogError("log policy", err)
				return
			}
			state = source + ":" + string(text)
		}
		if state == last {
			return
		}
		last = state
		if failure != "" {
			LogError("log policy", failure)
		} else {
			log.SetPolicy(policy, source)
			if err := system.SetNativeEventPolicy(policy.Levels()); err != nil {
				LogError("log policy", err)
			}
		}
		if applied != nil {
			applied(source)
		}
	}
	// The watch is installed before the first load, so a change between the two is not missed.
	stopWatch, err := system.WatchFile(log.PolicyPath(), func() { routine.Go("log-policy-load", load) })
	if err != nil {
		return nil, fmt.Errorf("watch %s: %w", log.PolicyPath(), err)
	}
	load()
	return stopWatch, nil
}
