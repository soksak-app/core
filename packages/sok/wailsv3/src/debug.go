package sok

// `sok debug query` (docs/spec/debug.md#timeline-command): one page of the events of the event files of the configuration directory,
// printed as the text lines of the timeline of the debug view (packages/workbench/debug-timeline.js). The reader of an event line,
// its text line and the JSON helpers that keep the output of the two implementations equal are here.

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const eventSchema = 2

var utcTime = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$`)

// eventMember is one eventMember of a JSON object in the order of the text, which the text line of a row keeps.
type eventMember struct {
	name  string
	value any
}

// eventObject is a JSON object whose members keep the order of the text. A repeated name is read as the last one, as JSON.parse does.
type eventObject []eventMember

func (o eventObject) get(name string) (any, bool) {
	for i := len(o) - 1; i >= 0; i-- {
		if o[i].name == name {
			return o[i].value, true
		}
	}
	return nil, false
}

// decodeValue reads one JSON value: nil, bool, json.Number, string, []any or object.
func decodeValue(dec *json.Decoder) (any, error) {
	token, err := dec.Token()
	if err != nil {
		return nil, err
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		return token, nil
	}
	if delim == '[' {
		items := []any{}
		for dec.More() {
			item, err := decodeValue(dec)
			if err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		_, err := dec.Token()
		return items, err
	}
	members := eventObject{}
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return nil, err
		}
		value, err := decodeValue(dec)
		if err != nil {
			return nil, err
		}
		members = append(members, eventMember{key.(string), value})
	}
	_, err = dec.Token()
	return members, err
}

// parseJSON reads text as one JSON value and nothing else.
func parseJSON(text string) (any, error) {
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	value, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("trailing data")
	}
	return value, nil
}

// jsNumber is the text that JSON.stringify gives a number.
func jsNumber(v float64) string {
	if v == 0 {
		return "0"
	}
	negative := v < 0
	text := strconv.FormatFloat(math.Abs(v), 'e', -1, 64)
	// FormatFloat with 'e' always writes d[.ddd]e±dd.
	mantissa, exponentText, found := strings.Cut(text, "e")
	exponent, err := strconv.Atoi(exponentText)
	if !found || err != nil {
		panic("strconv.FormatFloat wrote " + text + " without an exponent")
	}
	digits := strings.Replace(mantissa, ".", "", 1)
	n := exponent + 1
	var out string
	switch {
	case 0 < n && n <= 21:
		if len(digits) <= n {
			out = digits + strings.Repeat("0", n-len(digits))
		} else {
			out = digits[:n] + "." + digits[n:]
		}
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		out = digits[:1]
		if len(digits) > 1 {
			out += "." + digits[1:]
		}
		sign := "+"
		if n-1 < 0 {
			sign = "-"
		}
		out += "e" + sign + strconv.Itoa(int(math.Abs(float64(n-1))))
	}
	if negative {
		out = "-" + out
	}
	return out
}

// jsString is the text that JSON.stringify gives a string.
func jsString(s string) string {
	var out strings.Builder
	out.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			out.WriteString(`\"`)
		case r == '\\':
			out.WriteString(`\\`)
		case r == '\b':
			out.WriteString(`\b`)
		case r == '\f':
			out.WriteString(`\f`)
		case r == '\n':
			out.WriteString(`\n`)
		case r == '\r':
			out.WriteString(`\r`)
		case r == '\t':
			out.WriteString(`\t`)
		case r < 0x20:
			fmt.Fprintf(&out, `\u%04x`, r)
		default:
			out.WriteRune(r)
		}
	}
	out.WriteByte('"')
	return out.String()
}

// stringify is JSON.stringify of a decoded value; a missing value is `undefined`.
func stringify(value any, present bool) string {
	if !present {
		return "undefined"
	}
	switch v := value.(type) {
	case nil:
		return "null"
	case bool:
		return strconv.FormatBool(v)
	case json.Number:
		f, err := v.Float64()
		if err != nil {
			return "undefined"
		}
		return jsNumber(f)
	case string:
		return jsString(v)
	case []any:
		parts := make([]string, len(v))
		for i, item := range v {
			parts[i] = stringify(item, true)
		}
		return "[" + strings.Join(parts, ",") + "]"
	case eventObject:
		// A repeated name is one eventMember at the position of its first appearance with its last value.
		var names []string
		seen := map[string]bool{}
		for _, m := range v {
			if !seen[m.name] {
				seen[m.name] = true
				names = append(names, m.name)
			}
		}
		parts := make([]string, len(names))
		for i, name := range names {
			// default: the name comes from the members of this object, so the lookup finds it.
			last, _ := v.get(name)
			parts[i] = jsString(name) + ":" + stringify(last, true)
		}
		return "{" + strings.Join(parts, ",") + "}"
	}
	return "undefined"
}

