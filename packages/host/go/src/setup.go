package host

// The setup parts of the agents of the machine in the application (docs/spec/cli.md#agents-in-the-application): the host reads
// the environment of the login shell of the person at startup, reconciles user PATH, and brings the agent skill current.
// Setup calls use the setup library of the command line.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/soksak-app/core/packages/host/go/src/routine"
	sok "github.com/soksak-app/core/packages/sok/go/src"
	sokplatform "github.com/soksak-app/core/packages/sok/go/src/platform"
)

// loginShellBound is the time in which the login shell must print the environment: a shell that waits for input has no event
// that ends it.
const loginShellBound = 10 * time.Second

// errSetupOperationRunning is the refusal of a setup operation while another runs.
var errSetupOperationRunning = errors.New("another setup operation is running")

// SetupInstallRequest is the argument of the setupInstall call. Parts is received without a fixed type so that a value that is
// not a list of strings is refused.
type SetupInstallRequest struct {
	Parts any `json:"parts"`
}

// SetupChangeRequest names the user PATH preference and its desired value.
type SetupChangeRequest struct {
	Part    string `json:"part"`
	Enabled *bool  `json:"enabled"`
}

// LoginShellProcesses are the operations of the platform that the read of the login shell environment uses
// (platform.Platform).
type LoginShellProcesses interface {
	LoginShell() (string, error)
	NewProcessGroup(command *exec.Cmd) error
	EndProcessGroup(pid int) error
}

// Setups runs the setup operations of the application: sokPath is the sok of the application bundle, and the setup parts are read
// and installed in the environment of the login shell that processes names.
type Setups struct {
	sokPath    string
	identifier string
	pathsErr   error
	start      SetupStart
	processes  LoginShellProcesses
	changed    func()

	begin sync.Once
	// ready is closed when the start ended: the read of the environment, with env or envErr, and the skill write after it, so a
	// setup operation never runs beside the skill write of the start.
	ready   chan struct{}
	env     sok.AgentEnvironment
	envErr  error
	running sync.Mutex
	pathMu  sync.RWMutex
	pathEnv sok.AgentEnvironment
	pathErr error
}

