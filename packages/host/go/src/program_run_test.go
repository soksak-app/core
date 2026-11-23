package host

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

// Programs of a test run with the PATH of the test environment, so each test names its own PATH.
var programRunEnvironment = []string{"PATH=/usr/bin:/bin"}

// runProgramOrFail runs one program and fails the test when the run answers an error that the test does not expect.
func runProgramOrFail(t *testing.T, run ProgramRun) ProgramOutcome {
	t.Helper()
	outcome, err := RunProgram(context.Background(), run)
	if err != nil {
		t.Fatalf("RunProgram: %v", err)
	}
	return outcome
}

// contract: program.run.exit-reply
func TestProgramRunReplyCarriesExitStatusAndOutput(t *testing.T) {
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "/bin/sh", Args: []string{"-c", "echo ok; echo warn >&2; exit 3"},
		Directory: t.TempDir(), Environment: programRunEnvironment,
	})
	if outcome.Result != "exited" || outcome.Code == nil || *outcome.Code != 3 {
		t.Fatalf("result %q code %v, want exited with 3", outcome.Result, outcome.Code)
	}
	if outcome.Stdout != "ok\n" || outcome.Stderr != "warn\n" {
		t.Fatalf("stdout %q stderr %q", outcome.Stdout, outcome.Stderr)
	}
	if outcome.StdoutTruncated || outcome.StderrTruncated {
		t.Fatal("a short output was marked truncated")
	}
}

// contract: program.run.argument-vector-without-shell
func TestProgramRunArgumentsReachTheProgramWithoutShell(t *testing.T) {
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "/usr/bin/printf", Args: []string{"%s\n", "$HOME", ";"},
		Directory: t.TempDir(), Environment: programRunEnvironment,
	})
	if outcome.Stdout != "$HOME\n;\n" {
		t.Fatalf("stdout %q: the arguments were expanded or split", outcome.Stdout)
	}
}

// contract: program.run.path-lookup-as-terminal
func TestProgramRunBareNameIsFoundThroughTheRunPath(t *testing.T) {
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "sh", Args: []string{"-c", "exit 0"},
		Directory: t.TempDir(), Environment: []string{"PATH=/nonexistent-folder:/bin:/usr/bin"},
	})
	if outcome.Result != "exited" {
		t.Fatalf("result %q", outcome.Result)
	}
	_, err := RunProgram(context.Background(), ProgramRun{
		Name: "run", Program: "soksak-no-such-program", Directory: t.TempDir(), Environment: programRunEnvironment,
	})
	if err == nil || err.Error() != "program not found: soksak-no-such-program" {
		t.Fatalf("error %v, want program not found", err)
	}
}

// contract: program.run.relative-path-from-project
func TestProgramRunRelativePathResolvesFromTheProjectFolder(t *testing.T) {
	project := t.TempDir()
	folder := filepath.Join(project, "bin")
	if err := os.Mkdir(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(folder, "tool")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho relative\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "bin/tool", Directory: project, Environment: programRunEnvironment,
	})
	if outcome.Stdout != "relative\n" {
		t.Fatalf("stdout %q", outcome.Stdout)
	}
}

// contract: program.run.working-directory-is-project
func TestProgramRunWorkingDirectoryIsTheProjectFolder(t *testing.T) {
	project, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "/bin/pwd", Directory: project, Environment: programRunEnvironment,
	})
	if strings.TrimSpace(outcome.Stdout) != project {
		t.Fatalf("working directory %q, want %q", outcome.Stdout, project)
	}
}

// contract: program.run.standard-input-is-null
func TestProgramRunStandardInputIsEndOfFile(t *testing.T) {
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "/bin/cat", Directory: t.TempDir(), Environment: programRunEnvironment,
	})
	if outcome.Result != "exited" || outcome.Stdout != "" {
		t.Fatalf("result %q stdout %q: standard input was not the end of file", outcome.Result, outcome.Stdout)
	}
}

