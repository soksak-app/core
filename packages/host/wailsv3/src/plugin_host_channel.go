package host

// The channel of a plugin host page (docs/spec/plugin-host.md#channel). The page sends through the sok-view handler and
// receives the host messages that the host posts to its ready document. A reply answers a request of the main page and goes
// to it as the event plugin-host-reply; a call request or a cancel of the page goes to the main page as the event
// plugin-host-call, and the main page answers it with the PluginHostReply call; a declared UI snapshot goes to the main page
// as the event declared-ui.snapshot. The served calls of the channel are the registration calls of exposure; every other
// command is refused with plugin host call <name> is not served. The events carry the plugin and no surface, because the
// host page holds no surface.

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
)

// pluginHostChannel is the channel of one plugin host: its plugin, its declared state, its ready document and its calls
// that the main page has not answered. document is empty while the page has sent no ready message, and state is nil when
// the host declaration names no state.
type pluginHostChannel struct {
	plugin string
	state  *hostState
	// document is the ready document of the page, and processReady records the first ready message since the host was
	// created, which writes host.trace.plugin-host.process-ready once.
	document     string
	processReady bool
	calls        map[uint64]string
}

// pluginHostChannels are the channels of the window, by plugin id.
type pluginHostChannels struct {
	mu   sync.Mutex
	byID map[string]*pluginHostChannel
}

func newPluginHostChannels() *pluginHostChannels {
	return &pluginHostChannels{byID: map[string]*pluginHostChannel{}}
}

// register records the channel of plugin with its declared state. It runs when the host web view is created.
func (c *pluginHostChannels) register(plugin string, state *hostState) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.byID[plugin] = &pluginHostChannel{plugin: plugin, state: state, calls: map[uint64]string{}}
}

// unregister removes the channel of plugin. It runs when the host web view is disposed.
func (c *pluginHostChannels) unregister(plugin string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.byID, plugin)
}

// channel returns a copy of the channel of plugin, and false when the window has no host of plugin.
func (c *pluginHostChannels) channel(plugin string) (pluginHostChannel, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	channel, ok := c.byID[plugin]
	if !ok {
		return pluginHostChannel{}, false
	}
	return *channel, true
}

// setReadyDocument records document as the ready document of the host of plugin, and clears the record when document is
// empty. It returns false when the window has no host of plugin.
func (c *pluginHostChannels) setReadyDocument(plugin, document string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	channel, ok := c.byID[plugin]
	if !ok {
		return false
	}
	channel.document = document
	return true
}

// firstReady reports whether the host of plugin has no ready message yet, and records that it has one now. A window without
// the host reports false.
func (c *pluginHostChannels) firstReady(plugin string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	channel, ok := c.byID[plugin]
	if !ok || channel.processReady {
		return false
	}
	channel.processReady = true
	return true
}

// trackCall records the call request id with command as open. It runs when the request is forwarded to the main page.
func (c *pluginHostChannels) trackCall(plugin string, id uint64, command string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if channel, ok := c.byID[plugin]; ok {
		channel.calls[id] = command
	}
}

// answerCall records that the main page answered the call request id of the host of plugin, so the call is no longer open.
func (c *pluginHostChannels) answerCall(plugin string, id uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if channel, ok := c.byID[plugin]; ok {
		delete(channel.calls, id)
	}
}

// openCalls returns the commands of the calls of the host of plugin that the main page has not answered, in the order of
// their ids. It returns none when the window has no host of plugin.
func (c *pluginHostChannels) openCalls(plugin string) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	channel, ok := c.byID[plugin]
	if !ok {
		return nil
	}
	ids := make([]uint64, 0, len(channel.calls))
	for id := range channel.calls {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	commands := make([]string, 0, len(ids))
	for _, id := range ids {
		commands = append(commands, channel.calls[id])
	}
	return commands
}

// pluginHostOverflow is the error of a plugin host message that reports the loss of its message queue. The host closes the
// plugin host on it and restarts it within the restart limit (docs/spec/plugin-host.md#restarts).
type pluginHostOverflow struct {
	reason string
}

func (e pluginHostOverflow) Error() string { return e.reason }

