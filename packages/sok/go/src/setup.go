package sok

// The setup parts that let an agent reach the application (docs/spec/cli.md#setup-parts): the path entry, the skill files and the
// MCP registration, with their states and install steps. The hosts run the same operations through Setup
// (docs/spec/cli.md#agents-in-the-application), and the commands `sok skill`, `sok mcp install` and `sok setup` call them.

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"golang.org/x/term"
)

// AgentEnvironment is HOME, PATH and CLAUDE_CONFIG_DIR of the environment of a run, where nil is a variable that is not set, and
// every variable of that environment, from which the host builds the environment of its sidecars
// (docs/spec/cli.md#agents-in-the-application). `sok setup environment` prints it as one JSON line, which the host reads from the
// login shell of the person.
type AgentEnvironment struct {
	Home            *string           `json:"HOME"`
	Path            *string           `json:"PATH"`
	ClaudeConfigDir *string           `json:"CLAUDE_CONFIG_DIR"`
	Variables       map[string]string `json:"environment"`
}

// ProcessAgentEnvironment is the agent environment of this process.
func ProcessAgentEnvironment() AgentEnvironment {
	lookup := func(name string) *string {
		if value, ok := os.LookupEnv(name); ok {
			return &value
		}
		return nil
	}
	variables := map[string]string{}
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=") // silent: an entry of the environment has the form name=value.
		variables[name] = value
	}
	return AgentEnvironment{Home: lookup("HOME"), Path: lookup("PATH"), ClaudeConfigDir: lookup("CLAUDE_CONFIG_DIR"), Variables: variables}
}

// home is <home>, which a command that needs it requires.
func (e AgentEnvironment) home() (string, error) {
	if e.Home == nil || *e.Home == "" {
		return "", errors.New("HOME is not set")
	}
	return *e.Home, nil
}

func (e AgentEnvironment) path() string {
	if e.Path == nil {
		return ""
	}
	return *e.Path
}

// claudeConfigDir is CLAUDE_CONFIG_DIR, or "" when it is not set or empty.
func (e AgentEnvironment) claudeConfigDir() string {
	if e.ClaudeConfigDir == nil {
		return ""
	}
	return *e.ClaudeConfigDir
}

// applied is the environment of a child process: env with HOME, PATH and CLAUDE_CONFIG_DIR of the agent environment.
func (e AgentEnvironment) applied(env []string) []string {
	out := []string{}
	for _, entry := range env {
		name, _, _ := strings.Cut(entry, "=") // silent: an entry of the environment has the form name=value.
		if name != "HOME" && name != "PATH" && name != "CLAUDE_CONFIG_DIR" {
			out = append(out, entry)
		}
	}
	for _, variable := range []struct {
		name  string
		value *string
	}{{"HOME", e.Home}, {"PATH", e.Path}, {"CLAUDE_CONFIG_DIR", e.ClaudeConfigDir}} {
		if variable.value != nil {
			out = append(out, variable.name+"="+*variable.value)
		}
	}
	return out
}

// Setup is the input of the setup operations: the agent environment, <sok>, the canonical path of the sok of the application, and
// the path entry of the application, which does not apply when PathsError is set.
type Setup struct {
	Environment AgentEnvironment
	Sok         string
	Identifier  string
	PathsDir    string
	PathsError  error
}

// SetupPart is one setup part with its state (`ok`, `missing` or `error`), the reason of a missing part (`absent` or `differs`),
// the text of an error, and for an install whether the install changed it.
type SetupPart struct {
	Part    string `json:"part"`
	File    string `json:"file"`
	State   string `json:"state"`
	Step    string `json:"step"`
	Reason  string `json:"reason,omitempty"`
	Error   string `json:"error,omitempty"`
	Changed *bool  `json:"changed,omitempty"`
}

// SetupParts are the parts that apply, in the order path, skill files, registration.
type SetupParts struct {
	Parts []SetupPart `json:"parts"`
}

// setupKinds are the kinds of setup parts in their order.
var setupKinds = []string{"path", "skill", "mcp"}

// plainStep matches a <sok> that a step writes as it is.
var plainStep = regexp.MustCompile(`^[A-Za-z0-9/._-]+$`)

// StepOf writes <sok> for a step that a person types into a shell: as it is when it holds only A-Z, a-z, 0-9, /, ., _ and -, and
// otherwise between single quotes, with each single quote written as a quote, a backslash and two quotes.
func StepOf(sok string) string {
	if plainStep.MatchString(sok) {
		return sok
	}
	return "'" + strings.ReplaceAll(sok, "'", `'\''`) + "'"
}

// pathEntry is the file of the path entry and the content that `sok path install` writes for <sok>.
func (s Setup) pathEntry() (string, string) {
	return filepath.Join(s.PathsDir, s.Identifier), filepath.Dir(s.Sok) + "\n"
}

