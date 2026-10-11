package sok

// The index beside an event file (docs/spec/logging.md#index). It is derived from the file: it says which segments of 4,096
// lines can hold an event of a query. The Rust implementation (packages/sok/tauriv2/src/log_index.rs) writes the same bytes
// for the same file, and the golden digests of packages/log-contract/fixtures/query check it.

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math/bits"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

const (
	indexSegmentEvents = 4096
	indexVersion       = 1
	indexBlockBytes    = 20480
	indexRecordBytes   = 18760
	indexMembersBytes  = 64
	// indexChunkBytes is the size of one read of the file while it is indexed.
	indexChunkBytes = 8 << 20
	// indexLineLimit bounds the size of one line: a writer stores at most 1,048,576 bytes of fields (docs/spec/logging.md#bounds).
	indexLineLimit = 64 << 20
)

// The five Bloom filters of a record in the order of the specification: bytes and number of hashes.
var bloomShapes = [5]struct{ bytes, hashes int }{{1024, 4}, {512, 4}, {512, 4}, {256, 4}, {16384, 5}}

const (
	bloomEvent = iota
	bloomSurface
	bloomSession
	bloomRun
	bloomCids
)

// bloomOffsets are the offsets of the filters inside a record.
var bloomOffsets = func() [5]int {
	var offsets [5]int
	offset := indexMembersBytes
	for i, shape := range bloomShapes {
		offsets[i] = offset
		offset += shape.bytes
	}
	return offsets
}()

var (
	indexLevels  = []string{"error", "warn", "info", "debug", "trace"}
	indexLayers  = []string{"native", "host", "page", "plugin", "sidecar", "sok"}
	indexClasses = []string{"lifecycle", "input", "call", "io", "frame"}
)

// fnv1a is FNV-1a 64 over the bytes.
func fnv1a(data []byte) uint64 {
	hash := uint64(0xcbf29ce484222325)
	for _, b := range data {
		hash ^= uint64(b)
		hash *= 0x100000001b3
	}
	return hash
}

func fnv1aString(text string) uint64 {
	hash := uint64(0xcbf29ce484222325)
	for i := 0; i < len(text); i++ {
		hash ^= uint64(text[i])
		hash *= 0x100000001b3
	}
	return hash
}

// bloomAdd sets the bits of the item in a filter.
func bloomAdd(filter []byte, hashes int, item string) {
	hash := fnv1aString(item)
	step := bits.RotateLeft64(hash, 32) | 1
	mask := uint64(len(filter)*8 - 1)
	for i := 0; i < hashes; i++ {
		bit := (hash + uint64(i)*step) & mask
		filter[bit>>3] |= 1 << (bit & 7)
	}
}

// bloomHas reports whether the filter may hold the item.
func bloomHas(filter []byte, hashes int, item string) bool {
	hash := fnv1aString(item)
	step := bits.RotateLeft64(hash, 32) | 1
	mask := uint64(len(filter)*8 - 1)
	for i := 0; i < hashes; i++ {
		bit := (hash + uint64(i)*step) & mask
		if filter[bit>>3]&(1<<(bit&7)) == 0 {
			return false
		}
	}
	return true
}

// segment is the record of one segment.
type segment struct {
	offset, length    uint64
	firstSeq, lastSeq uint64
	events            uint32
	minTs, maxTs      int64
	levels, layers    uint8
	classes           uint8
	record            []byte
}

func newSegment(offset uint64) *segment {
	return &segment{offset: offset, record: make([]byte, indexRecordBytes), minTs: 1<<63 - 1, maxTs: -1 << 63}
}

// filterOf is the Bloom filter of the given kind in the record.
func (s *segment) filterOf(kind int) []byte {
	return s.record[bloomOffsets[kind] : bloomOffsets[kind]+bloomShapes[kind].bytes]
}

