package host

// The plugin host web views of a window (docs/spec/plugin-host.md). The host creates the plugin host web view of a
// plugin when the main page of the window loads a plugin whose manifest declares host, and disposes it when the plugin
// is removed or disabled, when the application applies a plugin change that reloads the window, and when the window
// closes. The channel, the exposure, the snapshots, the restart limit and the state of the host page are the work of
// F212.9-3 and F212.9-4.

import (
	"bytes"
	"encoding/json"
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
		// The host channel consumes the state of the web view (F212.9-3).
	})
	if err == nil {
		err = system.SetViewMessage(handle, func(value string) {
			LogError("plugin host channel", fmt.Errorf("plugin %s: a host message arrived before its channel is wired", plugin))
		})
	}
	if err == nil {
		err = system.SetViewEnded(handle, func() {
			// The restart of the host page follows the restart limit (F212.9-4); until then the end is an error line.
			LogError("plugin host", fmt.Errorf("plugin %s: the host process ended", plugin))
		})
	}
	if err == nil {
		err = s.addThemeScript(handle)
	}
	if err == nil && !system.LoadDocument(handle, "sok://"+plugin+"/"+page) {
		err = fmt.Errorf("plugin host of %s cannot load sok://%s/%s", plugin, plugin, page)
	}
	if err != nil {
		system.CloseDocument(handle)
		return err
	}
	s.mu.Lock()
	s.pluginHosts[plugin] = handle
	s.mu.Unlock()
	EmitHost(LevelDebug, "host.trace.plugin-host.process-request", map[string]any{"plugin": plugin, "window": s.name})
	return nil
}

// disposePluginHost closes the plugin host web view of plugin. It runs on the UI thread.
func (s *Surfaces) disposePluginHost(plugin string) {
	s.mu.Lock()
	handle, ok := s.pluginHosts[plugin]
	delete(s.pluginHosts, plugin)
	s.mu.Unlock()
	if ok {
		system.CloseDocument(handle)
	}
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
	for _, handle := range handles {
		system.CloseDocument(handle)
	}
}