// Check reads the state of each part that applies and changes nothing.
func (s Setup) Check() (SetupParts, error) {
	parts := []SetupPart{}
	if s.PathsError == nil {
		file, want := s.pathEntry()
		part := SetupPart{Part: "path", File: file, Step: "sudo " + StepOf(s.Sok) + " path install"}
		data, err := os.ReadFile(file)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			part.State, part.Reason = "missing", "absent"
		case err != nil:
			part.State, part.Error = "error", fileError(file, err).Error()
		case string(data) == want:
			part.State = "ok"
		default:
			part.State, part.Reason = "missing", "differs"
		}
		parts = append(parts, part)
	}
	folders, _, err := s.skillFolders()
	if err != nil {
		return SetupParts{}, err
	}
	for _, folder := range folders {
		part := SetupPart{Part: "skill", File: folder.file, Step: StepOf(s.Sok) + " skill install"}
		state, reason, err := skillState(folder.file)
		if err != nil {
			part.State, part.Error = "error", err.Error()
		} else {
			part.State, part.Reason = state, reason
		}
		parts = append(parts, part)
	}
	part, applies, err := s.mcpPart()
	if err != nil {
		return SetupParts{}, err
	}
	if applies {
		parts = append(parts, part)
	}
	return SetupParts{Parts: parts}, nil
}

// NotCurrent is the error that names each part of the kinds (every kind for none) that is not ok, or nil.
func (p SetupParts) NotCurrent(kinds []string) error {
	var names []string
	for _, part := range p.Parts {
		if part.State != "ok" && (len(kinds) == 0 || slices.Contains(kinds, part.Part)) {
			names = append(names, part.Part+" "+part.File)
		}
	}
	if names == nil {
		return nil
	}
	return fmt.Errorf("setup parts are not current: %s", strings.Join(names, ", "))
}

// checkKinds refuses a kind that is not a setup part.
func checkKinds(kinds []string) error {
	for _, kind := range kinds {
		if !slices.Contains(setupKinds, kind) {
			return fmt.Errorf("unknown setup part: %s", kind)
		}
	}
	return nil
}

// Install installs each part of the kinds (every kind for none) that is not ok, by the rules of its own command, and returns the
// parts as Check reads them afterwards with `changed`. A missing path entry is installed only when terminal is set, by
// `sudo <sok> path install` as a child that asks for the password on that terminal. The error names the parts of the kinds that are
// not ok, followed by the error of each install that failed.
func (s Setup) Install(kinds []string, terminal bool) (SetupParts, error) {
	if err := checkKinds(kinds); err != nil {
		return SetupParts{}, err
	}
	before, err := s.Check()
	if err != nil {
		return SetupParts{}, err
	}
	named := func(kind string) bool { return len(kinds) == 0 || slices.Contains(kinds, kind) }
	pending := map[string]bool{}
	for _, part := range before.Parts {
		if part.State != "ok" && named(part.Part) {
			pending[part.Part] = true
		}
	}
	changed := map[string]bool{}
	var failures []string
	if pending["path"] && terminal {
		file, _ := s.pathEntry() // silent: the second result is the content of the entry, which the root sok of the step writes.
		err := s.installPathEntry()
		recordPathStep(file, err)
		if err != nil {
			failures = append(failures, err.Error())
		} else {
			changed[file] = true
		}
	}
	if pending["skill"] {
		files, err := s.InstallSkills()
		for _, file := range files {
			changed[file.File] = file.State == "written"
		}
		if err != nil {
			failures = append(failures, err.Error())
		}
	}
	if pending["mcp"] {
		result, err := s.InstallMCP()
		if err != nil {
			failures = append(failures, err.Error())
		} else if result.State == "registered" {
			file, err := s.claudeConfigFile()
			if err != nil {
				return SetupParts{}, err
			}
			changed[file] = true
		}
	}
	after, err := s.Check()
	if err != nil {
		return SetupParts{}, err
	}
	// The skill folders are decided when the install starts: a folder that a later step creates, such as the Codex folder that the
	// registration creates, is not written by this install and is not judged by it (docs/spec/cli.md#agent-skill).
	decided := map[string]bool{}
	for _, part := range before.Parts {
		if part.Part == "skill" {
			decided[part.File] = true
		}
	}
	kept := after.Parts[:0]
	for _, part := range after.Parts {
		if part.Part == "skill" && !decided[part.File] {
			continue
		}
		kept = append(kept, part)
	}
	after.Parts = kept
	for n := range after.Parts {
		value := changed[after.Parts[n].File]
		after.Parts[n].Changed = &value
	}
	notCurrent := after.NotCurrent(kinds)
	if notCurrent == nil {
		return after, nil
	}
	return after, errors.New(strings.Join(append([]string{notCurrent.Error()}, failures...), "; "))
}

