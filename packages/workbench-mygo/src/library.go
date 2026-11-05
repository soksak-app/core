package workbench

import (
	"cmp"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
)

// The library: the screen of the saved projects and the form that adds one, as packages/workbench/library.js draws them. The plugin
// page belongs to the plugin screen.

// libraryState is the state of the library of a window.
type libraryState struct {
	page, query, order string
	pluginQuery        string
	// revealUpdates brings the update list into view in the next frame of the plugin page.
	revealUpdates bool
	formMode      string // create, open, or "" while the form is closed.
	name, parent  string
	// folderErrors holds the reason of each project folder that cannot be read, checks the latest check of each root, and foldersFor the
	// roots that were last checked.
	folderErrors map[string]string
	checks       map[string]int
	checkCount   int
	foldersFor   string
	// previews holds the panes of the preview of each shown project, as they stood in the last frame, and previewErrors the reason of each
	// project whose stored layout cannot be opened.
	previews      map[string][]previewPane
	previewErrors map[string]string
}

func newLibraryState() libraryState {
	return libraryState{page: "projects", order: "saved", folderErrors: map[string]string{}, checks: map[string]int{}}
}

// shownProjects returns the projects of the search in the order of the library.
func (s *Shell) shownProjects() []projectRecord {
	shown := make([]projectRecord, 0, len(s.projects))
	query := strings.ToLower(strings.TrimSpace(s.library.query))
	for _, project := range s.projects {
		if strings.Contains(strings.ToLower(project.Title+" "+project.Root), query) {
			shown = append(shown, project)
		}
	}
	switch s.library.order {
	case "name":
		slices.SortStableFunc(shown, func(a, b projectRecord) int { return strings.Compare(a.Title, b.Title) })
	case "recent":
		slices.SortStableFunc(shown, func(a, b projectRecord) int { return cmp.Compare(b.LastOpened, a.LastOpened) })
	case "open":
		isOpen := func(project projectRecord) int {
			if project.ID == s.active {
				return 1
			}
			return 0
		}
		slices.SortStableFunc(shown, func(a, b projectRecord) int { return cmp.Compare(isOpen(b), isOpen(a)) })
	}
	return shown
}

type libraryField struct {
	Field string `json:"field"`
	Value string `json:"value"`
}

// registerLibrary adds the commands of the library.
func (s *Shell) registerLibrary() {
	act(s, "core.library.page", func(value struct {
		Page string `json:"page"`
	}) error {
		return s.showLibraryPage(value.Page)
	})
	act(s, "core.library.search", func(value struct {
		Query string `json:"query"`
	}) error {
		s.library.query = value.Query
		s.options.Invalidate()
		return nil
	})
	act(s, "core.library.sort", func(value struct {
		Order string `json:"order"`
	}) error {
		if !slices.Contains(librarySorts, value.Order) {
			return fmt.Errorf("unknown sort %s", value.Order)
		}
		s.library.order = value.Order
		s.options.Invalidate()
		return nil
	})
	act(s, "core.library.search.focus", func(struct{}) error {
		if !s.inLibrary() {
			return fmt.Errorf("the library is not shown")
		}
		if s.library.page == pluginsPage {
			return s.keyboard.Set("core.library.plugins.search", 0)
		}
		return s.keyboard.Set("core.library.search", 0)
	})
	act(s, "core.library.open", func(value idParam) error { s.activate(value.ID); return nil })
	act(s, "core.library.pin", func(value struct {
		ID     string `json:"id"`
		Pinned bool   `json:"pinned"`
	}) error {
		return s.pinProject(value.ID, value.Pinned)
	})
	act(s, "core.library.remove", func(value idParam) error { s.removeProject(value.ID); return nil })
	act(s, "core.library.return", func(struct{}) error {
		if s.opened() == nil {
			return fmt.Errorf("there is no workspace to return to")
		}
		s.browsing = false
		s.options.Invalidate()
		return nil
	})
	act(s, "core.library.window", func(struct{}) error {
		cids := s.events.BeginOperation("workbench.window.operation", map[string]any{"action": "new"})
		s.calls.Caused(cids).Call("windowNew", nil, func(_ any, err error) {
			if err != nil {
				s.fail(err)
			}
		})
		return nil
	})
	act(s, "core.library.form.open", func(value struct {
		Mode string `json:"mode"`
	}) error {
		if value.Mode != "create" && value.Mode != "open" {
			return fmt.Errorf("unknown form mode %s", value.Mode)
		}
		s.library.formMode = value.Mode
		s.options.Invalidate()
		return nil
	})
	act(s, "core.library.form.cancel", func(struct{}) error {
		if s.library.formMode == "" {
			return fmt.Errorf("the form is not open")
		}
		s.library.formMode = ""
		s.options.Invalidate()
		return nil
	})
	act(s, "core.library.form.set", func(value libraryField) error {
		switch value.Field {
		case "name":
			s.library.name = value.Value
		case "parent":
			s.library.parent = value.Value
		default:
			return fmt.Errorf("the form has no %s field", value.Field)
		}
		s.options.Invalidate()
		return nil
	})
	act(s, "core.library.form.submit", func(struct{}) error { return s.submitForm() })
	act(s, "core.library.choose-folder", func(struct{}) error {
		s.calls.Call("folderChoose", nil, func(value any, err error) {
			if err != nil {
				s.fail(err)
				return
			}
			if chosen, err := decode[string](value); err == nil && chosen != "" {
				s.library.parent = chosen
				s.options.Invalidate()
			}
		})
		return nil
	})
}

// submitForm opens the folder of the form: a new folder in create mode, an existing folder otherwise.
func (s *Shell) submitForm() error {
	if s.library.formMode == "" {
		return fmt.Errorf("the form is not open")
	}
	opened := func(value any, err error) {
		if err != nil {
			s.fail(err)
			return
		}
		folder, err := decode[ProjectFolderValue](value)
		if err != nil {
			s.fail(err)
			return
		}
		s.library.formMode, s.library.name, s.library.parent = "", "", ""
		s.openFolder(folder, s.freeTint(), func(_ json.RawMessage, err error) {
			if err != nil {
				s.fail(err)
			}
		})
	}
	if s.library.formMode == "create" {
		s.calls.Call("projectCreate", map[string]string{"parent": s.library.parent, "name": s.library.name}, opened)
		return nil
	}
	s.calls.Call("projectFolder", s.library.parent, opened)
	return nil
}
