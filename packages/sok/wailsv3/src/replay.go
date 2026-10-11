package sok

// `sok debug replay` (docs/spec/replay.md#command): the events of a session are replayed by the replay executable that an
// installed sidecar declares, and every stored hash of the sidecar and of the page is compared with the replayed one. The
// Rust implementation (packages/sok/tauriv2/src/replay.rs) gives the same output and the same error text.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
)

var (
	screenHashText = regexp.MustCompile(`^[0-9a-f]{64}$`)
	replayRole     = regexp.MustCompile(`^[a-z][a-z0-9]*$`)
)

// ReplayDivergence is the first stored hash that differs from the replayed one.
type ReplayDivergence struct {
	Session string
	// Segment is the boot of the run of the sidecar that produced the screen (docs/spec/replay.md#segments).
	Segment  string
	Sequence int64
	// Layer is the layer of the stored hash: sidecar, or plugin for the page frame record that the plugin of the page writes.
	Layer string
	// Expected is the replayed hash, or none for a page frame that has no frame of the sidecar.
	Expected string
	Found    string
}

func (d ReplayDivergence) Error() string {
	return fmt.Sprintf("replay divergence: session %s segment %s sequence %d layer %s expected %s found %s", d.Session, d.Segment, d.Sequence, d.Layer, d.Expected, d.Found)
}

// ReplayResult counts the frame records that were compared and found equal, the segments of the session and the greatest
// number of event lines that the replay held at once (the lines of one segment).
type ReplayResult struct {
	SidecarFrames, PageFrames int
	Segments, HeldLines       int
}

// replayFrame is a frame record of the session. segment is the boot of the run of the sidecar: of the row for a record of the
// sidecar, and the fields.segment that the page stored for a record of the page, which is empty when it stored none.
type replayFrame struct {
	sequence int64
	hash     string
	layer    string
	segment  string
}

// replayEvent is the part of an event line that the replay reads.
type replayEvent struct {
	Layer   string `json:"layer"`
	Class   string `json:"class"`
	Session string `json:"session"`
	Fields  struct {
		Sequence any `json:"sequence"`
		Hash     any `json:"hash"`
		Segment  any `json:"segment"`
	} `json:"fields"`
}

func replayError(session, format string, args ...any) error {
	return fmt.Errorf("replay session %s: %s", session, fmt.Sprintf(format, args...))
}

// scanReplaySession calls visit for each row of the session in the order of the query, with the sequence of the event (0 when
// it has none). A row of a layer other than sidecar and plugin (the page frame records) is not visited, and neither is a row with a sequence above until.
func scanReplaySession(configDir, session string, until *int64, visit func(row LogRow, event replayEvent, sequence int64) error) error {
	params, err := json.Marshal(map[string]any{"channel": "all", "session": session, "order": "asc", "limit": queryMaxLimit})
	if err != nil {
		return err
	}
	query, err := ParseLogQuery(params)
	if err != nil {
		return err
	}
	for {
		page, err := QueryLogs(configDir, query, nil)
		if err != nil {
			return err
		}
		for _, row := range page.Rows {
			var event replayEvent
			if err := json.Unmarshal(row.Event, &event); err != nil {
				return replayError(session, "%s offset %d: %v", row.File, row.Offset, err)
			}
			if event.Layer == "" {
				return replayError(session, "%s offset %d: the event has no layer", row.File, row.Offset)
			}
			sequence := int64(0)
			if n, isNumber := event.Fields.Sequence.(float64); isNumber && n >= 1 && n == math.Trunc(n) {
				sequence = int64(n)
			}
			if sequence != 0 && until != nil && sequence > *until {
				continue
			}
			if event.Layer != "sidecar" && event.Layer != "plugin" {
				continue
			}
			if err := visit(row, event, sequence); err != nil {
				return err
			}
		}
		if page.Next == nil {
			return nil
		}
		query.After = page.Next
	}
}

