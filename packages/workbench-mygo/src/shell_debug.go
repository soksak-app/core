package workbench

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/egoist/mygo/ui"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// The debug view of a window (docs/spec/debug.md): the shell reads the logs folder through the host calls of the debug files
// and the query of the event log, holds the shown content, and DrawDebugView draws it.

const (
	debugPageRows    = 500
	debugHoldLimit   = 2000
	debugContextRows = 5
)

var (
	errDebugClosed      = errors.New("the debug view is not open")
	errDebugNoTimeline  = errors.New("the debug timeline is not shown")
	debugEventFile      = regexp.MustCompile(`^logs/[a-z][a-z0-9]*-[^/]+?(?:\.debug)?\.jsonl(?:\.[1-9][0-9]*)?$`)
	debugUTCTime        = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$`)
	debugFilterMembers  = []string{"channel", "level", "class", "layer", "text", "event", "event_prefix", "surface", "session", "cid", "run", "from", "to"}
	debugQueriedMembers = []string{"class", "text", "event", "event_prefix", "surface", "session", "cid", "run"}
)

// debugRow is a row of the event files with its text line.
type debugRow struct {
	role, boot string
	ts, seq    int64
	line       string
}

func (r debugRow) id() string { return r.role + "-" + r.boot + ":" + strconv.FormatInt(r.seq, 10) }

func (r debugRow) key() sok.LogCursor {
	return sok.LogCursor{TsUs: r.ts, Role: r.role, Boot: r.boot, Seq: r.seq}
}

func compareDebugRows(left, right debugRow) int {
	if left.ts != right.ts {
		return int(left.ts - right.ts)
	}
	if order := strings.Compare(left.role, right.role); order != 0 {
		return order
	}
	if order := strings.Compare(left.boot, right.boot); order != 0 {
		return order
	}
	return int(left.seq - right.seq)
}

// debugIdentifier is an identifier of an event as the text of its line.
func debugIdentifier(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	return string(raw)
}

// debugFields returns the fields of an event as `name=value`, in the order of the event.
func debugFields(raw json.RawMessage) ([]string, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, fmt.Errorf("event fields must be an object: %s", raw)
	}
	var parts []string
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		parts = append(parts, fmt.Sprintf("%v=%s", token, value))
	}
	return parts, nil
}

// debugRowOf reads a row of a page: one text line of time, level, layer, event, identifiers and fields.
func debugRowOf(row sok.LogRow) (debugRow, error) {
	var event struct {
		TsUs    int64           `json:"ts_us"`
		Seq     int64           `json:"seq"`
		Level   string          `json:"level"`
		Layer   string          `json:"layer"`
		Event   string          `json:"event"`
		Window  json.RawMessage `json:"window"`
		Surface json.RawMessage `json:"surface"`
		Session json.RawMessage `json:"session"`
		Cids    []string        `json:"cids"`
		Fields  json.RawMessage `json:"fields"`
	}
	if err := json.Unmarshal(row.Event, &event); err != nil {
		return debugRow{}, fmt.Errorf("event of %s-%s: %w", row.Role, row.Boot, err)
	}
	stamp := time.UnixMicro(event.TsUs).UTC().Format("2006-01-02T15:04:05.000000Z")
	parts := []string{stamp, event.Level, event.Layer, event.Event}
	for _, identifier := range []struct {
		name string
		raw  json.RawMessage
	}{{"window", event.Window}, {"surface", event.Surface}, {"session", event.Session}} {
		if len(identifier.raw) > 0 {
			parts = append(parts, identifier.name+"="+debugIdentifier(identifier.raw))
		}
	}
	if len(event.Cids) > 0 {
		parts = append(parts, "cids="+strings.Join(event.Cids, ","))
	}
	fields, err := debugFields(event.Fields)
	if err != nil {
		return debugRow{}, err
	}
	line := strings.Join(append(parts, fields...), " ")
	return debugRow{role: row.Role, boot: row.Boot, ts: event.TsUs, seq: event.Seq, line: line}, nil
}

// debugTimelineState is the shown timeline: the rows of the pages in key order, their identities, the rows held only as context,
// whether an older row may exist, the greatest seq of each process when the newest page was read, and the rows that following
// left out. Token tells a read that finishes later that the timeline was replaced.
type debugTimelineState struct {
	filter    DebugFilter
	rows      []debugRow
	ids       map[string]bool
	context   map[string]bool
	older     bool
	tail      map[string]int64
	following bool
	appended  int
	omitted   int
	selected  map[string]debugRow
	token     int
	drafts    map[string]string
}

// withPage adds the rows of a page in key order, once each, and sheds the oldest rows past the hold limit. A row of the context
// that was not held is held as context, and a row of the filter that was held as context is a row of the filter from then on.
// It returns the timeline and the number of new rows.
func (t debugTimelineState) withPage(rows []debugRow, asContext bool) (debugTimelineState, int) {
	fresh := make([]debugRow, 0, len(rows))
	brought := make(map[string]bool, len(rows))
	for _, row := range rows {
		brought[row.id()] = true
		if !t.ids[row.id()] && !slices.ContainsFunc(fresh, func(held debugRow) bool { return held.id() == row.id() }) {
			fresh = append(fresh, row)
		}
	}
	merged := slices.SortedStableFunc(slices.Values(append(slices.Clone(t.rows), fresh...)), compareDebugRows)
	shed := max(0, len(merged)-debugHoldLimit)
	merged = merged[shed:]
	ids := make(map[string]bool, len(merged))
	for _, row := range merged {
		ids[row.id()] = true
	}
	context := map[string]bool{}
	for id := range t.context {
		if ids[id] && (asContext || !brought[id]) {
			context[id] = true
		}
	}
	if asContext {
		for _, row := range fresh {
			if ids[row.id()] {
				context[row.id()] = true
			}
		}
	}
	t.rows, t.ids, t.context = merged, ids, context
	t.omitted += shed
	t.older = t.older || shed > 0
	return t, len(fresh)
}

// debugOperation is the running or last operation. Written and Total are set for a save of the logs folder.
type debugOperation struct {
	Action  string  `json:"action"`
	Path    *string `json:"path"`
	State   string  `json:"state"`
	Written *int64  `json:"written,omitempty"`
	Total   *int64  `json:"total,omitempty"`
}

// debugStateShown is the state file that the view shows.
type debugStateShown struct {
	path        string
	state       DebugState
	lines       []string
	with        *string
	differences []DebugDifference
}

// debugViewState is the debug view of a shell. Tasks are the reads and changes of the timeline, one after another, so a notice that
// arrives during a read waits and a row is read once.
type debugViewState struct {
	open      bool
	recorded  *string
	entries   []DebugEntry
	viewing   *DebugShown
	timeline  *debugTimelineState
	state     *debugStateShown
	operation *debugOperation
	failure   *string
	scroll    ui.ScrollState
	tasks     []func(done func())
	tokens    int
}

func (d *debugViewState) fail(step string, err error) {
	text := step + ": " + err.Error()
	d.failure = &text
}

// exclusive runs task after the earlier tasks of the timeline. The task calls done when it ended, whatever its outcome.
func (d *debugViewState) exclusive(task func(done func())) {
	d.tasks = append(d.tasks, task)
	if len(d.tasks) == 1 {
		d.next()
	}
}

func (d *debugViewState) next() {
	d.tasks[0](func() {
		d.tasks = d.tasks[1:]
		if len(d.tasks) > 0 {
			d.next()
		}
	})
}

// shownTimeline checks that the view is open and shows a timeline.
func (d *debugViewState) shownTimeline() error {
	if !d.open {
		return errDebugClosed
	}
	if d.timeline == nil {
		return errDebugNoTimeline
	}
	return nil
}

func (d *debugViewState) rowAt(row *int) (debugRow, error) {
	if err := d.shownTimeline(); err != nil {
		return debugRow{}, err
	}
	if row == nil || *row < 0 || *row >= len(d.timeline.rows) {
		text := "null"
		if row != nil {
			text = strconv.Itoa(*row)
		}
		return debugRow{}, fmt.Errorf("timeline row %s is not one of the %d rows", text, len(d.timeline.rows))
	}
	return d.timeline.rows[*row], nil
}

// fresh is the timeline of the newest page of a query, in descending order, with the selection, the following and the drafts it keeps.
func (d *debugViewState) fresh(filter DebugFilter, rows []debugRow, page sok.LogPage, selected map[string]debugRow, following bool, drafts map[string]string) *debugTimelineState {
	d.tokens++
	held := slices.Clone(rows)
	slices.Reverse(held)
	ids := make(map[string]bool, len(held))
	for _, row := range held {
		ids[row.id()] = true
	}
	return &debugTimelineState{filter: filter, rows: held, ids: ids, context: map[string]bool{}, older: page.Next != nil, tail: page.Tail,
		following: following, selected: selected, token: d.tokens, drafts: drafts}
}

// filterMember is the member of the filter by its name in the parameters of core.debug.timeline.filter.
func filterMember(filter *DebugFilter, name string) *string {
	return map[string]*string{
		"channel": &filter.Channel, "level": &filter.Level, "class": &filter.Class, "layer": &filter.Layer, "text": &filter.Text,
		"event": &filter.Event, "event_prefix": &filter.EventPrefix, "surface": &filter.Surface, "session": &filter.Session,
		"cid": &filter.Cid, "run": &filter.Run, "from": &filter.From, "to": &filter.To,
	}[name]
}

// debugBound is the microseconds of a time bound, or nil for the empty text that leaves the bound open.
func debugBound(name, value string) (*int64, error) {
	if value == "" {
		return nil, nil
	}
	invalid := fmt.Errorf("log query %s %s is not a UTC time like 2026-10-08T22:53:20.123456Z", name, quoted(value))
	match := debugUTCTime.FindStringSubmatch(value)
	if match == nil {
		return nil, invalid
	}
	numbers := make([]int, 6)
	for index := range numbers {
		number, err := strconv.Atoi(match[index+1])
		if err != nil {
			return nil, invalid
		}
		numbers[index] = number
	}
	year, month, day, hour, minute, second := numbers[0], numbers[1], numbers[2], numbers[3], numbers[4], numbers[5]
	date := time.Date(year, time.Month(month), day, hour, minute, second, 0, time.UTC)
	// A date that the calendar does not have (for example February 30) moves to another day.
	if date.Year() != year || int(date.Month()) != month || date.Day() != day || hour > 23 || minute > 59 || second > 59 {
		return nil, invalid
	}
	fraction, err := strconv.ParseInt((match[7] + "000000")[:6], 10, 64)
	if err != nil {
		return nil, invalid
	}
	micro := date.UnixMicro() + fraction
	return &micro, nil
}

// debugQuery is the request of the host call logQuery for a filter: the members that the filter leaves open are not in it, and
// the UTC times become from_us and to_us. The host refuses another value of the query with its own text.
func debugQuery(filter DebugFilter) (map[string]any, error) {
	request := map[string]any{"channel": filter.Channel, "level": filter.Level}
	if filter.Layer != "all" {
		request["layer"] = filter.Layer
	}
	for _, name := range debugQueriedMembers {
		if value := *filterMember(&filter, name); value != "" {
			request[name] = value
		}
	}
	from, err := debugBound("from", filter.From)
	if err != nil {
		return nil, err
	}
	to, err := debugBound("to", filter.To)
	if err != nil {
		return nil, err
	}
	if from != nil {
		request["from_us"] = *from
	}
	if to != nil {
		request["to_us"] = *to
	}
	return request, nil
}

// debugPage asks the host for a page of the query.
func (s *Shell) debugPage(request map[string]any, answer func(rows []debugRow, page sok.LogPage, err error)) {
	s.calls.Call("logQuery", request, func(value any, err error) {
		if err != nil {
			answer(nil, sok.LogPage{}, err)
			return
		}
		page, err := decode[sok.LogPage](value)
		if err != nil {
			answer(nil, sok.LogPage{}, err)
			return
		}
		if page.Rows == nil || page.Tail == nil {
			encoded, err := json.Marshal(value)
			if err != nil {
				answer(nil, sok.LogPage{}, err)
				return
			}
			answer(nil, sok.LogPage{}, fmt.Errorf("the host answered a page without rows and a tail: %s", encoded))
			return
		}
		rows := make([]debugRow, len(page.Rows))
		for index, row := range page.Rows {
			if rows[index], err = debugRowOf(row); err != nil {
				answer(nil, sok.LogPage{}, err)
				return
			}
		}
		answer(rows, page, nil)
	})
}

// debugStatuses is the value of every status that the registry serves.
func (s *Shell) debugStatuses() []map[string]any {
	_, names := s.registry.Names()
	statuses := make([]map[string]any, 0, len(names))
	for _, name := range names {
		status := map[string]any{"name": name, "surface": nil}
		value, err := s.registry.Read(name)
		if err != nil {
			status["error"] = map[string]string{"message": err.Error()}
		} else {
			status["result"] = value
		}
		statuses = append(statuses, status)
	}
	return statuses
}

// openDebug opens the view: it records the state into logs/ and lists the files of logs/. A failed step is shown in the view and
// the next step still runs.
func (s *Shell) openDebug(answer func(any, error)) {
	d := &s.debugView
	if d.open {
		answer(nil, nil)
		return
	}
	s.settingsWindow.open = false
	*d = debugViewState{open: true, tasks: d.tasks, tokens: d.tokens}
	s.options.Invalidate()
	s.calls.Call("debugRecord", map[string]any{"workbench": s.debugStatuses()}, func(value any, err error) {
		if err != nil {
			d.fail("record", err)
		} else if recorded, err := decode[struct {
			Path string `json:"path"`
		}](value); err != nil {
			d.fail("record", err)
		} else {
			d.recorded = &recorded.Path
		}
		s.calls.Call("debugFiles", nil, func(value any, err error) {
			if err == nil {
				var entries []DebugEntry
				if entries, err = decode[[]DebugEntry](value); err == nil {
					d.entries = NewestFirst(entries)
				}
			}
			if err != nil {
				d.fail("list", err)
			}
			s.options.Invalidate()
			answer(nil, nil)
		})
	})
}

func (s *Shell) closeDebug() {
	d := &s.debugView
	if !d.open {
		return
	}
	s.errors.Hide(debugErrorPlace)
	d.open, d.viewing, d.timeline, d.state = false, nil, nil, nil
	s.options.Invalidate()
}

// debugRead reads a file of logs/.
func (s *Shell) debugRead(path string, answer func(read debugRead, err error)) {
	s.calls.Call("debugRead", map[string]string{"path": path}, func(value any, err error) {
		if err != nil {
			answer(debugRead{}, err)
			return
		}
		read, err := decode[debugRead](value)
		answer(read, err)
	})
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

// shown is the file of a read for the view. The host answers an image as a data URL.
func (r debugRead) shown() (*DebugShown, error) {
	shown := &DebugShown{Path: r.Path, Size: r.Size, Truncated: r.Truncated, Kind: r.Kind, Text: r.Text}
	if r.Kind != "image" {
		return shown, nil
	}
	_, encoded, found := strings.Cut(r.Image, ",")
	if !found {
		return nil, fmt.Errorf("%s: the host answered an image without a data URL", r.Path)
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", r.Path, err)
	}
	if shown.Image, err = ui.DecodeImage(data); err != nil {
		return nil, fmt.Errorf("%s: %w", r.Path, err)
	}
	return shown, nil
}

func (s *Shell) viewDebugFile(path string, answer func(any, error)) {
	d := &s.debugView
	if !d.open {
		answer(nil, errDebugClosed)
		return
	}
	d.failure, d.timeline, d.state = nil, nil, nil
	s.debugRead(path, func(read debugRead, err error) {
		var shown *DebugShown
		if err == nil {
			shown, err = read.shown()
		}
		if err != nil {
			d.fail("view", err)
		} else {
			d.viewing = shown
		}
		s.options.Invalidate()
		answer(nil, err)
	})
}

func (s *Shell) listDebugFiles() error {
	d := &s.debugView
	if !d.open {
		return errDebugClosed
	}
	d.viewing, d.timeline, d.state = nil, nil, nil
	s.options.Invalidate()
	return nil
}

func (s *Shell) showDebugTimeline(answer func(any, error)) {
	d := &s.debugView
	if !d.open {
		answer(nil, errDebugClosed)
		return
	}
	d.failure = nil
	d.exclusive(func(done func()) {
		end := func(err error) {
			if err != nil {
				d.timeline = nil
				d.fail("timeline", err)
			}
			s.options.Invalidate()
			done()
			answer(nil, err)
		}
		filter := DebugFilter{Channel: "other", Level: "trace", Layer: "all"}
		request, err := debugQuery(filter)
		if err != nil {
			end(err)
			return
		}
		request["order"], request["limit"] = "desc", debugPageRows
		s.debugPage(request, func(rows []debugRow, page sok.LogPage, err error) {
			if err == nil {
				d.timeline = d.fresh(filter, rows, page, map[string]debugRow{}, true, map[string]string{})
				d.viewing, d.state = nil, nil
			}
			end(err)
		})
	})
}

// followDebugGrowth asks for the rows that the files gained after the tail of the shown timeline and adds them in key order. A read
// that fails stops following and shows the error. A read that finishes after the timeline was replaced or stopped is discarded and
// leaves the tail, so the next read starts there.
func (s *Shell) followDebugGrowth(answer func(err error)) {
	d := &s.debugView
	d.exclusive(func(done func()) {
		current := d.timeline
		if !d.open || current == nil || !current.following {
			done()
			answer(nil)
			return
		}
		token := current.token
		stop := func(err error) {
			if d.timeline != nil && d.timeline.token == token {
				d.timeline.following = false
			}
			d.fail("follow", err)
			s.options.Invalidate()
			done()
			answer(err)
		}
		request, err := debugQuery(current.filter)
		if err != nil {
			stop(err)
			return
		}
		request["order"], request["limit"], request["since"] = "asc", debugPageRows, current.tail
		next := *current
		var tail map[string]int64
		appended := 0
		var read func()
		read = func() {
			s.debugPage(request, func(rows []debugRow, page sok.LogPage, err error) {
				if err != nil {
					stop(err)
					return
				}
				// The tail of the first page is the tail of the whole read: a row that arrived after it is read again.
				if tail == nil {
					tail = page.Tail
				}
				var added int
				next, added = next.withPage(rows, false)
				appended += added
				if page.Next != nil {
					request["after"] = page.Next
					read()
					return
				}
				if shown := d.timeline; shown != nil && shown.token == token && shown.following {
					unmarked := len(next.context) != len(shown.context)
					shown.rows, shown.ids, shown.context, shown.omitted, shown.older = next.rows, next.ids, next.context, next.omitted, next.older
					shown.tail = tail
					shown.appended += appended
					// A notice that adds nothing and ends no context draws nothing.
					if appended > 0 || unmarked {
						s.options.Invalidate()
					}
				}
				done()
				answer(nil)
			})
		}
		read()
	})
}

func (s *Shell) followDebugTimeline(on *bool, answer func(any, error)) {
	d := &s.debugView
	if err := d.shownTimeline(); err != nil {
		answer(nil, err)
		return
	}
	if on == nil {
		answer(nil, errors.New("timeline follow must be a boolean, found null"))
		return
	}
	d.failure = nil
	d.timeline.following = *on
	s.options.Invalidate()
	if !*on {
		answer(nil, nil)
		return
	}
	s.followDebugGrowth(func(err error) { answer(nil, err) })
}

func (s *Shell) olderDebugTimeline(answer func(any, error)) {
	d := &s.debugView
	if err := d.shownTimeline(); err != nil {
		answer(nil, err)
		return
	}
	d.failure = nil
	d.exclusive(func(done func()) {
		end := func(err error) {
			if err != nil {
				d.fail("older", err)
			}
			s.options.Invalidate()
			done()
			answer(nil, err)
		}
		current := d.timeline
		if current == nil || !current.older || len(current.rows) == 0 {
			done()
			answer(nil, nil)
			return
		}
		if len(current.rows) >= debugHoldLimit {
			end(fmt.Errorf("the timeline holds %d rows; narrow the filter or the time", debugHoldLimit))
			return
		}
		request, err := debugQuery(current.filter)
		if err != nil {
			end(err)
			return
		}
		request["order"], request["limit"], request["after"] = "desc", min(debugPageRows, debugHoldLimit-len(current.rows)), current.rows[0].key()
		token := current.token
		s.debugPage(request, func(rows []debugRow, page sok.LogPage, err error) {
			if err != nil {
				end(err)
				return
			}
			if shown := d.timeline; shown != nil && shown.token == token {
				omitted := shown.omitted
				added, _ := shown.withPage(rows, false)
				added.older = page.Next != nil || added.omitted > omitted
				*shown = added
			}
			end(nil)
		})
	})
}

func (s *Shell) filterDebugTimeline(change map[string]any, answer func(any, error)) {
	d := &s.debugView
	if err := d.shownTimeline(); err != nil {
		answer(nil, err)
		return
	}
	unknown := []string{}
	for _, name := range slices.Sorted(maps.Keys(change)) {
		if !slices.Contains(debugFilterMembers, name) {
			unknown = append(unknown, name)
		}
	}
	if len(unknown) > 0 {
		answer(nil, fmt.Errorf("timeline filter has no member %s", strings.Join(unknown, ", ")))
		return
	}
	if len(change) == 0 {
		answer(nil, fmt.Errorf("timeline filter needs %s", strings.Join(debugFilterMembers, ", ")))
		return
	}
	d.failure = nil
	d.exclusive(func(done func()) {
		end := func(err error) {
			if err != nil {
				d.fail("filter", err)
			}
			s.options.Invalidate()
			done()
			answer(nil, err)
		}
		current := d.timeline
		if current == nil {
			end(errDebugNoTimeline)
			return
		}
		filter := current.filter
		for name, value := range change {
			text, isText := value.(string)
			if !isText {
				encoded, err := json.Marshal(value)
				if err != nil {
					end(err)
					return
				}
				end(fmt.Errorf("log query %s must be a string, found %s", name, encoded))
				return
			}
			*filterMember(&filter, name) = text
		}
		request, err := debugQuery(filter)
		if err != nil {
			end(err)
			return
		}
		request["order"], request["limit"] = "desc", debugPageRows
		s.debugPage(request, func(rows []debugRow, page sok.LogPage, err error) {
			if err == nil {
				d.timeline = d.fresh(filter, rows, page, current.selected, current.following, current.drafts)
			}
			end(err)
		})
	})
}

func (s *Shell) selectDebugRow(row *int, selected *bool) error {
	d := &s.debugView
	if err := d.shownTimeline(); err != nil {
		return err
	}
	if selected == nil {
		return errors.New("timeline selected must be a boolean, found null")
	}
	chosen, err := d.rowAt(row)
	if err != nil {
		return err
	}
	if *selected {
		d.timeline.selected[chosen.id()] = chosen
	} else {
		delete(d.timeline.selected, chosen.id())
	}
	s.options.Invalidate()
	return nil
}

// contextDebugRow brings the rows around a row into the held rows, in the channel of the filter, whatever its other members are.
func (s *Shell) contextDebugRow(row *int, answer func(any, error)) {
	d := &s.debugView
	chosen, err := d.rowAt(row)
	if err != nil {
		answer(nil, err)
		return
	}
	d.failure = nil
	d.exclusive(func(done func()) {
		current := d.timeline
		if current == nil {
			done()
			answer(nil, nil)
			return
		}
		token := current.token
		request := map[string]any{"channel": current.filter.Channel, "around": chosen.key(), "earlier": debugContextRows, "later": debugContextRows}
		s.debugPage(request, func(rows []debugRow, _ sok.LogPage, err error) {
			if err != nil {
				d.fail("context", err)
			} else if shown := d.timeline; shown != nil && shown.token == token {
				added, _ := shown.withPage(rows, true)
				*shown = added
			}
			s.options.Invalidate()
			done()
			answer(nil, err)
		})
	})
}

// debugStateOf reads and parses one listed state file.
func (s *Shell) debugStateOf(path string, answer func(state DebugState, err error)) {
	if !slices.Contains(DebugStateFiles(s.debugView.entries), path) {
		answer(DebugState{}, fmt.Errorf("%s is not a state file of the list", path))
		return
	}
	s.debugRead(path, func(read debugRead, err error) {
		if err != nil {
			answer(DebugState{}, err)
			return
		}
		if read.Kind != "text" {
			answer(DebugState{}, fmt.Errorf("%s: a state file must be text, found %s", path, read.Kind))
			return
		}
		state, err := ParseDebugState(path, read.Text, read.Truncated)
		answer(state, err)
	})
}

func (s *Shell) showDebugState(path string, answer func(any, error)) {
	d := &s.debugView
	if !d.open {
		answer(nil, errDebugClosed)
		return
	}
	d.failure = nil
	s.debugStateOf(path, func(state DebugState, err error) {
		if err != nil {
			d.fail("state", err)
		} else {
			d.state = &debugStateShown{path: path, state: state, lines: DebugStateLines(state)}
			d.viewing, d.timeline = nil, nil
		}
		s.options.Invalidate()
		answer(nil, err)
	})
}

// compareDebugState compares the shown state file with another state file of the list; an empty path ends the comparison.
func (s *Shell) compareDebugState(path string, answer func(any, error)) {
	d := &s.debugView
	if !d.open {
		answer(nil, errDebugClosed)
		return
	}
	if d.state == nil {
		answer(nil, errors.New("the debug state is not shown"))
		return
	}
	d.failure = nil
	end := func(err error) {
		if err != nil {
			d.fail("compare", err)
		}
		s.options.Invalidate()
		answer(nil, err)
	}
	if path == "" {
		d.state.with, d.state.differences = nil, nil
		end(nil)
		return
	}
	if path == d.state.path {
		end(fmt.Errorf("%s is the shown state file", path))
		return
	}
	s.debugStateOf(path, func(other DebugState, err error) {
		if err == nil && d.state != nil {
			d.state.with, d.state.differences = &path, CompareDebugStates(d.state.state, other)
		}
		end(err)
	})
}

// debugSaving runs one save operation of the open view and answers the host's {saved}.
func (s *Shell) debugSaving(action, path, call string, argument any, answer func(any, error)) {
	d := &s.debugView
	d.operation = &debugOperation{Action: action, Path: &path, State: "running"}
	d.failure = nil
	s.options.Invalidate()
	s.calls.Call(call, argument, func(value any, err error) {
		d.operation = &debugOperation{Action: action, Path: &path, State: "done"}
		if err != nil {
			d.operation.State = "failed"
			d.fail(action, err)
		}
		s.options.Invalidate()
		answer(value, err)
	})
}

func (s *Shell) saveDebugFile(path string, answer func(any, error)) {
	if !s.debugView.open {
		answer(nil, errDebugClosed)
		return
	}
	s.debugSaving("save", path, "debugSave", map[string]string{"path": path}, answer)
}

// saveDebugRows saves the text lines of the selected rows, in timeline order, where the person chooses; the person may cancel.
func (s *Shell) saveDebugRows(answer func(any, error)) {
	d := &s.debugView
	if err := d.shownTimeline(); err != nil {
		answer(nil, err)
		return
	}
	name := "soksak-timeline-" + time.Now().UTC().Format("20060102T150405Z") + ".txt"
	selected := slices.SortedFunc(maps.Values(d.timeline.selected), compareDebugRows)
	if len(selected) == 0 {
		failed := errors.New("no timeline row is selected")
		d.operation = &debugOperation{Action: "save-rows", Path: &name, State: "failed"}
		d.fail("save-rows", failed)
		s.options.Invalidate()
		answer(nil, failed)
		return
	}
	lines := strings.Builder{}
	for _, row := range selected {
		lines.WriteString(row.line + "\n")
	}
	s.debugSaving("save-rows", name, "debugSaveText", map[string]string{"name": name, "text": lines.String()}, answer)
}

// debugSaveStarted is the answer of debugSaveAll. Saved is nil when the person cancelled the save panel.
type debugSaveStarted struct {
	Saved *string `json:"saved"`
	Total int64   `json:"total"`
}

// saveDebugFiles saves logs/ as one compressed file where the person chooses. The host answers {saved, total} when the place is
// chosen and writes on its own thread; the events debug-save-progress and debug-save-done end the operation.
func (s *Shell) saveDebugFiles(answer func(any, error)) {
	d := &s.debugView
	if !d.open {
		answer(nil, errDebugClosed)
		return
	}
	if d.operation != nil && d.operation.Action == "save-all" && d.operation.State == "running" {
		place := "the save panel is open"
		if d.operation.Path != nil {
			place = *d.operation.Path
		}
		refused := errors.New("debug: a save of the logs folder is running: " + place)
		d.fail("save-all", refused)
		s.options.Invalidate()
		answer(nil, refused)
		return
	}
	d.operation = &debugOperation{Action: "save-all", State: "running"}
	d.failure = nil
	s.options.Invalidate()
	s.calls.Call("debugSaveAll", nil, func(value any, err error) {
		var started debugSaveStarted
		if err == nil {
			started, err = decode[debugSaveStarted](value)
		}
		switch {
		case err != nil:
			d.operation = &debugOperation{Action: "save-all", State: "failed"}
			d.fail("save-all", err)
		case started.Saved == nil:
			d.operation = &debugOperation{Action: "save-all", State: "done"}
		default:
			written := int64(0)
			d.operation = &debugOperation{Action: "save-all", Path: started.Saved, State: "running", Written: &written, Total: &started.Total}
		}
		s.options.Invalidate()
		answer(value, err)
	})
}

// debugEvent follows the host events of the debug view: the progress and the end of a save of the logs folder, which a reloaded
// window takes as its operation, and the notice that an event file grew.
func (s *Shell) debugEvent(name string, data []any) {
	if len(data) != 1 {
		return
	}
	d := &s.debugView
	switch name {
	case "debug-save-progress":
		progress, err := decode[struct {
			Saved   string `json:"saved"`
			Written int64  `json:"written"`
			Total   int64  `json:"total"`
		}](data[0])
		if err != nil {
			s.fail(err)
			return
		}
		d.operation = &debugOperation{Action: "save-all", Path: &progress.Saved, State: "running", Written: &progress.Written, Total: &progress.Total}
		s.options.Invalidate()
	case "debug-save-done":
		end, err := decode[struct {
			Saved string  `json:"saved"`
			Error *string `json:"error"`
		}](data[0])
		if err != nil {
			s.fail(err)
			return
		}
		seen := d.operation != nil && d.operation.Path != nil && *d.operation.Path == end.Saved
		var total, written int64
		if seen && d.operation.Total != nil {
			total = *d.operation.Total
		}
		if seen && d.operation.Written != nil {
			written = *d.operation.Written
		}
		state := "failed"
		if end.Error == nil {
			state, written = "done", total
		}
		d.operation = &debugOperation{Action: "save-all", Path: &end.Saved, State: state, Written: &written, Total: &total}
		if end.Error != nil {
			d.fail("save-all", errors.New(*end.Error))
		}
		s.options.Invalidate()
	case "debug-log-changed":
		notice, err := decode[struct {
			Path string `json:"path"`
		}](data[0])
		if err != nil {
			s.fail(err)
			return
		}
		if d.timeline != nil && d.timeline.following && debugEventFile.MatchString(notice.Path) {
			// A failed read is shown in the view and stops following.
			s.followDebugGrowth(func(error) {})
		}
	}
}

// debugTimelineStatus is the timeline part of the status core.debug.
type debugTimelineStatus struct {
	Following bool   `json:"following"`
	Appended  int    `json:"appended"`
	Held      int    `json:"held"`
	Older     bool   `json:"older"`
	Omitted   int    `json:"omitted"`
	Context   int    `json:"context"`
	Selected  int    `json:"selected"`
	Warning   string `json:"warning"`
	DebugFilter
}

type debugStateStatus struct {
	Path        string  `json:"path"`
	Lines       int     `json:"lines"`
	With        *string `json:"with"`
	Differences int     `json:"differences"`
}

type debugViewingStatus struct {
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	Truncated bool   `json:"truncated"`
	Kind      string `json:"kind"`
	Length    int    `json:"length"`
}

type debugStatus struct {
	Open      bool                 `json:"open"`
	Recorded  *string              `json:"recorded"`
	Entries   []DebugEntry         `json:"entries"`
	Viewing   *debugViewingStatus  `json:"viewing"`
	Timeline  *debugTimelineStatus `json:"timeline"`
	State     *debugStateStatus    `json:"state"`
	Scroll    float32              `json:"scroll"`
	Operation *debugOperation      `json:"operation"`
	Error     *string              `json:"error"`
}

func (s *Shell) debugStatusOf() debugStatus {
	d := &s.debugView
	status := debugStatus{Open: d.open, Recorded: d.recorded, Entries: d.entries, Scroll: d.scroll.Y, Operation: d.operation, Error: d.failure}
	if status.Entries == nil {
		status.Entries = []DebugEntry{}
	}
	if d.viewing != nil {
		status.Viewing = &debugViewingStatus{Path: d.viewing.Path, Size: d.viewing.Size, Truncated: d.viewing.Truncated, Kind: d.viewing.Kind,
			Length: len(utf16.Encode([]rune(d.viewing.Text)))}
	}
	if t := d.timeline; t != nil {
		status.Timeline = &debugTimelineStatus{Following: t.following, Appended: t.appended, Held: len(t.rows), Older: t.older, Omitted: t.omitted,
			Context: len(t.context), Selected: len(t.selected), Warning: selectionWarning, DebugFilter: t.filter}
	}
	if d.state != nil {
		status.State = &debugStateStatus{Path: d.state.path, Lines: len(d.state.lines), With: d.state.with, Differences: len(d.state.differences)}
	}
	return status
}

// debugStyle reads the look of the card from the palette and the chrome metrics.
func (s *Shell) debugStyle() DebugStyle {
	metric := func(name string) float32 {
		value, _ := s.options.Declared.Metric(name)
		return float32(value)
	}
	pane := s.readSettingsPane()
	return DebugStyle{Card: s.palette.Card, Background: s.palette.Bg, Edge: s.palette.Edge, Rail: s.palette.Rail, Fg: s.palette.Fg, Muted: s.palette.Muted,
		Border: s.palette.BorderWidth, Radius: s.radiusMiddle(), ButtonRadius: s.radiusSmall(), Top: metric("set-card-top"),
		HeadH: pane.headH, HeadGap: pane.headGap, HeadPadStart: pane.headPadStart, HeadPadEnd: pane.headPadEnd,
		ShadowY: pane.shadowY, ShadowBlur: pane.shadowBlur, ShadowAlpha: pane.shadowAlpha,
		PanePadX: metric("dbg-pane-pad-x"), PaneTop: metric("dbg-pane-pad-top"), PaneBottom: metric("dbg-pane-pad-bottom"), ErrorGap: metric("dbg-error-gap"),
		RowGap: metric("dbg-row-gap"), RowH: metric("dbg-row-h"), ActW: metric("dbg-act-w"), BarGap: metric("dbg-bar-gap"), CaptionGap: pane.captionGap,
		ActionsGap: metric("set-actions-gap"), ActionsMargin: metric("set-actions-margin"), FieldPadY: metric("field-pad-y"),
		Space1: metric("space-1"), Space2: metric("space-2"), Space3: metric("space-3"),
		LineHeight: pane.lineHeight, TextControl: s.textControl(), TextSmall: s.textSmall(),
		Close: func(c *ui.Context, button ui.Element, title string) { s.drawAct(c, button, title, "close", false, 1) }}
}

// debugScreen is what DrawDebugView draws.
func (s *Shell) debugScreen() DebugView {
	d := &s.debugView
	width, _ := s.options.Declared.Metric("dbg-card-w")
	view := DebugView{CardWidth: float32(width), CardMaxHeight: float32(s.settingsWindow.height * settingsCardMaxShare), Entries: d.entries,
		Viewing: d.viewing, Failure: d.failure, Scroll: &d.scroll, Style: s.debugStyle()}
	if operation := d.operation; operation != nil {
		view.Operation = &DebugOperation{Action: operation.Action, State: operation.State, Writing: operation.Total != nil}
		if operation.Path != nil {
			view.Operation.Path = *operation.Path
		}
		if operation.Total != nil {
			view.Operation.Written, view.Operation.Total = *operation.Written, *operation.Total
		}
	}
	if t := d.timeline; t != nil {
		rows := make([]DebugRow, len(t.rows))
		for index, row := range t.rows {
			_, selected := t.selected[row.id()]
			rows[index] = DebugRow{Line: row.line, Context: t.context[row.id()], Selected: selected}
			if rows[index].Context {
				rows[index].Line = "  " + row.line
			}
		}
		view.Timeline = &DebugTimeline{Filter: t.filter, Rows: rows, Older: t.older, Following: t.following, Omitted: t.omitted, Drafts: t.drafts}
	}
	if state := d.state; state != nil {
		view.State = &DebugStateView{Path: state.path, Lines: state.lines, Differences: state.differences,
			Compare: slices.DeleteFunc(DebugStateFiles(d.entries), func(path string) bool { return path == state.path })}
		if state.with != nil {
			view.State.With = *state.with
		}
	}
	return view
}

// drawDebug draws the view over the window.
func (s *Shell) drawDebug(c *ui.Context) {
	if s.debugView.open {
		ui.Overlay(c, func() { DrawDebugView(c, s.binder, s.debugScreen(), s.errors) })
	}
}

type debugPath struct {
	Path string `json:"path"`
}

type debugRowParam struct {
	Row      *int  `json:"row"`
	Selected *bool `json:"selected"`
}

// laterAct registers name with a function of its parameters that answers in a later step.
func laterAct[T any](s *Shell, name string, run func(value T, answer func(value any, err error))) {
	s.registry.CommandLater(name, func(raw json.RawMessage, answer func(value any, err error)) {
		value, err := params[T](raw)
		if err != nil {
			answer(nil, fmt.Errorf("%s: %w", name, err))
			return
		}
		run(value, answer)
	})
}

// registerDebug registers the status and the commands of the view.
func (s *Shell) registerDebug() {
	s.registry.Status("core.debug", func() any { return s.debugStatusOf() })
	laterAct(s, "core.debug.open", func(_ struct{}, answer func(any, error)) { s.openDebug(answer) })
	act(s, "core.debug.close", func(struct{}) error {
		s.closeDebug()
		return nil
	})
	act(s, "core.debug.list", func(struct{}) error { return s.listDebugFiles() })
	laterAct(s, "core.debug.view", func(value debugPath, answer func(any, error)) { s.viewDebugFile(value.Path, answer) })
	laterAct(s, "core.debug.save", func(value debugPath, answer func(any, error)) { s.saveDebugFile(value.Path, answer) })
	laterAct(s, "core.debug.save-all", func(_ struct{}, answer func(any, error)) { s.saveDebugFiles(answer) })
	laterAct(s, "core.debug.state", func(value debugPath, answer func(any, error)) { s.showDebugState(value.Path, answer) })
	laterAct(s, "core.debug.state.compare", func(value struct {
		With string `json:"with"`
	}, answer func(any, error)) {
		s.compareDebugState(value.With, answer)
	})
	laterAct(s, "core.debug.timeline", func(_ struct{}, answer func(any, error)) { s.showDebugTimeline(answer) })
	laterAct(s, "core.debug.timeline.filter", s.filterDebugTimeline)
	laterAct(s, "core.debug.timeline.follow", func(value struct {
		On *bool `json:"on"`
	}, answer func(any, error)) {
		s.followDebugTimeline(value.On, answer)
	})
	laterAct(s, "core.debug.timeline.older", func(_ struct{}, answer func(any, error)) { s.olderDebugTimeline(answer) })
	act(s, "core.debug.timeline.select", func(value debugRowParam) error { return s.selectDebugRow(value.Row, value.Selected) })
	laterAct(s, "core.debug.timeline.context", func(value debugRowParam, answer func(any, error)) { s.contextDebugRow(value.Row, answer) })
	laterAct(s, "core.debug.timeline.save", func(_ struct{}, answer func(any, error)) { s.saveDebugRows(answer) })
}
