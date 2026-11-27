package workbench

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"unicode/utf16"
)

// The entries of the notice center and their persistence (docs/spec/notifications.md#notice-center). The entries merge into the shown
// toasts and status lines of the notices in the toast path; this store holds the entries, their read state and their expiry.

// noticeKinds are the kinds of a notice (docs/spec/notifications.md#notices).
var noticeKinds = []string{"success", "info", "warning", "error", "progress"}

// NoticeSource is the source of a notice: a card, a plugin, the settings or the core.
type NoticeSource struct {
	Kind   string `json:"kind"`
	Card   string `json:"card,omitempty"`
	Tab    string `json:"tab,omitempty"`
	// Label is the title of the tab when the entry was added; the source chip shows it for a card entry.
	Label  string `json:"label,omitempty"`
	Plugin string `json:"plugin,omitempty"`
}

// NoticeAction is an action of a notice: a label and a declared command with its params.
type NoticeAction struct {
	Label   string         `json:"label"`
	Command string         `json:"command"`
	Params  map[string]any `json:"params,omitempty"`
}

// noticeFields are the fields of a notice of a command, checked with the notice rule (packages/plugin-api/tab-notice.js).
type noticeFields struct {
	Kind   string
	Title  string
	Text   string
	Action *NoticeAction
	System *bool
}

// utf16Length is the length of s in UTF-16 units, which is the length that the notice rule counts.
func utf16Length(s string) int {
	return len(utf16.Encode([]rune(s)))
}

// hasControl reports whether s holds a control character: U+0000 to U+001F or U+007F to U+009F.
func hasControl(s string) bool {
	for _, r := range s {
		if (r >= 0x00 && r <= 0x1f) || (r >= 0x7f && r <= 0x9f) {
			return true
		}
	}
	return false
}

// plainObject returns the keys of raw when raw is an object whose keys are all allowed; any other value is refused with the text of
// packages/plugin-api/tab-notice.js.
func plainObject(raw json.RawMessage, allowed []string, name string) (map[string]json.RawMessage, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return nil, fmt.Errorf("%s must be an object", name)
	}
	for key := range object {
		if !slices.Contains(allowed, key) {
			last := allowed[len(allowed)-1]
			return nil, fmt.Errorf("%s takes only %s and %s; found %s", name, strings.Join(allowed[:len(allowed)-1], ", "), last, key)
		}
	}
	return object, nil
}

// checkNoticeFields checks the fields of a notice of core.notices.add and returns them. kind and title are required; text, action
// and system are optional.
func checkNoticeFields(raw map[string]json.RawMessage) (noticeFields, error) {
	var fields noticeFields
	kind, _ := decodeString(raw["kind"])
	if !slices.Contains(noticeKinds, kind) {
		return fields, fmt.Errorf("a notice kind must be success, info, warning, error or progress")
	}
	title, ok := decodeString(raw["title"])
	if !ok || utf16Length(title) < 1 || utf16Length(title) > 120 || hasControl(title) {
		return fields, fmt.Errorf("a notice title must be 1 to 120 characters without control characters")
	}
	text := ""
	if value, present := raw["text"]; present {
		var ok bool
		text, ok = decodeString(value)
		if !ok || utf16Length(text) > 1024 || hasControl(text) {
			return fields, fmt.Errorf("a notice text must be 0 to 1024 characters without control characters")
		}
	}
	fields.Kind, fields.Title, fields.Text = kind, title, text
	if value, present := raw["action"]; present {
		action, err := checkNoticeAction(value)
		if err != nil {
			return fields, err
		}
		fields.Action = action
	}
	if value, present := raw["system"]; present {
		var system bool
		if err := json.Unmarshal(value, &system); err != nil {
			return fields, fmt.Errorf("a notice system must be true or false")
		}
		fields.System = &system
	}
	return fields, nil
}

// checkNoticeAction checks an action of a notice: a label of 1 to 24 characters, a declared command and optional params.
func checkNoticeAction(raw json.RawMessage) (*NoticeAction, error) {
	object, err := plainObject(raw, []string{"label", "command", "params"}, "a notice action")
	if err != nil {
		return nil, err
	}
	label, ok := decodeString(object["label"])
	if !ok || utf16Length(label) < 1 || utf16Length(label) > 24 {
		return nil, fmt.Errorf("a notice action label must be 1 to 24 characters")
	}
	command, ok := decodeString(object["command"])
	if !ok || command == "" {
		return nil, fmt.Errorf("a notice action command must be a non-empty string")
	}
	action := &NoticeAction{Label: label, Command: command}
	if value, present := object["params"]; present {
		var params map[string]any
		if err := json.Unmarshal(value, &params); err != nil || params == nil {
			return nil, fmt.Errorf("a notice action params must be an object")
		}
		action.Params = params
	}
	return action, nil
}

// decodeString returns the string of a JSON value and whether the value is a string.
func decodeString(raw json.RawMessage) (string, bool) {
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", false
	}
	return text, true
}