// ReplayLogs replays the session from the event files of the configuration directory and compares the frame records. until
// is the greatest sequence that is replayed and compared; nil replays the whole session. A stored hash that differs from the
// replayed one is returned as a ReplayDivergence.
//
// A session is a list of segments, one for each run (boot) of the sidecar, because the sequence restarts at 1 in a new run
// (docs/spec/replay.md#segments). The first scan reads the frame records and the boots; the second scan collects the event lines of
// one segment at a time, runs the replay executable on them and compares that segment, so the lines of the session are never
// held together.
func ReplayLogs(configDir, session string, until *int64) (ReplayResult, error) {
	var result ReplayResult
	roles := map[string]bool{}
	var segments []string
	var frames []replayFrame
	err := scanReplaySession(configDir, session, until, func(row LogRow, event replayEvent, sequence int64) error {
		if event.Layer == "sidecar" {
			roles[row.Role] = true
			if len(segments) == 0 || segments[len(segments)-1] != row.Boot {
				if slices.Contains(segments, row.Boot) {
					return replayError(session, "the sidecar events of the segments %s and %s are interleaved", row.Boot, segments[len(segments)-1])
				}
				segments = append(segments, row.Boot)
			}
		}
		if event.Class != "frame" {
			return nil
		}
		hash, isText := event.Fields.Hash.(string)
		if sequence == 0 || !isText {
			return replayError(session, "%s offset %d: a frame record needs an integer fields.sequence from 1 and a string fields.hash", row.File, row.Offset)
		}
		if !screenHashText.MatchString(hash) {
			return replayError(session, "sequence %d layer %s: the stored hash is not 64 lowercase hexadecimal characters: %s", sequence, event.Layer, jsString(hash))
		}
		frame := replayFrame{sequence: sequence, hash: hash, layer: event.Layer}
		if event.Layer == "sidecar" {
			frame.segment = row.Boot
		} else if stored, present := event.Fields.Segment.(string); present {
			frame.segment = stored
		} else if event.Fields.Segment != nil {
			return replayError(session, "the page frame record at sequence %d has a fields.segment that is not text", sequence)
		}
		frames = append(frames, frame)
		return nil
	})
	if err != nil {
		return result, err
	}
	if len(segments) == 0 {
		return result, replayError(session, "the event files hold no event of the layer sidecar for it")
	}
	if len(roles) > 1 {
		return result, replayError(session, "sidecar events of more than one role: %s", strings.Join(slices.Sorted(maps.Keys(roles)), ", "))
	}
	role := slices.Collect(maps.Keys(roles))[0]
	if !slices.ContainsFunc(frames, func(f replayFrame) bool { return f.layer == "sidecar" }) {
		return result, replayError(session, "no frame record to compare")
	}
	// A page frame names the segment of the screen message it received.
	for _, frame := range frames {
		if frame.layer != "plugin" {
			continue
		}
		switch {
		case frame.segment == "":
			return result, replayError(session, "the page frame record at sequence %d has no fields.segment", frame.sequence)
		case !slices.Contains(segments, frame.segment):
			return result, replayError(session, "the page frame record at sequence %d names the segment %s, which the session does not have", frame.sequence, frame.segment)
		}
	}
	folder, executable, kinds, err := replayExecutable(configDir, session, role)
	if err != nil {
		return result, err
	}
	result.Segments = len(segments)
	next := 0
	var lines [][]byte
	// finish replays and compares the segments up to and including the segment index that has the lines held now.
	finish := func(through int) error {
		for ; next <= through; next++ {
			if err := compareReplaySegment(session, segments[next], frames, folder, executable, kinds, lines, &result); err != nil {
				return err
			}
			lines = nil
		}
		return nil
	}
	err = scanReplaySession(configDir, session, until, func(row LogRow, event replayEvent, sequence int64) error {
		if event.Layer != "sidecar" {
			return nil
		}
		index := slices.Index(segments, row.Boot)
		if index < 0 {
			return replayError(session, "the event files changed during the replay: the segment %s was not there before", row.Boot)
		}
		if err := finish(index - 1); err != nil {
			return err
		}
		lines = append(lines, row.Event)
		result.HeldLines = max(result.HeldLines, len(lines))
		return nil
	})
	if err != nil {
		return result, err
	}
	return result, finish(len(segments) - 1)
}

