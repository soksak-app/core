package workbench

import (
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// The rename of a tab of a bar: a double click puts a field in the place of the tab, Enter and losing the focus save the name, and Escape leaves it.

// renameTarget is the project or the space that a field renames.
type renameTarget struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// rename is the rename in progress. fresh is true until the field selected its text, and held once it had the focus.
type rename struct {
	renameTarget
	Value string `json:"value"`
	fresh bool
	held  bool
}

// registerRename adds the commands that name and order projects and spaces, and the status of a rename.
func (s *Shell) registerRename() {
	s.registry.Status("core.rename", func() any {
		if s.renaming == nil {
			return nil
		}
		return s.renaming
	})
	act(s, "core.rename.begin", func(value renameTarget) error { return s.beginRename(value) })
	act(s, "core.rename.set", func(value struct {
		Value string `json:"value"`
	}) error {
		if s.renaming == nil {
			return fmt.Errorf("nothing is being renamed")
		}
		s.renaming.Value = value.Value
		s.options.Invalidate()
		return nil
	})
	act(s, "core.rename.commit", func(struct{}) error { return s.commitRename() })
	act(s, "core.rename.cancel", func(struct{}) error {
		if s.renaming == nil {
			return fmt.Errorf("nothing is being renamed")
		}
		s.renaming = nil
		s.options.Invalidate()
		return nil
	})
	act(s, "core.project.rename", func(value struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}) error {
		return s.renameProject(value.ID, value.Title)
	})
	act(s, "core.space.rename", func(value struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}) error {
		return s.renameSpace(value.ID, value.Title)
	})
	act(s, "core.project.pin", func(value struct {
		ID     string `json:"id"`
		Pinned bool   `json:"pinned"`
	}) error {
		return s.pinProject(value.ID, value.Pinned)
	})
	act(s, "core.project.move", func(value struct {
		ID    string `json:"id"`
		Delta int    `json:"delta"`
	}) error {
		s.moveProject(value.ID, value.Delta)
		return nil
	})
}

func (s *Shell) beginRename(target renameTarget) error {
	title := ""
	switch target.Kind {
	case "project":
		project := s.project(target.ID)
		if project == nil {
			return fmt.Errorf("no project %s", target.ID)
		}
		title = project.Title
	case "space":
		project := s.opened()
		if project == nil {
			return fmt.Errorf("no space %s", target.ID)
		}
		space, err := layout.SpaceIn(&project.Project, target.ID)
		if err != nil {
			return fmt.Errorf("no space %s", target.ID)
		}
		title = space.Title
	default:
		return fmt.Errorf("unknown rename target %s", target.Kind)
	}
	s.renaming = &rename{renameTarget: target, Value: title, fresh: true}
	s.options.Invalidate()
	return nil
}

// commitRename saves the name. An empty name keeps the old one.
func (s *Shell) commitRename() error {
	if s.renaming == nil {
		return fmt.Errorf("nothing is being renamed")
	}
	target, title := s.renaming.renameTarget, strings.TrimSpace(s.renaming.Value)
	s.renaming = nil
	s.options.Invalidate()
	switch {
	case title == "":
		return nil
	case target.Kind == "project":
		return s.renameProject(target.ID, title)
	}
	return s.renameSpace(target.ID, title)
}

func (s *Shell) renameProject(id, title string) error {
	project := s.project(id)
	if project == nil {
		return fmt.Errorf("Unknown project: %s", id)
	}
	project.Title = title
	s.patch(id, map[string]any{"title": title})
	s.options.Invalidate()
	return nil
}

func (s *Shell) renameSpace(id, title string) error {
	project := s.opened()
	if project == nil {
		return fmt.Errorf("no project is shown")
	}
	space, err := layout.SpaceIn(&project.Project, id)
	if err != nil {
		return err
	}
	space.Title = title
	if err := s.keepPlane(project); err != nil {
		return err
	}
	s.storeSpaces(project)
	s.options.Invalidate()
	return nil
}

func (s *Shell) pinProject(id string, pinned bool) error {
	project := s.project(id)
	if project == nil {
		return fmt.Errorf("Unknown project: %s", id)
	}
	project.Pinned = pinned
	s.patch(id, map[string]any{"pinned": pinned})
	s.options.Invalidate()
	return nil
}

// moveProject moves a project in the stored order. Like the store, it moves nothing for a project that is not there or past either end.
func (s *Shell) moveProject(id string, delta int) {
	at := slices.IndexFunc(s.projects, func(project projectRecord) bool { return project.ID == id })
	to := at + delta
	if at >= 0 && to >= 0 && to < len(s.projects) {
		project := s.projects[at]
		s.projects = slices.Insert(slices.Delete(s.projects, at, at+1), to, project)
	}
	s.calls.CallInOrder("workspace", "workspace", map[string]any{"kind": "move", "id": id, "delta": delta}, func(_ any, err error) {
		if err != nil {
			s.fail(err)
		}
	})
	s.options.Invalidate()
}

// drawRenameField draws the field in the place of the tab being renamed.
func (s *Shell) drawRenameField(c *ui.Context) {
	m := s.metrics
	held := s.renaming
	value := held.Value
	s.binder.Control(c, "core.rename.input", "core.rename.set", "")
	field := s.binder.Bound(ui.TextInputBase(c, &value), "core.rename.input").Label(value).AutoFocus().Shrink(0).Width(s.frameLength(m.barTabRootW)).PaddingX(s.frameLength(m.barTabRootPad)).
		Border(s.palette.BorderWidth, s.palette.Focus).Radius(s.radiusSmall()).Background(s.palette.Bg).TextColor(s.palette.Fg).
		FontSize(s.frameFont(s.textControl())).
		HandleInput(func(event ui.InputEvent) bool {
			if event.Kind != ui.InputKeyDown || event.Key != ui.KeyEscape {
				return false
			}
			s.binder.run("core.rename.cancel", nil)
			return true
		})
	if held.fresh {
		field.SetTextSelection(0, utf8.RuneCountInString(value))
		held.fresh = false
	}
	switch {
	case field.Changed():
		s.binder.run("core.rename.set", map[string]string{"value": value})
	case field.Submitted():
		s.binder.run("core.rename.commit", nil)
	case field.Focused():
		held.held = true
	case held.held:
		s.binder.run("core.rename.commit", nil)
	}
}