// sessionVariables are the variables that the login session gives every application of the person, and the only variables of the
// host that the login shell starts with, so the environment that it prints does not depend on the process that started the
// application (docs/spec/cli.md#agents-in-the-application).
var sessionVariables = []string{"HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "SSH_AUTH_SOCK", "__CF_USER_TEXT_ENCODING"}

// shellProcessVariables are the variables that a shell sets for each process that it starts, which the environment of a sidecar
// does not take from the login shell (docs/spec/sidecars.md#processes-of-a-surface).
var shellProcessVariables = []string{"PWD", "OLDPWD", "SHLVL", "_"}

// SetupStart is what the start of the host does with the setup files of the person (docs/spec/cli.md#agents-in-the-application).
// The zero value brings them current.
type SetupStart struct {
	// Kept names why the start changes no setup file of the person: a debug build, or a configuration directory that the run was
	// given, which a check or a second application uses beside the application of the person.
	Kept string
	// Translocated is the folder of an executable that runs from a folder that macOS made for App Translocation; the folder ends
	// with the process, so a registration of its sok would name a path that no longer exists.
	Translocated string
}

// translocationFolder is the path element of the folders that macOS makes for App Translocation.
const translocationFolder = "/AppTranslocation/"

// SetupStartOf returns the start of the setup of the application identifier, run with the configuration directory that the command
// line gave ("" for none) from the executable.
func SetupStartOf(identifier, configDirectory, executable string) SetupStart {
	switch {
	case strings.HasSuffix(identifier, ".dev"):
		return SetupStart{Kept: "the debug build " + identifier}
	case configDirectory != "":
		return SetupStart{Kept: "the configuration directory " + configDirectory}
	case strings.Contains(executable, translocationFolder):
		return SetupStart{Translocated: filepath.Dir(executable)}
	}
	return SetupStart{}
}

// NewSetups returns the setup operations of the sok sokPath of the application identifier; start tells what the start does with
// the setup files of the person, and changed sends setup-changed to every window.
func NewSetups(sokPath, identifier string, start SetupStart, processes LoginShellProcesses, changed func()) (*Setups, error) {
	system, err := sokplatform.Current()
	if err != nil {
		return nil, err
	}
	return &Setups{sokPath: sokPath, identifier: identifier, start: start, pathsErr: system.UserPath(), processes: processes, changed: changed,
		ready: make(chan struct{})}, nil
}

// Start reads the login shell environment, reconciles user PATH, brings the skill, the MCP registration and the hooks current, and
// sends setup-changed. A start that keeps the files of the person or runs from a translocated folder only reads the environment
// and records why it changed no file.
// The work runs off the start path. A later call does nothing.
func (s *Setups) Start() {
	s.begin.Do(func() {
		routine.Go("setup-environment", func() {
			s.env, s.envErr = s.readEnvironment()
			if s.start != (SetupStart{}) {
				if s.start.Translocated != "" {
					EmitHost(LevelError, "host.setup.translocated", map[string]any{"folder": s.start.Translocated})
				} else {
					EmitHost(LevelInfo, "host.setup.kept", map[string]any{"reason": s.start.Kept})
				}
				// The user PATH part reports the environment as the start read it, without a change.
				s.pathEnv = s.env
				close(s.ready)
				s.changed()
				return
			}
			if s.envErr == nil && s.pathsErr == nil {
				s.pathEnv, s.pathErr = s.reconcileUserPath(s.env, nil)
			}
			s.bringSkillCurrent()
			s.bringAgentPartsCurrent()
			close(s.ready)
			s.changed()
		})
	})
}

// setup is the input of the setup library in the environment of the login shell, after the start ended.
func (s *Setups) setup() (sok.Setup, error) {
	<-s.ready
	return s.environmentSetup()
}

// environmentSetup is the input of the setup library in the environment that the start read.
func (s *Setups) environmentSetup() (sok.Setup, error) {
	if s.envErr != nil {
		return sok.Setup{}, s.envErr
	}
	return sok.Setup{Environment: s.env, Sok: s.sokPath, Identifier: s.identifier}, nil
}

// bringSkillCurrent writes a differing skill file of each agent folder that exists, as `sok mcp` does, and records each skill file
// that it could not write, or another failure, as one error host.setup.skill. No agent folder is no error.
func (s *Setups) bringSkillCurrent() {
	setup, err := s.environmentSetup()
	if err == nil {
		_, err = setup.InstallSkills()
	}
	var none *sok.NoAgentFolderError
	if err == nil || errors.As(err, &none) {
		return
	}
	var writes sok.SkillWriteErrors
	if errors.As(err, &writes) {
		for _, write := range writes {
			EmitHost(LevelError, "host.setup.skill", map[string]any{"file": write.File, "reason": write.Err.Error()})
		}
		return
	}
	EmitHost(LevelError, "host.setup.skill", map[string]any{"file": nil, "reason": err.Error()})
}

// bringAgentPartsCurrent installs the MCP registration and the hooks that are not current, as `sok setup install mcp hook` does, so
// each start registers the sok of this bundle, and records a part that it could not install as one error host.setup.install.
func (s *Setups) bringAgentPartsCurrent() {
	// silent: a failed read of the environment is recorded once, as host.setup.skill by bringSkillCurrent.
	setup, err := s.environmentSetup()
	if err != nil {
		return
	}
	if _, err := setup.Install([]string{"mcp", "hook"}); err != nil {
		EmitHost(LevelError, "host.setup.install", map[string]any{"reason": err.Error()})
	}
}

// SidecarEnvironment returns the environment of a sidecar: the variables of the login shell without the ones that a shell sets for
// each process, after the start ended; a failed read is the error of every sidecar start.
func (s *Setups) SidecarEnvironment() (map[string]string, error) {
	<-s.ready
	if s.envErr != nil {
		return nil, s.envErr
	}
	variables := make(map[string]string, len(s.env.Variables))
	for name, value := range s.env.Variables {
		variables[name] = value
	}
	for _, name := range shellProcessVariables {
		delete(variables, name)
	}
	return variables, nil
}

// State returns the setup parts with the current state of the user PATH registration.
func (s *Setups) State() (sok.SetupParts, error) {
	return s.state(true)
}

func (s *Setups) state(refresh bool) (sok.SetupParts, error) {
	setup, err := s.setup()
	if err != nil {
		return sok.SetupParts{}, err
	}
	parts, err := setup.Check()
	if err != nil {
		return parts, err
	}
	return s.withUserPath(parts, refresh)
}

func (s *Setups) withUserPath(parts sok.SetupParts, refresh bool) (sok.SetupParts, error) {
	if s.pathsErr != nil {
		return parts, nil
	}
	s.pathMu.RLock()
	environment, pathErr := s.pathEnv, s.pathErr
	s.pathMu.RUnlock()
	if refresh {
		var err error
		environment, err = s.readEnvironment()
		if err != nil {
			return sok.SetupParts{}, err
		}
	}
	part, err := sok.UserPathState(environment)
	if err != nil {
		return sok.SetupParts{}, err
	}
	if pathErr != nil && part.State != "ok" {
		part.State, part.Reason, part.Error = "error", "", pathErr.Error()
	}
	parts.Parts = append([]sok.SetupPart{part}, parts.Parts...)
	return parts, nil
}

// reconcileUserPath applies the saved preference and verifies a change in a fresh login shell.
func (s *Setups) reconcileUserPath(environment sok.AgentEnvironment, enabled *bool) (sok.AgentEnvironment, error) {
	shell, err := s.processes.LoginShell()
	if err != nil {
		return environment, err
	}
	changed, err := sok.ConfigureUserPath(environment, shell, s.sokPath, enabled)
	if err != nil || !changed {
		return environment, err
	}
	fresh, err := s.readEnvironment()
	if err != nil {
		return environment, err
	}
	part, err := sok.UserPathState(fresh)
	if err != nil {
		return fresh, err
	}
	if part.State != "ok" {
		return fresh, fmt.Errorf("login shell %s: the user PATH registration is %s", shell, part.State)
	}
	return fresh, nil
}

// Change saves and applies the user PATH preference and notifies every window of the result.
func (s *Setups) Change(request SetupChangeRequest) (sok.SetupParts, error) {
	if request.Part != "path" || request.Enabled == nil {
		return sok.SetupParts{}, errors.New("setup change requires path and a boolean enabled")
	}
	if !s.running.TryLock() {
		return sok.SetupParts{}, errSetupOperationRunning
	}
	defer s.running.Unlock()
	<-s.ready
	if s.envErr != nil {
		return sok.SetupParts{}, s.envErr
	}
	if s.pathsErr != nil {
		return sok.SetupParts{}, s.pathsErr
	}
	s.pathMu.RLock()
	environment := s.pathEnv
	s.pathMu.RUnlock()
	if *request.Enabled {
		fresh, err := s.readEnvironment()
		if err != nil {
			return sok.SetupParts{}, err
		}
		environment = fresh
	}
	environment, err := s.reconcileUserPath(environment, request.Enabled)
	s.pathMu.Lock()
	s.pathEnv, s.pathErr = environment, err
	s.pathMu.Unlock()
	s.changed()
	if err != nil {
		return sok.SetupParts{}, err
	}
	return s.state(false)
}

// Install installs the named kinds of skill and mcp as `sok setup install` does and returns its parts, then sends setup-changed.
func (s *Setups) Install(request SetupInstallRequest) (sok.SetupParts, error) {
	kinds, err := setupKindsOf(request.Parts)
	if err != nil {
		return sok.SetupParts{}, err
	}
	if !s.running.TryLock() {
		return sok.SetupParts{}, errSetupOperationRunning
	}
	defer s.running.Unlock()
	setup, err := s.setup()
	if err != nil {
		return sok.SetupParts{}, err
	}
	parts, err := setup.Install(kinds)
	// The install can have changed a part also when it failed, so every window reads the parts again.
	s.changed()
	if err != nil {
		return sok.SetupParts{}, err
	}
	return s.withUserPath(parts, false)
}

// setupPartKinds are the kinds of setup parts, as `sok setup` names them.
var setupPartKinds = []string{"skill", "mcp"}

// setupKindsOf reads the parts of a setupInstall request: a non-empty list of setup part names without repetition.
func setupKindsOf(value any) ([]string, error) {
	list, ok := value.([]any)
	kinds := make([]string, 0, len(list))
	for _, item := range list {
		kind, text := item.(string)
		if !text || slices.Contains(kinds, kind) {
			ok = false
			break
		}
		kinds = append(kinds, kind)
	}
	if !ok || len(kinds) == 0 {
		return nil, errors.New("parts must be a non-empty list of setup parts without repetition")
	}
	for _, kind := range kinds {
		if !slices.Contains(setupPartKinds, kind) {
			return nil, fmt.Errorf("unknown setup part: %s", kind)
		}
	}
	return kinds, nil
}

// readEnvironment runs `<shell> -l -i -c '<sok> setup environment'` in a process group of its own with standard input from
// /dev/null, and returns the environment of the JSON line that it prints. The read ends at that line, not at the end of the output
// or of the shell, because a process that the start files of the shell started can hold the output open; the process group ends in
// every outcome.
func (s *Setups) readEnvironment() (_ sok.AgentEnvironment, failure error) {
	shell, err := s.processes.LoginShell()
	if err != nil {
		return sok.AgentEnvironment{}, err
	}
	fail := func(format string, values ...any) (sok.AgentEnvironment, error) {
		return sok.AgentEnvironment{}, fmt.Errorf("login shell %s: %s", shell, fmt.Sprintf(format, values...))
	}
	stdoutRead, stdoutWrite, err := os.Pipe()
	if err != nil {
		return fail("%v", err)
	}
	defer stdoutRead.Close()
	stderrRead, stderrWrite, err := os.Pipe()
	if err != nil {
		stdoutWrite.Close()
		return fail("%v", err)
	}
	defer stderrRead.Close()
	line := sok.StepOf(s.sokPath) + " setup environment"
	if filepath.Base(shell) == "zsh" {
		// zsh permits ZDOTDIR to be local to the shell. The setup part needs its effective value.
		line = "export ZDOTDIR; " + line
	}
	command := exec.Command(shell, "-l", "-i", "-c", line)
	command.Stdout, command.Stderr = stdoutWrite, stderrWrite
	command.Env = []string{}
	for _, name := range sessionVariables {
		if value, ok := os.LookupEnv(name); ok {
			command.Env = append(command.Env, name+"="+value)
		}
	}
	if err := s.processes.NewProcessGroup(command); err != nil {
		stdoutWrite.Close()
		stderrWrite.Close()
		return fail("%v", err)
	}
	// exec opens /dev/null for a nil standard input.
	err = command.Start()
	stdoutWrite.Close()
	stderrWrite.Close()
	if err != nil {
		return fail("start: %s", osReason(err))
	}
	group := command.Process.Pid
	defer func() {
		if err := s.processes.EndProcessGroup(group); err != nil {
			failure = errors.Join(failure, fmt.Errorf("login shell %s: %w", shell, err))
		}
	}()
	exited := make(chan error, 1)
	routine.Go("login-shell-wait", func() { exited <- command.Wait() })
	lines := make(chan sok.AgentEnvironment, 1)
	stdoutDone := make(chan struct{})
	routine.Go("login-shell-stdout", func() {
		defer close(stdoutDone)
		if environment, ok := environmentLine(stdoutRead); ok {
			lines <- environment
		}
	})
	var stderr bytes.Buffer
	var stderrErr error
	stderrDone := make(chan struct{})
	routine.Go("login-shell-stderr", func() {
		defer close(stderrDone)
		// The read ends at the end of the pipe, or when the return closes the pipe; only a read that ended at the end of the pipe
		// is inspected.
		_, stderrErr = io.Copy(&stderr, stderrRead)
	})
	bound := time.NewTimer(loginShellBound)
	defer bound.Stop()
	select {
	case environment := <-lines:
		return environment, nil
	case waitErr := <-exited:
		// The output that the shell wrote before it ended is in the pipes. A process that the start files started can hold them
		// open, so the process group ends first and the reads then take the output and end at the end of the pipes. A process that
		// left the group and holds them leaves the read to the bound.
		if err := s.processes.EndProcessGroup(group); err != nil {
			return fail("%v", err)
		}
		outputs := make(chan struct{})
		routine.Go("login-shell-outputs", func() {
			<-stdoutDone
			<-stderrDone
			close(outputs)
		})
		select {
		case <-outputs:
		case <-bound.C:
			return fail("no environment within %d s", int(loginShellBound/time.Second))
		}
		select {
		case environment := <-lines:
			return environment, nil
		default:
		}
		reason := exitReason(waitErr)
		if stderrErr != nil {
			return fail("%s; read the standard error: %s", reason, osReason(stderrErr))
		}
		// silent: a standard error without a line feed is its own first line.
		if line, _, _ := strings.Cut(strings.TrimSpace(stderr.String()), "\n"); line != "" {
			reason += ": " + line
		}
		return fail("%s", reason)
	case <-bound.C:
		return fail("no environment within %d s", int(loginShellBound/time.Second))
	}
}

// environmentLine reads lines until one is the JSON object of `sok setup environment`; the lines before it are output of the start
// files of the shell.
func environmentLine(reader io.Reader) (sok.AgentEnvironment, bool) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if !bytes.HasPrefix(line, []byte("{")) {
			continue
		}
		// The line is the one object and nothing after it.
		decoder := json.NewDecoder(bytes.NewReader(line))
		decoder.DisallowUnknownFields()
		var environment sok.AgentEnvironment
		// A line without environment is the earlier form of the line, which the reader does not take.
		if decoder.Decode(&environment) == nil && decoder.InputOffset() == int64(len(line)) && environment.Variables != nil {
			return environment, true
		}
	}
	return sok.AgentEnvironment{}, false
}

