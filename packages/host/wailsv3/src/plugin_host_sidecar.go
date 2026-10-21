package host

// The sidecar requests of a plugin host (docs/plans/plugin-host-routes.md rules 2 and 3). The host page sends a request
// for a sidecar that its plugin depends on, in a session plugin:<plugin id>:<project id>:<sidecar name>. The session is
// sent through the existing sidecar path with the folder root that its project records in the window.

import (
	"encoding/json"
	"fmt"
	"strings"
)

// PluginHostSidecarSendRequest is a sidecar request of the host of Plugin: the sidecar, the session id and the body and
// the correlation identifiers of the request.
type PluginHostSidecarSendRequest struct {
	Plugin  string          `json:"plugin"`
	Sidecar string          `json:"sidecar"`
	ID      string          `json:"id"`
	Body    json.RawMessage `json:"body"`
	Cids    []string        `json:"cids"`
}

// pluginSession is the project and the sidecar of a plugin session id, plugin:<plugin>:<project>:<sidecar>.
type pluginSession struct {
	plugin, project, sidecar string
}

// parsePluginSession returns the parts of the plugin session id, or false for an id that is not one. No id contains a
// colon, so the split is unambiguous (docs/plans/plugin-host-routes.md rule 2).
func parsePluginSession(id string) (pluginSession, bool) {
	if !strings.HasPrefix(id, "plugin:") {
		return pluginSession{}, false
	}
	parts := strings.Split(id, ":")
	if len(parts) != 4 {
		return pluginSession{}, false
	}
	for _, part := range parts {
		if part == "" {
			return pluginSession{}, false
		}
	}
	return pluginSession{plugin: parts[1], project: parts[2], sidecar: parts[3]}, true
}

// stateSession is the project of a state session id, state:<plugin>:<project>, which a state module of the workbench page sends
// to its sidecar (docs/plans/plugin-host-routes.md F229-8).
type stateSession struct {
	plugin, project string
}

// parseStateSession returns the parts of the state session id, or false for an id that is not one.
func parseStateSession(id string) (stateSession, bool) {
	if !strings.HasPrefix(id, "state:") {
		return stateSession{}, false
	}
	parts := strings.Split(id, ":")
	if len(parts) != 3 || parts[1] == "" || parts[2] == "" {
		return stateSession{}, false
	}
	return stateSession{plugin: parts[1], project: parts[2]}, true
}

// pluginHostSidecarSend sends the request of req for the host of its plugin through the sidecar path. It refuses a session
// that does not name the plugin and the sidecar, a sidecar that the plugin does not depend on, and a project that this window
// does not hold or whose folder is empty. The refusal texts are the ones of the plugin host contract (docs/spec/host-contract.md).
func (s *Surfaces) pluginHostSidecarSend(req PluginHostSidecarSendRequest) error {
	session, ok := parsePluginSession(req.ID)
	if !ok || session.plugin != req.Plugin || session.sidecar != req.Sidecar {
		return fmt.Errorf("plugin host %s cannot use sidecar session %s", req.Plugin, req.ID)
	}
	if !s.sidecars.dependsOn(req.Plugin, req.Sidecar) {
		return fmt.Errorf("plugin host %s cannot use sidecar %s", req.Plugin, req.Sidecar)
	}
	// A send while the window shows no project is refused: a released project never supplies a root (F229-1).
	if s.shownProject() == "" {
		return fmt.Errorf("plugin host %s: no project is shown", req.Plugin)
	}
	root, held := s.projectRoot(session.project)
	if !held {
		return fmt.Errorf("plugin host %s: project %s is not held by this window", req.Plugin, session.project)
	}
	if root == "" {
		return fmt.Errorf("plugin host %s: project %s has no folder", req.Plugin, session.project)
	}
	return s.sidecars.SendPluginWithCids(s, req.Sidecar, req.ID, root, req.Body, req.Cids)
}

// closePluginSessions closes, through the close of a sidecar session, the plugin sessions that owner holds and that match
// (docs/plans/plugin-host-routes.md rule 7).
func (c *Sidecars) closePluginSessions(owner SidecarOwner, match func(pluginSession) bool) {
	c.closeOwnedSessions(owner, func(id string) bool {
		session, ok := parsePluginSession(id)
		return ok && match(session)
	})
}

// closeProjectSessions closes the plugin sessions and the state sessions of project that owner holds (docs/plans/plugin-host-routes.md
// rule 7, F229-8).
func (c *Sidecars) closeProjectSessions(owner SidecarOwner, project string) {
	c.closeOwnedSessions(owner, func(id string) bool {
		if session, ok := parsePluginSession(id); ok {
			return session.project == project
		}
		state, ok := parseStateSession(id)
		return ok && state.project == project
	})
}

// closeOwnedSessions closes the sessions of owner whose ids match. The ids are collected under c.mu, which is released before
// each close, since Close takes the lock itself (sidecars.go closeSurface).
func (c *Sidecars) closeOwnedSessions(owner SidecarOwner, match func(id string) bool) {
	c.mu.Lock()
	ids := make([]string, 0)
	for id, current := range c.owners {
		if current == owner && match(id) {
			ids = append(ids, id)
		}
	}
	c.mu.Unlock()
	for _, id := range ids {
		c.Close(id)
	}
}

// pluginHostSidecarClose closes the plugin sessions of plugin that this window owns. The main page calls it when the host of
// the plugin ends (docs/plans/plugin-host-routes.md rule 7); a session of another window is not closed.
func (s *Surfaces) pluginHostSidecarClose(plugin string) error {
	s.sidecars.closePluginSessions(s, func(session pluginSession) bool { return session.plugin == plugin })
	return nil
}

// projectRoot returns the folder root that this window records for the project id, and whether the window holds the project.
// The record is written and removed under the host lock (projects.go).
func (s *Surfaces) projectRoot(id string) (string, bool) {
	if s.host != nil {
		s.host.mu.Lock()
		defer s.host.mu.Unlock()
	}
	root, ok := s.projects[id]
	return root, ok
}
