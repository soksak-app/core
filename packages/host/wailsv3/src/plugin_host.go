package host

// The plugin host web views of a window (docs/spec/plugin-host.md). The host creates the plugin host web view of a
// plugin when the main page of the window loads a plugin whose manifest declares host, and disposes it when the plugin
// is removed or disabled, when the application applies a plugin change that reloads the window, and when the window
// closes. The channel of the host page is in plugin_host_channel.go; the restart limit and the saved state of the host
// pages are here (docs/spec/plugin-host.md#restarts, docs/spec/plugin-host.md#state).

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// hostPlugin is one enabled installed plugin whose manifest declares host, with its id, its page and its declared state,
// which is nil when the declaration names no state.
type hostPlugin struct {
	id, page string
	state    *hostState
	// exposes is the exposes of the manifest of the plugin, as an object (docs/spec/plugin-host.md#configuration).
	exposes json.RawMessage
}

// hostState is the state field of a host declaration: the format number of the saved value and its size limit in bytes
// (docs/spec/plugin-host.md#declaration).
type hostState struct {
	format, maxBytes int
}

// hostPlugins returns the enabled installed plugins whose manifest declares host, in the order of their ids. A host
// declaration that is not an object, whose page is not a non-empty string, or whose state is not {format, maxBytes}
// with positive integers, is an error (docs/spec/plugin-host.md#declaration). The texts of the errors are the same in both hosts
// (docs/spec/host-contract.md).
func hostPlugins(configDir string) ([]hostPlugin, error) {
	plugins, _, err := enabledPlugins(configDir)
	if err != nil {
		return nil, err
	}
	var hosts []hostPlugin
	for _, plugin := range plugins {
		page, state, err := hostDeclaration(plugin.id, plugin.manifest)
		if err != nil {
			return nil, err
		}
		if page == "" {
			continue
		}
		exposes, err := hostExposes(plugin.id, plugin.manifest)
		if err != nil {
			return nil, err
		}
		hosts = append(hosts, hostPlugin{id: plugin.id, page: page, state: state, exposes: exposes})
	}
	return hosts, nil
}