// compareReplaySegment runs the replay executable on the lines of the segment and compares the frame records of the segment in
// the order of sequence, a record of the sidecar before a record of the page. A segment with no frame record of the sidecar
// runs nothing: its page frame records have none to equal.
func compareReplaySegment(session, segment string, all []replayFrame, folder, executable string, kinds map[string]string, lines [][]byte, result *ReplayResult) error {
	// The replay inputs of the segment follow the rules of a session before the executable applies them (docs/spec/replay.md#command).
	var inputs []ReplayInput
	for _, line := range lines {
		var event struct {
			Event  string          `json:"event"`
			Fields json.RawMessage `json:"fields"`
		}
		if err := json.Unmarshal(line, &event); err != nil {
			return replayError(session, "segment %s: %v", segment, err)
		}
		if kind, input := kinds[event.Event]; input {
			inputs = append(inputs, ReplayInput{Kind: kind, Fields: event.Fields})
		}
	}
	if problem := ReplaySessionProblem(inputs); problem != "" {
		return replayError(session, "segment %s: %s", segment, problem)
	}
	var frames []replayFrame
	for _, frame := range all {
		if frame.segment == segment {
			frames = append(frames, frame)
		}
	}
	sort.SliceStable(frames, func(i, j int) bool {
		if frames[i].sequence != frames[j].sequence {
			return frames[i].sequence < frames[j].sequence
		}
		return frames[i].layer == "sidecar" && frames[j].layer != "sidecar"
	})
	var replayed map[int64]string
	if slices.ContainsFunc(frames, func(f replayFrame) bool { return f.layer == "sidecar" }) {
		var input bytes.Buffer
		for _, line := range lines {
			input.Write(line)
			input.WriteByte('\n')
		}
		var err error
		if replayed, err = runReplayExecutable(session, folder, executable, input.Bytes()); err != nil {
			return err
		}
	}
	stored := map[int64]bool{}
	for _, frame := range frames {
		hash, reported := replayed[frame.sequence]
		if frame.layer == "sidecar" {
			if !reported {
				return replayError(session, "the replay executable reported no hash for the frame record at sequence %d", frame.sequence)
			}
			stored[frame.sequence] = true
			if hash != frame.hash {
				return ReplayDivergence{Session: session, Segment: segment, Sequence: frame.sequence, Layer: "sidecar", Expected: hash, Found: frame.hash}
			}
			result.SidecarFrames++
			continue
		}
		if !stored[frame.sequence] {
			return ReplayDivergence{Session: session, Segment: segment, Sequence: frame.sequence, Layer: "plugin", Expected: "none", Found: frame.hash}
		}
		if hash != frame.hash {
			return ReplayDivergence{Session: session, Segment: segment, Sequence: frame.sequence, Layer: "plugin", Expected: hash, Found: frame.hash}
		}
		result.PageFrames++
	}
	return nil
}

// replayExecutable finds the installed sidecar that declares the replay role and returns its folder, the declared path of its
// replay executable and the kind of each replay input by the name of its event (replay.inputs).
func replayExecutable(configDir, session, role string) (string, string, map[string]string, error) {
	installed, err := ReadInstalled(configDir)
	if err != nil {
		return "", "", nil, err
	}
	var declaring []string
	var folder, executable string
	var kinds map[string]string
	for _, name := range slices.Sorted(maps.Keys(installed.Sidecars)) {
		dir := filepath.Join(configDir, installed.Sidecars[name].Path)
		file := filepath.Join(dir, "sidecar.json")
		data, err := os.ReadFile(file)
		if err != nil {
			return "", "", nil, fileError(file, err)
		}
		var declaration struct {
			Replay *struct {
				Role       string            `json:"role"`
				Executable string            `json:"executable"`
				Inputs     map[string]string `json:"inputs"`
			} `json:"replay"`
		}
		if err := json.Unmarshal(data, &declaration); err != nil {
			return "", "", nil, fmt.Errorf("%s: %w", file, err)
		}
		if declaration.Replay == nil || declaration.Replay.Role != role {
			continue
		}
		path := declaration.Replay.Executable
		if !replayRole.MatchString(role) || path == "" || strings.HasPrefix(path, "/") || slices.Contains(strings.Split(path, "/"), "..") {
			return "", "", nil, fmt.Errorf("%s: replay must have a lowercase word role and an executable path inside the package", file)
		}
		// The kind of a replay input is the sidecar's choice of event name, which replay.inputs declares (docs/spec/sidecars.md).
		kinds = map[string]string{}
		for _, kind := range ReplayInputKinds {
			event := declaration.Replay.Inputs[kind]
			if !strings.HasPrefix(event, "sidecar.") {
				return "", "", nil, fmt.Errorf("%s: replay.inputs must name the event of the layer sidecar of each kind of replay input; %s is %q", file, kind, event)
			}
			kinds[event] = kind
		}
		declaring = append(declaring, name)
		folder, executable = dir, path
	}
	switch len(declaring) {
	case 0:
		return "", "", nil, replayError(session, "no installed sidecar declares the replay role %s", role)
	case 1:
		return folder, executable, kinds, nil
	}
	return "", "", nil, replayError(session, "the sidecars %s declare the replay role %s", strings.Join(declaring, ", "), role)
}

