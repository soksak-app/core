package workbench

import (
	"encoding/json"
	"fmt"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// params reads the parameters of a command.
func params[T any](raw json.RawMessage) (T, error) {
	var value T
	if len(raw) == 0 {
		return value, nil
	}
	return value, json.Unmarshal(raw, &value)
}

// command registers name with a function of its parameters, which runs in a step of the main thread.
func command[T any](s *Shell, name string, run func(value T) (any, error)) {
	s.registry.Command(name, func(raw json.RawMessage) (any, error) {
		value, err := params[T](raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		return run(value)
	})
}

// later registers name with a function of its parameters that answers in a later step.
func later[T any](s *Shell, name string, run func(value T, answer func(any, error))) {
	s.registry.CommandLater(name, func(raw json.RawMessage, answer func(any, error)) {
		value, err := params[T](raw)
		if err != nil {
			answer(nil, fmt.Errorf("%s: %w", name, err))
			return
		}
		run(value, answer)
	})
}

// act is a command without an answer.
func act[T any](s *Shell, name string, run func(value T) error) {
	command(s, name, func(value T) (any, error) { return nil, run(value) })
}

type cardParam struct {
	Card   string `json:"card"`
	Side   string `json:"side"`
	Plugin string `json:"plugin"`
}

// splitCardParam retains the side field's presence until its declared error is
// formed; JSON null and an absent field are distinct protocol values.
type splitCardParam struct {
	Card   string          `json:"card"`
	Side   json.RawMessage `json:"side"`
	Plugin string          `json:"plugin"`
}

type addTabParam struct {
	Card   string          `json:"card"`
	Plugin string          `json:"plugin"`
	Params json.RawMessage `json:"params"`
}

type boundaryParam struct {
	Axis     layout.Axis `json:"axis"`
	Line     int         `json:"line"`
	Position *float64    `json:"position"`
}

type tabParam struct {
	Tab string `json:"tab"`
}

type idParam struct {
	ID string `json:"id"`
}

// requirePlane returns the error of a command of the plane in a window that shows no project.
func (s *Shell) requirePlane() error {
	if s.plane == nil || s.browsing {
		return fmt.Errorf("no project is shown")
	}
	return nil
}

// register adds the commands of the shell to the registry.
func (s *Shell) register() {
	s.registerLibrary()
	s.registerRename()
	s.registerSettings()
	s.registerPicker()
	Functions{Text: s.text, Focus: s.exposedFocus, Pointer: s.pointer, Contributions: s.contributions}.Register(s.registry)
	s.registerTabDrag()
	s.registerCardSidebars()
	s.registerPlugins()
	s.registerDebug()
	act(s, "core.projects.browse", func(struct{}) error { s.browse(); return nil })
	later(s, "core.projects.flush", func(_ struct{}, answer func(any, error)) { s.flushProjects(answerNull(answer)) })
	command(s, "core.plugins.apply", func(struct{}) (any, error) {
		s.pluginsChanged()
		return map[string]bool{"reloaded": true}, nil
	})
	s.registerProjectOpen()
	s.registerFixture()
	act(s, "core.project.activate", func(value idParam) error { s.activate(value.ID); return nil })
	s.registerProjectClose()
	s.registry.CommandLater("core.window.new", func(_ json.RawMessage, answer func(any, error)) {
		s.newWindow(func(err error) { answer(nil, err) })
	})
	act(s, "core.space.activate", func(value idParam) error { return s.activateSpace(value.ID) })
	act(s, "core.grid.size", func(value struct {
		Card string      `json:"card"`
		Axis layout.Axis `json:"axis"`
		Size float64     `json:"size"`
	}) error {
		if err := s.requirePlane(); err != nil {
			return err
		}
		if !s.plane.SetSize(value.Card, value.Axis, &value.Size) {
			return fmt.Errorf("cannot size %s on %s", value.Card, value.Axis)
		}
		s.settle()
		return nil
	})
	s.registry.CommandLater("core.space.close", func(raw json.RawMessage, answer func(any, error)) {
		value, err := params[idParam](raw)
		if err != nil {
			answer(nil, fmt.Errorf("core.space.close: %w", err))
			return
		}
		project := s.opened()
		if project == nil {
			answer(nil, fmt.Errorf("no project is shown"))
			return
		}
		// The last space does not close. Only the active space has tabs in the plane, so only it can hold a modified tab.
		if len(project.Spaces) == 1 {
			answer(closed(false), nil)
			return
		}
		closeIt := func(settled bool) {
			if !settled {
				answer(closed(false), nil)
				return
			}
			if err := s.closeSpace(value.ID); err != nil {
				answer(nil, err)
				return
			}
			answer(closed(true), nil)
		}
		if value.ID == project.ActiveSpaceID {
			s.settleModified(closeIt)
			return
		}
		closeIt(true)
	})
	command(s, "core.space.add", func(struct{}) (any, error) {
		space, err := s.addSpace()
		if err != nil {
			return nil, err
		}
		return map[string]string{"id": space.ID, "title": space.Title}, nil
	})
	act(s, "core.layout.balance", func(struct{}) error {
		if err := s.requirePlane(); err != nil {
			return err
		}
		if _, err := s.plane.Balance(); err != nil {
			return err
		}
		s.settle()
		return nil
	})
	act(s, "core.card.focus", func(value cardParam) error {
		s.events.Trace("action", func() map[string]any { return map[string]any{"kind": "card.focus", "card": value.Card} })
		if err := s.requirePlane(); err != nil {
			return err
		}
		if _, ok := s.plane.Card(value.Card); !ok {
			return fmt.Errorf("Unknown card: %s", value.Card)
		}
		s.focusCard(value.Card)
		if s.fullscreen != value.Card {
			s.fullscreen = ""
		}
		s.options.Invalidate()
		return nil
	})
	act(s, "core.card.fullscreen", func(value cardParam) error {
		if err := s.requirePlane(); err != nil {
			return err
		}
		if err := s.paneCard(value.Card); err != nil {
			return err
		}
		s.focusCard(value.Card)
		if s.fullscreen == value.Card {
			s.fullscreen = ""
		} else {
			s.fullscreen = value.Card
		}
		s.options.Invalidate()
		return nil
	})
	command(s, "core.card.split", func(value splitCardParam) (any, error) {
		side := "undefined"
		if len(value.Side) != 0 {
			if string(value.Side) == "null" {
				side = "null"
			} else if err := json.Unmarshal(value.Side, &side); err != nil {
				return nil, fmt.Errorf("core.card.split: %w", err)
			}
		}
		if err := s.requirePlane(); err != nil {
			return nil, err
		}
		return s.splitCard(value.Card, side, value.Plugin)
	})
	command(s, "core.card.close", func(value cardParam) (any, error) {
		if err := s.requirePlane(); err != nil {
			return nil, err
		}
		done, err := s.askedCloseCard(value.Card)
		return closed(done), err
	})
	command(s, "core.boundary.move", func(value boundaryParam) (any, error) {
		if err := s.requirePlane(); err != nil {
			return nil, err
		}
		if !s.plane.HasBoundary(value.Axis, value.Line) {
			return nil, fmt.Errorf("no %s boundary at line %d", value.Axis, value.Line)
		}
		if value.Position == nil {
			return nil, fmt.Errorf("core.boundary.move: position is missing")
		}
		moved := s.plane.MoveBoundary(value.Axis, value.Line, *value.Position, false)
		s.settle()
		return map[string]float64{"position": moved}, nil
	})
	command(s, "core.card.add-tab", func(value addTabParam) (any, error) {
		if err := s.requirePlane(); err != nil {
			return nil, err
		}
		tab, err := s.addTab(value.Card, value.Plugin, value.Params)
		if err != nil {
			return nil, err
		}
		return map[string]string{"tab": tab}, nil
	})
	act(s, "core.tab.select", func(value tabParam) error {
		s.events.Trace("action", func() map[string]any { return map[string]any{"kind": "tab.select", "tab": value.Tab} })
		if err := s.requirePlane(); err != nil {
			return err
		}
		return s.selectTab(value.Tab)
	})
	command(s, "core.tab.close", func(value tabParam) (any, error) {
		if err := s.requirePlane(); err != nil {
			return nil, err
		}
		done, err := s.askedCloseTab(value.Tab)
		return closed(done), err
	})
}
