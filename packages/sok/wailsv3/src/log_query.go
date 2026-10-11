package sok

// The query over the event files of a configuration directory (docs/spec/logging.md#query). It reads the files through their
// indexes and answers one page. The Rust implementation (packages/sok/tauriv2/src/log_query.rs) gives the same page, cursor and
// error text for the same files and parameters.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	queryDefaultLimit = 500
	queryMaxLimit     = 5000
	// queryPageBytes bounds the line text of the rows of one page; the first row is always taken.
	queryPageBytes = 8388608
)

var (
	queryChannels = []string{"other", "debug", "all"}
	queryOrders   = []string{"asc", "desc"}
	// logFileName is the name of an event file: role, boot, the debug marker and the generation.
	logFileName = regexp.MustCompile(`^([a-z][a-z0-9]*)-(.+?)(\.debug)?\.jsonl(?:\.([1-5]))?$`)
	// queryMembers are the parameters of a query in the order that they are checked.
	queryMembers = []string{"channel", "level", "class", "layer", "event", "event_prefix", "surface", "session", "cid", "run", "text", "from_us", "to_us", "limit", "order", "after", "since"}
)

// LogCursor is the key of a row: the position that a page continues after.
type LogCursor struct {
	TsUs int64  `json:"ts_us"`
	Role string `json:"role"`
	Boot string `json:"boot"`
	Seq  int64  `json:"seq"`
}

// less orders the keys of two rows.
func (a LogCursor) less(b LogCursor) bool {
	if a.TsUs != b.TsUs {
		return a.TsUs < b.TsUs
	}
	if a.Role != b.Role {
		return a.Role < b.Role
	}
	if a.Boot != b.Boot {
		return a.Boot < b.Boot
	}
	return a.Seq < b.Seq
}

// LogQuery is a query with its defaults applied.
type LogQuery struct {
	Channel, Level, Class, Layer, Event, EventPrefix, Surface, Session, Cid, Run, Text, Order string
	FromUs, ToUs                                                                              *int64
	Limit                                                                                     int
	After                                                                                     *LogCursor
	Since                                                                                     map[string]int64
}

func queryError(format string, args ...any) error {
	return fmt.Errorf("log query "+format, args...)
}