// contract: program.run.output-bound-truncates
func TestProgramRunOutputBeyondTheBoundIsDiscardedAndMarked(t *testing.T) {
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "/bin/sh", Args: []string{"-c", "head -c 1048577 /dev/zero"},
		Directory: t.TempDir(), Environment: programRunEnvironment,
	})
	if int64(len(outcome.Stdout)) != programOutputMaxBytes || !outcome.StdoutTruncated {
		t.Fatalf("kept %d bytes, truncated %v", len(outcome.Stdout), outcome.StdoutTruncated)
	}
	if outcome.StdoutBytes != programOutputMaxBytes+1 {
		t.Fatalf("counted %d bytes, want %d", outcome.StdoutBytes, programOutputMaxBytes+1)
	}
}

// contract: program.run.output-bound-keeps-whole-characters
// A kept part that ends inside a UTF-8 character ends before that character (docs/spec/native-surfaces.md#program-runs).
func TestProgramRunTruncationKeepsWholeCharacters(t *testing.T) {
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "/bin/sh",
		Args:      []string{"-c", "head -c 1048575 /dev/zero | tr '\\000' a; printf '\\303\\251'"},
		Directory: t.TempDir(), Environment: programRunEnvironment,
	})
	if len(outcome.Stdout) != programOutputMaxBytes-1 || !outcome.StdoutTruncated {
		t.Fatalf("kept %d bytes, truncated %v: the character was cut", len(outcome.Stdout), outcome.StdoutTruncated)
	}
}

// contract: program.run.output-not-utf8-fails
func TestProgramRunStreamThatIsNotUTF8Fails(t *testing.T) {
	_, err := RunProgram(context.Background(), ProgramRun{
		Name: "run", Program: "/bin/sh", Args: []string{"-c", "printf '\\377' >&2"},
		Directory: t.TempDir(), Environment: programRunEnvironment,
	})
	if err == nil || err.Error() != "program run: stderr is not UTF-8" {
		t.Fatalf("error %v, want stderr is not UTF-8", err)
	}
}

// contract: program.run.start-failure-text
func TestProgramRunStartFailureNamesTheProgram(t *testing.T) {
	file := filepath.Join(t.TempDir(), "plain")
	if err := os.WriteFile(file, []byte("not a program\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := RunProgram(context.Background(), ProgramRun{
		Name: "run", Program: file, Directory: t.TempDir(), Environment: programRunEnvironment,
	})
	if err == nil || !strings.HasPrefix(err.Error(), "program "+file+": start failed: ") {
		t.Fatalf("error %v, want the start failure of %s", err, file)
	}
}

