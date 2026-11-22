package host

// The host calls of a declared program run (docs/spec/native-surfaces.md#program-runs). The main page passes a view call
// runtime.program.run to programRun, and its cancel to programCancel. The declaration is the programs member of the view start
// values, which the workbench validated when it read plugin.json (docs/spec/plugins.md#pluginjson).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"sync"
	"unicode"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// programRunsPerSurface is the number of runs that a surface holds open at once.
const programRunsPerSurface = 4

// ProgramRunRequest is the argument of programRun: the view surface, the identifier of the view call, the declared name and the
// argument texts.
type ProgramRunRequest struct {
	Surface string   `json:"surface"`
	ID      uint64   `json:"id"`
	Name    string   `json:"name"`
	Args    []string `json:"args"`
}

// ProgramCancelRequest is the argument of programCancel: the surface and the identifier of the view call whose run ends.
type ProgramCancelRequest struct {
	Surface string `json:"surface"`
	ID      uint64 `json:"id"`
}

// ProgramTruncated tells, for each stream, whether the run discarded bytes beyond the bound.
type ProgramTruncated struct {
	Stdout bool `json:"stdout"`
	Stderr bool `json:"stderr"`
}

// ProgramRunReply is the answer of programRun to the view call of a program that exited.
type ProgramRunReply struct {
	Code      *int             `json:"code"`
	Stdout    string           `json:"stdout"`
	Stderr    string           `json:"stderr"`
	Truncated ProgramTruncated `json:"truncated"`
}

// programSlot is one slot of the args of a declared program: a literal text or a pattern that the whole argument matches.
type programSlot struct {
	text      string
	pattern   string
	isPattern bool
}

// programRunSpec is a checked run: the declared program, its working directory and the argument texts that its slots accept.
type programRunSpec struct {
	Program   string
	Directory string
	Args      []string
}

// programDeclaration is one declared program of a plugin: the program text and the slots of its arguments.
type programDeclaration struct {
	Program string
	Slots   []programSlot
}

// isJSONText reports whether raw is a JSON string, so that a null or a number is not read as a text.
func isJSONText(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '"'
}