// runReplayExecutable runs the replay executable in the folder of its sidecar with the lines on its standard input and reads
// one {"sequence", "hash"} object per line of its standard output.
func runReplayExecutable(session, folder, executable string, input []byte) (map[int64]string, error) {
	command := exec.Command(filepath.Join(folder, filepath.FromSlash(executable)))
	command.Dir = folder
	command.Stdin = bytes.NewReader(input)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err != nil {
		var exited *exec.ExitError
		if !errors.As(err, &exited) {
			return nil, replayError(session, "%s: %s", executable, osReason(err))
		}
		// silent: the lines after the first one of the standard error are not part of the reason that the error states.
		reason, _, _ := strings.Cut(strings.TrimSpace(stderr.String()), "\n")
		if exited.ExitCode() < 0 {
			return nil, replayError(session, "%s was ended by a signal: %s", executable, reason)
		}
		return nil, replayError(session, "%s exited with status %d: %s", executable, exited.ExitCode(), reason)
	}
	hashes := map[int64]string{}
	text := stdout.String()
	for index, line := range strings.Split(strings.TrimSuffix(text, "\n"), "\n") {
		if text == "" {
			break
		}
		invalid := replayError(session, "replay output line %d is not {\"sequence\": <integer>, \"hash\": <64 lowercase hexadecimal characters>}: %s", index+1, line)
		value, err := parseJSON(line)
		object, isObject := value.(eventObject)
		if err != nil || !isObject || len(object) != 2 {
			return nil, invalid
		}
		sequenceValue, hasSequence := object.get("sequence")
		hashValue, hasHash := object.get("hash")
		sequenceNumber, isNumber := sequenceValue.(json.Number)
		hash, isText := hashValue.(string)
		if !hasSequence || !hasHash || !isNumber || !isText || !screenHashText.MatchString(hash) {
			return nil, invalid
		}
		number, err := strconv.ParseFloat(sequenceNumber.String(), 64)
		if err != nil || number < 1 || number != math.Trunc(number) {
			return nil, invalid
		}
		sequence := int64(number)
		if earlier, repeated := hashes[sequence]; repeated && earlier != hash {
			return nil, replayError(session, "the replay executable reported two hashes for the sequence %d", sequence)
		}
		hashes[sequence] = hash
	}
	return hashes, nil
}

// runReplay runs `sok debug replay <session> [--until <sequence>]`.
func runReplay(a arguments, stdout io.Writer, options Options) error {
	session, err := a.positional(2, "session")
	if err != nil {
		return err
	}
	if len(a.positionals) > 3 {
		return usage("unexpected argument %s", a.positionals[3])
	}
	var until *int64
	if value, given := a.values["until"]; given {
		n, err := strconv.ParseInt(value, 10, 64)
		if err != nil || n < 0 {
			return usage("--until must be a non-negative integer, found %s", jsString(value))
		}
		until = &n
	}
	configDir, err := configDirOf(a.values, options)
	if err != nil {
		return err
	}
	result, err := ReplayLogs(configDir, session, until)
	var diverged ReplayDivergence
	if errors.As(err, &diverged) {
		if log := runLog.Load(); log != nil {
			log.Emit(LevelError, "sok.replay.divergence", map[string]any{"session": diverged.Session, "segment": diverged.Segment, "sequence": diverged.Sequence, "layer": diverged.Layer, "expected": diverged.Expected, "found": diverged.Found})
		}
	}
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "replay session %s: %d sidecar frames and %d page frames equal in %d segments\n", session, result.SidecarFrames, result.PageFrames, result.Segments)
	return err
}
