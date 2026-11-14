package host

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// paramsOf encodes the params of a request.
func paramsOf(t *testing.T, params map[string]any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// invalidParams fails the test unless err is the error -32602.
func invalidParams(t *testing.T, params map[string]any, err error) {
	t.Helper()
	var coded *RPCError
	if !errors.As(err, &coded) || coded.Code != codeInvalidParams {
		t.Fatalf("%v: error %v, want the error %d", params, err, codeInvalidParams)
	}
}

// contract: endpoint.input.pointer-missing-coordinate, endpoint.input.pointer-numeric-button-rejected, endpoint.input.pointer-middle-button-rejected, endpoint.input.pointer-clicks-range, endpoint.input.pointer-clicks-only-on-press-and-release, endpoint.input.pointer-unknown-field-rejected, endpoint.input.pointer-activate-only-on-move, endpoint.input.pointer-activate-must-be-bool, endpoint.input.pointer-phase-and-scroll-decoding, endpoint.input.pointer-name
func TestPointerInputRejectsInvalidParams(t *testing.T) {
	rejected := []map[string]any{
		{"window": "main", "x": 1, "y": 2, "phase": "down", "button": 0},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "button": "middle"},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "activate": true},
		{"window": "main", "y": 2, "phase": "move"},
		{"window": "main", "x": 1, "y": 2, "phase": "move", "activate": "yes"},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "clicks": 0},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "clicks": -1},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "clicks": 4},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "clicks": 1.5},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "clicks": "2"},
		{"window": "main", "x": 1, "y": 2, "phase": "move", "clicks": 2},
		{"window": "main", "x": 1, "y": 2, "phase": "drag", "clicks": 2},
		{"window": "main", "x": 1, "y": 2, "phase": "scroll", "clicks": 2},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "clickCount": 2},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "Clicks": 2},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "pointer": ""},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "pointer": "Second"},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "pointer": "a b"},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "pointer": strings.Repeat("p", 33)},
		{"window": "main", "x": 1, "y": 2, "phase": "down", "pointer": 2},
		{"window": "main", "x": 1, "y": 2, "phase": "hover"},
	}
	for _, params := range rejected {
		_, err := pointerInput(paramsOf(t, params))
		invalidParams(t, params, err)
	}
}

// contract: endpoint.input.pointer-clicks-default, endpoint.input.pointer-activate-only-on-move, endpoint.input.pointer-defaults, endpoint.input.pointer-right-button-accepted, endpoint.input.pointer-phase-and-scroll-decoding, endpoint.input.pointer-name
func TestPointerInputReadsValidParams(t *testing.T) {
	cases := []struct {
		params map[string]any
		want   PointerInput
	}{
		{map[string]any{"window": "main", "x": 1, "y": 2, "phase": "move", "activate": true},
			PointerInput{Pointer: "main", X: 1, Y: 2, Phase: "move", Button: "left", Activate: true, Clicks: 1}},
		{map[string]any{"window": "main", "x": 3, "y": 4, "phase": "up", "button": "right"},
			PointerInput{Pointer: "main", X: 3, Y: 4, Phase: "up", Button: "right", Clicks: 1}},
		{map[string]any{"window": "main", "x": 1.5, "y": 2, "phase": "drag"},
			PointerInput{Pointer: "main", X: 1.5, Y: 2, Phase: "drag", Button: "left", Clicks: 1}},
		{map[string]any{"window": "main", "x": 0, "y": 0, "phase": "scroll", "deltaY": -3, "button": "right"},
			PointerInput{Pointer: "main", X: 0, Y: 0, Phase: "scroll", Button: "right", DeltaY: -3, Clicks: 1}},
		{map[string]any{"window": "main", "x": 5, "y": 6, "phase": "down", "clicks": 2},
			PointerInput{Pointer: "main", X: 5, Y: 6, Phase: "down", Button: "left", Clicks: 2}},
		{map[string]any{"window": "main", "x": 5, "y": 6, "phase": "up", "clicks": 3},
			PointerInput{Pointer: "main", X: 5, Y: 6, Phase: "up", Button: "left", Clicks: 3}},
		{map[string]any{"window": "main", "x": 7, "y": 8, "phase": "down", "pointer": "second-1"},
			PointerInput{Pointer: "second-1", X: 7, Y: 8, Phase: "down", Button: "left", Clicks: 1}},
		{map[string]any{"window": "main", "x": 7, "y": 8, "phase": "drag", "pointer": strings.Repeat("p", 32)},
			PointerInput{Pointer: strings.Repeat("p", 32), X: 7, Y: 8, Phase: "drag", Button: "left", Clicks: 1}},
	}
	for _, c := range cases {
		got, err := pointerInput(paramsOf(t, c.params))
		if err != nil {
			t.Fatalf("%v: %v", c.params, err)
		}
		if got != c.want {
			t.Fatalf("%v: pointer input %+v, want %+v", c.params, got, c.want)
		}
	}
}

