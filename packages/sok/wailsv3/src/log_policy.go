package sok

// The policy of the event log and the gate of the producers (docs/spec/logging.md#classes-and-policy).
//
// The policy says for each class the least severe level that is stored. A producer asks the gate before it builds the fields of
// an event: a closed gate builds nothing, and the writer counts what the producers did not build for each class and level, so no
// event disappears without a trace. The host writes the policy file and watches it; this writer holds the policy in force.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"sort"
	"strings"
	"sync/atomic"
)

// LogPolicySchema is the schema number of the policy file.
const LogPolicySchema = 1

// The number that a policy stores for a class whose events are not stored at all; the other numbers are the position of the least
// severe stored level in levelNames.
const policyOff = -1

var levelNames = []Level{LevelError, LevelWarn, LevelInfo, LevelDebug, LevelTrace}

// policyNames are the values of a class in the file, from the one that stores nothing to the one that stores everything.
var policyNames = []string{"off", "error", "warn", "info", "debug", "trace"}

// LogPolicy says for each class the least severe level that is stored.
type LogPolicy struct {
	// max is, for each class in the order of Classes, policyOff or the position in levelNames of the least severe level that is stored.
	max [5]int8
}

// DefaultLogPolicy stores only errors in every class: a release pays for no event below error and keeps the record of every error that
// the display path shows. Every writer applies it before the first policy and while no policy file exists.
func DefaultLogPolicy() LogPolicy {
	var policy LogPolicy
	for index := range policy.max {
		policy.max[index] = int8(slices.Index(levelNames, LevelError))
	}
	return policy
}

func classIndex(class Class) int { return slices.Index(Classes, class) }

func levelIndex(level Level) int { return slices.Index(levelNames, level) }

// Allows reports whether an event of the class and the level is stored under the policy. A class or a level outside the contract is not
// stored.
func (p LogPolicy) Allows(class Class, level Level) bool {
	c, l := classIndex(class), levelIndex(level)
	return c >= 0 && l >= 0 && int(p.max[c]) >= l
}

// Classes returns the policy as it is written in the file: the value of each class.
func (p LogPolicy) Classes() map[string]string {
	classes := make(map[string]string, len(Classes))
	for index, class := range Classes {
		classes[string(class)] = policyNames[int(p.max[index])+1]
	}
	return classes
}

// JSON is the text of the policy file.
func (p LogPolicy) JSON() ([]byte, error) {
	return json.Marshal(map[string]any{"schema": LogPolicySchema, "classes": p.Classes()})
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
		return LogPolicy{}, fmt.Errorf("%s: schema must be the number %d, found %s", file, LogPolicySchema, string(members["schema"]))
	}
	if schema != LogPolicySchema {
		return LogPolicy{}, fmt.Errorf("%s: schema %d is not %d", file, schema, LogPolicySchema)
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
	for index, class := range Classes {
		raw, found := classes[string(class)]
		if !found {
			return LogPolicy{}, fmt.Errorf("%s: the class %s is missing", file, class)
		}
		var value string
		if err := json.Unmarshal(raw, &value); err != nil || string(raw) == "null" {
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
	names := make([]string, len(Classes))
	for index, class := range Classes {
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

// Policy is the policy in force: the policy that SetPolicy put in force last, or the default policy before the first.
func (l *EventLog) Policy() LogPolicy {
	if current := l.gate.current.Load(); current != nil {
		return current.policy
	}
	return DefaultLogPolicy()
}

// PolicyPath is the file of the policy that this writer follows; it is empty for a writer that has none.
func (l *EventLog) PolicyPath() string { return l.policyPath }

// Levels returns, for each class in the order of Classes, the position in the levels error, warn, info, debug, trace of the least
// severe level that is stored, or -1 when the class is stored at no level; the native library takes the policy in this form.
func (p LogPolicy) Levels() [5]int8 { return p.max }

// applyToolPolicy applies the policy file of the configuration directory once, at the start of the tool (docs/spec/logging.md#policy-file).
// No file keeps the default policy. A file that the reader refuses is stored as the error record `sok.record.error` of the place
// `log policy`, and the default policy stays in force; a record that the writer refuses is returned.
func applyToolPolicy(log *EventLog, path string) error {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	var policy LogPolicy
	if err == nil {
		policy, err = ParseLogPolicy(path, data)
	}
	if err != nil {
		if !log.Emit(LevelError, "sok.record.error", map[string]any{"where": "log policy", "text": err.Error()}) {
			return fmt.Errorf("log policy: %v: the record was refused", err)
		}
		return nil
	}
	log.SetPolicy(policy, "file")
	return nil
}