// add records one line in the segment: what the scan found and the size of the line with its line feed.
func (s *segment) add(line *scannedLine, size uint64) {
	if s.events == 0 {
		s.firstSeq = uint64(line.seq)
	}
	s.lastSeq = uint64(line.seq)
	s.events++
	s.length += size
	s.minTs = min(s.minTs, line.tsUs)
	s.maxTs = max(s.maxTs, line.tsUs)
	s.levels |= 1 << line.level
	s.layers |= 1 << line.layer
	if line.class >= 0 {
		s.classes |= 1 << line.class
	}
	name := line.event
	for i := 0; i < len(name); i++ {
		if name[i] == '.' {
			bloomAdd(s.filterOf(bloomEvent), bloomShapes[bloomEvent].hashes, name[:i])
		}
	}
	bloomAdd(s.filterOf(bloomEvent), bloomShapes[bloomEvent].hashes, name)
	if line.surface != "" {
		bloomAdd(s.filterOf(bloomSurface), bloomShapes[bloomSurface].hashes, line.surface)
	}
	if line.session != "" {
		bloomAdd(s.filterOf(bloomSession), bloomShapes[bloomSession].hashes, line.session)
	}
	if line.run != "" {
		bloomAdd(s.filterOf(bloomRun), bloomShapes[bloomRun].hashes, line.run)
	}
	for _, cid := range line.cids {
		bloomAdd(s.filterOf(bloomCids), bloomShapes[bloomCids].hashes, cid)
	}
}

// encode writes the members and the checksum into the record.
func (s *segment) encode() []byte {
	r := s.record
	binary.LittleEndian.PutUint64(r[0:], s.offset)
	binary.LittleEndian.PutUint64(r[8:], s.length)
	binary.LittleEndian.PutUint64(r[16:], s.firstSeq)
	binary.LittleEndian.PutUint64(r[24:], s.lastSeq)
	binary.LittleEndian.PutUint32(r[32:], s.events)
	binary.LittleEndian.PutUint64(r[40:], uint64(s.minTs))
	binary.LittleEndian.PutUint64(r[48:], uint64(s.maxTs))
	r[56], r[57], r[58] = s.levels, s.layers, s.classes
	binary.LittleEndian.PutUint64(r[indexRecordBytes-8:], fnv1a(r[:indexRecordBytes-8]))
	return r
}

// decodeSegment reads a record; it fails when the checksum does not match.
func decodeSegment(record []byte) (*segment, bool) {
	if binary.LittleEndian.Uint64(record[indexRecordBytes-8:]) != fnv1a(record[:indexRecordBytes-8]) {
		return nil, false
	}
	return &segment{
		offset:   binary.LittleEndian.Uint64(record[0:]),
		length:   binary.LittleEndian.Uint64(record[8:]),
		firstSeq: binary.LittleEndian.Uint64(record[16:]),
		lastSeq:  binary.LittleEndian.Uint64(record[24:]),
		events:   binary.LittleEndian.Uint32(record[32:]),
		minTs:    int64(binary.LittleEndian.Uint64(record[40:])),
		maxTs:    int64(binary.LittleEndian.Uint64(record[48:])),
		levels:   record[56], layers: record[57], classes: record[58],
		record: record,
	}, true
}

// indexState is the content of a state block.
type indexState struct {
	generation    uint64
	headLen       uint32
	headHash      uint64
	indexedBytes  uint64
	sourceSize    uint64
	sourceMtimeNs int64
	firstSeq      uint64
	lastSeq       uint64
	events        uint64
	fullSegments  uint32
	tail          *segment
}

func (s *indexState) encode() []byte {
	b := make([]byte, indexBlockBytes)
	copy(b, "SKIX")
	binary.LittleEndian.PutUint32(b[4:], indexVersion)
	binary.LittleEndian.PutUint32(b[8:], indexSegmentEvents)
	binary.LittleEndian.PutUint32(b[12:], s.headLen)
	binary.LittleEndian.PutUint64(b[16:], s.generation)
	binary.LittleEndian.PutUint64(b[24:], s.headHash)
	binary.LittleEndian.PutUint64(b[32:], s.indexedBytes)
	binary.LittleEndian.PutUint64(b[40:], s.sourceSize)
	binary.LittleEndian.PutUint64(b[48:], uint64(s.sourceMtimeNs))
	binary.LittleEndian.PutUint64(b[56:], s.firstSeq)
	binary.LittleEndian.PutUint64(b[64:], s.lastSeq)
	binary.LittleEndian.PutUint64(b[72:], s.events)
	binary.LittleEndian.PutUint32(b[80:], s.fullSegments)
	if s.tail != nil {
		binary.LittleEndian.PutUint32(b[84:], 1)
		copy(b[88:], s.tail.encode())
	}
	binary.LittleEndian.PutUint64(b[indexBlockBytes-8:], fnv1a(b[:indexBlockBytes-8]))
	return b
}