// parseProgramDeclarations reads the programs declaration of a view start: each member names a program and its value has the members
// program and args. It checks every member at the boundary and refuses an invalid one with the text of the Rust host for the same input
// (docs/spec/host-contract.md, program.run.declaration-is-checked-at-the-boundary).
func parseProgramDeclarations(raw json.RawMessage) (map[string]programDeclaration, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil || object == nil {
		return nil, fmt.Errorf("programs is not an object")
	}
	names := make([]string, 0, len(object))
	for name := range object {
		names = append(names, name)
	}
	slices.Sort(names)
	declarations := make(map[string]programDeclaration, len(object))
	for _, name := range names {
		if !sok.ProgramNameValid(name) {
			return nil, fmt.Errorf("programs.%s name is not of the form [a-z][a-z0-9-]*", name)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(object[name], &fields); err != nil || fields == nil {
			return nil, fmt.Errorf("programs.%s is not an object", name)
		}
		members := make([]string, 0, len(fields))
		for member := range fields {
			members = append(members, member)
		}
		slices.Sort(members)
		for _, member := range members {
			if member != "program" && member != "args" {
				return nil, fmt.Errorf("programs.%s has an unknown member %s", name, member)
			}
		}
		var program string
		if !isJSONText(fields["program"]) || json.Unmarshal(fields["program"], &program) != nil ||
			program == "" || len(program) > sok.ProgramTextMaxBytes || strings.ContainsFunc(program, unicode.IsControl) {
			return nil, fmt.Errorf("programs.%s program is not a text of 1 to 255 bytes without a control character", name)
		}
		if strings.HasPrefix(program, sok.ProgramPluginPrefix) && !sok.ProgramPluginPathValid(strings.TrimPrefix(program, sok.ProgramPluginPrefix)) {
			return nil, fmt.Errorf("programs.%s program plugin path must be a relative path of / separated segments that are not empty, . or .., without a backslash", name)
		}
		var slots []programSlot
		if raw, present := fields["args"]; present {
			var items []json.RawMessage
			if err := json.Unmarshal(raw, &items); err != nil || items == nil {
				return nil, fmt.Errorf("programs.%s args is not an array", name)
			}
			if len(items) > sok.ProgramSlotsMax {
				return nil, fmt.Errorf("programs.%s args has more than %d slots", name, sok.ProgramSlotsMax)
			}
			for index, item := range items {
				slot, err := parseDeclaredSlot(name, index, item)
				if err != nil {
					return nil, err
				}
				slots = append(slots, slot)
			}
		}
		declarations[name] = programDeclaration{Program: program, Slots: slots}
	}
	return declarations, nil
}

// parseDeclaredSlot reads argument slot index of the program name: a text, or an object whose single member pattern is a regular
// expression of at most ProgramPatternMaxBytes bytes that compiles.
func parseDeclaredSlot(name string, index int, raw json.RawMessage) (programSlot, error) {
	if isJSONText(raw) {
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return programSlot{}, fmt.Errorf("programs.%s args.%d is neither a text nor an object with the single member pattern", name, index)
		}
		return programSlot{text: text}, nil
	}
	var object map[string]json.RawMessage
	var pattern string
	if err := json.Unmarshal(raw, &object); err != nil || len(object) != 1 || !isJSONText(object["pattern"]) ||
		json.Unmarshal(object["pattern"], &pattern) != nil {
		return programSlot{}, fmt.Errorf("programs.%s args.%d is neither a text nor an object with the single member pattern", name, index)
	}
	if len(pattern) > sok.ProgramPatternMaxBytes {
		return programSlot{}, fmt.Errorf("programs.%s pattern is longer than %d bytes", name, sok.ProgramPatternMaxBytes)
	}
	if _, err := regexp.Compile(pattern); err != nil {
		return programSlot{}, fmt.Errorf("programs.%s pattern does not compile: %w", name, err)
	}
	return programSlot{pattern: pattern, isPattern: true}, nil
}

// programMatches reports whether arg is accepted by slot. A pattern is compiled as sok.ProgramPatternSource: it must match the whole
// argument, and a pattern that does not compile is an error.
func programMatches(slot programSlot, arg string) (bool, error) {
	if !slot.isPattern {
		return arg == slot.text, nil
	}
	expression, err := regexp.Compile(sok.ProgramPatternSource(slot.pattern))
	if err != nil {
		return false, err
	}
	return expression.MatchString(arg), nil
}

// checkProgramRun checks a run request against the programs declaration of the view start values and the project of the surface.
// It refuses in the order of the Rust host: a window without a project, a name that the declaration lacks, an argument count that
// differs from the slots, an argument that its slot does not accept, and a pattern that does not compile. Each refusal is the text of
// docs/spec/native-surfaces.md#program-runs.
func checkProgramRun(declarations json.RawMessage, plugin, name string, args []string, project *SurfaceProject) (programRunSpec, error) {
	if project == nil {
		return programRunSpec{}, fmt.Errorf("program run: the window shows no project")
	}
	declared := map[string]programDeclaration{}
	if declarations != nil {
		var all map[string]json.RawMessage
		if err := json.Unmarshal(declarations, &all); err != nil {
			return programRunSpec{}, fmt.Errorf("the declarations are not an object")
		}
		if raw, ok := all["programs"]; ok {
			parsed, err := parseProgramDeclarations(raw)
			if err != nil {
				return programRunSpec{}, err
			}
			declared = parsed
		}
	}
	decl, ok := declared[name]
	if !ok {
		return programRunSpec{}, fmt.Errorf("program %s is not declared by %s", name, plugin)
	}
	if len(decl.Slots) != len(args) {
		return programRunSpec{}, fmt.Errorf("program %s takes %d arguments, %d given", name, len(decl.Slots), len(args))
	}
	for index, slot := range decl.Slots {
		if !slot.isPattern {
			if args[index] != slot.text {
				return programRunSpec{}, fmt.Errorf("program %s argument %d %s does not equal its text", name, index+1, args[index])
			}
			continue
		}
		matched, err := programMatches(slot, args[index])
		if err != nil {
			return programRunSpec{}, fmt.Errorf("program %s pattern does not compile: %w", name, err)
		}
		if !matched {
			return programRunSpec{}, fmt.Errorf("program %s argument %d %s does not match its pattern", name, index+1, args[index])
		}
	}
	if args == nil {
		args = []string{}
	}
	return programRunSpec{Program: decl.Program, Directory: project.Root, Args: args}, nil
}

