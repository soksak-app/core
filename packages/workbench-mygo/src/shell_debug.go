package workbench

import (
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/egoist/mygo/ui"
)

// The commands of the debug view (docs/spec/debug.md), over the host calls of the logs folder.

// debugState is the open debug view: what DrawDebugView draws and the state file that opening wrote.
type debugState struct {
	view     DebugView
	recorded *string
}

type debugPathParam struct {
	Path string `json:"path"`
}

type debugWithParam struct {
	With string `json:"with"`
}

// debugShownImage is the start of the address of an image that debugRead answers.
const debugShownImage = "data:image/png;base64,"

func (s *Shell) registerDebug() {
	act(s, "core.debug.open", func(struct{}) error { s.openDebug(); return nil })
	act(s, "core.debug.close", func(struct{}) error {
		s.debug = nil
		s.errors.Hide(debugErrorPlace)
		s.options.Invalidate()
		return nil
	})
	act(s, "core.debug.list", func(struct{}) error { return s.listDebug() })
	act(s, "core.debug.view", s.viewDebugFile)
	act(s, "core.debug.state", s.viewDebugState)
	act(s, "core.debug.state.compare", s.compareDebugState)
	act(s, "core.debug.save", s.saveDebugFile)
	act(s, "core.debug.save-all", func(struct{}) error { return s.saveDebugFiles() })
	s.registry.Status("core.debug", s.debugStatus)
}

// requireDebug returns the error of a command of a view that is not open.
func (s *Shell) requireDebug() error {
	if s.debug == nil {
		return fmt.Errorf("the debug view is not open")
	}
	return nil
}

// debugAnswer gives the open view the answer of a call of debug. A view that closed takes no answer, and a failure is shown in the view.
func (s *Shell) debugAnswer(debug *debugState, take func(value any) error) func(value any, err error) {
	return func(value any, err error) {
		if s.debug != debug {
			return
		}
		if err == nil {
			err = take(value)
		}
		if err != nil {
			s.debugFailed(err)
		}
		s.options.Invalidate()
	}
}

func (s *Shell) debugFailed(err error) {
	text := err.Error()
	s.debug.view.Failure = &text
	s.options.Invalidate()
}

// openDebug records the state of the window, then lists the files. A failure of a step leaves the next step.
func (s *Shell) openDebug() {
	debug := &debugState{}
	s.debug = debug
	s.options.Invalidate()
	s.calls.Call("debugRecord", map[string]any{"workbench": s.statusValues()}, func(value any, err error) {
		s.debugAnswer(debug, func(value any) error {
			recorded, err := decode[debugPathParam](value)
			if err != nil {
				return err
			}
			debug.recorded = &recorded.Path
			return nil
		})(value, err)
		if s.debug == debug {
			if err := s.listDebug(); err != nil {
				s.debugFailed(err)
			}
		}
	})
}

// statusValues is the value of each status of the registry, and the error of a status that does not read.
func (s *Shell) statusValues() map[string]any {
	_, names := s.registry.Names()
	values := make(map[string]any, len(names))
	for _, name := range names {
		if name == "core.debug" {
			continue
		}
		value, err := s.registry.Read(name)
		if err != nil {
			value = map[string]string{"error": err.Error()}
		}
		values[name] = value
	}
	return values
}

// listDebug reads the files of the logs folder and shows the list.
func (s *Shell) listDebug() error {
	if err := s.requireDebug(); err != nil {
		return err
	}
	debug := s.debug
	s.calls.Call("debugFiles", nil, s.debugAnswer(debug, func(value any) error {
		entries, err := decode[[]DebugEntry](value)
		if err != nil {
			return err
		}
		debug.view.Entries = NewestFirst(entries)
		debug.view.Viewing, debug.view.State = nil, nil
		return nil
	}))
	return nil
}

// debugRead is the answer of the host call debugRead.
type debugRead struct {
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	Truncated bool   `json:"truncated"`
	Kind      string `json:"kind"`
	Text      string `json:"text"`
	Image     string `json:"image"`
}