// decodeBlock reads a state block. A block of zeros is unused. A block with another magic or version is an error; a block whose
// checksum does not match is not valid.
func decodeBlock(name string, number int, b []byte) (state indexState, used, valid bool, err error) {
	if bytes.Equal(b, make([]byte, len(b))) {
		return indexState{}, false, false, nil
	}
	if string(b[:4]) != "SKIX" {
		return indexState{}, true, false, fmt.Errorf("%s: block %d does not start with SKIX", name, number)
	}
	if version := binary.LittleEndian.Uint32(b[4:]); version != indexVersion {
		return indexState{}, true, false, fmt.Errorf("%s: version %d is not %d", name, version, indexVersion)
	}
	if binary.LittleEndian.Uint64(b[indexBlockBytes-8:]) != fnv1a(b[:indexBlockBytes-8]) {
		return indexState{}, true, false, nil
	}
	if lines := binary.LittleEndian.Uint32(b[8:]); lines != indexSegmentEvents {
		return indexState{}, true, false, fmt.Errorf("%s: %d lines in a segment is not %d", name, lines, indexSegmentEvents)
	}
	state = indexState{
		headLen:       binary.LittleEndian.Uint32(b[12:]),
		generation:    binary.LittleEndian.Uint64(b[16:]),
		headHash:      binary.LittleEndian.Uint64(b[24:]),
		indexedBytes:  binary.LittleEndian.Uint64(b[32:]),
		sourceSize:    binary.LittleEndian.Uint64(b[40:]),
		sourceMtimeNs: int64(binary.LittleEndian.Uint64(b[48:])),
		firstSeq:      binary.LittleEndian.Uint64(b[56:]),
		lastSeq:       binary.LittleEndian.Uint64(b[64:]),
		events:        binary.LittleEndian.Uint64(b[72:]),
		fullSegments:  binary.LittleEndian.Uint32(b[80:]),
	}
	if binary.LittleEndian.Uint32(b[84:]) == 1 {
		tail, ok := decodeSegment(append([]byte(nil), b[88:88+indexRecordBytes]...))
		if !ok {
			return indexState{}, true, false, nil
		}
		state.tail = tail
	}
	return state, true, true, nil
}

// indexFile is the content of an index file that was read.
type indexFile struct {
	name  string
	state indexState
	// exists is false when the file holds no valid state block.
	exists bool
	data   []byte
}

// parseIndex reads the two state blocks of the content of an index file; name is the display name of the index.
func parseIndex(name string, data []byte) (indexFile, error) {
	file := indexFile{name: name, data: data}
	if len(data) == 0 {
		return file, nil
	}
	if len(data) < 2*indexBlockBytes {
		return file, fmt.Errorf("%s: %d bytes are fewer than the two state blocks of %d", name, len(data), 2*indexBlockBytes)
	}
	anyUsed := false
	for number := 0; number < 2; number++ {
		state, used, valid, err := decodeBlock(name, number, data[number*indexBlockBytes:(number+1)*indexBlockBytes])
		if err != nil {
			return file, err
		}
		anyUsed = anyUsed || used
		if valid && (!file.exists || state.generation > file.state.generation) {
			file.state, file.exists = state, true
		}
	}
	if !anyUsed {
		return file, nil
	}
	if !file.exists {
		return file, fmt.Errorf("%s: neither state block has a valid checksum", name)
	}
	if follow := uint64(len(data)-2*indexBlockBytes) / indexRecordBytes; follow < uint64(file.state.fullSegments) {
		return file, fmt.Errorf("%s: %d records follow the state blocks, and the state block counts %d", name, follow, file.state.fullSegments)
	}
	return file, nil
}

// segmentAt reads the record of segment number n; the tail is the segment after the full ones.
func (f *indexFile) segmentAt(n int) (*segment, error) {
	if n == int(f.state.fullSegments) && f.state.tail != nil {
		return f.state.tail, nil
	}
	start := 2*indexBlockBytes + n*indexRecordBytes
	s, ok := decodeSegment(f.data[start : start+indexRecordBytes])
	if !ok {
		return nil, fmt.Errorf("%s: segment %d has a record whose checksum does not match", f.name, n)
	}
	return s, nil
}