// programRunKey names one open run: the surface and the identifier of its view call.
type programRunKey struct {
	surface string
	id      uint64
}

// programRuns holds the open runs of a window, with the cancel of each. Its zero value is ready to use.
type programRuns struct {
	mu   sync.Mutex
	open map[programRunKey]context.CancelCauseFunc
}

// begin records a run as open. It refuses a run whose identifier is open already, and the run that would exceed the limit of
// programRunsPerSurface open runs of its surface.
func (r *programRuns) begin(surface string, id uint64, cancel context.CancelCauseFunc) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.open == nil {
		r.open = map[programRunKey]context.CancelCauseFunc{}
	}
	key := programRunKey{surface, id}
	count := 0
	for other := range r.open {
		if other.surface == surface {
			count++
		}
	}
	if count >= programRunsPerSurface {
		return fmt.Errorf("program run: %d runs are open on surface %s", programRunsPerSurface, surface)
	}
	if _, ok := r.open[key]; ok {
		return fmt.Errorf("program run: call %d is already open on surface %s", id, surface)
	}
	r.open[key] = cancel
	return nil
}

// finish removes a run that ended.
func (r *programRuns) finish(surface string, id uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.open, programRunKey{surface, id})
}

// cancel ends one open run with ProgramCancelled. A run that is not open is left alone.
func (r *programRuns) cancel(surface string, id uint64) {
	r.mu.Lock()
	cancel := r.open[programRunKey{surface, id}]
	r.mu.Unlock()
	if cancel != nil {
		cancel(ProgramCancelled)
	}
}

// end ends every open run of surface with cause.
func (r *programRuns) end(surface string, cause ProgramEnd) {
	r.mu.Lock()
	var cancels []context.CancelCauseFunc
	for key, cancel := range r.open {
		if key.surface == surface {
			cancels = append(cancels, cancel)
		}
	}
	r.mu.Unlock()
	for _, cancel := range cancels {
		cancel(cause)
	}
}

// endAll ends every open run of the window with cause.
func (r *programRuns) endAll(cause ProgramEnd) {
	r.mu.Lock()
	var cancels []context.CancelCauseFunc
	for _, cancel := range r.open {
		cancels = append(cancels, cancel)
	}
	r.mu.Unlock()
	for _, cancel := range cancels {
		cancel(cause)
	}
}

// programView is what a run needs of its view: the plugin, the declarations of its start values and the project of the window.
type programView struct {
	plugin       string
	declarations json.RawMessage
	project      *SurfaceProject
}

// programView reads the view of surface from the lifecycle record. It runs on the main thread, which owns the record.
func (s *Surfaces) programView(surface string) (programView, error) {
	spec := s.viewRecords().specs[surface]
	if spec == nil {
		return programView{}, fmt.Errorf("program run: surface %s has no view", surface)
	}
	return programView{plugin: spec.plugin, declarations: spec.start.Declarations, project: spec.start.Project}, nil
}

// refuseProgramRun writes the refusal of a run as host.program.refused and returns the refusal as the answer of the call.
func refuseProgramRun(surface string, view programView, name string, err error) error {
	EmitHost(LevelError, "host.program.refused", map[string]any{"plugin": view.plugin, "surface": surface, "name": name, "reason": err.Error()})
	return err
}