func (s *Shell) viewDebugFile(param debugPathParam) error {
	if err := s.requireDebug(); err != nil {
		return err
	}
	debug := s.debug
	s.calls.Call("debugRead", param, s.debugAnswer(debug, func(value any) error {
		file, err := decode[debugRead](value)
		if err != nil {
			return err
		}
		shown := &DebugShown{Path: file.Path, Size: file.Size, Truncated: file.Truncated, Kind: file.Kind, Text: file.Text}
		if file.Kind == "image" {
			encoded, ok := strings.CutPrefix(file.Image, debugShownImage)
			if !ok {
				return fmt.Errorf("the image of %s has no PNG address", file.Path)
			}
			data, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				return fmt.Errorf("the image of %s: %w", file.Path, err)
			}
			if shown.Image, err = ui.DecodeImage(data); err != nil {
				return fmt.Errorf("the image of %s: %w", file.Path, err)
			}
		}
		debug.view.Viewing, debug.view.State = shown, nil
		return nil
	}))
	return nil
}

// stateListed refuses a path that is not a state file of the list.
func (s *Shell) stateListed(path string) error {
	for _, listed := range DebugStateFiles(s.debug.view.Entries) {
		if listed == path {
			return nil
		}
	}
	return fmt.Errorf("%s is not a state file of the list", path)
}

// readDebugState reads the state file path and gives it to take.
func (s *Shell) readDebugState(debug *debugState, path string, take func(state DebugState)) {
	s.calls.Call("debugRead", debugPathParam{Path: path}, s.debugAnswer(debug, func(value any) error {
		file, err := decode[debugRead](value)
		if err != nil {
			return err
		}
		state, err := ParseDebugState(path, file.Text, file.Truncated)
		if err != nil {
			return err
		}
		take(state)
		return nil
	}))
}

func (s *Shell) viewDebugState(param debugPathParam) error {
	if err := s.requireDebug(); err != nil {
		return err
	}
	if err := s.stateListed(param.Path); err != nil {
		return err
	}
	debug := s.debug
	s.readDebugState(debug, param.Path, func(state DebugState) {
		compare := []string{}
		for _, path := range DebugStateFiles(debug.view.Entries) {
			if path != param.Path {
				compare = append(compare, path)
			}
		}
		debug.view.Viewing = nil
		debug.view.State = &DebugStateView{Path: param.Path, Lines: DebugStateLines(state), Compare: compare}
	})
	return nil
}

func (s *Shell) compareDebugState(param debugWithParam) error {
	if err := s.requireDebug(); err != nil {
		return err
	}
	shown := s.debug.view.State
	if shown == nil {
		return fmt.Errorf("no state file is shown")
	}
	if param.With == "" {
		shown.With, shown.Differences = "", nil
		s.options.Invalidate()
		return nil
	}
	if param.With == shown.Path {
		return fmt.Errorf("%s is the shown state file", param.With)
	}
	if err := s.stateListed(param.With); err != nil {
		return err
	}
	debug := s.debug
	s.readDebugState(debug, shown.Path, func(first DebugState) {
		s.readDebugState(debug, param.With, func(second DebugState) {
			shown.With, shown.Differences = param.With, CompareDebugStates(first, second)
		})
	})
	return nil
}

func (s *Shell) saveDebugFile(param debugPathParam) error {
	if err := s.requireDebug(); err != nil {
		return err
	}
	debug := s.debug
	debug.view.Operation, debug.view.Failure = &DebugOperation{Action: "save", Path: param.Path, State: "running"}, nil
	s.options.Invalidate()
	s.calls.Call("debugSave", param, func(value any, err error) {
		if s.debug != debug {
			return
		}
		debug.view.Operation.State = "done"
		if err != nil {
			debug.view.Operation.State = "failed"
			s.debugFailed(err)
		}
		s.options.Invalidate()
	})
	return nil
}

