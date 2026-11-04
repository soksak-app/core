package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
)

// The files dropped on the window (docs/spec/native-surfaces.md#file-drop). The host sends the text that its drop view made, and
// the workbench gives the files to the drop command of the plugin of the view under the point, as dropFiles of
// packages/workbench/core-exposure.js does.

// dropRecord is the status core.drop: the files last dropped and the result of their handling.
type dropRecord struct {
	URLs    []string `json:"urls"`
	X       *float64 `json:"x"`
	Y       *float64 `json:"y"`
	Surface *string  `json:"surface"`
	Command *string  `json:"command"`
	Error   *string  `json:"error"`
}

// filesDropped handles the event files-dropped.
func (s *Shell) filesDropped(data []any) {
	record := &dropRecord{}
	if err := s.runDrop(data, record); err != nil {
		s.dropEnded(record, err)
	}
}

// dropEnded records the end of a drop. A failure names its reason in the status and in the application log.
func (s *Shell) dropEnded(record *dropRecord, err error) {
	if err != nil {
		reason := err.Error()
		record.Error = &reason
		s.options.Report("drop: " + reason)
	}
	s.lastDrop = record
	s.options.Invalidate()
}

// runDrop runs the drop command of the view under the drop point. The status takes each fact as it is known.
func (s *Shell) runDrop(data []any, record *dropRecord) error {
	if len(data) != 1 {
		return errors.New("the application sent an invalid file drop")
	}
	text, ok := data[0].(string)
	if !ok {
		return errors.New("the application sent an invalid file drop")
	}
	if err := json.Unmarshal([]byte(text), record); err != nil {
		return errors.New("the application sent an invalid file drop")
	}
	if len(record.URLs) == 0 || record.X == nil || record.Y == nil {
		return errors.New("the application sent an invalid file drop")
	}
	surface, found := s.surfaceAt(*record.X, *record.Y)
	if !found {
		return errors.New("no surface is under the drop point")
	}
	record.Surface = &surface
	plugin := s.surfaces.held[surface].tab.Plugin
	command := s.units[plugin].Drop
	if command == "" {
		return fmt.Errorf("plugin %s declares no drop command", plugin)
	}
	record.Command = &command
	params, err := json.Marshal(map[string][]string{"urls": record.URLs})
	if err != nil {
		return err
	}
	return s.runViewCommand(surface, command, params, nil, func(_ any, err error) { s.dropEnded(record, err) })
}

// surfaceAt returns the view that the point of the window shows. A layer of the window covers the views under it.
func (s *Shell) surfaceAt(x, y float64) (string, bool) {
	if s.picker.open || s.settingsWindow.open {
		return "", false
	}
	for id, box := range s.surfaces.drawn {
		if x >= box.X && x < box.X+box.W && y >= box.Y && y < box.Y+box.H {
			return id, true
		}
	}
	return "", false
}
