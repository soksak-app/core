package workbench

import (
	"encoding/json"
	"fmt"
	"strings"
)

// The view calls that the keyboard, the clipboard and the text scale of a view reach (docs/spec/native-surfaces.md#view-surfaces).

// runInputCall runs the call when it is one of these calls and tells whether it was. A refusal is the answer of the call.
func (s *Shell) runInputCall(call viewCallEvent, view *viewState, answer viewAnswer) bool {
	done := func(_ any, err error) { answer(nil, err) }
	switch call.Command {
	case "runtime.textSize.read":
		view.scale = s.scaleOf(call.Surface)
		answer(view.scale, nil)
	case "runtime.textSize.on":
		view.scale, view.textSize = s.scaleOf(call.Surface), true
		answer(nil, nil)
	case "runtime.log.levels.on":
		view.levels = true
		answer(nil, nil)
	case "tab.focus":
		answer(nil, s.viewFocus(call))
	case "runtime.clipboard.read":
		s.readClipboard(call, answer)
	case "runtime.clipboard.writeText":
		var text string
		if err := json.Unmarshal(call.Params, &text); err != nil {
			answer(nil, fmt.Errorf("view call %s requires a string", call.Command))
			break
		}
		s.calls.Call("clipboardWriteText", text, done)
	case "runtime.clipboard.persistPNG":
		s.persistClipboard(call, answer)
	case "runtime.links.open":
		var url string
		if err := json.Unmarshal(call.Params, &url); err != nil || url == "" {
			answer(nil, fmt.Errorf("view call %s requires a non-empty URL", call.Command))
			break
		}
		s.calls.Call("linkOpen", map[string]string{"url": url}, done)
	default:
		return false
	}
	return true
}

// scaleOf is the text scale of the view of surface: the frame factor with the factor of the card that holds the surface. A view
// of no card has the frame factor.
func (s *Shell) scaleOf(surface string) float64 {
	if s.plane == nil {
		return s.text.Frame()
	}
	for _, card := range s.plane.Cards() {
		data, err := s.cardData(card.ID)
		if err != nil {
			continue // A card without tabs holds no surface.
		}
		for _, tab := range data.TabList() {
			if tab.ID == surface {
				return s.text.Effective(card.ID)
			}
		}
	}
	return s.text.Frame()
}

// followScale sends each view that follows its text scale the scale that changed.
func (s *Shell) followScale() {
	for surface, view := range s.surfaces.views {
		if scale := s.scaleOf(surface); view.textSize && scale != view.scale {
			view.scale = scale
			s.pushView(surface, view, "textSize", scale)
		}
	}
}

// followLogLevels sends each view that follows the log levels the stored level of each class of the event log-policy.
func (s *Shell) followLogLevels(data []any) {
	policy, err := eventBody[struct {
		Classes map[string]string `json:"classes"`
	}]("log-policy", data)
	if err != nil {
		s.fail(err)
		return
	}
	for surface, view := range s.surfaces.views {
		if view.levels {
			s.pushView(surface, view, "log.levels", policy.Classes)
		}
	}
}

// viewFocus records the exposed element that a view reports as focused, or null.
func (s *Shell) viewFocus(call viewCallEvent) error {
	var focus *struct {
		Name  string `json:"name"`
		Index *int   `json:"index"`
	}
	if err := json.Unmarshal(call.Params, &focus); err != nil {
		return fmt.Errorf("view call %s requires {name, index} or null, not %s", call.Command, call.Params)
	}
	if focus != nil && (focus.Name == "" || focus.Index == nil || *focus.Index < 0) {
		return fmt.Errorf("view call %s requires {name, index} or null, not %s", call.Command, call.Params)
	}
	return nil
}

// readClipboard answers a clipboard read: null for an absent payload, and for a PNG the id of the binary store of the view.
func (s *Shell) readClipboard(call viewCallEvent, answer viewAnswer) {
	var kind string
	if err := json.Unmarshal(call.Params, &kind); err != nil {
		answer(nil, fmt.Errorf("view call %s requires a type", call.Command))
		return
	}
	switch kind {
	case "png":
		s.calls.Call("clipboardReadViewPNG", map[string]any{"surface": call.Surface, "userInitiated": true}, func(value any, err error) {
			if err != nil {
				answer(nil, err)
				return
			}
			png, err := decode[struct {
				Present bool   `json:"present"`
				Type    string `json:"type"`
				Binary  string `json:"binary"`
			}](value)
			switch {
			case err != nil:
				answer(nil, err)
			case !png.Present:
				answer(nil, nil)
			default:
				answer(map[string]any{"present": true, "type": "png", "binary": png.Binary}, nil)
			}
		})
	case "text", "fileURLs":
		s.calls.Call("clipboardRead", map[string]any{"type": kind, "userInitiated": true}, func(value any, err error) {
			if err != nil {
				answer(nil, err)
				return
			}
			read, err := decode[struct {
				Present bool     `json:"present"`
				Text    string   `json:"text"`
				URLs    []string `json:"urls"`
			}](value)
			switch {
			case err != nil:
				answer(nil, err)
			case !read.Present:
				answer(nil, nil)
			case kind == "text":
				answer(read.Text, nil)
			default:
				answer(read.URLs, nil)
			}
		})
	default:
		answer(nil, fmt.Errorf("view call %s %s is not served", call.Command, kind))
	}
}

// persistClipboard stores the PNG of an upload of the view and answers its path, also quoted for a shell.
func (s *Shell) persistClipboard(call viewCallEvent, answer viewAnswer) {
	fields, err := viewFields[struct {
		Binary string `json:"binary"`
	}](call)
	if err != nil {
		answer(nil, err)
		return
	}
	s.calls.Call("clipboardPersistViewPNG", map[string]any{"surface": call.Surface, "binary": fields.Binary}, func(value any, err error) {
		if err != nil {
			answer(nil, err)
			return
		}
		persisted, err := decode[struct {
			Path string `json:"path"`
		}](value)
		if err == nil && persisted.Path == "" {
			err = fmt.Errorf("view call %s: the host reply has no path", call.Command)
		}
		if err != nil {
			answer(nil, err)
			return
		}
		answer(map[string]string{"path": persisted.Path, "shellQuotedPath": shellQuoted(persisted.Path)}, nil)
	})
}

// shellQuoted is path as one argument of a shell.
func shellQuoted(path string) string {
	return "'" + strings.ReplaceAll(path, "'", `'\''`) + "'"
}