// segments is the number of segments of the index, the tail included.
func (f *indexFile) segments() int {
	n := int(f.state.fullSegments)
	if f.state.tail != nil {
		n++
	}
	return n
}

// scannedLine is what the scan of one line of an event file finds.
type scannedLine struct {
	tsUs, seq int64
	level     int
	layer     int
	// class is the index in indexClasses, or -1 when the line has none.
	class            int
	event            string
	surface, session string
	cids             []string
	run              string
}

// lineShape is the typed view of a line: a member of another type fails the decoding, and the line is then read again by the
// reader whose error names the file and the line.
type lineShape struct {
	TsUs    json.Number     `json:"ts_us"`
	Seq     json.Number     `json:"seq"`
	Level   string          `json:"level"`
	Layer   string          `json:"layer"`
	Event   *string         `json:"event"`
	Class   *string         `json:"class"`
	Surface *string         `json:"surface"`
	Session *string         `json:"session"`
	Cids    []string        `json:"cids"`
	Fields  json.RawMessage `json:"fields"`
}

type fieldsShape struct {
	Surface json.RawMessage `json:"surface"`
	Session json.RawMessage `json:"session"`
	Run     json.RawMessage `json:"run"`
}

func indexOfName(list []string, name string) int {
	for i, item := range list {
		if item == name {
			return i
		}
	}
	return -1
}

// stringMember is the string that raw holds, or false when raw is missing or is not a string.
func stringMember(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || raw[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", false
	}
	return text, true
}

// scanLine reads one line. A line that the typed read does not accept is read again by the reader of the event structure, whose
// error names the file and the line; a line that this reader accepts after all is reported with the reason of the typed read.
func scanLine(file string, number int, raw []byte) (*scannedLine, error) {
	line, reason := scanFast(raw)
	if reason == nil {
		return line, nil
	}
	if _, err := rowOf(file, number, string(raw)); err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("%s:%d: the line cannot be indexed: %v", file, number, reason)
}

func scanFast(raw []byte) (*scannedLine, error) {
	var shape lineShape
	if err := json.Unmarshal(raw, &shape); err != nil {
		return nil, err
	}
	tsUs, err := strconv.ParseInt(string(shape.TsUs), 10, 64)
	if err != nil {
		return nil, err
	}
	seq, err := strconv.ParseInt(string(shape.Seq), 10, 64)
	if err != nil {
		return nil, err
	}
	if shape.Event == nil {
		return nil, errors.New("event is missing")
	}
	line := &scannedLine{tsUs: tsUs, seq: seq, event: *shape.Event, cids: shape.Cids, class: -1}
	if line.level = indexOfName(indexLevels, shape.Level); line.level < 0 {
		return nil, errors.New("level is not defined")
	}
	if line.layer = indexOfName(indexLayers, shape.Layer); line.layer < 0 {
		return nil, errors.New("layer is not defined")
	}
	if shape.Class != nil {
		if line.class = indexOfName(indexClasses, *shape.Class); line.class < 0 {
			return nil, errors.New("class is not defined")
		}
	}
	if shape.Surface != nil {
		line.surface = *shape.Surface
	}
	if shape.Session != nil {
		line.session = *shape.Session
	}
	if len(shape.Fields) > 0 {
		if shape.Fields[0] != '{' {
			return nil, errors.New("fields is not an object")
		}
		if bytes.Contains(shape.Fields, []byte(`"surface"`)) || bytes.Contains(shape.Fields, []byte(`"session"`)) || bytes.Contains(shape.Fields, []byte(`"run"`)) {
			var fields fieldsShape
			if err := json.Unmarshal(shape.Fields, &fields); err != nil {
				return nil, err
			}
			if text, ok := stringMember(fields.Surface); ok && line.surface == "" {
				line.surface = text
			}
			if text, ok := stringMember(fields.Session); ok && line.session == "" {
				line.session = text
			}
			if text, ok := stringMember(fields.Run); ok {
				line.run = text
			}
		}
	}
	return line, nil
}