// ParseLogQuery reads the parameters of a query: one JSON object.
func ParseLogQuery(params []byte) (LogQuery, error) {
	value, err := parseJSON(string(params))
	if err != nil {
		return LogQuery{}, queryError("parameters must be a JSON object, found %s", strings.TrimSpace(string(params)))
	}
	object, ok := value.(eventObject)
	if !ok {
		return LogQuery{}, queryError("parameters must be an object, found %s", stringify(value, true))
	}
	var unknown []string
	for _, member := range object {
		if !contains(queryMembers, member.name) && !contains(unknown, member.name) {
			unknown = append(unknown, member.name)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return LogQuery{}, queryError("has no parameter %s", unknown[0])
	}
	query := LogQuery{Channel: "other", Level: "trace", Order: "asc", Limit: queryDefaultLimit}
	member := func(name string) (any, bool) { return object.get(name) }
	choice := func(name string, options []string, to *string) error {
		value, present := member(name)
		if !present {
			return nil
		}
		text, ok := value.(string)
		if !ok || !contains(options, text) {
			return queryError("%s %s is not one of %s", name, stringify(value, true), strings.Join(options, ", "))
		}
		*to = text
		return nil
	}
	text := func(name string, to *string) error {
		value, present := member(name)
		if !present {
			return nil
		}
		s, ok := value.(string)
		if !ok || s == "" {
			return queryError("%s must be a non-empty string, found %s", name, stringify(value, true))
		}
		*to = s
		return nil
	}
	bound := func(name string, to **int64) error {
		value, present := member(name)
		if !present {
			return nil
		}
		n, integer := isInteger(value)
		if !integer || n < 0 {
			return queryError("%s must be a non-negative integer, found %s", name, stringify(value, true))
		}
		*to = &n
		return nil
	}
	steps := []func() error{
		func() error { return choice("channel", queryChannels, &query.Channel) },
		func() error { return choice("level", indexLevels, &query.Level) },
		func() error { return choice("class", indexClasses, &query.Class) },
		func() error { return choice("layer", indexLayers, &query.Layer) },
		func() error { return text("event", &query.Event) },
		func() error { return text("event_prefix", &query.EventPrefix) },
		func() error { return text("surface", &query.Surface) },
		func() error { return text("session", &query.Session) },
		func() error { return text("cid", &query.Cid) },
		func() error { return text("run", &query.Run) },
		func() error { return text("text", &query.Text) },
		func() error { return bound("from_us", &query.FromUs) },
		func() error { return bound("to_us", &query.ToUs) },
		func() error {
			value, present := member("limit")
			if !present {
				return nil
			}
			n, integer := isInteger(value)
			if !integer || n < 1 || n > queryMaxLimit {
				return queryError("limit must be an integer from 1 to %d, found %s", queryMaxLimit, stringify(value, true))
			}
			query.Limit = int(n)
			return nil
		},
		func() error { return choice("order", queryOrders, &query.Order) },
		func() error {
			value, present := member("after")
			if !present {
				return nil
			}
			cursor, ok := cursorOf(value)
			if !ok {
				return queryError("after must be {ts_us, role, boot, seq}, found %s", stringify(value, true))
			}
			query.After = &cursor
			return nil
		},
		func() error {
			value, present := member("since")
			if !present {
				return nil
			}
			since, ok := value.(eventObject)
			if !ok {
				return queryError("since must map process names to integers, found %s", stringify(value, true))
			}
			query.Since = map[string]int64{}
			for _, entry := range since {
				n, integer := isInteger(entry.value)
				if !integer {
					return queryError("since must map process names to integers, found %s", stringify(value, true))
				}
				query.Since[entry.name] = n
			}
			return nil
		},
	}
	for _, step := range steps {
		if err := step(); err != nil {
			return LogQuery{}, err
		}
	}
	if query.FromUs != nil && query.ToUs != nil && *query.FromUs > *query.ToUs {
		return LogQuery{}, queryError("from_us is later than to_us: %d %d", *query.FromUs, *query.ToUs)
	}
	if query.Event != "" && query.EventPrefix != "" {
		return LogQuery{}, queryError("takes event or event_prefix, not both")
	}
	if strings.HasSuffix(query.EventPrefix, ".") {
		return LogQuery{}, queryError("event_prefix %s must not end with a dot", jsString(query.EventPrefix))
	}
	return query, nil
}

// cursorOf reads a cursor: an object of exactly ts_us, role, boot and seq.
func cursorOf(value any) (LogCursor, bool) {
	object, ok := value.(eventObject)
	if !ok || len(object) != 4 {
		return LogCursor{}, false
	}
	tsUs, tsOK := object.get("ts_us")
	role, roleOK := object.get("role")
	boot, bootOK := object.get("boot")
	seq, seqOK := object.get("seq")
	if !tsOK || !roleOK || !bootOK || !seqOK {
		return LogCursor{}, false
	}
	ts, tsInteger := isInteger(tsUs)
	number, seqInteger := isInteger(seq)
	roleText, roleString := role.(string)
	bootText, bootString := boot.(string)
	if !tsInteger || !seqInteger || !roleString || !bootString || roleText == "" || bootText == "" {
		return LogCursor{}, false
	}
	return LogCursor{ts, roleText, bootText, number}, true
}

// LogRow is one row of a page.
type LogRow struct {
	Role   string          `json:"role"`
	Boot   string          `json:"boot"`
	File   string          `json:"file"`
	Offset int64           `json:"offset"`
	Event  json.RawMessage `json:"event"`
}

// LogScanned says how much of the files a query looked at.
type LogScanned struct {
	Files    int `json:"files"`
	Segments int `json:"segments"`
	Read     int `json:"read"`
	Lines    int `json:"lines"`
	Rebuilt  int `json:"rebuilt"`
}

// LogPage is the answer of a query.
type LogPage struct {
	Rows    []LogRow         `json:"rows"`
	Next    *LogCursor       `json:"next"`
	Tail    map[string]int64 `json:"tail"`
	Scanned LogScanned       `json:"scanned"`
}

// logSource is an event file of the channel.
type logSource struct {
	role, boot string
	name, path string
}

func (s logSource) process() string { return s.role + "-" + s.boot }

// discoverLogs lists the event files of the channel under <config-dir>/logs/ in the order of their names.
func discoverLogs(configDir, channel string) ([]logSource, error) {
	logs := filepath.Join(configDir, "logs")
	entries, err := os.ReadDir(logs)
	if err != nil {
		return nil, fileError(logs, err)
	}
	var sources []logSource
	for _, entry := range entries {
		match := logFileName.FindStringSubmatch(entry.Name())
		if match == nil || entry.IsDir() {
			continue
		}
		debug := match[3] != ""
		if channel == "other" && debug || channel == "debug" && !debug {
			continue
		}
		sources = append(sources, logSource{role: match[1], boot: match[2], name: "logs/" + entry.Name(), path: filepath.Join(logs, entry.Name())})
	}
	sort.Slice(sources, func(i, j int) bool { return sources[i].name < sources[j].name })
	return sources, nil
}

// queryPlan is a query with the values that its tests use.
type queryPlan struct {
	query     LogQuery
	levelMask uint8
	layerBit  uint8
	classBit  uint8
	hasLayer  bool
	hasClass  bool
	low, high int64
	needle    []byte
	// literals are values that a line holds in the same bytes when it holds them at all, so a line without them is not parsed.
	literals [][]byte
}

func newPlan(query LogQuery) *queryPlan {
	p := &queryPlan{query: query, low: math.MinInt64, high: math.MaxInt64}
	p.levelMask = uint8(1<<(indexOfName(indexLevels, query.Level)+1) - 1)
	if query.Layer != "" {
		p.hasLayer, p.layerBit = true, 1<<indexOfName(indexLayers, query.Layer)
	}
	if query.Class != "" {
		p.hasClass, p.classBit = true, 1<<indexOfName(indexClasses, query.Class)
	}
	if query.FromUs != nil {
		p.low = *query.FromUs
	}
	if query.ToUs != nil {
		p.high = *query.ToUs
	}
	p.needle = []byte(asciiLowered(query.Text))
	for _, value := range []string{query.Event, query.EventPrefix, query.Surface, query.Session, query.Cid} {
		if literal := plainLiteral(value); literal != nil {
			p.literals = append(p.literals, literal)
		}
	}
	return p
}

// plainLiteral is the bytes of a value that JSON writes as they are: printable ASCII without a quote, a backslash and the characters
// that a Go writer escapes (<, > and &). It is nil for another value or an empty one.
func plainLiteral(value string) []byte {
	if value == "" {
		return nil
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c < 0x20 || c > 0x7e || c == '"' || c == '\\' || c == '<' || c == '>' || c == '&' {
			return nil
		}
	}
	return []byte(value)
}

func asciiLowered(text string) string {
	b := []byte(text)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// containsFold reports whether hay holds needle, which is already in lower case, comparing ASCII letters without case.
func containsFold(hay, needle []byte) bool {
	n := len(needle)
	if n == 0 {
		return true
	}
	for i := 0; i+n <= len(hay); i++ {
		j := 0
		for ; j < n; j++ {
			c := hay[i+j]
			if c >= 'A' && c <= 'Z' {
				c += 32
			}
			if c != needle[j] {
				break
			}
		}
		if j == n {
			return true
		}
	}
	return false
}

// admits reports whether the record can hold a row of the plan.
func (p *queryPlan) admits(s *segment, process string, order string) bool {
	if s.maxTs < p.low || s.minTs > p.high {
		return false
	}
	if s.levels&p.levelMask == 0 || p.hasLayer && s.layers&p.layerBit == 0 || p.hasClass && s.classes&p.classBit == 0 {
		return false
	}
	if cursor := p.query.After; cursor != nil {
		if order == "asc" && s.maxTs < cursor.TsUs || order == "desc" && s.minTs > cursor.TsUs {
			return false
		}
	}
	if limit, ok := p.query.Since[process]; ok && int64(s.lastSeq) <= limit {
		return false
	}
	q := p.query
	has := func(kind int, item string) bool {
		return bloomHas(s.filterOf(kind), bloomShapes[kind].hashes, item)
	}
	switch {
	case q.Event != "" && !has(bloomEvent, q.Event):
		return false
	case q.EventPrefix != "" && !has(bloomEvent, q.EventPrefix):
		return false
	case q.Surface != "" && !has(bloomSurface, q.Surface):
		return false
	case q.Session != "" && !has(bloomSession, q.Session):
		return false
	case q.Cid != "" && !has(bloomCids, q.Cid):
		return false
	}
	return true
}

// prefilter reports whether a line can be a row of the plan without parsing it: it holds the text and the literal values.
func (p *queryPlan) prefilter(raw []byte) bool {
	if len(p.needle) > 0 && !containsFold(raw, p.needle) {
		return false
	}
	for _, literal := range p.literals {
		if !bytes.Contains(raw, literal) {
			return false
		}
	}
	return true
}

// matches reports whether a line is a row of the plan; the cursor and the bounds of the run are applied by the caller.
func (p *queryPlan) matches(line *scannedLine, process string) bool {
	q := p.query
	if limit, ok := q.Since[process]; ok && line.seq <= limit {
		return false
	}
	if line.tsUs < p.low || line.tsUs > p.high || line.level >= len(indexLevels) || uint8(1)<<line.level&p.levelMask == 0 {
		return false
	}
	if p.hasLayer && uint8(1)<<line.layer&p.layerBit == 0 {
		return false
	}
	if p.hasClass && (line.class < 0 || uint8(1)<<line.class&p.classBit == 0) {
		return false
	}
	switch {
	case q.Event != "" && line.event != q.Event:
		return false
	case q.EventPrefix != "" && line.event != q.EventPrefix && !strings.HasPrefix(line.event, q.EventPrefix+"."):
		return false
	case q.Surface != "" && line.surface != q.Surface:
		return false
	case q.Session != "" && line.session != q.Session:
		return false
	case q.Cid != "" && !contains(line.cids, q.Cid):
		return false
	}
	return true
}

// queriedLog is an event file of the channel with its index.
type queriedLog struct {
	source logSource
	opened *openedLog
}

// QueryLogs answers a query over the event files of the configuration directory. indexed, when it is not nil, is called for each
// index that the query had to update.
func QueryLogs(configDir string, query LogQuery, indexed func(IndexUpdate)) (result LogPage, err error) {
	sources, err := discoverLogs(configDir, query.Channel)
	if err != nil {
		return LogPage{}, err
	}
	page := LogPage{Rows: []LogRow{}, Tail: map[string]int64{}}
	var logs []queriedLog
	defer func() {
		for _, l := range logs {
			if closeErr := l.opened.close(); closeErr != nil && err == nil {
				result, err = LogPage{}, fileError(l.source.name, closeErr)
			}
		}
	}()
	for _, source := range sources {
		opened, err := openLog(source.path)
		if err != nil {
			return LogPage{}, err
		}
		logs = append(logs, queriedLog{source, opened})
		if opened.update.Changed && indexed != nil {
			indexed(opened.update)
		}
		if opened.update.Rebuilt {
			page.Scanned.Rebuilt++
		}
		page.Scanned.Files++
		page.Scanned.Segments += opened.index.segments()
		if opened.index.state.events > 0 {
			process := source.process()
			page.Tail[process] = max(page.Tail[process], int64(opened.index.state.lastSeq))
		}
	}
	p := newPlan(query)
	if query.Run != "" {
		low, high, err := resolveRun(logs, query.Run, &page.Scanned)
		if err != nil {
			return LogPage{}, err
		}
		p.low, p.high = max(p.low, low), min(p.high, high)
	}
	type candidate struct {
		log    *queriedLog
		number int
		seg    *segment
	}
	var candidates []candidate
	for i := range logs {
		l := &logs[i]
		for n := 0; n < l.opened.index.segments(); n++ {
			seg, err := l.opened.index.segmentAt(n)
			if err != nil {
				return LogPage{}, err
			}
			if p.admits(seg, l.source.process(), query.Order) {
				candidates = append(candidates, candidate{l, n, seg})
			}
		}
	}
	ascending := query.Order == "asc"
	sort.SliceStable(candidates, func(i, j int) bool {
		if ascending {
			return candidates[i].seg.minTs < candidates[j].seg.minTs
		}
		return candidates[i].seg.maxTs > candidates[j].seg.maxTs
	})
	type entry struct {
		key  LogCursor
		row  LogRow
		size int
	}
	var best []entry
	before := func(a, b LogCursor) bool {
		if ascending {
			return a.less(b)
		}
		return b.less(a)
	}
	for _, c := range candidates {
		if len(best) == query.Limit+1 {
			last := best[len(best)-1].key.TsUs
			if ascending && c.seg.minTs > last || !ascending && c.seg.maxTs < last {
				break
			}
		}
		data := make([]byte, c.seg.length)
		if _, err := c.log.opened.source.ReadAt(data, int64(c.seg.offset)); err != nil {
			return LogPage{}, fileError(c.log.source.name, err)
		}
		page.Scanned.Read++
		process := c.log.source.process()
		offset := int64(c.seg.offset)
		number := c.number*indexSegmentEvents + 1
		for len(data) > 0 {
			end := bytes.IndexByte(data, '\n')
			if end < 0 {
				return LogPage{}, fmt.Errorf("%s: segment %d does not end with a line feed", c.log.source.name, c.number)
			}
			raw := data[:end]
			data = data[end+1:]
			lineOffset := offset
			offset += int64(end) + 1
			page.Scanned.Lines++
			number++
			if !p.prefilter(raw) {
				continue
			}
			line, err := scanLine(c.log.source.name, number-1, raw)
			if err != nil {
				return LogPage{}, err
			}
			if !p.matches(line, process) {
				continue
			}
			key := LogCursor{line.tsUs, c.log.source.role, c.log.source.boot, line.seq}
			if cursor := query.After; cursor != nil && !before(*cursor, key) {
				continue
			}
			if len(best) == query.Limit+1 && !before(key, best[len(best)-1].key) {
				continue
			}
			at := sort.Search(len(best), func(i int) bool { return before(key, best[i].key) })
			row := LogRow{Role: key.Role, Boot: key.Boot, File: c.log.source.name, Offset: lineOffset, Event: append(json.RawMessage(nil), raw...)}
			best = append(best, entry{})
			copy(best[at+1:], best[at:])
			best[at] = entry{key, row, len(raw)}
			if len(best) > query.Limit+1 {
				best = best[:query.Limit+1]
			}
		}
	}
	taken, used := 0, 0
	for taken < len(best) && taken < query.Limit {
		if taken > 0 && used+best[taken].size > queryPageBytes {
			break
		}
		used += best[taken].size
		page.Rows = append(page.Rows, best[taken].row)
		taken++
	}
	if taken < len(best) {
		key := best[taken-1].key
		page.Next = &key
	}
	return page, nil
}

// resolveRun finds the range of time of a run: from the earliest host.test.start to the latest host.test.end whose fields.run is
// the identifier, or to the end of the files when the last start has no end after it.
func resolveRun(logs []queriedLog, run string, scanned *LogScanned) (int64, int64, error) {
	low, lastStart, lastEnd := int64(math.MaxInt64), int64(math.MinInt64), int64(math.MinInt64)
	found := false
	for i := range logs {
		l := &logs[i]
		for n := 0; n < l.opened.index.segments(); n++ {
			seg, err := l.opened.index.segmentAt(n)
			if err != nil {
				return 0, 0, err
			}
			has := func(kind int, item string) bool { return bloomHas(seg.filterOf(kind), bloomShapes[kind].hashes, item) }
			if !has(bloomRun, run) || !has(bloomEvent, "host.test.start") && !has(bloomEvent, "host.test.end") {
				continue
			}
			data := make([]byte, seg.length)
			if _, err := l.opened.source.ReadAt(data, int64(seg.offset)); err != nil {
				return 0, 0, fileError(l.source.name, err)
			}
			scanned.Read++
			number := n*indexSegmentEvents + 1
			for _, raw := range bytes.Split(bytes.TrimSuffix(data, []byte("\n")), []byte("\n")) {
				line, err := scanLine(l.source.name, number, raw)
				number++
				if err != nil {
					return 0, 0, err
				}
				scanned.Lines++
				if line.run != run {
					continue
				}
				switch line.event {
				case "host.test.start":
					found = true
					low = min(low, line.tsUs)
					lastStart = max(lastStart, line.tsUs)
				case "host.test.end":
					lastEnd = max(lastEnd, line.tsUs)
				}
			}
		}
	}
	if !found {
		return 0, 0, queryError("run %s has no host.test.start in the channel", jsString(run))
	}
	if lastEnd < lastStart {
		return low, math.MaxInt64, nil
	}
	return low, lastEnd, nil
}

// LogLine is the text line of an event line of a file: the form that the debug view shows and `sok debug query` prints.
func LogLine(event []byte) (string, error) {
	row, err := rowOf("event", 1, string(event))
	if err != nil {
		return "", err
	}
	return eventLine(row), nil
}

// FormatLogCursor is the form of a cursor in the flag --after and in the note of the next page.
func FormatLogCursor(c LogCursor) string {
	return strconv.FormatInt(c.TsUs, 10) + "/" + c.Role + "/" + c.Boot + "/" + strconv.FormatInt(c.Seq, 10)
}
