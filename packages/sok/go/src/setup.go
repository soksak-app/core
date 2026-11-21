package sok

// The setup parts that let an agent reach the application (docs/spec/cli.md#setup-parts): the path entry, the skill files and the
// MCP registration, with their states and install steps. The hosts run the same operations through Setup
// (docs/spec/cli.md#agents-in-the-application), and the commands `sok skill`, `sok mcp install` and `sok setup` call them.

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
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
// the identifier of the application.
type Setup struct {
	Environment AgentEnvironment
	Sok         string
	Identifier  string
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
	Enabled *bool  `json:"enabled,omitempty"`
}

// SetupParts are the parts that apply, in the order skill files, registration, hooks.
type SetupParts struct {
	Parts []SetupPart `json:"parts"`
}

// setupKinds are the kinds of setup parts in their order.
var setupKinds = []string{"skill", "mcp", "hook"}

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

// Check reads the state of each part that applies and changes nothing.
func (s Setup) Check() (SetupParts, error) {
	parts := []SetupPart{}
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
	hooks, err := s.hookParts()
	if err != nil {
		return SetupParts{}, err
	}
	return SetupParts{Parts: append(parts, hooks...)}, nil
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
// parts as Check reads them afterwards with `changed`. The error names the parts of the kinds that are not ok, followed by the error
// of each install that failed.
func (s Setup) Install(kinds []string) (SetupParts, error) {
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
	// The hook files are read after the registration too, which can create the Codex folder, as the skills are.
	if named("hook") {
		hooks, err := s.hookParts()
		if err != nil {
			return SetupParts{}, err
		}
		for _, part := range hooks {
			if part.State != "ok" {
				pending["hook"] = true
			}
		}
	}
	if pending["hook"] {
		hookChanged, err := s.InstallHooks()
		for file, ok := range hookChanged {
			changed[file] = ok
		}
		if err != nil {
			failures = append(failures, err.Error())
		}
	}
	// The skills are written after the registration, which can create an agent folder, such as the Codex folder that codex mcp
	// add creates; the skill parts are read again, so the skill file of that folder is written too (docs/spec/cli.md#agent-skill).
	if named("skill") {
		registered, err := s.Check()
		if err != nil {
			return SetupParts{}, err
		}
		for _, part := range registered.Parts {
			if part.Part == "skill" && part.State != "ok" {
				pending["skill"] = true
			}
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
	after, err := s.Check()
	if err != nil {
		return SetupParts{}, err
	}
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
	return Setup{Environment: ProcessAgentEnvironment(), Sok: sok, Identifier: options.Identifier}, nil
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
	if word == "setup" && len(a.positionals) > 1 && a.positionals[1] == "remove" {
		return true, runRemoveHook(a, stdout, options)
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
	parts, installErr := setup.Install(extra)
	if parts.Parts == nil {
		return true, installErr
	}
	if err := printJSON(stdout, parts); err != nil {
		return true, err
	}
	return true, installErr
}

// runRemoveHook is `sok setup remove hook`: it removes the soksak entries of the hook files and prints the hook parts after the
// removal, as `sok setup check` prints them (docs/spec/agent-roles.md#session-restart-hook).
func runRemoveHook(a arguments, stdout io.Writer, options Options) error {
	if len(a.positionals) != 3 || a.positionals[2] != "hook" {
		return usage("setup remove takes the part hook")
	}
	setup, err := commandSetup(options)
	if err != nil {
		return err
	}
	if _, err := setup.RemoveHooks(); err != nil {
		return err
	}
	parts, err := setup.hookParts()
	if err != nil {
		return err
	}
	return printJSON(stdout, SetupParts{Parts: parts})
}