// contract: program.run.cancel-ends-the-group
func TestProgramRunCancelKillsTheProgramGroup(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	started := make(chan struct{})
	done := make(chan ProgramOutcome, 1)
	go func() {
		outcome, _ := RunProgram(ctx, ProgramRun{
			Name: "run", Program: "/bin/sh", Args: []string{"-c", "sleep 30 & echo started; wait"},
			Directory: t.TempDir(), Environment: programRunEnvironment,
			OnStart: func(int) { close(started) },
		})
		done <- outcome
	}()
	<-started
	cancel(ProgramCancelled)
	select {
	case outcome := <-done:
		if outcome.Result != "cancelled" {
			t.Fatalf("result %q, want cancelled", outcome.Result)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the run did not end: the child of the program kept the pipes open")
	}
}

// contract: program.run.view-end-ends-the-run, program.run.surface-close-ends-the-run, program.run.window-close-ends-the-run
func TestProgramRunEndKindsAreReportedAsTheirResult(t *testing.T) {
	for _, end := range []ProgramEnd{ProgramProcessEnded, ProgramSurfaceClosed, ProgramWindowClosed} {
		ctx, cancel := context.WithCancelCause(context.Background())
		started := make(chan struct{})
		done := make(chan ProgramOutcome, 1)
		go func() {
			outcome, _ := RunProgram(ctx, ProgramRun{
				Name: "run", Program: "/bin/sleep", Args: []string{"30"},
				Directory: t.TempDir(), Environment: programRunEnvironment,
				OnStart: func(int) { close(started) },
			})
			done <- outcome
		}()
		<-started
		cancel(end)
		select {
		case outcome := <-done:
			if outcome.Result != string(end) {
				t.Fatalf("result %q, want %q", outcome.Result, end)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("the run ended by %s did not end", end)
		}
	}
}

// programDeclarations is the programs declaration of a view start, as the workbench sends it: one run of git with two slots.
var programDeclarations = mustProgramDeclarations(`{"status":{"program":"git","args":["status",{"pattern":"-[a-z]+"}]},"bare":{"program":"ls"}}`)

// mustProgramDeclarations parses the programs member of a sync surface for a test whose declaration is valid.
func mustProgramDeclarations(text string) map[string]programDeclaration {
	declared, err := parseProgramDeclarations(json.RawMessage(text))
	if err != nil {
		panic(err)
	}
	return declared
}

var programProject = &SurfaceProject{ID: "p", Root: "/projects/p"}

// contract: program.run.refuses-undeclared-name
func TestProgramRunRefusesAnUndeclaredName(t *testing.T) {
	_, err := checkProgramRun(programDeclarations, "plugin-x", "unknown", nil, programProject)
	if err == nil || err.Error() != "program unknown is not declared by plugin-x" {
		t.Fatalf("error %v", err)
	}
}

// contract: program.run.refuses-argument-count
func TestProgramRunRefusesAWrongArgumentCount(t *testing.T) {
	_, err := checkProgramRun(programDeclarations, "plugin-x", "status", []string{"status", "-s", "extra"}, programProject)
	if err == nil || err.Error() != "program status takes 2 arguments, 3 given" {
		t.Fatalf("error %v", err)
	}
}

// contract: program.run.refuses-argument-outside-pattern
func TestProgramRunRefusesAnArgumentOutsideItsPattern(t *testing.T) {
	_, err := checkProgramRun(programDeclarations, "plugin-x", "status", []string{"status", "-S"}, programProject)
	if err == nil || err.Error() != "program status argument 2 -S does not match its pattern" {
		t.Fatalf("error %v", err)
	}
	_, err = checkProgramRun(programDeclarations, "plugin-x", "status", []string{"status", "-s x"}, programProject)
	if err == nil || err.Error() != "program status argument 2 -s x does not match its pattern" {
		t.Fatalf("pattern must match the whole argument: error %v", err)
	}
}

// contract: program.run.refuses-pattern-that-does-not-compile
func TestProgramRunRefusesAPatternThatDoesNotCompile(t *testing.T) {
	_, err := parseProgramDeclarations(json.RawMessage(`{"bad":{"program":"git","args":[{"pattern":"("}]}}`))
	if err == nil || !strings.HasPrefix(err.Error(), "programs.bad pattern does not compile: ") {
		t.Fatalf("error %v", err)
	}
}

// contract: program.run.refuses-argument-not-equal-text
func TestProgramRunRefusesALiteralArgumentThatDiffers(t *testing.T) {
	_, err := checkProgramRun(programDeclarations, "plugin-x", "status", []string{"stat", "-s"}, programProject)
	if err == nil || err.Error() != "program status argument 1 stat does not equal its text" {
		t.Fatalf("error %v", err)
	}
}

// contract: program.run.refuses-open-call-id
func TestProgramRunRefusesAnOpenCallIdentifier(t *testing.T) {
	var runs programRuns
	cancel := func(error) {}
	if err := runs.begin("s1", 1, cancel); err != nil {
		t.Fatalf("begin: %v", err)
	}
	err := runs.begin("s1", 1, cancel)
	if err == nil || err.Error() != "program run: call 1 is already open on surface s1" {
		t.Fatalf("error %v", err)
	}
	if err := runs.begin("s2", 1, cancel); err != nil {
		t.Fatalf("the identifier of another surface is free: %v", err)
	}
}

// contract: program.run.refuses-surface-without-view
// A run of a surface without a view, or of a surface that has closed, is refused with the no-view text of the spec.
func TestProgramRunOfASurfaceWithoutAViewIsRefused(t *testing.T) {
	s := &Surfaces{}
	if _, err := s.programView("s1"); err == nil || err.Error() != "program run: surface s1 has no view" {
		t.Fatalf("error %v", err)
	}
}

// contract: program.run.declaration-is-checked-at-the-boundary
func TestProgramDeclarationIsCheckedAtTheBoundary(t *testing.T) {
	declared, err := parseProgramDeclarations(json.RawMessage(`{"lint":{"program":"bin/lint","args":["src",{"pattern":"[a-z]+"}]},"version":{"program":"/usr/bin/true"}}`))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if declared["lint"].Program != "bin/lint" || len(declared["lint"].Slots) != 2 ||
		declared["lint"].Slots[0].text != "src" || declared["lint"].Slots[1].pattern != "[a-z]+" || !declared["lint"].Slots[1].isPattern {
		t.Fatalf("lint: %+v", declared["lint"])
	}
	if len(declared["version"].Slots) != 0 {
		t.Fatalf("version: %+v", declared["version"])
	}
	refusals := map[string]string{
		`{"Lint":{"program":"x"}}`:                                "programs.Lint name is not of the form [a-z][a-z0-9-]*",
		`{"lint":{"program":"x","extra":1}}`:                      "programs.lint has an unknown member extra",
		`{"lint":{"program":"x","args":[{"pattern":"a","x":1}]}}`: "programs.lint args.0 is neither a text nor an object with the single member pattern",
	}
	for input, want := range refusals {
		_, err := parseProgramDeclarations(json.RawMessage(input))
		if err == nil || err.Error() != want {
			t.Fatalf("%s: error %v, want %q", input, err, want)
		}
	}
	_, err = parseProgramDeclarations(json.RawMessage(`{"lint":{"program":"x","args":[{"pattern":"("}]}}`))
	if err == nil || !strings.HasPrefix(err.Error(), "programs.lint pattern does not compile: ") {
		t.Fatalf("uncompiled pattern: error %v", err)
	}
}

// contract: program.run.refuses-without-project
func TestProgramRunRefusesAWindowWithoutProject(t *testing.T) {
	_, err := checkProgramRun(programDeclarations, "plugin-x", "bare", nil, nil)
	if err == nil || err.Error() != "program run: the window shows no project" {
		t.Fatalf("error %v", err)
	}
}

// contract: program.run.accepts-matching-arguments
// A run whose declaration matches starts with the declared program and the matched arguments.
func TestProgramRunAcceptsAMatchingRun(t *testing.T) {
	run, err := checkProgramRun(programDeclarations, "plugin-x", "status", []string{"status", "-s"}, programProject)
	if err != nil {
		t.Fatalf("error %v", err)
	}
	if run.Program != "git" || run.Directory != "/projects/p" || len(run.Args) != 2 {
		t.Fatalf("run %+v", run)
	}
}

// contract: program.run.refuses-fifth-open-run
func TestProgramRunRefusesTheFifthOpenRunOfASurface(t *testing.T) {
	var runs programRuns
	for i := range programRunsPerSurface {
		_, cancel := context.WithCancelCause(context.Background())
		if err := runs.begin("s1", uint64(i), cancel); err != nil {
			t.Fatalf("run %d refused: %v", i+1, err)
		}
	}
	_, cancel := context.WithCancelCause(context.Background())
	err := runs.begin("s1", 5, cancel)
	if err == nil || err.Error() != "program run: 4 runs are open on surface s1" {
		t.Fatalf("error %v", err)
	}
	if err := runs.begin("s2", 1, cancel); err != nil {
		t.Fatalf("another surface was refused: %v", err)
	}
}

// contract: program.run.surface-close-ends-the-run, program.run.window-close-ends-the-run
// Ending a surface cancels its open runs with the cause and leaves the runs of other surfaces open.
func TestProgramRunsEndWithTheirSurface(t *testing.T) {
	var runs programRuns
	ctx1, cancel1 := context.WithCancelCause(context.Background())
	ctx2, cancel2 := context.WithCancelCause(context.Background())
	if err := runs.begin("s1", 1, cancel1); err != nil {
		t.Fatal(err)
	}
	if err := runs.begin("s2", 1, cancel2); err != nil {
		t.Fatal(err)
	}
	runs.end("s1", ProgramSurfaceClosed)
	if context.Cause(ctx1) != ProgramSurfaceClosed {
		t.Fatalf("surface run cause %v", context.Cause(ctx1))
	}
	if ctx2.Err() != nil {
		t.Fatal("another surface's run ended")
	}
	runs.endAll(ProgramWindowClosed)
	if context.Cause(ctx2) != ProgramWindowClosed {
		t.Fatalf("window run cause %v", context.Cause(ctx2))
	}
}

// contract: program.run.cancel-is-idempotent
// A cancel of a run that is open ends it with ProgramCancelled; a cancel of a run that ended changes nothing.
func TestProgramRunCancelIsIdempotent(t *testing.T) {
	var runs programRuns
	ctx, cancel := context.WithCancelCause(context.Background())
	if err := runs.begin("s1", 1, cancel); err != nil {
		t.Fatal(err)
	}
	runs.cancel("s1", 1)
	runs.cancel("s1", 1)
	if context.Cause(ctx) != ProgramCancelled {
		t.Fatalf("cause %v", context.Cause(ctx))
	}
}

// contract: program.run.environment-as-sidecar
func TestProgramRunEnvironmentIsTheSidecarEnvironment(t *testing.T) {
	const sokFolder = "/fixture/soksak.app/Contents/MacOS"
	c, err := NewSidecars(nil, "")
	if err != nil {
		t.Fatalf("sidecars: %v", err)
	}
	c.sokFolder = sokFolder
	// The login shell variables pass through the production filter of the sidecar source before the environment is built.
	login := map[string]string{"PATH": "/usr/bin:" + sokFolder + ":/opt/bin", "PWD": "/somewhere", "SHLVL": "2", "_": "/usr/bin/env"}
	c.SetEnvironment(func() (map[string]string, error) {
		return withoutShellProcessVariables(login), nil
	})
	environment, err := c.environment()
	if err != nil {
		t.Fatalf("environment: %v", err)
	}
	if !slices.Contains(environment, "PATH="+sokFolder+":/usr/bin:/opt/bin") {
		t.Fatalf("PATH does not start with the sok folder: %v", environment)
	}
	for _, entry := range environment {
		if strings.HasPrefix(entry, "PWD=") || strings.HasPrefix(entry, "SHLVL=") {
			t.Fatalf("a shell variable reached the run: %s", entry)
		}
	}
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "/usr/bin/env", Directory: t.TempDir(), Environment: environment,
	})
	if strings.Contains(outcome.Stdout, "PWD=") || strings.Contains(outcome.Stdout, "SHLVL=") {
		t.Fatalf("the program saw a shell variable: %q", outcome.Stdout)
	}
}