// servedPluginHostCall reports whether the channel of a plugin host serves the call command. The served calls are the
// registration calls of exposure, the sidecar calls of the plugin's declared sidecars, the project data calls, the error,
// command and log calls (docs/spec/plugin-host.md#channel); the host answers the state calls itself.
func servedPluginHostCall(command string) bool {
	switch command {
	case "runtime.command.register", "page.exposure.register", "runtime.sidecar.send", "runtime.sidecar.on", "runtime.sidecar.onFailure",
		"runtime.data.get", "runtime.data.set", "runtime.error", "runtime.command", "runtime.log":
		return true
	}
	return false
}

// pluginHostRefusal is the code and the message with which the channel refuses a call that it does not serve.
const (
	pluginHostRefusalCode    = -32000
	pluginHostRefusalMessage = "plugin host call %s is not served"
)

// PluginHostReplyEvent returns the payload of the plugin-host-reply event for a reply of the host of plugin, which answers
// a request of the main page. A reply is {"reply": id, "result"} or {"reply": id, "error": {code, message}}; its id is an
// integer and it has exactly one of result and error, whose error has an integer code and a message. It returns false when
// message is not a reply, and an error for a reply whose fields are invalid.
func PluginHostReplyEvent(plugin string, message json.RawMessage) (map[string]any, bool, error) {
	var reply struct {
		Reply  *uint64         `json:"reply"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    *int    `json:"code"`
			Message *string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(message, &reply); err != nil {
		return nil, false, fmt.Errorf("plugin host %s: message is not an object: %w", plugin, err)
	}
	if reply.Reply == nil {
		return nil, false, nil
	}
	id := *reply.Reply
	hasResult := len(reply.Result) > 0 && string(reply.Result) != "null"
	if hasResult == (reply.Error != nil) {
		return nil, true, fmt.Errorf("plugin host %s: reply %d has both or neither of a result and an error", plugin, id)
	}
	if reply.Error != nil {
		if reply.Error.Code == nil {
			return nil, true, fmt.Errorf("plugin host %s: reply %d has an error without an integer code", plugin, id)
		}
		if reply.Error.Message == nil || *reply.Error.Message == "" {
			return nil, true, fmt.Errorf("plugin host %s: reply %d has an error without a message", plugin, id)
		}
		return map[string]any{"plugin": plugin, "id": id, "error": map[string]any{"code": *reply.Error.Code, "message": *reply.Error.Message}}, true, nil
	}
	return map[string]any{"plugin": plugin, "id": id, "result": json.RawMessage(reply.Result)}, true, nil
}

// PluginHostCallEvent returns the payload of the plugin-host-call event for a call request or a cancel of the host of
// plugin. A call request is {"id", "command", "params"}; a cancel is {"id", "cancel": true}. It returns false when message
// is neither, and an error for a call message whose fields are invalid, including a cancel that is not true or that names a
// command.
func PluginHostCallEvent(plugin string, message json.RawMessage) (map[string]any, bool, error) {
	var call struct {
		ID      *uint64         `json:"id"`
		Command *string         `json:"command"`
		Cancel  *bool           `json:"cancel"`
		Params  json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(message, &call); err != nil {
		return nil, false, fmt.Errorf("plugin host %s: message is not an object: %w", plugin, err)
	}
	if call.Command == nil && call.Cancel == nil {
		return nil, false, nil
	}
	if call.ID == nil {
		return nil, true, fmt.Errorf("plugin host %s: call has no integer id", plugin)
	}
	if call.Cancel != nil {
		if !*call.Cancel || call.Command != nil {
			return nil, true, fmt.Errorf("plugin host %s: call %d cancel must be true and name no command", plugin, *call.ID)
		}
		return map[string]any{"plugin": plugin, "id": *call.ID, "cancel": true}, true, nil
	}
	if call.Command == nil || *call.Command == "" {
		return nil, true, fmt.Errorf("plugin host %s: call %d has an empty command", plugin, *call.ID)
	}
	params := call.Params
	if len(params) == 0 {
		params = json.RawMessage(`null`)
	}
	return map[string]any{"plugin": plugin, "id": *call.ID, "command": *call.Command, "params": params}, true, nil
}

// PluginHostSnapshotEvent returns the payload of the declared-ui.snapshot event for a snapshot of the host of plugin. A
// snapshot is {"event": "declared-ui.snapshot", "plugin", "status", "seq", "value", "skipped"}, whose seq is an integer
// from 1 and whose skipped is a count of 0 or more. It returns false when message is not a snapshot, and an error for a
// snapshot whose fields are invalid. The host relays the snapshot and writes no event for it
// (docs/spec/plugin-host.md#declared-ui-snapshots).
func PluginHostSnapshotEvent(plugin string, message json.RawMessage) (map[string]any, bool, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(message, &fields); err != nil {
		return nil, false, fmt.Errorf("plugin host %s: message is not an object: %w", plugin, err)
	}
	if string(fields["event"]) != `"`+declaredSnapshotEvent+`"` {
		return nil, false, nil
	}
	var named string
	if raw, ok := fields["plugin"]; !ok || json.Unmarshal(raw, &named) != nil || named == "" {
		return nil, true, fmt.Errorf("plugin host %s: declared UI snapshot names no plugin", plugin)
	}
	if named != plugin {
		return nil, true, fmt.Errorf("plugin host %s: declared UI snapshot names plugin %q, want plugin %q", plugin, named, plugin)
	}
	var status string
	if raw, ok := fields["status"]; !ok || json.Unmarshal(raw, &status) != nil || status == "" {
		return nil, true, fmt.Errorf("plugin host %s: declared UI snapshot has no status", plugin)
	}
	var seq uint64
	if raw, ok := fields["seq"]; !ok || json.Unmarshal(raw, &seq) != nil || seq < 1 {
		return nil, true, fmt.Errorf("plugin host %s: declared UI snapshot of status %q has no seq from 1", plugin, status)
	}
	var skipped uint64
	if raw, ok := fields["skipped"]; !ok || json.Unmarshal(raw, &skipped) != nil {
		return nil, true, fmt.Errorf("plugin host %s: declared UI snapshot of status %q has no skipped count", plugin, status)
	}
	value, ok := fields["value"]
	if !ok {
		return nil, true, fmt.Errorf("plugin host %s: declared UI snapshot of status %q has no value", plugin, status)
	}
	return map[string]any{"plugin": plugin, "status": status, "seq": seq, "skipped": skipped, "value": value}, true, nil
}

// pluginHostMessage handles one message of the sok-view handler of the host of plugin. The message is {"message": value}
// for a message of the page and {"error": reason} for a message from another frame. It returns the reason that the host
// writes to the application log, or nil when the message needs no log line.
func (s *Surfaces) pluginHostMessage(plugin, value string) error {
	var received struct {
		Message json.RawMessage `json:"message"`
		Error   *string         `json:"error"`
	}
	if err := json.Unmarshal([]byte(value), &received); err != nil {
		return fmt.Errorf("plugin %s: message is not JSON: %w", plugin, err)
	}
	if received.Error != nil {
		return errors.New(*received.Error)
	}
	if received.Message == nil {
		return fmt.Errorf("plugin %s: message has neither message nor error", plugin)
	}
	channel, ok := s.pluginHostChannels.channel(plugin)
	if !ok {
		return fmt.Errorf("plugin %s: channel message of a window without the host", plugin)
	}
	reply, isReply, err := PluginHostReplyEvent(plugin, received.Message)
	if err != nil {
		return err
	}
	if isReply {
		s.windowEvent("plugin-host-reply", reply)
		return nil
	}
	call, isCall, err := PluginHostCallEvent(plugin, received.Message)
	if err != nil {
		return err
	}
	if isCall {
		if id, ok := call["id"].(uint64); ok {
			if command, ok := call["command"].(string); ok {
				if pluginHostStateCall(command) {
					// silent: PluginHostCallEvent sets the params of a call request as json.RawMessage.
					params, _ := call["params"].(json.RawMessage)
					// The host answers a state call itself from the saved value of the plugin and forwards it to no page
					// (docs/spec/plugin-host.md#state).
					return s.postPluginHost(plugin, s.pluginHostStates.answer(plugin, channel.state, id, command, params))
				}
				if !servedPluginHostCall(command) {
					// A call that the channel does not serve is refused to the page and forwarded to no page
					// (docs/spec/plugin-host.md#channel).
					return s.postPluginHost(plugin, map[string]any{
						"id":    id,
						"error": map[string]any{"code": pluginHostRefusalCode, "message": fmt.Sprintf(pluginHostRefusalMessage, command)},
					})
				}
				s.pluginHostChannels.trackCall(plugin, id, command)
			}
		}
		s.windowEvent("plugin-host-call", call)
		return nil
	}
	snapshot, isSnapshot, err := PluginHostSnapshotEvent(plugin, received.Message)
	if err != nil {
		return err
	}
	if isSnapshot {
		// A declared UI snapshot goes to the main page of the window, which acknowledges it and draws it
		// (docs/spec/plugin-host.md#declared-ui-snapshots). The host relays the snapshot and writes no event for it.
		s.windowEvent(declaredSnapshotEvent, snapshot)
		return nil
	}
	var event struct {
		Event    string `json:"event"`
		Plugin   string `json:"plugin"`
		Document string `json:"document"`
		Reason   string `json:"reason"`
	}
	if err := json.Unmarshal(received.Message, &event); err != nil {
		return fmt.Errorf("plugin %s: message is not an object: %w", plugin, err)
	}
	switch event.Event {
	case "view.ready":
		if event.Plugin != plugin || event.Document == "" {
			return fmt.Errorf("plugin %s: view.ready names plugin %q and document %q", plugin, event.Plugin, event.Document)
		}
		s.pluginHostChannels.setReadyDocument(plugin, event.Document)
		if s.pluginHostChannels.firstReady(plugin) {
			EmitHost(LevelDebug, "host.trace.plugin-host.process-ready", map[string]any{"plugin": plugin, "window": s.name})
		}
		// The current theme is the first message to a ready document, as it is for a view (docs/spec/plugin-host.md#channel).
		return s.postPluginHost(plugin, map[string]any{"event": "theme", "data": s.Theme()})
	case "view.error":
		if event.Reason == "" {
			return fmt.Errorf("plugin %s: view.error has no reason", plugin)
		}
		if len(event.Reason) >= len(viewQueueFullPrefix) && event.Reason[:len(viewQueueFullPrefix)] == viewQueueFullPrefix {
			return pluginHostOverflow{reason: event.Reason}
		}
		return errors.New(event.Reason)
	}
	return fmt.Errorf("plugin %s: event %q is unknown", plugin, event.Event)
}

// postPluginHost posts message to the ready document of the host of plugin, with the field sok 1. It returns an error when
// the host has no ready document or when the document refuses the message.
func (s *Surfaces) postPluginHost(plugin string, message map[string]any) error {
	ready, err := s.sendToPluginHost(plugin, message)
	if err != nil {
		return err
	}
	if !ready {
		return fmt.Errorf("plugin %s has no ready document", plugin)
	}
	return nil
}

// sendToPluginHost posts message to the ready document of the host of plugin and reports whether the host has one. A host
// without a ready document is not an error here, so the theme of a host that is not ready is skipped.
func (s *Surfaces) sendToPluginHost(plugin string, message map[string]any) (bool, error) {
	channel, ok := s.pluginHostChannels.channel(plugin)
	if !ok || channel.document == "" {
		return false, nil
	}
	s.mu.Lock()
	handle, ok := s.pluginHosts[plugin]
	s.mu.Unlock()
	if !ok {
		return false, fmt.Errorf("plugin %s has no host web view", plugin)
	}
	message["sok"] = viewChannelMarker
	data, err := json.Marshal(message)
	if err != nil {
		return false, err
	}
	if !system.PostDocument(handle, string(data)) {
		return false, fmt.Errorf("plugin %s: the host document refused the message", plugin)
	}
	return true, nil
}

// plugins returns the plugins that the window has a channel of, in no order.
func (c *pluginHostChannels) plugins() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	plugins := make([]string, 0, len(c.byID))
	for plugin := range c.byID {
		plugins = append(plugins, plugin)
	}
	return plugins
}

// postThemeToPluginHosts posts the current theme to each plugin host that has a ready document. It runs after the theme
// changed.
func (s *Surfaces) postThemeToPluginHosts() {
	for _, plugin := range s.pluginHostChannels.plugins() {
		if _, err := s.sendToPluginHost(plugin, map[string]any{"event": "theme", "data": s.Theme()}); err != nil {
			LogError("plugin host channel", err)
		}
	}
}
