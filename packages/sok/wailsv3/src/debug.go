package sok

// `sok debug timeline` (docs/spec/debug.md#timeline-command): the rows, the order, the filter and the text lines of the timeline of
// the debug view (packages/workbench/debug-timeline.js), read from the host event files of the configuration directory.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const eventSchema = 1

var (
	eventLevels   = []string{"error", "warn", "info", "debug", "trace"}
	eventLayers   = []string{"native", "host", "page", "plugin", "sidecar"}
	hostEventFile = regexp.MustCompile(`^host-[^/]+\.jsonl$`)
	utcTime       = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$`)
	contextDigits = regexp.MustCompile(`^[0-9]{1,4}$`)
)

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
	if text, ok := level.(string); !ok || !contains(eventLevels, text) {
		return fail("level %s is not one of %s", stringify(level, present), strings.Join(eventLevels, ", "))
	}
	row.level = level.(string)
	layer, present := event.get("layer")
	if text, ok := layer.(string); !ok || !contains(eventLayers, text) {
		return fail("layer %s is not one of %s", stringify(layer, present), strings.Join(eventLayers, ", "))
	}
	row.layer = layer.(string)
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

// parseEvents reads the whole lines of one event file. The first line must be `log.open` with the schema number that this reader knows.
func parseEvents(file string, data []byte) ([]eventRow, error) {
	// Only whole lines are read: bytes after the last line feed are a line that is not written to its end.
	if end := bytes.LastIndexByte(data, '\n'); end >= 0 {
		data = data[:end+1]
	} else {
		data = nil
	}
	var rows []eventRow
	for index, raw := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		if len(data) == 0 {
			break
		}
		row, err := rowOf(file, index+1, raw)
		if err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		// A file without a line is what a process that ended before its first write leaves: it has no row.
		return nil, nil
	}
	if rows[0].name != "log.open" {
		return nil, fmt.Errorf("%s: the first line is not log.open: %s", file, jsString(rows[0].name))
	}
	schema, present := rows[0].fields.get("schema")
	if n, integer := isInteger(schema); !present || !integer || n != eventSchema {
		text := "undefined"
		if present {
			text = stringify(schema, true)
			if number, ok := schema.(json.Number); ok {
				text = number.String()
			}
		}
		return nil, fmt.Errorf("%s: schema %s is not %d", file, text, eventSchema)
	}
	return rows, nil
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

// timelineFilter is the filter of the timeline; an empty text leaves a eventMember open.
type timelineFilter struct {
	level, layer, text, event, surface, session, cid, from, to, context string
}

// bound is the microseconds of a time bound, or false for the empty text that leaves the bound open.
func bound(name, value string) (int64, bool, error) {
	if value == "" {
		return 0, false, nil
	}
	invalid := fmt.Errorf("timeline %s %s is not a UTC time like 2026-10-08T22:53:20.123456Z or empty", name, jsString(value))
	match := utcTime.FindStringSubmatch(value)
	if match == nil {
		return 0, false, invalid
	}
	var number [6]int
	for i := range number {
		n, err := strconv.Atoi(match[i+1])
		if err != nil {
			return 0, false, invalid
		}
		number[i] = n
	}
	date := time.Date(number[0], time.Month(number[1]), number[2], number[3], number[4], number[5], 0, time.UTC)
	// A date that the calendar does not have (for example February 30) moves to another day in time.Date.
	if date.Year() != number[0] || int(date.Month()) != number[1] || date.Day() != number[2] || number[3] > 23 || number[4] > 59 || number[5] > 59 {
		return 0, false, invalid
	}
	fraction, err := strconv.Atoi(match[7] + strings.Repeat("0", 6-len(match[7])))
	if err != nil {
		return 0, false, invalid
	}
	return date.Unix()*1000000 + int64(fraction), true, nil
}

func contextCount(value string) (int, error) {
	if !contextDigits.MatchString(value) {
		return 0, fmt.Errorf("timeline context must be decimal digits, found %s", jsString(value))
	}
	count, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("timeline context must be decimal digits, found %s", jsString(value))
	}
	return count, nil
}

// filterRows returns the positions of the rows that pass the filter.
func filterRows(rows []eventRow, f timelineFilter) ([]bool, error) {
	if !contains(eventLevels, f.level) {
		return nil, fmt.Errorf("timeline level %s is not one of %s", jsString(f.level), strings.Join(eventLevels, ", "))
	}
	if f.layer != "all" && !contains(eventLayers, f.layer) {
		return nil, fmt.Errorf("timeline layer %s is not one of all, %s", jsString(f.layer), strings.Join(eventLayers, ", "))
	}
	if _, err := contextCount(f.context); err != nil {
		return nil, err
	}
	first, hasFirst, err := bound("from", f.from)
	if err != nil {
		return nil, err
	}
	last, hasLast, err := bound("to", f.to)
	if err != nil {
		return nil, err
	}
	if hasFirst && hasLast && first > last {
		return nil, fmt.Errorf("timeline from is later than to: %s %s", jsString(f.from), jsString(f.to))
	}
	least := indexOf(eventLevels, f.level)
	needle := strings.ToLower(f.text)
	name := strings.ToLower(f.event)
	pass := make([]bool, len(rows))
	for i, row := range rows {
		pass[i] = indexOf(eventLevels, row.level) <= least &&
			(f.layer == "all" || row.layer == f.layer) &&
			(name == "" || strings.Contains(strings.ToLower(row.name), name)) &&
			(f.surface == "" || (row.surface != nil && *row.surface == f.surface)) &&
			(f.session == "" || (row.session != nil && *row.session == f.session)) &&
			(f.cid == "" || contains(row.cids, f.cid)) &&
			(!hasFirst || row.tsUs >= first) &&
			(!hasLast || row.tsUs <= last) &&
			(needle == "" || strings.Contains(strings.ToLower(eventLine(row)), needle))
	}
	return pass, nil
}

func indexOf(list []string, value string) int {
	for i, item := range list {
		if item == value {
			return i
		}
	}
	return -1
}

// timelineLines is the text lines that the timeline shows: the rows that pass the filter with the context rows around them, once,
// in the order of the rows; a context row is indented by two spaces.
func timelineLines(rows []eventRow, f timelineFilter) ([]string, error) {
	pass, err := filterRows(rows, f)
	if err != nil {
		return nil, err
	}
	count, err := contextCount(f.context)
	if err != nil {
		return nil, err
	}
	var lines []string
	until := -1
	show := func(row eventRow, match bool) {
		prefix := ""
		if !match && count > 0 {
			prefix = "  "
		}
		lines = append(lines, prefix+eventLine(row))
	}
	for index, row := range rows {
		if pass[index] {
			for before := max(until+1, index-count); before < index; before++ {
				show(rows[before], false)
			}
			show(row, true)
			until = index + count
		} else if index <= until {
			show(row, false)
		}
	}
	return lines, nil
}

// runDebug runs `sok debug <view>`.
func runDebug(a arguments, stdout io.Writer, options Options) error {
	view, err := a.positional(1, "debug view")
	if err != nil {
		return err
	}
	if view != "timeline" {
		return usage("unknown command: debug %s", view)
	}
	if len(a.positionals) > 2 {
		return usage("unexpected argument %s", a.positionals[2])
	}
	filter := timelineFilter{level: "trace", layer: "all", context: "0"}
	for name, to := range map[string]*string{"level": &filter.level, "layer": &filter.layer, "text": &filter.text, "event": &filter.event,
		"surface": &filter.surface, "session": &filter.session, "cid": &filter.cid, "from": &filter.from, "to": &filter.to, "context": &filter.context} {
		if value, given := a.values[name]; given {
			*to = value
		}
	}
	configDir, err := configDirOf(a.values, options)
	if err != nil {
		return err
	}
	logs := filepath.Join(configDir, "logs")
	entries, err := os.ReadDir(logs)
	if err != nil {
		return fileError(logs, err)
	}
	var names []string
	for _, entry := range entries {
		if !entry.IsDir() && hostEventFile.MatchString(entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	if len(names) == 0 {
		return fmt.Errorf("no event file logs/host-<boot>.jsonl in %s", logs)
	}
	sort.Strings(names)
	var rows []eventRow
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(logs, name))
		if err != nil {
			return fileError(filepath.Join(logs, name), err)
		}
		parsed, err := parseEvents("logs/"+name, data)
		if err != nil {
			return err
		}
		rows = append(rows, parsed...)
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].tsUs != rows[j].tsUs {
			return rows[i].tsUs < rows[j].tsUs
		}
		if rows[i].seq != rows[j].seq {
			return rows[i].seq < rows[j].seq
		}
		return rows[i].file < rows[j].file
	})
	lines, err := timelineLines(rows, filter)
	if err != nil {
		return usage("%s", err.Error())
	}
	var out strings.Builder
	for _, line := range lines {
		out.WriteString(line + "\n")
	}
	_, err = io.WriteString(stdout, out.String())
	return err
}
