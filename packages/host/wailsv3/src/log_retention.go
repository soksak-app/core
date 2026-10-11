package host

// The retention of the event files (docs/spec/logging.md#retention). The files of the runs in logs/ stay within a stated bound. When
// they pass it, the oldest runs are removed whole, one run after another, until the files are within the bound or only the run of
// the writer and the pinned runs are left. A run whose name has a `.keep` file beside it is pinned and never removed. Every removal
// is the event `log.pruned`, so no file disappears without a record.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

// hostRetentionBytes is the bound of the files of the runs in logs/: 6 GiB.
const hostRetentionBytes = 6 << 30

// runFile is the name of a file of a run: `<role>-<boot>` and then an event file (`.jsonl`, `.debug.jsonl`, a generation `.<n>`, an
// index `.idx`), the standard error, the crash output or the pin `.keep`.
var runFile = regexp.MustCompile(`^([a-z][a-z0-9]*-[0-9A-Za-z_-]+)\.(?:(?:debug\.)?jsonl(?:\.[1-9][0-9]*)?(?:\.idx)?|stderr|crash|keep)$`)

// runFiles are the files of one run.
type runFiles struct {
	name   string
	files  []string
	sizes  []int64
	total  int64
	newest time.Time
	pinned bool
}

// prunedRuns says what a retention pass removed.
type prunedRuns struct {
	files     int
	bytes     int64
	runs      []string
	fromUs    int64
	toUs      int64
	remaining int64
}

// pruneRuns removes the oldest runs in directory while the files of the runs pass bound. The run `current` and the pinned runs stay.
// The age of a run is the newest modification time of its files. A failure of a removal or of a read is returned with the others, and
// the pass goes on with the next file.
func pruneRuns(directory, current string, bound int64) (prunedRuns, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return prunedRuns{}, err
	}
	runs := map[string]*runFiles{}
	var total int64
	var failures []error
	for _, entry := range entries {
		match := runFile.FindStringSubmatch(entry.Name())
		if match == nil || entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			failures = append(failures, err)
			continue
		}
		run := runs[match[1]]
		if run == nil {
			run = &runFiles{name: match[1]}
			runs[match[1]] = run
		}
		run.files = append(run.files, filepath.Join(directory, entry.Name()))
		run.sizes = append(run.sizes, info.Size())
		run.total += info.Size()
		total += info.Size()
		if info.ModTime().After(run.newest) {
			run.newest = info.ModTime()
		}
		if filepath.Ext(entry.Name()) == ".keep" {
			run.pinned = true
		}
	}
	result := prunedRuns{remaining: total}
	if total <= bound {
		return result, nil
	}
	var candidates []*runFiles
	for _, run := range runs {
		if run.name != current && !run.pinned {
			candidates = append(candidates, run)
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		if !candidates[i].newest.Equal(candidates[j].newest) {
			return candidates[i].newest.Before(candidates[j].newest)
		}
		return candidates[i].name < candidates[j].name
	})
	for _, run := range candidates {
		if result.remaining <= bound {
			break
		}
		for index, path := range run.files {
			if from, to, found, err := eventTimeRange(path); err != nil {
				failures = append(failures, err)
			} else if found {
				if result.fromUs == 0 || from < result.fromUs {
					result.fromUs = from
				}
				if to > result.toUs {
					result.toUs = to
				}
			}
			if err := os.Remove(path); err != nil {
				failures = append(failures, err)
				continue
			}
			result.files++
			result.bytes += run.sizes[index]
			result.remaining -= run.sizes[index]
		}
		result.runs = append(result.runs, run.name)
	}
	return result, errors.Join(failures...)
}

// eventTimeRange reads the `ts_us` of the first and of the last line of an event file. A file that is no event file (the standard error,
// the crash output, an index, a pin) has no range. An event file that is empty has none either; a line that is no event is an error.
func eventTimeRange(path string) (from, to int64, found bool, err error) {
	if !eventFileName.MatchString(filepath.Base(path)) {
		return 0, 0, false, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return 0, 0, false, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return 0, 0, false, err
	}
	if info.Size() == 0 {
		return 0, 0, false, nil
	}
	first, err := bufio.NewReaderSize(file, 64<<10).ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return 0, 0, false, fmt.Errorf("%s: %w", path, err)
	}
	if from, err = timeOf(path, first); err != nil {
		return 0, 0, false, err
	}
	// The last line lies in the last 64 KiB of a file whose lines are far smaller than that, except an event cut at its bound.
	tail := make([]byte, min(info.Size(), 64<<10))
	if _, err := file.ReadAt(tail, info.Size()-int64(len(tail))); err != nil && !errors.Is(err, io.EOF) {
		return 0, 0, false, fmt.Errorf("%s: %w", path, err)
	}
	tail = bytes.TrimRight(tail, "\n")
	if to, err = timeOf(path, tail[bytes.LastIndexByte(tail, '\n')+1:]); err != nil {
		return 0, 0, false, err
	}
	return from, to, true, nil
}

// eventFileName is the name of an event file of a run: the file, its debug file and their generations.
var eventFileName = regexp.MustCompile(`^[a-z][a-z0-9]*-[0-9A-Za-z_-]+\.(?:debug\.)?jsonl(?:\.[1-9][0-9]*)?$`)

// timeOf reads the `ts_us` of one line of an event file.
func timeOf(path string, line []byte) (int64, error) {
	var event struct {
		TsUs int64 `json:"ts_us"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(line), &event); err != nil || event.TsUs <= 0 {
		return 0, fmt.Errorf("%s: a line with no ts_us in %q", path, string(bytes.TrimSpace(line))[:min(len(bytes.TrimSpace(line)), 80)])
	}
	return event.TsUs, nil
}

// fields is the text of the event log.pruned.
func (p prunedRuns) fields(bound int64) json.RawMessage {
	runs := p.runs
	if runs == nil {
		runs = []string{}
	}
	text, err := json.Marshal(map[string]any{"logs": p.files, "bytes": p.bytes, "runs": runs, "from_us": p.fromUs, "to_us": p.toUs, "remaining": p.remaining, "bound": bound})
	if err != nil {
		// Numbers and text serialize without failure, so this is a defect of the serializer.
		fmt.Fprintf(os.Stderr, "event writer: log.pruned cannot be serialized: %v\n", err)
		return json.RawMessage(`{}`)
	}
	return text
}