// hostDeclaration returns the page and the state of the host declaration of the manifest of plugin, or an empty page when
// the manifest declares no host. The state is nil when the declaration names none. data is the plugin.json of the plugin
// in compact form.
func hostDeclaration(plugin string, data []byte) (string, *hostState, error) {
	var manifest struct {
		Host json.RawMessage `json:"host"`
	}
	if err := json.NewDecoder(bytes.NewReader(data)).Decode(&manifest); err != nil {
		return "", nil, fmt.Errorf("the manifest of plugin %s is not valid JSON", plugin)
	}
	if len(manifest.Host) == 0 || string(manifest.Host) == "null" {
		return "", nil, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(manifest.Host, &fields); err != nil {
		return "", nil, fmt.Errorf("plugin %s declares host that is not an object", plugin)
	}
	var page string
	if raw, ok := fields["page"]; !ok || json.Unmarshal(raw, &page) != nil || page == "" {
		return "", nil, fmt.Errorf("plugin %s declares host without a page", plugin)
	}
	raw, ok := fields["state"]
	if !ok {
		return page, nil, nil
	}
	state, err := hostStateDeclaration(plugin, raw)
	if err != nil {
		return "", nil, err
	}
	return page, state, nil
}

// hostStateDeclaration returns the state field raw of the host declaration of plugin. It is an object of exactly format
// and maxBytes, each a positive integer, in the form of surface.unload (docs/spec/plugin-host.md#declaration).
func hostStateDeclaration(plugin string, raw json.RawMessage) (*hostState, error) {
	invalid := fmt.Errorf("plugin %s declares host state that is not {format, maxBytes} with positive integers", plugin)
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || len(fields) != 2 {
		return nil, invalid
	}
	var state hostState
	for name, value := range map[string]*int{"format": &state.format, "maxBytes": &state.maxBytes} {
		field, ok := fields[name]
		if !ok || json.Unmarshal(field, value) != nil || *value < 1 {
			return nil, invalid
		}
	}
	return &state, nil
}

// loadPluginHosts creates the plugin host web view of every loaded plugin whose manifest declares host and that the
// window has no host web view of. It runs when the page is ready (docs/spec/plugin-host.md#lifetime).
func (s *Surfaces) loadPluginHosts() {
	if s.host == nil {
		// A window of a test without a host holds no plugin host.
		return
	}
	plugins, err := hostPlugins(s.host.configDir)
	if err != nil {
		LogError("plugin host", err)
		return
	}
	application.InvokeSync(func() {
		s.createPluginHosts(s.window.NativeWindow(), plugins)
	})
}

// createPluginHosts creates the plugin host web view of every plugin in plugins that the window has no host web view
// of and whose restarts the limit has not stopped (docs/spec/plugin-host.md#restarts). It runs on the UI thread.
func (s *Surfaces) createPluginHosts(window unsafe.Pointer, plugins []hostPlugin) {
	if s.host == nil {
		return
	}
	directory := filepath.Join(s.host.configDir, documentData)
	s.mu.Lock()
	var pending []hostPlugin
	for _, plugin := range plugins {
		if s.pluginHosts[plugin.id] == nil && !s.pluginHostRestarts.stopped(plugin.id) {
			pending = append(pending, plugin)
		}
	}
	s.mu.Unlock()
	for _, plugin := range pending {
		folder, err := PluginFolder(s.host.configDir, plugin.id)
		if err != nil {
			LogError("plugin host", err)
			continue
		}
		if err := s.createPluginHost(window, plugin, directory, folder); err != nil {
			LogError("plugin host", err)
		}
	}
}

// createPluginHost creates the plugin host web view of declared with the view configuration
// (docs/spec/native-surfaces.md#view-surfaces) and loads sok://<plugin>/<page> into it. It runs on the UI thread.
func (s *Surfaces) createPluginHost(window unsafe.Pointer, declared hostPlugin, directory, folder string) error {
	plugin, page := declared.id, declared.page
	handle, err := system.CreatePluginHost(window, directory, folder, plugin, viewChannelScript, func(state string) {
		// A navigation of the page clears its ready document, so the next ready message is the first record of it
		// (docs/spec/plugin-host.md#channel, view.channel.ready).
		s.pluginHostState(plugin, state)
	})
	if err == nil {
		s.pluginHostChannels.register(plugin, declared.state)
		err = system.SetViewMessage(handle, func(value string) {
			s.pluginHostReceived(plugin, value)
		})
	}
	if err == nil {
		err = system.SetViewEnded(handle, func() {
			s.pluginHostEnded(plugin, handle)
		})
	}
	if err == nil {
		err = s.addThemeScript(handle)
	}
	if err == nil {
		err = s.addHostStartScript(handle, declared.exposes)
	}
	if err == nil && !system.LoadDocument(handle, "sok://"+plugin+"/"+page) {
		err = fmt.Errorf("plugin host of %s cannot load sok://%s/%s", plugin, plugin, page)
	}
	if err != nil {
		s.pluginHostChannels.unregister(plugin)
		system.CloseDocument(handle)
		return err
	}
	s.mu.Lock()
	s.pluginHosts[plugin] = handle
	s.mu.Unlock()
	EmitHost(LevelDebug, "host.trace.plugin-host.process-request", map[string]any{"plugin": plugin, "window": s.name})
	return nil
}

// disposePluginHost closes the plugin host web view of plugin and sends plugin-host-ended {plugin} to the main page, which
// removes the registrations of the host (docs/spec/plugin-host.md#channel). It runs on the UI thread.
func (s *Surfaces) disposePluginHost(plugin string) {
	s.mu.Lock()
	handle, ok := s.pluginHosts[plugin]
	delete(s.pluginHosts, plugin)
	s.mu.Unlock()
	s.pluginHostChannels.unregister(plugin)
	if ok {
		system.CloseDocument(handle)
		s.windowEvent("plugin-host-ended", map[string]any{"plugin": plugin})
	}
}

// pluginHostEnded handles the end of the page process of the host web view handle of plugin: it writes the end to the
// application log and handles it as a failure of the host. The end of a web view that is no longer the host of plugin was
// already handled. It runs on the UI thread.
func (s *Surfaces) pluginHostEnded(plugin string, handle unsafe.Pointer) {
	s.mu.Lock()
	current := s.pluginHosts[plugin]
	s.mu.Unlock()
	if current != handle {
		return
	}
	LogError("plugin host", fmt.Errorf("plugin %s: the host process ended", plugin))
	s.pluginHostFailed(plugin)
}

// pluginHostFailed handles a failure of the plugin host of plugin in this window: an end of its page process that the host
// did not cause, or the queue overflow of its channel. It disposes the host and counts the failure in the record of the
// plugin over every window; below the limit it creates the host again in this window, and at the fourth failure within
// 300 s it stops the restarts and disposes the host of the plugin in every window (docs/spec/plugin-host.md#restarts). It
// runs on the UI thread.
func (s *Surfaces) pluginHostFailed(plugin string) {
	s.disposePluginHost(plugin)
	attempt, stop := s.pluginHostRestarts.failed(plugin)
	if stop {
		LogError("plugin host "+plugin, fmt.Sprintf("restart limit: %d failures within %d s", restartLimit, int(restartWindow/time.Second)))
		EmitHost(LevelError, "host.plugin-host.restart-limit", map[string]any{"plugin": plugin})
		for _, window := range s.hostWindows() {
			window.disposePluginHost(plugin)
		}
		return
	}
	if attempt == 0 {
		// A failure that arrives after the stop restarts nothing; the stop disposed the host in every window.
		return
	}
	EmitHost(LevelError, "host.plugin-host.restart", map[string]any{"plugin": plugin, "attempt": attempt})
	s.recreatePluginHosts()
}

// pluginHostReset handles the open of a surface of plugin by the person: when the limit stopped the restarts of its plugin
// host, it clears the record, writes host.trace.plugin-host.restart-reset, and creates the host again in every window
// through invoke, which runs a function on the UI thread (docs/spec/plugin-host.md#restarts).
func (s *Surfaces) pluginHostReset(plugin string, invoke func(func())) {
	resetPluginHost(s.pluginHostRestarts, s.hostWindows(), plugin, invoke)
}

// resetPluginHost clears the record of the plugin host of plugin in records when the limit stopped it, and then creates the
// host again in each of windows through invoke. It is the step that the open of a surface and the enable of a plugin share.
func resetPluginHost(records *pluginHostRestarts, windows []*Surfaces, plugin string, invoke func(func())) {
	if !records.reset(plugin) {
		return
	}
	EmitHost(LevelDebug, "host.trace.plugin-host.restart-reset", map[string]any{"plugin": plugin})
	for _, window := range windows {
		invoke(window.recreatePluginHosts)
	}
}

// pluginEnabled handles the enable of plugin by the person in one step, as the open of its surface does: the stop of its plugin
// host and the stops of the sidecars that its manifest lists are cleared (docs/spec/plugin-host.md#restarts,
// docs/spec/sidecars.md#failure).
func (h *Host) pluginEnabled(plugin string) {
	h.sidecars.PluginEnabled(plugin)
	resetPluginHost(h.pluginHostRestarts, h.allWindows(), plugin, application.InvokeSync)
}

// recreatePluginHosts creates the plugin host web view of every loaded plugin that the window has none of and whose
// restarts are not stopped. It runs on the UI thread.
func (s *Surfaces) recreatePluginHosts() {
	if s.host == nil {
		// A window of a test without a host holds no plugin host.
		return
	}
	plugins, err := hostPlugins(s.host.configDir)
	if err != nil {
		LogError("plugin host", err)
		return
	}
	// default: a window of a test has no native window, and its fake platform takes none.
	var window unsafe.Pointer
	if s.window != nil {
		window = s.window.NativeWindow()
	}
	s.createPluginHosts(window, plugins)
}

// hostWindows returns the windows of the host of s, or none for a window of a test without a host.
func (s *Surfaces) hostWindows() []*Surfaces {
	if s.host == nil {
		return nil
	}
	return s.host.allWindows()
}

// allWindows returns the windows of the application at the moment of the call.
func (h *Host) allWindows() []*Surfaces {
	h.mu.Lock()
	defer h.mu.Unlock()
	windows := make([]*Surfaces, 0, len(h.windows))
	for _, window := range h.windows {
		windows = append(windows, window)
	}
	return windows
}

// disposePluginHosts closes every plugin host web view of the window. It runs on the UI thread.
func (s *Surfaces) disposePluginHosts() {
	s.mu.Lock()
	handles := make([]unsafe.Pointer, 0, len(s.pluginHosts))
	for plugin, handle := range s.pluginHosts {
		handles = append(handles, handle)
		delete(s.pluginHosts, plugin)
	}
	s.mu.Unlock()
	// The main page is replaced or ends with the window, so its registrations of the hosts end with it.
	for _, plugin := range s.pluginHostChannels.plugins() {
		s.pluginHostChannels.unregister(plugin)
	}
	for _, handle := range handles {
		system.CloseDocument(handle)
	}
}

// pluginHostReceived handles one message of the sok-view handler of the host of plugin and writes its failure to the
// application log. A message that reports the loss of the message queue is a failure of the plugin host, which closes it
// and restarts it within the restart limit. It runs on the UI thread.
func (s *Surfaces) pluginHostReceived(plugin, value string) {
	err := s.pluginHostMessage(plugin, value)
	if err == nil {
		return
	}
	LogError("plugin host channel", err)
	var overflow pluginHostOverflow
	if errors.As(err, &overflow) {
		// The page has lost messages, so its host web view is closed (docs/spec/plugin-host.md#channel).
		s.pluginHostFailed(plugin)
	}
}

// pluginHostState records the navigation state of the host of plugin. A navigation that starts after the last state clears its ready
// record, so the next ready message of the new document is the first record of it. The progress of a navigation keeps the record.
func (s *Surfaces) pluginHostState(plugin, state string) {
	var loaded struct {
		// Loading is decoded only to check that the state carries a JSON boolean.
		Loading     bool    `json:"loading"`
		Navigations *uint64 `json:"navigations"`
	}
	if err := json.Unmarshal([]byte(state), &loaded); err != nil {
		LogError("plugin host channel", fmt.Errorf("plugin %s: state is not JSON: %w", plugin, err))
		return
	}
	if loaded.Navigations == nil {
		LogError("plugin host channel", fmt.Errorf("plugin %s: state has no navigations", plugin))
		return
	}
	if err := s.pluginHostChannels.recordNavigations(plugin, *loaded.Navigations); err != nil {
		LogError("plugin host channel", err)
	}
}

// PluginHostReplyRequest is the reply of the main page to a call request of the host of Plugin. It has a result or an
// error, not both.
type PluginHostReplyRequest struct {
	Plugin string          `json:"plugin"`
	ID     uint64          `json:"id"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *ViewReplyError `json:"error,omitempty"`
}

// answerPluginHostCall posts the reply of req to the ready document of the host of Plugin as {"sok": 1, "id", "result"} or
// {"sok": 1, "id", "error"}, and records that the main page answered the call, so the call is no longer open
// (docs/spec/plugin-host.md#channel). A reply has a result or an error, not both; an error has a code and a message.
func (s *Surfaces) answerPluginHostCall(req PluginHostReplyRequest) error {
	if req.Plugin == "" {
		return errors.New("plugin host reply names no plugin")
	}
	if (req.Result != nil) == (req.Error != nil) {
		return fmt.Errorf("plugin host reply %d has both or neither of a result and an error", req.ID)
	}
	message := map[string]any{"id": req.ID}
	if req.Error != nil {
		message["error"] = map[string]any{"code": req.Error.Code, "message": req.Error.Message}
	} else {
		message["result"] = req.Result
	}
	if err := s.postPluginHost(req.Plugin, message); err != nil {
		return err
	}
	s.pluginHostChannels.answerCall(req.Plugin, req.ID)
	return nil
}

// PluginHostRequestRequest is a request of the main page to the host of Plugin, such as the pull of a declared status
// (docs/spec/plugin-host.md#declared-ui-snapshots). Params is the params of the request.
type PluginHostRequestRequest struct {
	Plugin  string          `json:"plugin"`
	ID      uint64          `json:"id"`
	Command string          `json:"command"`
	Params  json.RawMessage `json:"params"`
}

// pushPluginHostRequest posts the request of req to the ready document of the host of Plugin as
// {"sok": 1, "id", "command", "params"}. A request has an id and a command; a request without params carries null. The
// page answers it through the sok-view handler as a reply, which the host relays as the event plugin-host-reply.
func (s *Surfaces) pushPluginHostRequest(req PluginHostRequestRequest) error {
	if req.Plugin == "" {
		return errors.New("plugin host request names no plugin")
	}
	if req.ID == 0 {
		return errors.New("plugin host request has no id")
	}
	if req.Command == "" {
		return fmt.Errorf("plugin host request %d has an empty command", req.ID)
	}
	params := req.Params
	if len(params) == 0 {
		params = json.RawMessage(`null`)
	}
	return s.postPluginHost(req.Plugin, map[string]any{"id": req.ID, "command": req.Command, "params": params})
}

// PluginHostEventRequest is an event that the main page pushes to the host of Plugin, such as the acknowledgement of a
// declared UI snapshot (docs/spec/plugin-host.md#declared-ui-snapshots).
type PluginHostEventRequest struct {
	Plugin string          `json:"plugin"`
	Event  string          `json:"event"`
	Data   json.RawMessage `json:"data"`
}

// pushPluginHostEvent posts the event of req to the ready document of the host of Plugin as {"sok": 1, "event", "data"}.
// An event without a name or without data is refused.
func (s *Surfaces) pushPluginHostEvent(req PluginHostEventRequest) error {
	if req.Plugin == "" {
		return errors.New("plugin host event names no plugin")
	}
	if req.Event == "" {
		return errors.New("plugin host event has an empty event name")
	}
	if len(req.Data) == 0 {
		return fmt.Errorf("plugin host event %s has no data", req.Event)
	}
	return s.postPluginHost(req.Plugin, map[string]any{"event": req.Event, "data": req.Data})
}

// pluginHostStates are the saved values of the plugin hosts of the application, one per plugin, which the host page of
// every window reads and writes (docs/spec/plugin-host.md#state). The host process holds them until it ends or the plugin
// is removed or disabled, so a value survives a restart of the host page and not the end of the application.
type pluginHostStates struct {
	mu    sync.Mutex
	saved map[string]savedHostState
}

// savedHostState is the saved value of one plugin host in compact JSON with the declared format it was written with.
type savedHostState struct {
	format int
	value  json.RawMessage
}

func newPluginHostStates() *pluginHostStates {
	return &pluginHostStates{saved: map[string]savedHostState{}}
}

// pluginHostStateCall reports whether command is a state call, which the host answers itself
// (docs/spec/plugin-host.md#state).
func pluginHostStateCall(command string) bool {
	return command == "state.write" || command == "state.read"
}

// answer runs the state call command with params for the host of plugin, whose declared state is declared, and returns
// the host message of its reply: {"id", "result"} or {"id", "error": {code, message}}.
func (c *pluginHostStates) answer(plugin string, declared *hostState, id uint64, command string, params json.RawMessage) map[string]any {
	result, err := c.run(plugin, declared, command, params)
	if err != nil {
		return map[string]any{"id": id, "error": map[string]any{"code": pluginHostRefusalCode, "message": err.Error()}}
	}
	return map[string]any{"id": id, "result": result}
}

// run runs the state call command and returns its result. state.read returns {"value"}, the last saved value or null;
// state.write saves the value of {"value"} with the declared format and returns null. A host without a declared state,
// a write without a value or over maxBytes in compact JSON, and a read of a value of another format are refused.
func (c *pluginHostStates) run(plugin string, declared *hostState, command string, params json.RawMessage) (any, error) {
	if declared == nil {
		return nil, fmt.Errorf("plugin %s declares no host state", plugin)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if command == "state.read" {
		saved, ok := c.saved[plugin]
		if !ok {
			return map[string]any{"value": nil}, nil
		}
		if saved.format != declared.format {
			return nil, fmt.Errorf("plugin %s state format %d is not %d", plugin, saved.format, declared.format)
		}
		return map[string]any{"value": saved.value}, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(params, &fields); err != nil {
		return nil, fmt.Errorf("plugin %s state.write has no value", plugin)
	}
	value, ok := fields["value"]
	if !ok {
		return nil, fmt.Errorf("plugin %s state.write has no value", plugin)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, value); err != nil {
		return nil, fmt.Errorf("plugin %s state is not JSON: %w", plugin, err)
	}
	if compact.Len() > declared.maxBytes {
		return nil, fmt.Errorf("plugin %s state of %d bytes exceeds %d", plugin, compact.Len(), declared.maxBytes)
	}
	c.saved[plugin] = savedHostState{format: declared.format, value: json.RawMessage(compact.Bytes())}
	return nil, nil
}

// pluginChanged applies the plugin change action of plugin to the saved values: a removal or a disable removes the saved
// value of the plugin, and every other change keeps it (docs/spec/plugin-host.md#state).
func (c *pluginHostStates) pluginChanged(action, plugin string) {
	if action != "remove" && action != "disable" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.saved, plugin)
}

// pluginHostRestart is the restart-limit record of the plugin host of one plugin over every window: the counted failures
// of the sidecar failure contract (docs/spec/sidecars.md#failure) and the restarts since the last reset.
type pluginHostRestart struct {
	record   restartRecord
	attempts int
}

// pluginHostRestarts are the restart-limit records of the plugin hosts of the application, by plugin
// (docs/spec/plugin-host.md#restarts). Now is the clock of the limit; a test injects it, and nil uses time.Now.
type pluginHostRestarts struct {
	mu       sync.Mutex
	byPlugin map[string]*pluginHostRestart
	Now      func() time.Time
}

func newPluginHostRestarts() *pluginHostRestarts {
	return &pluginHostRestarts{byPlugin: map[string]*pluginHostRestart{}}
}

// failed counts a failure of the plugin host of plugin at the current time. It returns the attempt of the restart that
// follows, counted since the last reset, or 0 when the host restarts no more; stop is true for the failure that stops the
// restarts. A failure after the stop is not counted.
func (c *pluginHostRestarts) failed(plugin string) (attempt int, stop bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry := c.byPlugin[plugin]
	if entry == nil {
		entry = &pluginHostRestart{}
		c.byPlugin[plugin] = entry
	}
	if entry.record.stopped {
		return 0, false
	}
	// default: nil Now is the wall clock; a test injects the clock it moves.
	now := time.Now()
	if c.Now != nil {
		now = c.Now()
	}
	if entry.record.count(now) {
		return 0, true
	}
	entry.attempts++
	return entry.attempts, false
}

// stopped reports whether the limit stopped the restarts of the plugin host of plugin.
func (c *pluginHostRestarts) stopped(plugin string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry := c.byPlugin[plugin]
	return entry != nil && entry.record.stopped
}

// reset clears the record of the plugin host of plugin when the limit stopped its restarts, and reports whether it did.
func (c *pluginHostRestarts) reset(plugin string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry := c.byPlugin[plugin]
	if entry == nil || !entry.record.stopped {
		return false
	}
	delete(c.byPlugin, plugin)
	return true
}

// hostExposes returns the exposes of the manifest of plugin as a JSON object, or {} when the manifest declares none
// (docs/spec/plugin-host.md#configuration). An exposes that is not an object is refused.
func hostExposes(plugin string, data []byte) (json.RawMessage, error) {
	var manifest struct {
		Exposes json.RawMessage `json:"exposes"`
	}
	if err := json.NewDecoder(bytes.NewReader(data)).Decode(&manifest); err != nil {
		return nil, fmt.Errorf("the manifest of plugin %s is not valid JSON", plugin)
	}
	if len(manifest.Exposes) == 0 || string(manifest.Exposes) == "null" {
		return json.RawMessage("{}"), nil
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(manifest.Exposes, &object); err != nil || object == nil {
		return nil, fmt.Errorf("the exposes of plugin %s are not an object", plugin)
	}
	return manifest.Exposes, nil
}

// hostStartScript returns the document-start script that sets window.sokHost to the frozen project of the window and the exposes of
// the plugin. project is nil in a window that shows no project. The host has no surface and no origin
// (docs/spec/plugin-host.md#configuration).
func hostStartScript(project *SurfaceProject, exposes json.RawMessage) (string, error) {
	value := "null"
	if project != nil {
		id, err := json.Marshal(project.ID)
		if err != nil {
			return "", fmt.Errorf("plugin host project cannot be serialized: %w", err)
		}
		root, err := json.Marshal(project.Root)
		if err != nil {
			return "", fmt.Errorf("plugin host project cannot be serialized: %w", err)
		}
		value = `Object.freeze({"id":` + string(id) + `,"root":` + string(root) + `})`
	}
	return "window.sokHost = Object.freeze({project: " + value + ", declarations: " + string(exposes) + "});", nil
}

// addHostStartScript adds the start values script of a plugin host with the project that the window shows.
func (s *Surfaces) addHostStartScript(document unsafe.Pointer, exposes json.RawMessage) error {
	script, err := hostStartScript(s.shownProjectValue(), exposes)
	if err != nil {
		return err
	}
	return system.AddDocumentScript(document, script)
}
