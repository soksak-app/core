package host

// The policy of the event log and the gate of the producers (docs/spec/logging.md#classes-and-policy).
//
// The policy says for each class the least severe level that is stored. The host writes it to `<config-dir>/log-policy.json` from
// the setting `diagnostics.log`; every process watches the file through file system events and applies the policy that it holds. A
// producer asks the gate before it builds the fields of an event: a closed gate builds nothing, and the writer counts what the
// producers did not build for each class and level, so no event disappears without a trace.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
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

// logPolicySchema is the schema number of the policy file.
const logPolicySchema = 1

// The number that a policy stores for a class whose events are not stored at all; the other numbers are the position of the least
// severe stored level in levelNames.
const policyOff = -1

var levelNames = []Level{LevelError, LevelWarn, LevelInfo, LevelDebug, LevelTrace}

// policyNames are the values of a class in the file, from the one that stores nothing to the one that stores everything.
var policyNames = []string{"off", "error", "warn", "info", "debug", "trace"}

// LogPolicy says for each class the least severe level that is stored.
type LogPolicy struct {
	// max is, for each class in the order of sok.Classes, policyOff or the position in levelNames of the least severe level that is stored.
	max [5]int8
}

// DefaultLogPolicy stores every level of every class: the diagnostic builds of the 0.0.x series record everything.
func DefaultLogPolicy() LogPolicy {
	var policy LogPolicy
	for index := range policy.max {
		policy.max[index] = int8(len(levelNames) - 1)
	}
	return policy
}

func classIndex(class Class) int { return slices.Index(sok.Classes, class) }

func levelIndex(level Level) int { return slices.Index(levelNames, level) }

// Allows reports whether an event of the class and the level is stored under the policy. A class or a level outside the contract is not
// stored.
func (p LogPolicy) Allows(class Class, level Level) bool {
	c, l := classIndex(class), levelIndex(level)
	return c >= 0 && l >= 0 && int(p.max[c]) >= l
}

// Classes returns the policy as it is written in the file: the value of each class.
func (p LogPolicy) Classes() map[string]string {
	classes := make(map[string]string, len(sok.Classes))
	for index, class := range sok.Classes {
		classes[string(class)] = policyNames[int(p.max[index])+1]
	}
	return classes
}

// JSON is the text of the policy file.
func (p LogPolicy) JSON() ([]byte, error) {
	return json.Marshal(map[string]any{"schema": logPolicySchema, "classes": p.Classes()})
}

// ParseLogPolicy reads the text of a policy file. Every member, class and level is checked, and an error names the file and what it
// found; a policy that leaves a class out is refused, because no value stands in for it.
func ParseLogPolicy(file string, data []byte) (LogPolicy, error) {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(data, &members); err != nil {
		return LogPolicy{}, fmt.Errorf("%s: not JSON: %v", file, err)
	}
	names := make([]string, 0, len(members))
	for name := range members {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if name != "schema" && name != "classes" {
			return LogPolicy{}, fmt.Errorf("%s: the member %s is not one of schema, classes", file, name)
		}
	}
	var schema int
	if err := json.Unmarshal(members["schema"], &schema); err != nil {
		return LogPolicy{}, fmt.Errorf("%s: schema must be the number %d, found %s", file, logPolicySchema, string(members["schema"]))
	}
	if schema != logPolicySchema {
		return LogPolicy{}, fmt.Errorf("%s: schema %d is not %d", file, schema, logPolicySchema)
	}
	var classes map[string]json.RawMessage
	if err := json.Unmarshal(members["classes"], &classes); err != nil || classes == nil {
		return LogPolicy{}, fmt.Errorf("%s: classes must be an object that names every class", file)
	}
	given := make([]string, 0, len(classes))
	for name := range classes {
		given = append(given, name)
	}
	sort.Strings(given)
	for _, name := range given {
		if classIndex(Class(name)) < 0 {
			return LogPolicy{}, fmt.Errorf("%s: the class %s is not one of %s", file, name, joinClasses())
		}
	}
	var policy LogPolicy
	for index, class := range sok.Classes {
		raw, found := classes[string(class)]
		if !found {
			return LogPolicy{}, fmt.Errorf("%s: the class %s is missing", file, class)
		}
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			return LogPolicy{}, fmt.Errorf("%s: the level of the class %s must be text, found %s", file, class, string(raw))
		}
		at := slices.Index(policyNames, value)
		if at < 0 {
			return LogPolicy{}, fmt.Errorf("%s: the level %q of the class %s is not one of %s", file, value, class, strings.Join(policyNames, ", "))
		}
		policy.max[index] = int8(at - 1)
	}
	return policy, nil
}

func joinClasses() string {
	names := make([]string, len(sok.Classes))
	for index, class := range sok.Classes {
		names[index] = string(class)
	}
	return strings.Join(names, ", ")
}