// ProgramRun runs the declared program of a view call (docs/spec/native-surfaces.md#program-runs). It answers the exit of the program.
// A run that the view process, the surface, the window or a cancel ends answers the ProgramEnd of its end, which the main page
// does not send as a reply, because the view call has already ended.
func (h *Host) ProgramRun(ctx context.Context, reqJSON json.RawMessage) (ProgramRunReply, error) {
	req, err := argument[ProgramRunRequest]("request", reqJSON)
	if err != nil {
		return ProgramRunReply{}, err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return ProgramRunReply{}, err
	}
	view, err := mainThreadResult(func() (programView, error) { return s.programView(req.Surface) })
	if err != nil {
		return ProgramRunReply{}, refuseProgramRun(req.Surface, programView{}, req.Name, err)
	}
	spec, err := checkProgramRun(view.declarations, view.plugin, req.Name, req.Args, view.project)
	if err != nil {
		return ProgramRunReply{}, refuseProgramRun(req.Surface, view, req.Name, err)
	}
	// The run belongs to the window and ends with the surface, the view or the window, not with the call that started it.
	runContext, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	if err := s.programs.begin(req.Surface, req.ID, cancel); err != nil {
		return ProgramRunReply{}, refuseProgramRun(req.Surface, view, req.Name, err)
	}
	defer s.programs.finish(req.Surface, req.ID)
	environment, err := s.sidecars.environment()
	if err != nil {
		return ProgramRunReply{}, fmt.Errorf("program %s: environment: %w", req.Name, err)
	}
	// A program of the form plugin:<path> resolves in the installed version folder of the plugin, which the view folder uses.
	folder := ""
	if strings.HasPrefix(spec.Program, sok.ProgramPluginPrefix) {
		folder, err = PluginFolder(s.sidecars.configDir, view.plugin)
		if err != nil {
			EmitHost(LevelError, "host.program.failed", map[string]any{"plugin": view.plugin, "surface": req.Surface, "name": req.Name, "reason": err.Error()})
			return ProgramRunReply{}, err
		}
	}
	outcome, err := RunProgram(runContext, ProgramRun{
		Name: req.Name, Program: spec.Program, Args: spec.Args, Directory: spec.Directory, Environment: environment, PluginFolder: folder,
		OnStart: func(int) {
			EmitHost(LevelInfo, "host.program.start", map[string]any{
				"plugin": view.plugin, "surface": req.Surface, "name": req.Name, "program": spec.Program, "args": spec.Args, "cwd": spec.Directory,
			})
		},
	})
	if outcome.Result != "" {
		var signal any
		if outcome.Signal != "" {
			signal = outcome.Signal
		}
		EmitHost(LevelInfo, "host.program.end", map[string]any{
			"plugin": view.plugin, "surface": req.Surface, "name": req.Name, "result": outcome.Result, "code": outcome.Code, "signal": signal,
			"stdoutBytes": outcome.StdoutBytes, "stderrBytes": outcome.StderrBytes,
			"stdoutTruncated": outcome.StdoutTruncated, "stderrTruncated": outcome.StderrTruncated, "durationUs": outcome.Duration.Microseconds(),
		})
	}
	if err != nil {
		EmitHost(LevelError, "host.program.failed", map[string]any{"plugin": view.plugin, "surface": req.Surface, "name": req.Name, "reason": err.Error()})
		return ProgramRunReply{}, err
	}
	if outcome.Result != "exited" {
		return ProgramRunReply{}, ProgramEnd(outcome.Result)
	}
	return ProgramRunReply{
		Code: outcome.Code, Stdout: outcome.Stdout, Stderr: outcome.Stderr,
		Truncated: ProgramTruncated{Stdout: outcome.StdoutTruncated, Stderr: outcome.StderrTruncated},
	}, nil
}

// ProgramCancel ends the open run of a view call. A run that is not open is left alone, so a repeated cancel changes nothing.
func (h *Host) ProgramCancel(ctx context.Context, reqJSON json.RawMessage) error {
	req, err := argument[ProgramCancelRequest]("request", reqJSON)
	if err != nil {
		return err
	}
	s, err := h.surface(ctx)
	if err != nil {
		return err
	}
	s.programs.cancel(req.Surface, req.ID)
	return nil
}
