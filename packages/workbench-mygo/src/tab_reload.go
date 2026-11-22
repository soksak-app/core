package workbench

// registerTabReload declares core.tab.reload {tab}: the host restarts the view of the tab and the command answers {tab}. The host refuses
// a tab without a view with an error that names the tab (docs/spec/exposure.md#tab-memory).
func (s *Shell) registerTabReload() {
	later(s, "core.tab.reload", func(value tabParam, answer func(any, error)) {
		s.calls.CallInOrder("tab reload "+value.Tab, "viewReload", map[string]any{"surface": value.Tab}, func(_ any, err error) {
			if err != nil {
				answer(nil, err)
				return
			}
			answer(map[string]any{"tab": value.Tab}, nil)
		})
	})
}
