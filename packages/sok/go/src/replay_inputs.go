package sok

// The rules of the replay inputs of a session (docs/spec/replay.md#records): the forms of each kind and the rules of a
// session, with the texts of replayInputProblem and replaySessionProblem of @soksak/log-contract, whose golden cases
// (docs/spec/cases/log-contract/replay/inputs.json) both tools reproduce.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strings"
)

// ReplayInputKinds are the kinds of the replay inputs, which replay.inputs of a sidecar.json maps to event names.
var ReplayInputKinds = []string{"output", "write", "resize", "selection", "viewport", "theme"}

var (
	replayHex   = regexp.MustCompile(`^(?:[0-9a-f]{2})+$`)
	replayColor = regexp.MustCompile(`^#[0-9a-f]{6}$`)
)

// ReplayInput is one replay input of a session: its kind and its fields as the event stored them.
type ReplayInput struct {
	Kind   string
	Fields json.RawMessage
}

// replayFields holds the members of the fields of an input in their order, so a problem names the first member that breaks a
// rule as the JavaScript reader does.
type replayFields struct {
	values map[string]any
	order  []string
}

func parseReplayFields(raw json.RawMessage) (replayFields, error) {
	fields := replayFields{values: map[string]any{}}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return fields, fmt.Errorf("the fields are not an object")
	}
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return fields, err
		}
		name := token.(string)
		var value any
		if name == "colors" {
			var colors json.RawMessage
			if err := decoder.Decode(&colors); err != nil {
				return fields, err
			}
			value = colors
		} else if err := decoder.Decode(&value); err != nil {
			return fields, err
		}
		fields.values[name] = value
		fields.order = append(fields.order, name)
	}
	return fields, nil
}

// shown writes a value as JSON.stringify writes it, and undefined for an absent member.
func shown(value any, present bool) string {
	if !present {
		return "undefined"
	}
	if raw, isRaw := value.(json.RawMessage); isRaw {
		var compact bytes.Buffer
		if err := json.Compact(&compact, raw); err == nil {
			return compact.String()
		}
	}
	text, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	return string(text)
}

// integer returns the value of a member as an integer when it is a number without a fraction.
func (f replayFields) integer(name string) (int64, bool) {
	number, isNumber := f.values[name].(json.Number)
	if !isNumber {
		return 0, false
	}
	value, err := number.Float64()
	if err != nil || value != math.Trunc(value) {
		return 0, false
	}
	return int64(value), true
}

func (f replayFields) integerFrom(kind, name string, min int64) string {
	if value, ok := f.integer(name); ok && value >= min {
		return ""
	}
	value, present := f.values[name]
	return fmt.Sprintf("%s: %s must be an integer from %d, found %s", kind, name, min, shown(value, present))
}

