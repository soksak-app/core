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
	Session  string
	Sequence int64
	// Layer is the layer of the stored hash: sidecar or page.
	Layer string
	// Expected is the replayed hash, or none for a page frame that has no frame of the sidecar.
	Expected string
	Found    string
}

func (d ReplayDivergence) Error() string {
	return fmt.Sprintf("replay divergence: session %s sequence %d layer %s expected %s found %s", d.Session, d.Sequence, d.Layer, d.Expected, d.Found)
}

// ReplayResult counts the frame records that were compared and found equal.
type ReplayResult struct {
	SidecarFrames, PageFrames int
}

// replayFrame is a frame record of the session.
type replayFrame struct {
	sequence int64
	hash     string
	layer    string
}

// replayEvent is the part of an event line that the replay reads.
type replayEvent struct {
	Layer   string `json:"layer"`
	Class   string `json:"class"`
	Session string `json:"session"`
	Fields  struct {
		Sequence any `json:"sequence"`
		Hash     any `json:"hash"`
	} `json:"fields"`
}

func replayError(session, format string, args ...any) error {
	return fmt.Errorf("replay session %s: %s", session, fmt.Sprintf(format, args...))
}

// ReplayLogs replays the session from the event files of the configuration directory and compares the frame records. until
// is the greatest sequence that is replayed and compared; nil replays the whole session. A stored hash that differs from the
// replayed one is returned as a ReplayDivergence.
func ReplayLogs(configDir, session string, until *int64) (ReplayResult, error) {
	var result ReplayResult
	var sidecarLines []json.RawMessage
	roles := map[string]bool{}
	var frames []replayFrame
	params, err := json.Marshal(map[string]any{"channel": "all", "session": session, "order": "asc", "limit": queryMaxLimit})
	if err != nil {
		return result, err
	}
	query, err := ParseLogQuery(params)
	if err != nil {
		return result, err
	}
	for {
		page, err := QueryLogs(configDir, query, nil)
		if err != nil {
			return result, err
		}
		for _, row := range page.Rows {
			var event replayEvent
			if err := json.Unmarshal(row.Event, &event); err != nil {
				return result, replayError(session, "%s offset %d: %v", row.File, row.Offset, err)
			}
			if event.Layer == "" {
				return result, replayError(session, "%s offset %d: the event has no layer", row.File, row.Offset)
			}
			sequence, hasSequence := int64(0), false
			if n, isNumber := event.Fields.Sequence.(float64); isNumber && n >= 1 && n == math.Trunc(n) {
				sequence, hasSequence = int64(n), true
			}
			if hasSequence && until != nil && sequence > *until {
				continue
			}
			switch event.Layer {
			case "sidecar":
				roles[row.Role] = true
				sidecarLines = append(sidecarLines, row.Event)
			case "page":
			default:
				continue
			}
			if event.Class != "frame" {
				continue
			}
			hash, isText := event.Fields.Hash.(string)
			if !hasSequence || !isText {
				return result, replayError(session, "%s offset %d: a frame record needs an integer fields.sequence from 1 and a string fields.hash", row.File, row.Offset)
			}
			if !screenHashText.MatchString(hash) {
				return result, replayError(session, "sequence %d layer %s: the stored hash is not 64 lowercase hexadecimal characters: %s", sequence, event.Layer, jsString(hash))
			}
			frames = append(frames, replayFrame{sequence: sequence, hash: hash, layer: event.Layer})
		}
		if page.Next == nil {
			break
		}
		query.After = page.Next
	}
	if len(sidecarLines) == 0 {
		return result, replayError(session, "the event files hold no event of the layer sidecar for it")
	}
	if len(roles) > 1 {
		names := make([]string, 0, len(roles))
		for role := range roles {
			names = append(names, role)
		}
		sort.Strings(names)
		return result, replayError(session, "sidecar events of more than one role: %s", strings.Join(names, ", "))
	}
	var role string
	for name := range roles {
		role = name
	}
	if !slices.ContainsFunc(frames, func(f replayFrame) bool { return f.layer == "sidecar" }) {
		return result, replayError(session, "no frame record to compare")
	}
	folder, executable, err := replayExecutable(configDir, session, role)
	if err != nil {
		return result, err
	}
	var input bytes.Buffer
	for _, line := range sidecarLines {
		input.Write(line)
		input.WriteByte('\n')
	}
	replayed, err := runReplayExecutable(session, folder, executable, input.Bytes())
	if err != nil {
		return result, err
	}
	// The records are compared in the order of sequence, a record of the sidecar before a record of the page.
	sort.SliceStable(frames, func(i, j int) bool {
		if frames[i].sequence != frames[j].sequence {
			return frames[i].sequence < frames[j].sequence
		}
		return frames[i].layer == "sidecar" && frames[j].layer != "sidecar"
	})
	stored := map[int64]bool{}
	for _, frame := range frames {
		hash, reported := replayed[frame.sequence]
		if frame.layer == "sidecar" {
			if !reported {
				return result, replayError(session, "the replay executable reported no hash for the frame record at sequence %d", frame.sequence)
			}
			stored[frame.sequence] = true
			if hash != frame.hash {
				return result, ReplayDivergence{Session: session, Sequence: frame.sequence, Layer: "sidecar", Expected: hash, Found: frame.hash}
			}
			result.SidecarFrames++
			continue
		}
		if !stored[frame.sequence] {
			return result, ReplayDivergence{Session: session, Sequence: frame.sequence, Layer: "page", Expected: "none", Found: frame.hash}
		}
		if hash != frame.hash {
			return result, ReplayDivergence{Session: session, Sequence: frame.sequence, Layer: "page", Expected: hash, Found: frame.hash}
		}
		result.PageFrames++
	}
	return result, nil
}