// IndexUpdate says what one update of an index did.
type IndexUpdate struct {
	// File is the display name of the event file, `logs/<name>`.
	File string
	// Changed is false when the index was current.
	Changed bool
	// Rebuilt is true when the whole file was indexed; Reason says why.
	Rebuilt bool
	Reason  string
	// Lines and Bytes are the lines indexed by this update and the bytes of the file that were read.
	Lines, Bytes int64
	Micros       int64
}

// logDisplayName is the name that errors give an event file: `logs/<name>`.
func logDisplayName(path string) string { return "logs/" + filepath.Base(path) }

// openedLog is an event file with its index brought up to date. The source stays open, so the segments are read from the file
// that was indexed even when a rotation renames it afterwards.
type openedLog struct {
	name   string
	source *os.File
	index  indexFile
	update IndexUpdate
}

func (o *openedLog) close() error { return o.source.Close() }

// lockedIndex opens the event file and its index, locks the index, and checks that both are still the files at their paths, so a
// rotation cannot mix two files. The caller releases the lock with unlockIndex.
func lockedIndex(path string) (source, idx *os.File, system platform.Platform, err error) {
	system, err = platform.Current()
	if err != nil {
		return nil, nil, nil, err
	}
	for attempt := 0; attempt < 8; attempt++ {
		source, err = os.Open(path)
		if err != nil {
			return nil, nil, nil, fileError(path, err)
		}
		idx, err = os.OpenFile(path+".idx", os.O_RDWR|os.O_CREATE|syscall.O_CLOEXEC, 0o600)
		if err != nil {
			source.Close()
			return nil, nil, nil, fileError(path+".idx", err)
		}
		if err = system.LockFile(idx); err != nil {
			source.Close()
			idx.Close()
			return nil, nil, nil, err
		}
		sameSource, errSource := stillAt(source, path)
		sameIndex, errIndex := stillAt(idx, path+".idx")
		if errSource != nil || errIndex != nil {
			source.Close()
			unlockIndex(system, idx)
			return nil, nil, nil, errors.Join(errSource, errIndex)
		}
		if sameSource && sameIndex {
			return source, idx, system, nil
		}
		source.Close()
		unlockIndex(system, idx)
	}
	return nil, nil, nil, fmt.Errorf("%s: the file was renamed 8 times while it was opened", path)
}

// unlockIndex releases the lock of the index and closes it.
func unlockIndex(system platform.Platform, idx *os.File) {
	// default: closing the file releases the lock too, so a failed unlock leaves nothing held after the close below.
	_ = system.UnlockFile(idx)
	idx.Close()
}

// stillAt reports whether the open file is the file at the path.
func stillAt(file *os.File, path string) (bool, error) {
	opened, err := file.Stat()
	if err != nil {
		return false, fileError(path, err)
	}
	named, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fileError(path, err)
	}
	return os.SameFile(opened, named), nil
}

// UpdateLogIndex brings the index of the event file at path up to date, building it when it does not exist, and says what it did.
func UpdateLogIndex(path string) (IndexUpdate, error) {
	opened, err := openLog(path)
	if err != nil {
		return IndexUpdate{File: logDisplayName(path)}, err
	}
	update := opened.update
	if err := opened.close(); err != nil {
		return update, fileError(path, err)
	}
	return update, nil
}

// openLog brings the index of the event file up to date and returns the file with the index content.
func openLog(path string) (*openedLog, error) {
	source, idx, system, err := lockedIndex(path)
	if err != nil {
		return nil, err
	}
	opened, err := refreshLocked(path, source, idx)
	unlockIndex(system, idx)
	if err != nil {
		source.Close()
		return nil, err
	}
	return opened, nil
}

