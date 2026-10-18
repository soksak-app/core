package host

// The `log` call of the page (docs/spec/logging.md#writers): the page relays a batch of events. The host validates the
// whole batch before it writes any event, then stores every event in the layer `page` or `plugin` that its name starts with,
// with the clocks and the correlation identifiers the page gave it. The page asks for the clocks of the host with the action
// `clock`, so it can convert its own clock to them.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// relayedEvent is one validated event of a page batch.
type relayedEvent struct {
	tsMicros int64
	monoNs   uint64
	cids     []string
	level    Level
	event    string
	fields   json.RawMessage
	// layer is `page` or `plugin`, the prefix of the name of the event.
	layer string
	// page is the time origin of the document that wrote the event (docs/spec/logging.md#event).
	page string
	// record is the record of the page that the event carries, when it is a `page.record.<level>` event.
	record *Entry
}

// ClockReading is the answer to the action `clock`: the clocks of the host at the time of the call.
type ClockReading struct {
	TsMicros int64  `json:"ts_us"`
	MonoNs   uint64 `json:"mono_ns"`
}

// LogReply is the answer of the `log` call: the lines `<level> page <where>: <text>` of the records of the page in a batch,
// which the host shows in the transcript of the window, the clocks of a `clock` request, or the classes of the policy in force of a
// `policy-read` request.
type LogReply struct {
	Lines   []string
	Clock   *ClockReading
	Classes map[string]string
}

// LogCommand answers a `clock` request with the clocks of the host and stores nothing. It validates a batch request of the
// page, queues its events into the writer of the host, and returns the lines of the page records in it.
func LogCommand(log *EventLog, request map[string]any) (LogReply, error) {
	action, ok := request["action"].(string)
	if !ok {
		return LogReply{}, fmt.Errorf("action must be batch, clock, policy or policy-read")
	}
	if action == "clock" {
		return LogReply{Clock: &ClockReading{TsMicros: time.Now().UnixMicro(), MonoNs: monotonicNanos()}}, nil
	}
	if action == "policy" {
		return LogReply{}, setLogPolicy(log, request)
	}
	if action == "policy-read" {
		return LogReply{Classes: log.Policy().Classes()}, nil
	}
	if action != "batch" {
		return LogReply{}, fmt.Errorf("action must be batch, clock, policy or policy-read, not %q", action)
	}
	lines, err := logBatch(log, request)
	return LogReply{Lines: lines}, err
}

func logBatch(log *EventLog, request map[string]any) ([]string, error) {
	items, ok := request["events"].([]any)
	if !ok {
		return nil, fmt.Errorf("events must be an array")
	}
	events := make([]relayedEvent, 0, len(items))
	for index, item := range items {
		event, err := relayedEventOf(item)
		if err != nil {
			return nil, fmt.Errorf("events[%d]: %w", index, err)
		}
		events = append(events, event)
	}
	for index, event := range events {
		if _, err := log.EmitRelayed(RelayedEvent{TsMicros: event.tsMicros, MonoNs: event.monoNs, Layer: event.layer, Page: event.page, Level: event.level,
			Event: event.event, Cids: event.cids, Fields: event.fields}); err != nil {
			// The batch was validated as a whole, so a refusal here is a defect of the validation; nothing is written
			// after it.
			return nil, fmt.Errorf("events[%d]: %w", index, err)
		}
	}
	var lines []string
	for _, event := range events {
		if event.record != nil {
			lines = append(lines, event.record.Line())
		}
	}
	return lines, nil
}

var errBadCids = errors.New("cids must be an array of non-empty strings without a quote, a backslash or a control character")

func relayedEventOf(item any) (relayedEvent, error) {
	object, ok := item.(map[string]any)
	if !ok {
		return relayedEvent{}, fmt.Errorf("the event must be an object")
	}
	ts, ok := object["ts_us"].(float64)
	if !ok || ts <= 0 || ts != math.Trunc(ts) {
		return relayedEvent{}, fmt.Errorf("ts_us must be a positive integer")
	}
	mono, ok := object["mono_ns"].(float64)
	if !ok || mono <= 0 || mono != math.Trunc(mono) {
		return relayedEvent{}, fmt.Errorf("mono_ns must be a positive integer")
	}
	level, ok := object["level"].(string)
	if !ok || !slices.Contains([]Level{LevelError, LevelWarn, LevelInfo, LevelDebug, LevelTrace}, Level(level)) {
		return relayedEvent{}, fmt.Errorf("level must be one of error, warn, info, debug, trace")
	}
	name, ok := object["event"].(string)
	if !ok || name == "" {
		return relayedEvent{}, fmt.Errorf("event must be a name")
	}
	fields, ok := object["fields"].(map[string]any)
	if !ok {
		return relayedEvent{}, fmt.Errorf("fields must be an object")
	}
	text, err := json.Marshal(fields)
	if err != nil {
		return relayedEvent{}, fmt.Errorf("fields cannot be serialized: %w", err)
	}
	var cids []string
	if present, found := object["cids"]; found {
		list, isList := present.([]any)
		if !isList {
			return relayedEvent{}, errBadCids
		}
		for _, item := range list {
			cid, isString := item.(string)
			if !isString {
				return relayedEvent{}, errBadCids
			}
			cids = append(cids, cid)
		}
		if sok.CheckCids(cids) != nil {
			return relayedEvent{}, errBadCids
		}
	}
	var layer string
	switch {
	case strings.HasPrefix(name, "page."):
		layer = "page"
	case strings.HasPrefix(name, "plugin."):
		layer = "plugin"
	default:
		return relayedEvent{}, fmt.Errorf("the event %q does not start with page. or plugin.", name)
	}
	page, ok := object["page"].(string)
	if !ok || page == "" {
		return relayedEvent{}, fmt.Errorf("page must name the document that wrote the event")
	}
	var record *Entry
	if strings.HasPrefix(name, "page.record.") {
		where, okWhere := fields["where"].(string)
		body, okText := fields["text"].(string)
		if !okWhere || !okText {
			return relayedEvent{}, fmt.Errorf("fields where and text must be strings")
		}
		record = &Entry{Level: level, Layer: "page", Where: where, Text: body}
	}
	return relayedEvent{tsMicros: int64(ts), monoNs: uint64(mono), cids: cids, level: Level(level), event: name, fields: text, layer: layer, page: page, record: record}, nil
}

// Log relays a batch of page events to the event writer of the host and shows its page records in the transcript of the
// window. It answers a `clock` request with the clocks of the host, a `policy-read` request with `{classes}` of the policy in force,
// and a batch with nothing.
func (h *Host) Log(ctx context.Context, requestJSON json.RawMessage) (any, error) {
	request, err := argument[map[string]any]("request", requestJSON)
	if err != nil {
		return nil, err
	}
	if h.events == nil {
		return nil, fmt.Errorf("the event writer is not running")
	}
	s, err := h.surface(ctx)
	if err != nil {
		return nil, err
	}
	reply, err := LogCommand(h.events, request)
	if err != nil {
		return nil, err
	}
	for _, line := range reply.Lines {
		s.log(line)
	}
	if reply.Classes != nil {
		return map[string]any{"classes": reply.Classes}, nil
	}
	if reply.Clock != nil {
		return reply.Clock, nil
	}
	return nil, nil
}