// contract: program.run.call-id-is-an-integer
// The view call identifier is the integer id of the view-call protocol (docs/spec/native-surfaces.md#view-surfaces): the page sends it
// as a JSON integer, and a text identifier is refused at decoding.
func TestProgramCallRequestsDecodeTheIntegerViewCallID(t *testing.T) {
	run, err := argument[ProgramRunRequest]("request", json.RawMessage(`{"surface":"s1","id":7,"name":"lint","args":["src"]}`))
	if err != nil {
		t.Fatalf("decode the run request: %v", err)
	}
	if id, _ := json.Marshal(run.ID); string(id) != "7" || run.Surface != "s1" || run.Name != "lint" {
		t.Fatalf("decoded run request: %+v", run)
	}
	cancel, err := argument[ProgramCancelRequest]("request", json.RawMessage(`{"surface":"s1","id":7}`))
	if err != nil {
		t.Fatalf("decode the cancel request: %v", err)
	}
	if id, _ := json.Marshal(cancel.ID); string(id) != "7" {
		t.Fatalf("decoded cancel request: %+v", cancel)
	}
	if _, err := argument[ProgramRunRequest]("request", json.RawMessage(`{"surface":"s1","id":"7","name":"lint","args":[]}`)); err == nil {
		t.Fatal("a text view call identifier decoded as a run request")
	}
}