// refreshLocked brings the index up to date while the caller holds its lock.
func refreshLocked(path string, source, idx *os.File) (*openedLog, error) {
	started := time.Now()
	name := logDisplayName(path)
	opened := &openedLog{name: name, source: source, update: IndexUpdate{File: name}}
	info, err := source.Stat()
	if err != nil {
		return nil, fileError(path, err)
	}
	data, err := readAll(idx)
	if err != nil {
		return nil, fileError(path+".idx", err)
	}
	current, err := parseIndex(name+".idx", data)
	if err != nil {
		return nil, err
	}
	size, mtime := uint64(info.Size()), info.ModTime().UnixNano()
	state := current.state
	rebuild := ""
	switch {
	case !current.exists:
		rebuild = "the index did not exist"
	case state.sourceSize == size && state.sourceMtimeNs == mtime:
		opened.index = current
		return opened, nil
	case size < state.sourceSize:
		rebuild = "the file is smaller than the indexed part"
	case size == state.sourceSize:
		rebuild = "the modification time changed at the same size"
	case state.headLen > 0:
		head := make([]byte, state.headLen)
		if _, err := source.ReadAt(head, 0); err != nil || fnv1a(head) != state.headHash {
			rebuild = "the first line changed"
		}
	}
	if rebuild != "" {
		// An index that is built again is empty until the new state is written, so a failure leaves no state that describes the old file.
		if err := idx.Truncate(0); err != nil {
			return nil, fileError(path+".idx", err)
		}
		if _, err := idx.WriteAt(make([]byte, 2*indexBlockBytes), 0); err != nil {
			return nil, fileError(path+".idx", err)
		}
		state = indexState{}
	}
	read, lines, err := indexFrom(name, state, source, idx, size, mtime, rebuild != "")
	if err != nil {
		return nil, err
	}
	opened.update.Changed, opened.update.Rebuilt, opened.update.Reason = true, rebuild != "", rebuild
	opened.update.Bytes, opened.update.Lines = read, lines
	opened.update.Micros = time.Since(started).Microseconds()
	if data, err = readAll(idx); err != nil {
		return nil, fileError(path+".idx", err)
	}
	if opened.index, err = parseIndex(name+".idx", data); err != nil {
		return nil, err
	}
	return opened, nil
}

// readAll reads the whole file.
func readAll(file *os.File) ([]byte, error) {
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	data := make([]byte, info.Size())
	if len(data) > 0 {
		if _, err := file.ReadAt(data, 0); err != nil {
			return nil, err
		}
	}
	return data, nil
}

// indexFrom indexes the lines of the source after the indexed part (from the start when rebuild is set), writes the new full
// records and then the new state block. It returns the bytes it read and the lines it indexed.
func indexFrom(name string, state indexState, source, idx *os.File, size uint64, mtime int64, rebuild bool) (int64, int64, error) {
	start := state.indexedBytes
	events := uint64(state.fullSegments) * indexSegmentEvents
	if rebuild {
		start, events, state = 0, 0, indexState{}
	} else if state.tail != nil {
		start = state.tail.offset
	}
	firstEvent := events
	next := state
	next.tail = nil
	acc := newSegment(start)
	var carry []byte
	position := start
	buffer := make([]byte, indexChunkBytes)
	lineStart := start
	number := int(events) + 1
	var read int64
	finish := func(done *segment) error {
		offset := int64(2*indexBlockBytes) + int64(next.fullSegments)*indexRecordBytes
		if _, err := idx.WriteAt(done.encode(), offset); err != nil {
			return fileError(name+".idx", err)
		}
		next.fullSegments++
		return nil
	}
	for position < size {
		want := min(uint64(len(buffer)), size-position)
		n, err := source.ReadAt(buffer[:want], int64(position))
		if n == 0 && err != nil {
			return read, 0, fileError(name, err)
		}
		read += int64(n)
		position += uint64(n)
		chunk := buffer[:n]
		for {
			end := bytes.IndexByte(chunk, '\n')
			if end < 0 {
				break
			}
			lineBytes := chunk[:end]
			if len(carry) > 0 {
				lineBytes = append(carry, chunk[:end]...)
				carry = nil
			}
			chunk = chunk[end+1:]
			lineSize := uint64(len(lineBytes)) + 1
			line, err := scanLine(name, number, lineBytes)
			if err != nil {
				return read, 0, err
			}
			if events == 0 {
				if line.event != "log.open" {
					return read, 0, fmt.Errorf("%s: the first line is not log.open: %s", name, jsString(line.event))
				}
				schema, err := schemaOf(name, lineBytes)
				if err != nil {
					return read, 0, err
				}
				if schema != eventSchema {
					return read, 0, fmt.Errorf("%s: schema %d is not %d", name, schema, eventSchema)
				}
				next.headLen = uint32(lineSize)
				next.headHash = fnv1a(append(append([]byte(nil), lineBytes...), '\n'))
				next.firstSeq = uint64(line.seq)
			}
			acc.add(line, lineSize)
			next.lastSeq = uint64(line.seq)
			events++
			number++
			lineStart += lineSize
			if acc.events == indexSegmentEvents {
				if err := finish(acc); err != nil {
					return read, 0, err
				}
				acc = newSegment(lineStart)
			}
		}
		if len(chunk) > 0 {
			carry = append(carry, chunk...)
			if len(carry) > indexLineLimit {
				return read, 0, fmt.Errorf("%s:%d: the line is over %d bytes", name, number, indexLineLimit)
			}
		}
	}
	if acc.events > 0 {
		next.tail = acc
	}
	next.events = events
	next.indexedBytes = lineStart
	next.sourceSize, next.sourceMtimeNs = size, mtime
	next.generation = state.generation + 1
	if _, err := idx.WriteAt(next.encode(), int64(next.generation%2)*indexBlockBytes); err != nil {
		return read, 0, fileError(name+".idx", err)
	}
	return read, int64(events - firstEvent), nil
}

