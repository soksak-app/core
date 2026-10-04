package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// PluginsRunRequest 는 pluginsRun 호출의 인자다(docs/spec/installation.md#plugin-operations-in-the-application).
// Plugin 은 문자열이 아닌 값을 거부하기 위해 형을 정하지 않고 받는다.
type PluginsRunRequest struct {
	Action string `json:"action"`
	Plugin any    `json:"plugin"`
}

// PluginsRegistryRequest 는 pluginsUseRegistry 호출의 인자다. Index 는 문자열이 아닌 값을 거부하기 위해 형을 정하지
// 않고 받는다.
type PluginsRegistryRequest struct {
	Index any `json:"index"`
}

// PluginsChanged 는 plugins-changed event 의 값이다.
type PluginsChanged struct {
	Action string `json:"action"`
	Plugin string `json:"plugin"`
}

// errPluginOperationRunning 은 다른 plugin 작업이 실행 중일 때의 거부다.
var errPluginOperationRunning = errors.New("another plugin operation is running")

// Plugins 는 설정 폴더의 plugin 설치를 command line 의 installer library 로 바꾼다.
// 작업은 한 번에 하나만 실행하고, 바꾼 뒤 changed 로 알린다.
type Plugins struct {
	configDir string
	core      string
	platform  string
	running   sync.Mutex
	changed   func(PluginsChanged)
}

// NewPlugins 는 이 애플리케이션의 core version 과 platform 으로 작업하는 Plugins 를 만든다.
func NewPlugins(configDir string, changed func(PluginsChanged)) (*Plugins, error) {
	platform, err := sok.CurrentPlatform()
	if err != nil {
		return nil, err
	}
	return &Plugins{configDir: configDir, core: sok.CoreVersion, platform: platform, changed: changed}, nil
}

// State 는 registry 주소, 검사한 index, 설치 상태를 돌려준다.
func (p *Plugins) State() (*sok.PluginsState, error) {
	return sok.ReadPluginsState(p.configDir)
}

// Run 은 sok plugin <action> <plugin> 과 같은 작업을 실행하고 그 출력을 돌려준다.
func (p *Plugins) Run(request PluginsRunRequest) (any, error) {
	switch request.Action {
	case "install", "update", "remove", "enable", "disable":
	default:
		return nil, fmt.Errorf("unknown plugin action %q", request.Action)
	}
	plugin, ok := request.Plugin.(string)
	if !ok || plugin == "" {
		return nil, errors.New("plugin must be a non-empty string")
	}
	if !p.running.TryLock() {
		return nil, errPluginOperationRunning
	}
	result, err := sok.RunPluginAction(p.configDir, request.Action, plugin, p.core, p.platform)
	p.running.Unlock()
	if err != nil {
		return nil, err
	}
	p.changed(PluginsChanged{Action: request.Action, Plugin: plugin})
	return result, nil
}

// UseRegistry 는 sok registry use <index> 와 같이 registry index 를 정하고 그 출력을 돌려준다.
func (p *Plugins) UseRegistry(request PluginsRegistryRequest) (any, error) {
	index, ok := request.Index.(string)
	if !ok || index == "" {
		return nil, errors.New("index must be a non-empty string")
	}
	if !p.running.TryLock() {
		return nil, errPluginOperationRunning
	}
	url, err := sok.UseRegistry(p.configDir, index, sok.DefaultFetcher)
	p.running.Unlock()
	if err != nil {
		return nil, err
	}
	return map[string]string{"index": url}, nil
}

// PluginsState 는 page 의 pluginsState 호출이다.
func (h *Host) PluginsState() (*sok.PluginsState, error) {
	return h.plugins.State()
}

// PluginsRun 은 page 의 pluginsRun 호출이다.
func (h *Host) PluginsRun(requestJSON json.RawMessage) (any, error) {
	request, err := argument[PluginsRunRequest]("request", requestJSON)
	if err != nil {
		return nil, err
	}
	return h.plugins.Run(request)
}

// PluginsUseRegistry 는 page 의 pluginsUseRegistry 호출이다.
func (h *Host) PluginsUseRegistry(requestJSON json.RawMessage) (any, error) {
	request, err := argument[PluginsRegistryRequest]("request", requestJSON)
	if err != nil {
		return nil, err
	}
	return h.plugins.UseRegistry(request)
}

// notifyPlugins 는 모든 창에 plugins-changed 를 보낸다.
func (h *Host) notifyPlugins(change PluginsChanged) {
	h.mu.Lock()
	windows := make([]*Surfaces, 0, len(h.windows))
	for _, s := range h.windows {
		windows = append(windows, s)
	}
	h.mu.Unlock()
	for _, s := range windows {
		s.Emit("plugins-changed", change)
	}
}