// policyState is the policy in force with the place it came from.
type policyState struct {
	policy LogPolicy
	source string
}

// eventGate is the gate of a writer: the policy in force and, for each class and level, the number of events that were not built or
// stored since the writer last reported them.
type eventGate struct {
	max     [5]atomic.Int32
	gated   [5][5]atomic.Uint64
	current atomic.Pointer[policyState]
}

func newEventGate() *eventGate {
	gate := &eventGate{}
	gate.store(DefaultLogPolicy())
	return gate
}

func (g *eventGate) store(policy LogPolicy) {
	for index := range policy.max {
		g.max[index].Store(int32(policy.max[index]))
	}
}

func (g *eventGate) enabled(class Class, level Level) bool {
	c, l := classIndex(class), levelIndex(level)
	return c < 0 || l < 0 || int(g.max[c].Load()) >= l
}

func (g *eventGate) count(class Class, level Level) {
	if c, l := classIndex(class), levelIndex(level); c >= 0 && l >= 0 {
		g.gated[c][l].Add(1)
	}
}

// Enabled reports whether an event of the class and the level is stored under the policy in force. It counts nothing.
func (l *EventLog) Enabled(class Class, level Level) bool { return l.gate.enabled(class, level) }

// Gate is the question of a producer before it builds the fields of an event: it reports whether the event is stored. A closed gate
// counts the event, which the producer then does not build, so the counter of the class and the level stays exact.
func (l *EventLog) Gate(class Class, level Level) bool {
	if l.gate.enabled(class, level) {
		return true
	}
	l.gate.count(class, level)
	return false
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

// SetPolicy puts the policy in force. A policy that differs from the one in force, and the first policy of a writer, is the event
// `log.policy` with the place it came from (`default` or `file`); the same policy again stores nothing.
func (l *EventLog) SetPolicy(policy LogPolicy, source string) {
	next := &policyState{policy: policy, source: source}
	for {
		current := l.gate.current.Load()
		if current != nil && current.policy == policy {
			return
		}
		if l.gate.current.CompareAndSwap(current, next) {
			break
		}
	}
	l.gate.store(policy)
	fields, err := json.Marshal(map[string]any{"source": source, "classes": policy.Classes()})
	if err != nil {
		// A map of text serializes without failure, so this is a defect of the serializer.
		fmt.Fprintf(os.Stderr, "event writer: the policy cannot be serialized: %v\n", err)
		return
	}
	l.enqueueWriterEvent(LevelInfo, "log.policy", fields)
}

// PolicyPath is the file of the policy that this writer follows; it is empty for a writer that has none.
func (l *EventLog) PolicyPath() string { return l.policyPath }

// setLogPolicy is the action `policy` of the call `log`: the page sends the policy of its setting `diagnostics.log` as `classes`, and
// the host checks it with the rules of the file and writes the file, which every watcher applies (docs/spec/logging.md#classes-and-policy).
func setLogPolicy(log *EventLog, request map[string]any) error {
	if log.policyPath == "" {
		return errors.New("this event writer has no policy file")
	}
	data, err := json.Marshal(map[string]any{"schema": logPolicySchema, "classes": request["classes"]})
	if err != nil {
		return fmt.Errorf("the classes of the policy cannot be serialized: %w", err)
	}
	policy, err := ParseLogPolicy("the call log", data)
	if err != nil {
		return err
	}
	return WriteLogPolicy(log.policyPath, policy)
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
	if log.policyPath == "" {
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
		data, readErr := os.ReadFile(log.policyPath)
		var policy LogPolicy
		var failure string
		switch {
		case errors.Is(readErr, os.ErrNotExist):
			policy, source = DefaultLogPolicy(), "default"
		case readErr != nil:
			source, failure = "error", fmt.Sprintf("%s: %v", log.policyPath, readErr)
		case len(bytes.TrimSpace(data)) == 0:
			// silent: an empty file is a file that a writer truncated and is writing; its completion is the next notification.
			return
		default:
			parsed, parseErr := ParseLogPolicy(log.policyPath, data)
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
			if err := system.SetNativeEventPolicy(policy.nativeLevels()); err != nil {
				LogError("log policy", err)
			}
		}
		if applied != nil {
			applied(source)
		}
	}
	// The watch is installed before the first load, so a change between the two is not missed.
	stopWatch, err := system.WatchFile(log.policyPath, func() { routine.Go("log-policy-load", load) })
	if err != nil {
		return nil, fmt.Errorf("watch %s: %w", log.policyPath, err)
	}
	load()
	return stopWatch, nil
}

// nativeLevels is the policy in the form that the native library takes: for each class in the order of sok.Classes, policyOff or the
// number of the least severe level that is stored (the numbers of SP_EVENT_*).
func (p LogPolicy) nativeLevels() [5]int8 { return p.max }
