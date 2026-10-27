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
	"regexp"
	"slices"
	"strconv"
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

const viewLogFailureCode = -32000

const viewLogFieldsLimitBytes = 65536

var viewPageIdentityPattern = regexp.MustCompile(`^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)

func validViewPageIdentity(page string) bool {
	if !viewPageIdentityPattern.MatchString(page) {
		return false
	}
	value, err := strconv.ParseFloat(page, 64)
	return err == nil && value > 0 && !math.IsNaN(value) && !math.IsInf(value, 0)
}

func (s *Surfaces) viewLogRequest(surface, plugin string, generation uint64, call map[string]any) error {
	channel, ok := s.documents.view(surface)
	if !ok || channel.plugin != plugin || channel.generation != generation {
		return nil
	}
	if channel.document == "" || channel.page == "" {
		return fmt.Errorf("%s: runtime.log has no ready document", surface)
	}
	if s.host == nil || s.host.events == nil {
		return fmt.Errorf("%s: runtime.log event writer is not running", surface)
	}
	id, ok := call["id"].(uint64)
	if !ok {
		return fmt.Errorf("%s: runtime.log call has no integer id", surface)
	}
	params, ok := call["params"].(json.RawMessage)
	if !ok || len(params) == 0 {
		return s.replyViewLog(surface, generation, channel.document, channel.page, id, nil,
			fmt.Errorf("runtime.log params must be an object"))
	}
	var request map[string]any
	if err := json.Unmarshal(params, &request); err != nil || request == nil {
		if err == nil {
			err = errors.New("params must be an object")
		}
		return s.replyViewLog(surface, generation, channel.document, channel.page, id, nil,
			fmt.Errorf("runtime.log params are invalid: %w", err))
	}
	requestReply, err := viewLogCommand(s.host.events, plugin, surface, channel.page, request)
	if err != nil {
		return s.replyViewLog(surface, generation, channel.document, channel.page, id, nil, err)
	}
	var result any
	if requestReply.Clock != nil {
		result = requestReply.Clock
	}
	return s.replyViewLog(surface, generation, channel.document, channel.page, id, result, nil)
}

func (s *Surfaces) replyViewLog(surface string, generation uint64, document, page string, id uint64, result any, requestErr error) error {
	var reply ViewReplyRequest
	if requestErr != nil {
		reply = ViewReplyRequest{Page: page, Surface: surface, Generation: generation, ID: id,
			Error: &ViewReplyError{Code: viewLogFailureCode, Message: requestErr.Error()}}
	} else {
		data, err := json.Marshal(result)
		if err != nil {
			return fmt.Errorf("%s: encode runtime.log reply: %w", surface, err)
		}
		reply = ViewReplyRequest{Page: page, Surface: surface, Generation: generation, ID: id, Result: data}
	}
	message, err := ViewReplyMessage(reply)
	if err != nil {
		return err
	}
	posted, stale, postErr := s.postViewDocumentGeneration(surface, generation, document, page, message)
	if stale {
		return nil
	}
	if postErr != nil {
		postErr = fmt.Errorf("%s: post runtime.log reply: %w", surface, postErr)
		if requestErr != nil {
			return errors.Join(requestErr, postErr)
		}
		return postErr
	}
	if !posted {
		return fmt.Errorf("%s: runtime.log reply has no ready document", surface)
	}
	return nil
}

// postViewDocumentGeneration checks the ready document identity and generation in the UI task that posts the reply.
func (s *Surfaces) postViewDocumentGeneration(surface string, generation uint64, document, page string, message map[string]any) (bool, bool, error) {
	message["sok"] = viewChannelMarker
	data, err := json.Marshal(message)
	if err != nil {
		return false, false, err
	}
	var posted, stale bool
	var postErr error
	s.invoke(func() {
		channel, ok := s.documents.view(surface)
		if !ok || channel.generation != generation || channel.document != document || channel.page != page {
			stale = true
			return
		}
		handle, err := s.documents.Get(DocumentKey{Surface: surface, Name: viewRegionName})
		if err != nil {
			postErr = err
			return
		}
		if !system.PostDocument(handle, string(data)) {
			postErr = fmt.Errorf("the view document refused the message")
			return
		}
		posted = true
	})
	return posted, stale, postErr
}

func viewLogCommand(log *EventLog, plugin, surface, page string, request map[string]any) (LogReply, error) {
	action, ok := request["action"].(string)
	if !ok {
		return LogReply{}, errors.New("runtime.log action must be batch or clock")
	}
	switch action {
	case "clock":
		if len(request) != 1 {
			return LogReply{}, errors.New("runtime.log clock request accepts only action")
		}
	case "batch":
		if len(request) != 2 {
			return LogReply{}, errors.New("runtime.log batch request accepts only action and events")
		}
		if err := validateViewLogBatch(plugin, surface, page, request); err != nil {
			return LogReply{}, err
		}
		var err error
		request, err = withViewSurface(request, plugin, surface)
		if err != nil {
			return LogReply{}, err
		}
	default:
		return LogReply{}, fmt.Errorf("runtime.log action must be batch or clock, not %q", action)
	}
	return LogCommand(log, request)
}

func validateViewLogBatch(plugin, surface, page string, request map[string]any) error {
	items, ok := request["events"].([]any)
	if !ok {
		return errors.New("events must be an array")
	}
	pageOrigin, err := strconv.ParseFloat(page, 64)
	if err != nil || pageOrigin <= 0 || math.IsNaN(pageOrigin) || math.IsInf(pageOrigin, 0) {
		return errors.New("registered view page is not a positive finite time origin")
	}
	for index, item := range items {
		event, ok := item.(map[string]any)
		if !ok {
			return fmt.Errorf("events[%d]: the event must be an object", index)
		}
		if eventPage, ok := event["page"].(string); !ok || eventPage != page {
			return fmt.Errorf("events[%d]: page must match the ready view document", index)
		}
		name, ok := event["event"].(string)
		if !ok || name == "" {
			return fmt.Errorf("events[%d]: event must be a name", index)
		}
		fields, ok := event["fields"].(map[string]any)
		if !ok {
			return fmt.Errorf("events[%d]: fields must be an object", index)
		}
		switch name {
		case "page.start":
			timeOrigin, ok := fields["time_origin"].(float64)
			if !ok || timeOrigin != pageOrigin {
				return fmt.Errorf("events[%d]: page.start time_origin must match the ready page identity", index)
			}
			if url, ok := fields["url"].(string); !ok || url == "" {
				return fmt.Errorf("events[%d]: page.start url must be non-empty text", index)
			}
		case "page.log.clock", "page.log.dropped":
		case "page.log.gated":
			return fmt.Errorf("events[%d]: a view has no policy gate and cannot write page.log.gated", index)
		default:
			prefix := "plugin." + plugin + "."
			if !strings.HasPrefix(name, prefix) || len(name) == len(prefix) {
				return fmt.Errorf("events[%d]: event %q is not a record of plugin %q or an allowed page record", index, name, plugin)
			}
			if _, present := fields["surface"]; present {
				return fmt.Errorf("events[%d]: plugin record must not supply its surface", index)
			}
		}
	}
	return nil
}

func withViewSurface(request map[string]any, plugin, surface string) (map[string]any, error) {
	copyRequest := make(map[string]any, len(request))
	for key, value := range request {
		copyRequest[key] = value
	}
	items := request["events"].([]any)
	copyEvents := make([]any, len(items))
	for index, item := range items {
		event := item.(map[string]any)
		copyEvent := make(map[string]any, len(event))
		for key, value := range event {
			copyEvent[key] = value
		}
		name := event["event"].(string)
		prefix := "plugin." + plugin + "."
		if strings.HasPrefix(name, prefix) && len(name) > len(prefix) {
			fields := event["fields"].(map[string]any)
			copyFields := make(map[string]any, len(fields)+1)
			for key, value := range fields {
				copyFields[key] = value
			}
			copyFields["surface"] = surface
			text, produced, err := sok.BoundedMarshal(copyFields, viewLogFieldsLimitBytes)
			if err != nil {
				return nil, fmt.Errorf("events[%d].fields cannot be serialized: %w", index, err)
			}
			if produced > 0 {
				head, _ := sok.CutText(text, EventHeadBytes)
				copyFields = map[string]any{"head": head, "truncated": true, "surface": surface}
			}
			copyEvent["fields"] = copyFields
		}
		copyEvents[index] = copyEvent
	}
	copyRequest["events"] = copyEvents
	return copyRequest, nil
}
