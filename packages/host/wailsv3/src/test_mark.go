//go:build diagnostics

package host

// The marks of a test run (docs/spec/logging.md#test-marks): a window check stores the start and the end of each test in the
// event log of the application, so a test is a range of positions `(boot, seq)` of the log.

import (
	"encoding/json"
	"time"
)

// TestMark is the content of a `diagnostics.test.mark` request.
type TestMark struct {
	Kind   string
	Name   string
	Run    string
	Result string
}

// ParseTestMark reads the parameters of `diagnostics.test.mark`. Anything outside the contract is an invalid-params error.
func ParseTestMark(params json.RawMessage) (TestMark, error) {
	var fields map[string]any
	if err := decode(params, &fields); err != nil {
		return TestMark{}, err
	}
	text := func(key string) (string, bool) {
		value, ok := fields[key].(string)
		return value, ok && value != ""
	}
	var mark TestMark
	kind, isString := fields["kind"].(string)
	if !isString || (kind != "start" && kind != "end") {
		return TestMark{}, rpcError(codeInvalidParams, "kind must be start or end")
	}
	mark.Kind = kind
	var ok bool
	if mark.Name, ok = text("name"); !ok {
		return TestMark{}, rpcError(codeInvalidParams, "name must be a non-empty string")
	}
	if mark.Run, ok = text("run"); !ok {
		return TestMark{}, rpcError(codeInvalidParams, "run must be a non-empty string")
	}
	_, hasResult := fields["result"]
	if kind == "start" {
		if hasResult {
			return TestMark{}, rpcError(codeInvalidParams, "result is only for an end mark")
		}
		return mark, nil
	}
	result, isString := fields["result"].(string)
	if !isString || (result != "pass" && result != "fail" && result != "skip") {
		return TestMark{}, rpcError(codeInvalidParams, "result must be pass, fail or skip")
	}
	mark.Result = result
	return mark, nil
}

// EmitTestMark stores the mark as the event `host.test.start` or `host.test.end`, waits until it is in the log, and returns the
// boot identifier of the log and the seq of the line.
func EmitTestMark(mark TestMark, deadline time.Duration) (string, uint64, error) {
	fields := map[string]any{"name": mark.Name, "run": mark.Run}
	event := "host.test.start"
	if mark.Kind == "end" {
		event = "host.test.end"
		fields["result"] = mark.Result
	}
	// events: host.test.start, host.test.end
	return EmitHostPlaced(LevelInfo, event, fields, deadline)
}