// writeProgramFile writes a file of the plugin folder with the mode, creating its folders.
func writeProgramFile(t *testing.T, folder, name, content string, mode os.FileMode) {
	t.Helper()
	path := filepath.Join(folder, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

// contract: program.run.plugin-path-runs-installed-file
func TestProgramRunPluginPathRunsTheInstalledFile(t *testing.T) {
	folder := t.TempDir()
	writeProgramFile(t, folder, "bin/tool", "#!/bin/sh\necho \"$1\"\n", 0o755)
	outcome := runProgramOrFail(t, ProgramRun{
		Name: "run", Program: "plugin:bin/tool", Args: []string{"$HOME"},
		Directory: t.TempDir(), Environment: programRunEnvironment, PluginFolder: folder,
	})
	if outcome.Result != "exited" || outcome.Stdout != "$HOME\n" {
		t.Fatalf("result %q stdout %q: the program of the plugin folder did not run with its argument", outcome.Result, outcome.Stdout)
	}
}

// contract: program.run.plugin-path-not-found
func TestProgramRunPluginPathNotFoundFailsTheRun(t *testing.T) {
	project := t.TempDir()
	writeProgramFile(t, project, "bin/tool", "#!/bin/sh\necho ran\n", 0o755)
	_, err := RunProgram(context.Background(), ProgramRun{
		Name: "run", Program: "plugin:bin/tool", Directory: project, Environment: programRunEnvironment, PluginFolder: t.TempDir(),
	})
	if err == nil || err.Error() != "program not found: plugin:bin/tool" {
		t.Fatalf("error %v, want program not found: the file of the project folder must not be run", err)
	}
}

// contract: program.run.plugin-path-not-executable
func TestProgramRunPluginPathNotExecutableFailsTheRun(t *testing.T) {
	folder := t.TempDir()
	writeProgramFile(t, folder, "bin/tool", "#!/bin/sh\n", 0o644)
	_, err := RunProgram(context.Background(), ProgramRun{
		Name: "run", Program: "plugin:bin/tool", Directory: t.TempDir(), Environment: programRunEnvironment, PluginFolder: folder,
	})
	if err == nil || err.Error() != "program plugin:bin/tool is not a regular executable file" {
		t.Fatalf("error %v, want the executable refusal", err)
	}
}

// contract: program.run.plugin-path-refuses-invalid-path
func TestProgramDeclarationRefusesAnInvalidPluginPath(t *testing.T) {
	want := "programs.lint program plugin path must be a relative path of / separated segments that are not empty, . or .., without a backslash"
	for _, program := range []string{"plugin:../tool", "plugin:/tool", "plugin:", "plugin:bin//tool"} {
		input, err := json.Marshal(map[string]any{"lint": map[string]any{"program": program}})
		if err != nil {
			t.Fatal(err)
		}
		_, err = parseProgramDeclarations(json.RawMessage(input))
		if err == nil || err.Error() != want {
			t.Fatalf("%s: error %v, want %q", program, err, want)
		}
	}
}

// contract: program.run.reads-the-programs-of-the-sync-surface
func TestProgramRunReadsTheProgramsThatTheSyncRequestCarriesForTheSurface(t *testing.T) {
	const surface = `"id":"tab-a","visible":true,"dim":false,"plugin":"plugin-x","composition":{"kind":"view","page":"ui/page.html"},"x":0,"y":0,"w":10,"h":10,"start":{"params":{},"origin":{},"project":{"id":"p","root":"/projects/p"},"diagnostics":null,"section":null,"declarations":0}`
	request := json.RawMessage(`{"settled":true,"titlebar":40,"viewport":{"width":800,"height":600},"declarations":[{}],"surfaces":[{` + surface + `,"programs":{"agent-file":{"program":"echo","args":[{"pattern":"[a-z.]+"}]}}}]}`)
	decoded, err := decodeSyncRequest(request)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	s := &Surfaces{compositions: map[string]SurfaceComposition{}, surfacePlugins: map[string]string{},
		surfacePrograms: map[string]map[string]programDeclaration{}}
	s.recordSyncedSurface(decoded.Surfaces[0])
	spec := s.viewRecords().track("tab-a", nil, "plugin-x", "ui/page.html", true)
	spec.start = *decoded.Surfaces[0].Start
	view, err := s.programView("tab-a")
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	run, err := checkProgramRun(view.programs, view.plugin, "agent-file", []string{"notes.md"}, view.project)
	if err != nil {
		t.Fatalf("the declared program of the sync surface was refused: %v", err)
	}
	if run.Program != "echo" || !reflect.DeepEqual(run.Args, []string{"notes.md"}) {
		t.Fatalf("run %+v", run)
	}
	if _, err := decodeSyncRequest(json.RawMessage(strings.Replace(string(request), `"program":"echo"`, `"program":""`, 1))); err == nil ||
		err.Error() != `surface "tab-a": programs.agent-file program is not a text of 1 to 255 bytes without a control character` {
		t.Fatalf("an invalid programs member was not refused at the sync: %v", err)
	}
}
