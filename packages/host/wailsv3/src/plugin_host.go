package host

// The plugin host web views of a window (docs/spec/plugin-host.md). The host creates the plugin host web view of a
// plugin when the main page of the window loads a plugin whose manifest declares host, and disposes it when the plugin
// is removed or disabled, when the application applies a plugin change that reloads the window, and when the window
// closes. The channel of the host page is in plugin_host_channel.go; the restart limit and the state of the host page are
// the work of F212.9-4.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// hostPlugin is one enabled installed plugin whose manifest declares host, with its id and page.
type hostPlugin struct {
	id, page string
}

// hostPlugins returns the enabled installed plugins whose manifest declares host, in the order of their ids. A host
// declaration that is not an object, or whose page is not a non-empty string, is an error
// (docs/spec/plugin-host.md#declaration). The texts of the errors are the same in both hosts
// (docs/spec/host-contract.md).
func hostPlugins(configDir string) ([]hostPlugin, error) {
	plugins, _, err := enabledPlugins(configDir)
	if err != nil {
		return nil, err
	}
	var hosts []hostPlugin
	for _, plugin := range plugins {
		page, err := hostPage(plugin.id, plugin.manifest)
		if err != nil {
			return nil, err
		}
		if page == "" {
			continue
		}
		hosts = append(hosts, hostPlugin{id: plugin.id, page: page})
	}
	return hosts, nil
}

// hostPage returns the page of the host declaration of the manifest of plugin, or an empty string when the manifest
// declares no host. data is the plugin.json of the plugin in compact form.
func hostPage(plugin string, data []byte) (string, error) {
	var manifest struct {
		Host json.RawMessage `json:"host"`
	}
	if err := json.NewDecoder(bytes.NewReader(data)).Decode(&manifest); err != nil {
		return "", fmt.Errorf("the manifest of plugin %s is not valid JSON", plugin)
	}
	if len(manifest.Host) == 0 || string(manifest.Host) == "null" {
		return "", nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(manifest.Host, &fields); err != nil {
		return "", fmt.Errorf("plugin %s declares host that is not an object", plugin)
	}
	var page string
	if raw, ok := fields["page"]; !ok || json.Unmarshal(raw, &page) != nil || page == "" {
		return "", fmt.Errorf("plugin %s declares host without a page", plugin)
	}
	return page, nil
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
// of. It runs on the UI thread.
func (s *Surfaces) createPluginHosts(window unsafe.Pointer, plugins []hostPlugin) {
	if s.host == nil {
		return
	}
	directory := filepath.Join(s.host.configDir, documentData)
	s.mu.Lock()
	var pending []hostPlugin
	for _, plugin := range plugins {
		if s.pluginHosts[plugin.id] == nil {
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
		if err := s.createPluginHost(window, plugin.id, plugin.page, directory, folder); err != nil {
			LogError("plugin host", err)
		}
	}
}

// createPluginHost creates the plugin host web view of plugin with the view configuration
// (docs/spec/native-surfaces.md#view-surfaces) and loads sok://<plugin>/<page> into it. It runs on the UI thread.
func (s *Surfaces) createPluginHost(window unsafe.Pointer, plugin, page, directory, folder string) error {
	handle, err := system.CreatePluginHost(window, directory, folder, plugin, viewChannelScript, func(state string) {
		// A navigation of the page clears its ready document, so the next ready message is the first record of it
		// (docs/spec/plugin-host.md#channel, view.channel.ready).
		s.pluginHostState(plugin, state)
	})
	if err == nil {
		s.pluginHostChannels.register(plugin)
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
// application log and disposes the host. The end of a web view that is no longer the host of plugin was already handled.
// The restart of the host page follows the restart limit (F212.9-4). It runs on the UI thread.
func (s *Surfaces) pluginHostEnded(plugin string, handle unsafe.Pointer) {
	s.mu.Lock()
	current := s.pluginHosts[plugin]
	s.mu.Unlock()
	if current != handle {
		return
	}
	LogError("plugin host", fmt.Errorf("plugin %s: the host process ended", plugin))
	s.disposePluginHost(plugin)
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
// application log. A message that reports the loss of the message queue closes the plugin host; the restart of the page
// follows the restart limit (F212.9-4). It runs on the UI thread.
func (s *Surfaces) pluginHostReceived(plugin, value string) {
	err := s.pluginHostMessage(plugin, value)
	if err == nil {
		return
	}
	LogError("plugin host channel", err)
	var overflow pluginHostOverflow
	if errors.As(err, &overflow) {
		// The page has lost messages, so its host web view is closed (docs/spec/plugin-host.md#channel).
		s.disposePluginHost(plugin)
	}
}

// pluginHostState records the navigation state of the host of plugin. A loading document clears its ready record, so the
// next ready message of the new document is the first record of it.
func (s *Surfaces) pluginHostState(plugin, state string) {
	var loaded struct {
		Loading bool `json:"loading"`
	}
	if err := json.Unmarshal([]byte(state), &loaded); err != nil {
		LogError("plugin host channel", fmt.Errorf("plugin %s: state is not JSON: %w", plugin, err))
		return
	}
	if loaded.Loading {
		s.pluginHostChannels.setReadyDocument(plugin, "")
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
