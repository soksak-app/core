package host

// The `log` call of the page (docs/spec/logging.md#writers): the page relays a batch of events. The host validates the
// whole batch before it writes any event, then stores every event in the layer `page` or `plugin` that its name starts with, with the time the page gave it.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"
)

// relayedEvent is one validated event of a page batch.
type relayedEvent struct {
	tsMicros int64
	level    Level
	event    string
	fields   json.RawMessage
	// layer is `page` or `plugin`, the prefix of the name of the event.
	layer string
	// record is the record of the page that the event carries, when it is a `page.record.<level>` event.
	record *Entry
}

// LogCommand validates a batch request of the page, queues its events into the writer of the host, and returns the lines
// `<level> page <where>: <text>` of the records of the page in it, which the host shows in the transcript of the window.
func LogCommand(log *EventLog, request map[string]any) ([]string, error) {
	action, ok := request["action"].(string)
	if !ok {
		return nil, fmt.Errorf("action must be batch")
	}
	if action != "batch" {
		return nil, fmt.Errorf("action must be batch, not %q", action)
	}
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
		if _, err := log.EmitRelayed(event.tsMicros, event.layer, event.level, event.event, event.fields); err != nil {
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

func relayedEventOf(item any) (relayedEvent, error) {
	object, ok := item.(map[string]any)
	if !ok {
		return relayedEvent{}, fmt.Errorf("the event must be an object")
	}
	ts, ok := object["ts_us"].(float64)
	if !ok || ts <= 0 || ts != math.Trunc(ts) {
		return relayedEvent{}, fmt.Errorf("ts_us must be a positive integer")
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
	var layer string
	switch {
	case strings.HasPrefix(name, "page."):
		layer = "page"
	case strings.HasPrefix(name, "plugin."):
		layer = "plugin"
	default:
		return relayedEvent{}, fmt.Errorf("the event %q does not start with page. or plugin.", name)
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
	return relayedEvent{tsMicros: int64(ts), level: Level(level), event: name, fields: text, layer: layer, record: record}, nil
}

// Log relays a batch of page events to the event writer of the host and shows its page records in the transcript of the
// window.
func (h *Host) Log(ctx context.Context, requestJSON json.RawMessage) error {
	request, err := argument[map[string]any]("request", requestJSON)
	if err != nil {
		return err
	}
	if h.events == nil {
		return fmt.Errorf("the event writer is not running")
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	lines, err := LogCommand(h.events, request)
	if err != nil {
		return err
	}
	for _, line := range lines {
		s.log(line)
	}
	return nil
}