// contract: endpoint.input.key-unknown-modifier-rejected, endpoint.input.key-shift-command-mask, endpoint.input.key-control-option-and-text, endpoint.input.key-invalid-phase-or-modifier-type, endpoint.input.key-empty-text-types-the-key
func TestKeyInputReadsParams(t *testing.T) {
	rejected := []map[string]any{
		{"window": "main", "key": "a", "phase": "down", "modifiers": []string{"hyper"}},
		{"window": "main", "key": "a", "phase": "hold"},
		{"window": "main", "key": "a", "phase": "down", "modifiers": 2},
	}
	for _, params := range rejected {
		_, err := keyInput(paramsOf(t, params))
		invalidParams(t, params, err)
	}
	cases := []struct {
		params map[string]any
		want   KeyInput
	}{
		{map[string]any{"window": "main", "key": "a", "phase": "up", "modifiers": []string{"shift", "command"}}, KeyInput{Key: "a", Modifiers: 9}},
		{map[string]any{"window": "main", "key": "a", "text": "A", "phase": "up", "modifiers": []string{"control", "option"}},
			KeyInput{Key: "a", Text: "A", Modifiers: 6}},
		// InjectKey types the key name for an empty text.
		{map[string]any{"window": "main", "key": "Enter", "text": "", "phase": "down"}, KeyInput{Key: "Enter", Down: true}},
	}
	for _, c := range cases {
		got, err := keyInput(paramsOf(t, c.params))
		if err != nil {
			t.Fatalf("%v: %v", c.params, err)
		}
		if got != c.want {
			t.Fatalf("%v: key input %+v, want %+v", c.params, got, c.want)
		}
	}
}

// contract: endpoint.input.text-phases, endpoint.input.text-ranges, endpoint.input.text-invalid
func TestTextInputReadsParams(t *testing.T) {
	cases := []struct {
		params map[string]any
		want   TextInput
	}{
		{map[string]any{"window": "main", "phase": "mark", "text": "한😀"}, TextInput{Phase: TextMark, Text: "한😀", SelectionStart: 3, ReplacementStart: -1}},
		{map[string]any{"window": "main", "phase": "mark", "text": "한글", "selection": map[string]any{"start": 0, "length": 1},
			"replacement": map[string]any{"start": 2, "length": 3}},
			TextInput{Phase: TextMark, Text: "한글", SelectionStart: 0, SelectionLength: 1, ReplacementStart: 2, ReplacementLength: 3}},
		{map[string]any{"window": "main", "phase": "insert", "text": "한"}, TextInput{Phase: TextInsert, Text: "한", ReplacementStart: -1}},
		{map[string]any{"window": "main", "phase": "unmark"}, TextInput{Phase: TextUnmark, ReplacementStart: -1}},
	}
	for _, c := range cases {
		got, err := textInput(paramsOf(t, c.params))
		if err != nil {
			t.Fatalf("%v: %v", c.params, err)
		}
		if got != c.want {
			t.Fatalf("%v: text input %+v, want %+v", c.params, got, c.want)
		}
	}
	invalid := []map[string]any{
		{"window": "main", "phase": "compose", "text": "a"},
		{"window": "main", "phase": "mark"},
		{"window": "main", "phase": "unmark", "text": "a"},
		{"window": "main", "phase": "mark", "text": "ab", "selection": map[string]any{"start": 1, "length": 2}},
		{"window": "main", "phase": "insert", "text": "a", "selection": map[string]any{"start": 0, "length": 0}},
		{"window": "main", "phase": "insert", "text": "a", "replacement": map[string]any{"start": -1, "length": 0}},
		{"window": "main", "phase": "mark", "text": "a", "selection": map[string]any{"start": 0}},
	}
	for _, params := range invalid {
		_, err := textInput(paramsOf(t, params))
		invalidParams(t, params, err)
	}
}

// contract: endpoint.input.dialog-answer
func TestDialogAnswerInputReadsParams(t *testing.T) {
	cases := []struct {
		params map[string]any
		want   DialogAnswer
	}{
		{map[string]any{"window": "main", "id": "d1", "paths": []string{"/saved/host.jsonl"}}, DialogAnswer{ID: "d1", Paths: []string{"/saved/host.jsonl"}}},
		{map[string]any{"window": "main", "id": "d2", "paths": []string{"/saved/host.jsonl"}, "replace": true},
			DialogAnswer{ID: "d2", Paths: []string{"/saved/host.jsonl"}, Replace: true}},
		{map[string]any{"window": "main", "id": "d3", "paths": []string{"/a", "/b"}}, DialogAnswer{ID: "d3", Paths: []string{"/a", "/b"}}},
		{map[string]any{"window": "main", "id": "d4", "cancel": true}, DialogAnswer{ID: "d4", Cancel: true}},
	}
	for _, c := range cases {
		got, err := dialogAnswerInput(paramsOf(t, c.params))
		if err != nil {
			t.Fatalf("%v: %v", c.params, err)
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Fatalf("%v: answer %+v, want %+v", c.params, got, c.want)
		}
	}
	invalid := []map[string]any{
		{"window": "main", "paths": []string{"/a"}},
		{"window": "main", "id": "", "paths": []string{"/a"}},
		{"window": "main", "id": "d5", "paths": []string{"/a"}, "cancel": true},
		{"window": "main", "id": "d5"},
		{"window": "main", "id": "d5", "cancel": false},
		{"window": "main", "id": "d5", "paths": "/a"},
		{"window": "main", "id": "d5", "paths": []any{3}},
		{"window": "main", "id": "d5", "cancel": true, "replace": true},
	}
	for _, params := range invalid {
		_, err := dialogAnswerInput(paramsOf(t, params))
		invalidParams(t, params, err)
	}
}
