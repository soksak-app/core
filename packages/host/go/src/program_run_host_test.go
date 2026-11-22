package host

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

// programDeclarations is the programs declaration of a view start, as the workbench sends it: one run of git with two slots.
var programDeclarations = json.RawMessage(`{"programs":{"status":{"program":"git","args":["status",{"pattern":"-[a-z]+"}]},"bare":{"program":"ls"}}}`)

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
	decls := json.RawMessage(`{"programs":{"bad":{"program":"git","args":[{"pattern":"("}]}}}`)
	_, err := checkProgramRun(decls, "plugin-x", "bad", []string{"x"}, programProject)
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