// schemaOf reads the schema number of a log.open line.
func schemaOf(name string, raw []byte) (int64, error) {
	row, err := rowOf(name, 1, string(raw))
	if err != nil {
		return 0, err
	}
	schema, present := row.fields.get("schema")
	n, integer := isInteger(schema)
	if !present || !integer {
		text := "undefined"
		if present {
			text = stringify(schema, true)
			if number, ok := schema.(json.Number); ok {
				text = number.String()
			}
		}
		return 0, fmt.Errorf("%s: schema %s is not %d", name, text, eventSchema)
	}
	return n, nil
}

// LogIndexInfo is what the state block of an index says.
type LogIndexInfo struct {
	Events, IndexedBytes, SourceSize int64
	FullSegments, TailEvents         int
	FirstSeq, LastSeq                int64
}

// ReadLogIndex reads the state of the index of the event file at path without updating it. It is an error when the index has no
// valid state block.
func ReadLogIndex(path string) (LogIndexInfo, error) {
	data, err := os.ReadFile(path + ".idx")
	if err != nil {
		return LogIndexInfo{}, fileError(path+".idx", err)
	}
	index, err := parseIndex(logDisplayName(path)+".idx", data)
	if err != nil {
		return LogIndexInfo{}, err
	}
	if !index.exists {
		return LogIndexInfo{}, fmt.Errorf("%s: the index has no state block", logDisplayName(path)+".idx")
	}
	info := LogIndexInfo{
		Events: int64(index.state.events), IndexedBytes: int64(index.state.indexedBytes), SourceSize: int64(index.state.sourceSize),
		FullSegments: int(index.state.fullSegments), FirstSeq: int64(index.state.firstSeq), LastSeq: int64(index.state.lastSeq),
	}
	if index.state.tail != nil {
		info.TailEvents = int(index.state.tail.events)
	}
	return info, nil
}

// RotateLogIndexes runs rotate, which renames the generations of the event file at path (the file becomes generation 1, the
// generations move up and the one beyond `generations` is removed), and moves the index files with them. It first brings the
// index of the file up to date while it holds the lock of that index, so the index of the closed generation is complete. A
// rotate that fails leaves the index files where they are.
func RotateLogIndexes(path string, generations int, rotate func() error) error {
	source, idx, system, err := lockedIndex(path)
	if err != nil {
		return err
	}
	// The lock is held through the renames: the other updaters wait for it and then find the files at their new paths.
	defer unlockIndex(system, idx)
	opened, err := refreshLocked(path, source, idx)
	if err != nil {
		source.Close()
		return err
	}
	if err := opened.close(); err != nil {
		return fileError(path, err)
	}
	if err := rotate(); err != nil {
		return err
	}
	generation := func(n int) string { return fmt.Sprintf("%s.%d.idx", path, n) }
	if err := os.Remove(generation(generations)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fileError(generation(generations), err)
	}
	for n := generations - 1; n >= 1; n-- {
		if err := os.Rename(generation(n), generation(n+1)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fileError(generation(n), err)
		}
	}
	if err := os.Rename(path+".idx", generation(1)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fileError(path+".idx", err)
	}
	return nil
}