// saveDebugFiles starts a save of the logs folder, which the events debug-save-progress and debug-save-done follow.
func (s *Shell) saveDebugFiles() error {
	if err := s.requireDebug(); err != nil {
		return err
	}
	debug := s.debug
	if running := debug.view.Operation; running != nil && running.Action == "save-all" && running.State == "running" {
		path := running.Path
		if path == "" {
			path = "the save panel is open"
		}
		err := fmt.Errorf("debug: a save of the logs folder is running: %s", path)
		s.debugFailed(err)
		return err
	}
	debug.view.Operation, debug.view.Failure = &DebugOperation{Action: "save-all", State: "running"}, nil
	s.options.Invalidate()
	s.calls.Call("debugSaveAll", nil, func(value any, err error) {
		if s.debug != debug {
			return
		}
		started, decoded := decode[struct {
			Saved *string `json:"saved"`
			Total int64   `json:"total"`
		}](value)
		if err == nil {
			err = decoded
		}
		switch {
		case err != nil:
			debug.view.Operation.State = "failed"
			s.debugFailed(err)
		case started.Saved == nil:
			debug.view.Operation.State = "done"
		default:
			debug.view.Operation = &DebugOperation{Action: "save-all", Path: *started.Saved, State: "running", Total: started.Total, Writing: true}
		}
		s.options.Invalidate()
	})
	return nil
}

func (s *Shell) debugSaveProgress(data []any) {
	progress, err := eventBody[struct {
		Saved   string `json:"saved"`
		Written int64  `json:"written"`
		Total   int64  `json:"total"`
	}]("debug-save-progress", data)
	if err != nil {
		s.fail(err)
		return
	}
	if s.debug == nil {
		return
	}
	s.debug.view.Operation = &DebugOperation{Action: "save-all", Path: progress.Saved, State: "running", Written: progress.Written, Total: progress.Total, Writing: true}
	s.options.Invalidate()
}

func (s *Shell) debugSaveDone(data []any) {
	done, err := eventBody[struct {
		Saved string  `json:"saved"`
		Error *string `json:"error"`
	}]("debug-save-done", data)
	if err != nil {
		s.fail(err)
		return
	}
	if s.debug == nil {
		if done.Error != nil {
			s.fail(fmt.Errorf("%s", *done.Error))
		}
		return
	}
	operation := &DebugOperation{Action: "save-all", Path: done.Saved, State: "done"}
	if running := s.debug.view.Operation; running != nil && running.Path == done.Saved {
		operation.Written, operation.Total = running.Written, running.Total
	}
	s.debug.view.Operation = operation
	if done.Error != nil {
		operation.State = "failed"
		s.debugFailed(fmt.Errorf("%s", *done.Error))
	}
	s.options.Invalidate()
}

// debugStatus is the value of the status core.debug (docs/spec/debug.md#status).
func (s *Shell) debugStatus() any {
	status := map[string]any{"open": s.debug != nil, "recorded": nil, "entries": []any{}, "viewing": nil, "timeline": nil, "state": nil, "scroll": 0,
		"operation": nil, "error": nil}
	if s.debug == nil {
		return status
	}
	view := s.debug.view
	status["recorded"] = s.debug.recorded
	entries := make([]map[string]any, 0, len(view.Entries))
	for _, entry := range view.Entries {
		entries = append(entries, map[string]any{"path": entry.Path, "size": entry.Size, "modified": entry.Modified})
	}
	status["entries"] = entries
	if file := view.Viewing; file != nil {
		status["viewing"] = map[string]any{"path": file.Path, "size": file.Size, "truncated": file.Truncated, "kind": file.Kind, "length": len([]rune(file.Text))}
	}
	if state := view.State; state != nil {
		var with *string
		if state.With != "" {
			with = &state.With
		}
		status["state"] = map[string]any{"path": state.Path, "lines": len(state.Lines), "with": with, "differences": len(state.Differences)}
	}
	if operation := view.Operation; operation != nil {
		var path *string
		if operation.Path != "" {
			path = &operation.Path
		}
		status["operation"] = map[string]any{"action": operation.Action, "path": path, "state": operation.State}
	}
	if view.Failure != nil {
		status["error"] = *view.Failure
	}
	return status
}

// drawDebug draws the open debug view over the workbench.
func (s *Shell) drawDebug(c *ui.Context, width, height float32) {
	if s.debug == nil {
		return
	}
	view := s.debug.view
	view.CardWidth, view.CardMaxHeight = s.metrics.debugW, s.metrics.debugH*height
	ui.Box(c).Absolute().Left(0).Top(0).Size(width, height).Children(func() {
		DrawDebugView(c, s.binder, view, s.errors)
	})
}