// osReason is the text of the operating system error of err without the operation and the path, as the Rust host writes it.
func osReason(err error) string {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return errno.Error()
	}
	return err.Error()
}

// exitReason is the exit status of a shell, or the signal that ended it.
func exitReason(err error) string {
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return fmt.Sprintf("signal %d", int(status.Signal()))
		}
		return fmt.Sprintf("exit status %d", exit.ExitCode())
	}
	if err != nil {
		return err.Error()
	}
	return "exit status 0"
}

// SetupState is the setupState call of the page.
func (h *Host) SetupState() (sok.SetupParts, error) {
	return h.setups.State()
}

// SetupInstall is the setupInstall call of the page.
func (h *Host) SetupInstall(requestJSON json.RawMessage) (sok.SetupParts, error) {
	request, err := argument[SetupInstallRequest]("request", requestJSON)
	if err != nil {
		return sok.SetupParts{}, err
	}
	return h.setups.Install(request)
}

// SetupChange is the setupChange call of the page.
func (h *Host) SetupChange(requestJSON json.RawMessage) (sok.SetupParts, error) {
	request, err := argument[SetupChangeRequest]("request", requestJSON)
	if err != nil {
		return sok.SetupParts{}, err
	}
	return h.setups.Change(request)
}

// notifySetup sends setup-changed to every window.
func (h *Host) notifySetup() {
	h.mu.Lock()
	windows := make([]*Surfaces, 0, len(h.windows))
	for _, s := range h.windows {
		windows = append(windows, s)
	}
	h.mu.Unlock()
	for _, s := range windows {
		s.Emit("setup-changed")
	}
}