// ReplayInputProblem is the problem of the fields of one replay input of kind as text, or the empty text when the fields are in
// the form of the contract.
func ReplayInputProblem(kind string, raw json.RawMessage) string {
	if !slices.Contains(ReplayInputKinds, kind) {
		return fmt.Sprintf("replay input %s is not one of %s", kind, strings.Join(ReplayInputKinds, ", "))
	}
	fields, err := parseReplayFields(raw)
	if err != nil {
		return fmt.Sprintf("%s: %v", kind, err)
	}
	if problem := fields.integerFrom(kind, "sequence", 1); problem != "" {
		return problem
	}
	switch kind {
	case "output", "write":
		if hex, isText := fields.values["hex"].(string); isText && replayHex.MatchString(hex) {
			return ""
		}
		value, present := fields.values["hex"]
		return fmt.Sprintf("%s: hex must be lowercase hexadecimal text of whole bytes, found %s", kind, shown(value, present))
	case "resize":
		if problem := fields.integerFrom(kind, "rows", 1); problem != "" {
			return problem
		}
		return fields.integerFrom(kind, "cols", 1)
	case "selection":
		// default: an action that is not text is refused by the check below with the value shown.
		action, _ := fields.values["action"].(string)
		if !slices.Contains([]string{"start", "update", "end", "clear"}, action) {
			value, present := fields.values["action"]
			return fmt.Sprintf("selection: action must be start, update, end or clear, found %s", shown(value, present))
		}
		if action == "start" || action == "update" {
			if problem := fields.integerFrom(kind, "edge", 0); problem != "" {
				return problem
			}
			return fields.integerFrom(kind, "row", 0)
		}
		_, edge := fields.values["edge"]
		_, row := fields.values["row"]
		if edge || row {
			return fmt.Sprintf("selection: %s takes no edge and no row", action)
		}
		return ""
	case "viewport":
		lines, hasLines := fields.values["lines"]
		newest, hasNewest := fields.values["newest"]
		switch {
		case hasLines && hasNewest:
			return "viewport: lines and newest are exclusive"
		case !hasLines && !hasNewest:
			return "viewport: lines (a non-zero integer) or newest (true) is required"
		case hasNewest:
			if newest == true {
				return ""
			}
			return fmt.Sprintf("viewport: newest must be true, found %s", shown(newest, true))
		}
		if value, ok := fields.integer("lines"); ok && value != 0 {
			return ""
		}
		return fmt.Sprintf("viewport: lines must be a non-zero integer, found %s", shown(lines, true))
	}
	colors, present := fields.values["colors"]
	// default: a colors member that is not an object is refused by the parse below with the value shown.
	colorsText, _ := colors.(json.RawMessage)
	theme, err := parseReplayFields(colorsText)
	if !present || err != nil {
		return fmt.Sprintf("theme: colors must be an object of colors, found %s", shown(colors, present))
	}
	for _, name := range []string{"foreground", "background", "selection"} {
		if _, found := theme.values[name]; !found {
			return fmt.Sprintf("theme: colors.%s is required", name)
		}
	}
	for _, name := range theme.order {
		if color, isText := theme.values[name].(string); !isText || !replayColor.MatchString(color) {
			return fmt.Sprintf(`theme: colors.%s must be "#rrggbb" in lowercase, found %s`, name, shown(theme.values[name], true))
		}
	}
	return ""
}

// ReplaySessionProblem is the problem of the replay inputs of one session in the order they were applied, as text, or the empty
// text: each input is in form, the sequences run from 1 without a gap, the first input is a theme, a selection start or update
// lies inside the grid of the last resize, and a selection update or end follows a selection start.
func ReplaySessionProblem(inputs []ReplayInput) string {
	previous := int64(0)
	selecting := false
	var rows, cols int64
	resized := false
	for index, input := range inputs {
		at := index + 1
		if problem := ReplayInputProblem(input.Kind, input.Fields); problem != "" {
			return fmt.Sprintf("input %d: %s", at, problem)
		}
		// default: the form check above requires this member, so the zero value is never read.
		fields, _ := parseReplayFields(input.Fields)
		// default: the form check above requires this member, so the zero value is never read.
		sequence, _ := fields.integer("sequence")
		if sequence != previous+1 {
			return fmt.Sprintf("input %d has sequence %d and the sequence after %d is %d", at, sequence, previous, previous+1)
		}
		previous = sequence
		if index == 0 && input.Kind != "theme" {
			return fmt.Sprintf("input 1 is a %s and the first input of a session is a theme", input.Kind)
		}
		if input.Kind == "resize" {
			// default: the form check above requires these members, so the zero values are never read.
			gridRows, _ := fields.integer("rows")
			// default: the form check above requires these members, so the zero values are never read.
			gridCols, _ := fields.integer("cols")
			rows, cols, resized = gridRows, gridCols, true
		}
		if input.Kind != "selection" {
			continue
		}
		action := fields.values["action"].(string)
		if action == "start" || action == "update" {
			if !resized {
				return fmt.Sprintf("input %d is a selection %s before any resize", at, action)
			}
			// default: the form check above requires this member, so the zero value is never read.
			edge, _ := fields.integer("edge")
			// default: the form check above requires this member, so the zero value is never read.
			row, _ := fields.integer("row")
			if row >= rows || edge > cols {
				return fmt.Sprintf("input %d is a selection %s at edge %d row %d outside the grid of %d rows and %d columns", at, action, edge, row, rows, cols)
			}
		}
		if (action == "update" || action == "end") && !selecting {
			return fmt.Sprintf("input %d is a selection %s and no selection has started", at, action)
		}
		selecting = action == "start" || action == "update"
	}
	return ""
}