// installPathEntry runs `sudo <sok> path install` with the terminal of this process for the password.
func (s Setup) installPathEntry() error {
	sudo, err := findOnPath(s.Environment.path(), "sudo")
	if err != nil {
		return err
	}
	if sudo == "" {
		return errors.New("the sudo command is not on PATH")
	}
	command := exec.Command(sudo, s.Sok, "path", "install")
	command.Env = s.Environment.applied(os.Environ())
	command.Stdin = os.Stdin
	var stderr bytes.Buffer
	command.Stdout, command.Stderr = io.Discard, io.MultiWriter(os.Stderr, &stderr)
	err = command.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		line, _, _ := strings.Cut(stderr.String(), "\n") // silent: a standard error without a line feed is its own first line.
		return fmt.Errorf("sudo %s path install failed with status %d: %s", StepOf(s.Sok), exit.ExitCode(), line)
	}
	if err != nil {
		return fmt.Errorf("sudo %s path install: %w", StepOf(s.Sok), err)
	}
	return nil
}

// recordPathStep stores the result of `sudo <sok> path install` as sok.setup.path in the event file of the run
// (docs/spec/cli.md#event-log): the path entry command runs as root and opens no event file, so the run of the person records
// it. A run without an event file, such as a host, stores nothing.
func recordPathStep(file string, err error) {
	log := runLog.Load()
	if log == nil {
		return
	}
	if err == nil {
		log.Emit(LevelInfo, "sok.setup.path", map[string]any{"file": file, "ok": true})
		return
	}
	text, cut := CutText(err.Error(), callTextBytes)
	fields := map[string]any{"file": file, "ok": false, "error": text}
	if cut {
		fields["truncated"] = true
	}
	log.Emit(LevelWarn, "sok.setup.path", fields)
}

// runningSok is <sok>: the absolute path of the running sok with its symbolic links resolved.
func runningSok() (string, error) {
	executable, err := os.Executable()
	if err == nil {
		executable, err = filepath.EvalSymlinks(executable)
	}
	if err != nil {
		return "", fmt.Errorf("the location of sok is unknown: %w", err)
	}
	return executable, nil
}

// commandSetup is the Setup of a command of the running sok in the environment of its process.
func commandSetup(options Options) (Setup, error) {
	sok, err := runningSok()
	if err != nil {
		return Setup{}, err
	}
	return Setup{Environment: ProcessAgentEnvironment(), Sok: sok, Identifier: options.Identifier, PathsDir: options.PathsDir, PathsError: options.PathsError}, nil
}

// runAgentSetup runs `sok skill`, `sok mcp install` and `sok setup`, and reports false for another command.
func runAgentSetup(a arguments, stdout io.Writer, options Options) (bool, error) {
	if len(a.positionals) == 0 {
		return false, nil
	}
	word := a.positionals[0]
	if word != "skill" && word != "setup" && !(word == "mcp" && len(a.positionals) > 1 && a.positionals[1] == "install") {
		return false, nil
	}
	action, err := a.positional(1, word+" action")
	if err != nil {
		return true, err
	}
	extra := a.positionals[2:]
	if word == "setup" && action == "install" {
		if err := checkKinds(extra); err != nil {
			return true, usage("%s", err)
		}
	} else if len(extra) > 0 {
		return true, usage("unexpected argument %s", extra[0])
	}
	switch word + " " + action {
	case "skill print":
		_, err := io.WriteString(stdout, SkillText)
		return true, err
	case "setup environment":
		line, err := encodeJSON(ProcessAgentEnvironment())
		if err == nil {
			_, err = stdout.Write(append(line, '\n'))
		}
		return true, err
	case "skill install", "mcp install", "setup check", "setup install":
	default:
		return true, usage("unknown %s action: %s", word, action)
	}
	setup, err := commandSetup(options)
	if err != nil {
		return true, err
	}
	switch word + " " + action {
	case "skill install":
		files, installErr := setup.InstallSkills()
		if files == nil {
			return true, installErr
		}
		if err := printJSON(stdout, map[string]any{"skills": files}); err != nil {
			return true, err
		}
		return true, installErr
	case "mcp install":
		result, err := setup.InstallMCP()
		if err != nil {
			return true, err
		}
		return true, printJSON(stdout, result)
	case "setup check":
		parts, err := setup.Check()
		if err != nil {
			return true, err
		}
		if err := printJSON(stdout, parts); err != nil {
			return true, err
		}
		return true, parts.NotCurrent(nil)
	}
	parts, installErr := setup.Install(extra, term.IsTerminal(int(os.Stdin.Fd())))
	if parts.Parts == nil {
		return true, installErr
	}
	if err := printJSON(stdout, parts); err != nil {
		return true, err
	}
	return true, installErr
}
