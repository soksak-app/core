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
	later(s, "core.rename.commit", func(_ struct{}, answer func(any, error)) { s.commitRename(answerNull(answer)) })
	act(s, "core.rename.cancel", func(struct{}) error {
		if s.renaming == nil {
			return fmt.Errorf("nothing is being renamed")
		}
		s.renaming = nil
		s.options.Invalidate()
		return nil
	})
	later(s, "core.project.rename", func(value struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}, answer func(any, error)) {
		s.renameProject(value.ID, value.Title, answerNull(answer))
	})
	act(s, "core.space.rename", func(value struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}) error {
		return s.renameSpace(value.ID, value.Title)
	})
	later(s, "core.project.pin", func(value pinParam, answer func(any, error)) {
		s.pinProject(value.ID, value.Pinned, answerNull(answer))
	})
	later(s, "core.project.move", func(value struct {
		ID    string `json:"id"`
		Delta int    `json:"delta"`
	}, answer func(any, error)) {
		s.moveProject(value.ID, value.Delta, answerNull(answer))
	})
}

// pinParam is the parameter of a command that pins a project.
type pinParam struct {
	ID     string `json:"id"`
	Pinned bool   `json:"pinned"`
}

// answerNull answers a command without a value once its store call is done.
func answerNull(answer func(any, error)) func(error) {
	return func(err error) { answer(nil, err) }
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

// commitRename saves the name and tells when the store holds it. An empty name keeps the old one.
func (s *Shell) commitRename(done func(error)) {
	if s.renaming == nil {
		done(fmt.Errorf("nothing is being renamed"))
		return
	}
	target, title := s.renaming.renameTarget, strings.TrimSpace(s.renaming.Value)
	s.renaming = nil
	s.options.Invalidate()
	switch {
	case title == "":
		done(nil)
	case target.Kind == "project":
		s.renameProject(target.ID, title, done)
	default:
		done(s.renameSpace(target.ID, title))
	}
}

// patchProject writes members into the stored project and tells when the store holds them, or the refusal of the store. The shell takes
// the change from the answer, so it never shows what the store refused.
func (s *Shell) patchProject(id string, members map[string]any, apply func(project *projectRecord), done func(error)) {
	s.calls.CallInOrder("workspace", "workspace", map[string]any{"kind": "patch", "id": id, "patch": members}, func(_ any, err error) {
		if err != nil {
			done(err)
			return
		}
		if project := s.project(id); project != nil {
			apply(project)
		}
		s.options.Invalidate()
		done(nil)
	})
}

func (s *Shell) renameProject(id, title string, done func(error)) {
	s.patchProject(id, map[string]any{"title": title}, func(project *projectRecord) { project.Title = title }, done)
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

func (s *Shell) pinProject(id string, pinned bool, done func(error)) {
	s.patchProject(id, map[string]any{"pinned": pinned}, func(project *projectRecord) { project.Pinned = pinned }, done)
}

// moveProject moves a project in the stored order. Like the store, it moves nothing for a project that is not there or past either end.
func (s *Shell) moveProject(id string, delta int, done func(error)) {
	s.calls.CallInOrder("workspace", "workspace", map[string]any{"kind": "move", "id": id, "delta": delta}, func(_ any, err error) {
		if err != nil {
			done(err)
			return
		}
		at := slices.IndexFunc(s.projects, func(project projectRecord) bool { return project.ID == id })
		to := at + delta
		if at >= 0 && to >= 0 && to < len(s.projects) {
			project := s.projects[at]
			s.projects = slices.Insert(slices.Delete(s.projects, at, at+1), to, project)
		}
		s.options.Invalidate()
		done(nil)
	})
}

// drawRenameField draws the field in the place of the tab being renamed.
func (s *Shell) drawRenameField(c *ui.Context, width float32) {
	m := s.metrics
	held := s.renaming
	value := held.Value
	s.binder.Control(c, "core.rename.input", "core.rename.set", "")
	field := s.binder.Bound(ui.TextInputBase(c, &value), "core.rename.input").Label(value).AutoFocus().Shrink(0).Width(width).PaddingX(s.frameLength(m.barTabRootPad)).
		Border(s.palette.BorderWidth, s.palette.Focus).Radius(s.radiusSmall()).Background(s.palette.Bg).TextColor(s.palette.Fg).
		FontSize(s.frameFont(s.textControl())).LineHeight(m.lineHeight).
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