// eventRow is one line of an event file.
type eventRow struct {
	file    string
	tsUs    int64
	seq     int64
	level   string
	layer   string
	class   *string
	name    string
	window  *string
	surface *string
	session *string
	cids    []string
	fields  eventObject
}

func isInteger(value any) (int64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := number.Float64()
	if err != nil || f != math.Trunc(f) || math.IsInf(f, 0) {
		return 0, false
	}
	return int64(f), true
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// rowOf reads one event line into a row, or fails with an error that names the file and the line.
func rowOf(file string, number int, raw string) (eventRow, error) {
	where := fmt.Sprintf("%s:%d", file, number)
	fail := func(format string, args ...any) (eventRow, error) {
		return eventRow{}, fmt.Errorf(where+": "+format, args...)
	}
	parsed, err := parseJSON(raw)
	if err != nil {
		return fail("not JSON: %s", raw)
	}
	event, ok := parsed.(eventObject)
	if !ok {
		return fail("not an event object: %s", raw)
	}
	row := eventRow{file: file}
	for _, name := range []string{"ts_us", "seq"} {
		value, present := event.get(name)
		n, integer := isInteger(value)
		if !integer {
			return fail("%s must be an integer, found %s", name, stringify(value, present))
		}
		if name == "ts_us" {
			row.tsUs = n
		} else {
			row.seq = n
		}
	}
	level, present := event.get("level")
	if text, ok := level.(string); !ok || !contains(indexLevels, text) {
		return fail("level %s is not one of %s", stringify(level, present), strings.Join(indexLevels, ", "))
	}
	row.level = level.(string)
	layer, present := event.get("layer")
	if text, ok := layer.(string); !ok || !contains(indexLayers, text) {
		return fail("layer %s is not one of %s", stringify(layer, present), strings.Join(indexLayers, ", "))
	}
	row.layer = layer.(string)
	if class, present := event.get("class"); present {
		text, ok := class.(string)
		if !ok || !contains(indexClasses, text) {
			return fail("class %s is not one of %s", stringify(class, true), strings.Join(indexClasses, ", "))
		}
		row.class = &text
	}
	name, present := event.get("event")
	text, ok := name.(string)
	if !ok {
		return fail("event must be a string, found %s", stringify(name, present))
	}
	row.name = text
	if fields, present := event.get("fields"); present {
		members, ok := fields.(eventObject)
		if !ok {
			return fail("fields must be an object, found %s", stringify(fields, true))
		}
		row.fields = members
	}
	for _, identifier := range []struct {
		name string
		to   **string
	}{{"window", &row.window}, {"surface", &row.surface}, {"session", &row.session}} {
		value, present := event.get(identifier.name)
		if !present {
			continue
		}
		text, ok := value.(string)
		if !ok {
			return fail("%s must be a string, found %s", identifier.name, stringify(value, true))
		}
		*identifier.to = &text
	}
	if cids, present := event.get("cids"); present {
		list, ok := cids.([]any)
		for _, item := range list {
			if _, isString := item.(string); !isString {
				ok = false
			}
		}
		if !ok {
			return fail("cids must be an array of strings, found %s", stringify(cids, true))
		}
		for _, item := range list {
			row.cids = append(row.cids, item.(string))
		}
	}
	return row, nil
}

// timeText is the time of a row as UTC text with microseconds.
func timeText(tsUs int64) string {
	return time.UnixMicro(tsUs).UTC().Format("2006-01-02T15:04:05.000000Z")
}

// eventLine is one row as one text line: time, level, layer, event, identifiers, then the fields as `name=value`.
func eventLine(row eventRow) string {
	parts := []string{timeText(row.tsUs), row.level, row.layer, row.name}
	for _, identifier := range []struct {
		name  string
		value *string
	}{{"window", row.window}, {"surface", row.surface}, {"session", row.session}} {
		if identifier.value != nil {
			parts = append(parts, identifier.name+"="+*identifier.value)
		}
	}
	if row.cids != nil {
		parts = append(parts, "cids="+strings.Join(row.cids, ","))
	}
	seen := map[string]bool{}
	for _, m := range row.fields {
		if seen[m.name] {
			continue
		}
		seen[m.name] = true
		// default: the name comes from the members of this object, so the lookup finds it.
		last, _ := row.fields.get(m.name)
		parts = append(parts, m.name+"="+stringify(last, true))
	}
	return strings.Join(parts, " ")
}

// timeBound is the microseconds of a UTC time given to --from and --to.
func timeBound(name, value string) (int64, error) {
	invalid := fmt.Errorf("log query %s %s is not a UTC time like 2026-10-08T22:53:20.123456Z", name, jsString(value))
	match := utcTime.FindStringSubmatch(value)
	if match == nil {
		return 0, invalid
	}
	var number [6]int
	for i := range number {
		n, err := strconv.Atoi(match[i+1])
		if err != nil {
			return 0, invalid
		}
		number[i] = n
	}
	date := time.Date(number[0], time.Month(number[1]), number[2], number[3], number[4], number[5], 0, time.UTC)
	// A date that the calendar does not have (for example February 30) moves to another day in time.Date.
	if date.Year() != number[0] || int(date.Month()) != number[1] || date.Day() != number[2] || number[3] > 23 || number[4] > 59 || number[5] > 59 {
		return 0, invalid
	}
	fraction, err := strconv.Atoi(match[7] + strings.Repeat("0", 6-len(match[7])))
	if err != nil {
		return 0, invalid
	}
	return date.Unix()*1000000 + int64(fraction), nil
}

// afterFlag reads the value of --after: `<ts_us>/<role>/<boot>/<seq>`. A text of another form is given on as it is, so the query
// refuses it with its own words.
func afterFlag(value string) any {
	parts := strings.Split(value, "/")
	if len(parts) == 4 {
		ts, tsErr := strconv.ParseInt(parts[0], 10, 64)
		seq, seqErr := strconv.ParseInt(parts[3], 10, 64)
		if tsErr == nil && seqErr == nil {
			return map[string]any{"ts_us": ts, "role": parts[1], "boot": parts[2], "seq": seq}
		}
	}
	return value
}

// runDebug runs `sok debug query`.
func runDebug(a arguments, stdout, stderr io.Writer, options Options) error {
	view, err := a.positional(1, "debug view")
	if err != nil {
		return err
	}
	if view == "replay" {
		return runReplay(a, stdout, options)
	}
	if view != "query" {
		return usage("unknown command: debug %s", view)
	}
	if len(a.positionals) > 2 {
		return usage("unexpected argument %s", a.positionals[2])
	}
	params := map[string]any{}
	for flag, name := range map[string]string{"channel": "channel", "level": "level", "class": "class", "layer": "layer", "event": "event",
		"event-prefix": "event_prefix", "surface": "surface", "session": "session", "cid": "cid", "run": "run", "text": "text", "order": "order"} {
		if value, given := a.values[flag]; given {
			params[name] = value
		}
	}
	if value, given := a.values["limit"]; given {
		if n, err := strconv.ParseInt(value, 10, 64); err == nil {
			params["limit"] = n
		} else {
			params["limit"] = value
		}
	}
	for flag, name := range map[string]string{"from": "from_us", "to": "to_us"} {
		if value, given := a.values[flag]; given {
			bound, err := timeBound(flag, value)
			if err != nil {
				return usage("%s", err.Error())
			}
			params[name] = bound
		}
	}
	if value, given := a.values["after"]; given {
		params["after"] = afterFlag(value)
	}
	text, err := json.Marshal(params)
	if err != nil {
		return err
	}
	query, err := ParseLogQuery(text)
	if err != nil {
		return usage("%s", err.Error())
	}
	configDir, err := configDirOf(a.values, options)
	if err != nil {
		return err
	}
	page, err := QueryLogs(configDir, query, nil)
	if err != nil {
		return err
	}
	var out strings.Builder
	for _, row := range page.Rows {
		line, err := LogLine(row.Event)
		if err != nil {
			return err
		}
		out.WriteString(line + "\n")
	}
	if _, err := io.WriteString(stdout, out.String()); err != nil {
		return err
	}
	if page.Next != nil {
		_, err = fmt.Fprintf(stderr, "more: --after %s\n", FormatLogCursor(*page.Next))
	}
	return err
}
