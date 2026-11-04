package workbench

import (
	"encoding/json"
	"fmt"
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

// act is a command without an answer.
func act[T any](s *Shell, name string, run func(value T) error) {
	command(s, name, func(value T) (any, error) { return nil, run(value) })
}

type cardParam struct {
	Card   string `json:"card"`
	Side   string `json:"side"`
	Plugin string `json:"plugin"`
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
	act(s, "core.projects.browse", func(struct{}) error { s.browse(); return nil })
	act(s, "core.project.activate", func(value idParam) error { s.activate(value.ID); return nil })
	act(s, "core.project.close", func(value idParam) error { s.removeProject(value.ID); return nil })
	act(s, "core.space.activate", func(value idParam) error { return s.activateSpace(value.ID) })
	act(s, "core.space.close", func(value idParam) error { return s.closeSpace(value.ID) })
	act(s, "core.space.add", func(struct{}) error { return s.addSpace() })
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
		if err := s.requirePlane(); err != nil {
			return err
		}
		if _, ok := s.plane.Card(value.Card); !ok {
			return fmt.Errorf("Unknown card: %s", value.Card)
		}
		s.focused = value.Card
		s.options.Invalidate()
		return nil
	})
	command(s, "core.card.split", func(value cardParam) (any, error) {
		if err := s.requirePlane(); err != nil {
			return nil, err
		}
		born, err := s.splitCard(value.Card, value.Side, value.Plugin)
		if err != nil || born == "" {
			return nil, err
		}
		return map[string]string{"card": born}, nil
	})
	act(s, "core.card.close", func(value cardParam) error {
		if err := s.requirePlane(); err != nil {
			return err
		}
		return s.closeCard(value.Card)
	})
	command(s, "core.card.add-tab", func(value cardParam) (any, error) {
		if err := s.requirePlane(); err != nil {
			return nil, err
		}
		tab, err := s.addTab(value.Card, value.Plugin)
		if err != nil {
			return nil, err
		}
		return map[string]string{"tab": tab}, nil
	})
	act(s, "core.tab.select", func(value tabParam) error {
		if err := s.requirePlane(); err != nil {
			return err
		}
		return s.selectTab(value.Tab)
	})
	act(s, "core.tab.close", func(value tabParam) error {
		if err := s.requirePlane(); err != nil {
			return err
		}
		return s.closeTab(value.Tab)
	})
}
