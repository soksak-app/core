package workbench

// The role status of each tab (docs/spec/agent-roles.md#tab-role-state): the answer of each role operation of this window
// updates it, and a change of the stored workspace re-reads the watched tabs. The status of a tab without a role is the null
// members.
func (s *Shell) roleStatus(tab string) any {
	s.rolesMu.Lock()
	defer s.rolesMu.Unlock()
	if held, ok := s.roles[tab]; ok {
		return held
	}
	return map[string]any{"role": nil, "generation": nil, "state": nil, "seq": 0, "fingerprint": nil, "path": nil}
}

// setRoleStatus keeps the answer of a role operation of this window as the status of its tab.
func (s *Shell) setRoleStatus(tab string, value any) {
	held, ok := value.(map[string]any)
	if !ok {
		return
	}
	s.rolesMu.Lock()
	s.roles[tab] = held
	s.rolesMu.Unlock()
}

// refreshRoles re-reads the role status of each watched tab after a change of the stored workspace, because a role change of
// any window notifies it, and gives each answer to the watches of the registry.
func (s *Shell) refreshRoles() {
	for _, tab := range s.registry.WatchedSurfaces("core.tab.role") {
		s.calls.CallInOrder("role read", "workspace", map[string]any{"kind": "role", "tab": tab}, func(value any, err error) {
			if err != nil {
				s.fail(err)
				return
			}
			s.setRoleStatus(tab, value)
			if err := s.registry.Changed(); err != nil {
				s.fail(err)
			}
		})
	}
}