// replayExecutable finds the installed sidecar that declares the replay role and returns its folder and the declared path of
// its replay executable.
func replayExecutable(configDir, session, role string) (string, string, error) {
	installed, err := ReadInstalled(configDir)
	if err != nil {
		return "", "", err
	}
	var declaring []string
	var folder, executable string
	for _, name := range slices.Sorted(maps.Keys(installed.Sidecars)) {
		dir := filepath.Join(configDir, installed.Sidecars[name].Path)
		file := filepath.Join(dir, "sidecar.json")
		data, err := os.ReadFile(file)
		if err != nil {
			return "", "", fileError(file, err)
		}
		var declaration struct {
			Replay *struct {
				Role       string `json:"role"`
				Executable string `json:"executable"`
			} `json:"replay"`
		}
		if err := json.Unmarshal(data, &declaration); err != nil {
			return "", "", fmt.Errorf("%s: %w", file, err)
		}
		if declaration.Replay == nil || declaration.Replay.Role != role {
			continue
		}
		path := declaration.Replay.Executable
		if !replayRole.MatchString(role) || path == "" || strings.HasPrefix(path, "/") || slices.Contains(strings.Split(path, "/"), "..") {
			return "", "", fmt.Errorf("%s: replay must have a lowercase word role and an executable path inside the package", file)
		}
		declaring = append(declaring, name)
		folder, executable = dir, path
	}
	switch len(declaring) {
	case 0:
		return "", "", replayError(session, "no installed sidecar declares the replay role %s", role)
	case 1:
		return folder, executable, nil
	}
	return "", "", replayError(session, "the sidecars %s declare the replay role %s", strings.Join(declaring, ", "), role)
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
			log.Emit(LevelError, "sok.replay.divergence", map[string]any{"session": diverged.Session, "sequence": diverged.Sequence, "layer": diverged.Layer, "expected": diverged.Expected, "found": diverged.Found})
		}
	}
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(stdout, "replay session %s: %d sidecar frames and %d page frames equal\n", session, result.SidecarFrames, result.PageFrames)
	return err
}
