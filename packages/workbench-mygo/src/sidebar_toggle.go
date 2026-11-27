package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
)

// sideToggleParam is the parameter of core.sidebar.toggle: the window side whose sidebar is shown or hidden.
type sideToggleParam struct {
	Side string `json:"side"`
}

// registerSidebarToggle registers core.sidebar.toggle. It negates the visibility setting of one window side through core.settings.change
// with the scope of the applied value, which is the write of the side switch of the title bar (docs/spec/external-sidebars.md#window-tools).
// The shortcut rows of the sides run it on the work screen.
func (s *Shell) registerSidebarToggle() {
	s.registry.Command("core.sidebar.toggle", func(raw json.RawMessage) (any, error) {
		var param sideToggleParam
		if err := json.Unmarshal(raw, &param); err != nil {
			return nil, fmt.Errorf("core.sidebar.toggle: %w", err)
		}
		if s.inHome() {
			return nil, errors.New("the work screen is not shown")
		}
		on, _ := s.settings.Value(param.Side).(bool) // silent: the settings store checks the type of the value.
		change, err := json.Marshal(settingChange{Key: param.Side, Value: !on, Scope: s.settings.Source(param.Side)})
		if err != nil {
			return nil, err
		}
		return s.registry.Run("core.settings.change", change)
	})
}
