package sok

// Registers `sok mcp` with the claude command in its user scope (docs/spec/cli.md#mcp-registration). The configuration file of the
// claude command belongs to that program: sok reads only mcpServers.soksak of it and changes it only through the claude command.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/soksak-app/core/packages/sok/go/src/platform"
)

// registrationName is the name of the registration of every installed soksak application.
const registrationName = "soksak"

// MCPInstall is the result of `sok mcp install`: the registration entry as the configuration file holds it, its state
// (`current` or `registered`) and, when the running sok is not the registered one, the running sok.
type MCPInstall struct {
	Registration json.RawMessage `json:"registration"`
	State        string          `json:"state"`
	Running      string          `json:"running,omitempty"`
}

// findOnPath is the first folder of the PATH text that holds an executable regular file of the name, as a canonical path, or ""
// when none does. exec.LookPath reads the PATH of the process, and the setup operations read the PATH of the environment that the
// host gives them, so the folders are searched here.
func findOnPath(path, name string) (string, error) {
	for _, dir := range filepath.SplitList(path) {
		if dir == "" {
			continue
		}
		candidate := filepath.Join(dir, name)
		info, err := os.Stat(candidate)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			continue
		}
		resolved, err := filepath.EvalSymlinks(candidate)
		if err != nil {
			return "", fileError(candidate, err)
		}
		return filepath.Abs(resolved)
	}
	return "", nil
}

// registeredSok is the first sok on PATH, or the running sok when no folder of PATH holds one; the platform requires the sok of an
// application bundle on macOS.
func (s Setup) registeredSok() (string, error) {
	first, err := findOnPath(s.Environment.path(), "sok")
	if err != nil {
		return "", err
	}
	if first == "" {
		first = s.Sok
	}
	system, err := platform.Current()
	if err != nil {
		return "", err
	}
	if err := system.RegisteredSok(first); err != nil {
		return "", err
	}
	return first, nil
}

// claudeConfigFile is the configuration file of the claude command in the environment.
func (s Setup) claudeConfigFile() (string, error) {
	if dir := s.Environment.claudeConfigDir(); dir != "" {
		return filepath.Join(dir, ".claude.json"), nil
	}
	home, err := s.Environment.home()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude.json"), nil
}

// invalidJSON is the error of a JSON file that does not decode: `<file> is not valid JSON at line <l> column <c>` for a syntax
// error, with the line and the byte column of the byte at which the decoder stopped, both from 1, as the Rust implementation
// reports them; and `<file> is not a JSON object` for a value of another kind.
func invalidJSON(file string, data []byte, err error) error {
	var syntax *json.SyntaxError
	if !errors.As(err, &syntax) {
		return fmt.Errorf("%s is not a JSON object", file)
	}
	at := max(int(syntax.Offset)-1, 0)
	at = min(at, len(data))
	line := 1 + bytes.Count(data[:at], []byte("\n"))
	column := at - bytes.LastIndexByte(data[:at], '\n')
	return fmt.Errorf("%s is not valid JSON at line %d column %d", file, line, column)
}

// readRegistration reads mcpServers.soksak of the configuration file, or nil when the file or the entry does not exist.
func readRegistration(file string) (json.RawMessage, error) {
	data, err := os.ReadFile(file)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fileError(file, err)
	}
	var config struct {
		MCPServers json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, invalidJSON(file, data, err)
	}
	if config.MCPServers == nil || string(config.MCPServers) == "null" {
		return nil, nil
	}
	var servers map[string]json.RawMessage
	if err := json.Unmarshal(config.MCPServers, &servers); err != nil {
		return nil, fmt.Errorf("%s: mcpServers is not an object", file)
	}
	entry, ok := servers[registrationName]
	if !ok {
		return nil, nil
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, entry); err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	return compact.Bytes(), nil
}

// registrationCurrent tells whether the entry is an object with type stdio, command the registered sok, args ["mcp"] and no env or
// an empty one.
func registrationCurrent(entry json.RawMessage, sok string) bool {
	var fields struct {
		Type    *string        `json:"type"`
		Command *string        `json:"command"`
		Args    []string       `json:"args"`
		Env     map[string]any `json:"env"`
	}
	if entry == nil || json.Unmarshal(entry, &fields) != nil {
		return false
	}
	return fields.Type != nil && *fields.Type == "stdio" && fields.Command != nil && *fields.Command == sok &&
		len(fields.Args) == 1 && fields.Args[0] == "mcp" && len(fields.Env) == 0
}

// registrationCommand is the command of an earlier registration, or its JSON text when it has none.
func registrationCommand(entry json.RawMessage) string {
	var fields struct {
		Command *string `json:"command"`
	}
	if json.Unmarshal(entry, &fields) == nil && fields.Command != nil {
		return *fields.Command
	}
	return string(entry)
}

// RequireWritableVolume fails for a sok on a volume that is mounted read-only, which disappears after the run
// (docs/spec/cli.md#mcp-registration): the judgement of `sok path install` for the running sok and of `sok mcp install` for the
// registered sok.
func RequireWritableVolume(sok string) error {
	system, err := platform.Current()
	if err != nil {
		return err
	}
	readOnly, err := system.ReadOnlyVolume(sok)
	if err != nil {
		return fileError(sok, err)
	}
	if readOnly {
		return fmt.Errorf("%s is on a read-only volume; move the application to a folder such as /Applications and start it again", sok)
	}
	return nil
}

// runClaude runs the claude command with the arguments in the environment of the setup operations.
func (s Setup) runClaude(claude, subcommand string, args ...string) error {
	command := exec.Command(claude, append([]string{"mcp", subcommand}, args...)...)
	command.Env = s.Environment.applied(os.Environ())
	var stderr bytes.Buffer
	command.Stderr = &stderr
	err := command.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		line, _, _ := strings.Cut(stderr.String(), "\n") // silent: a standard error without a line feed is its own first line.
		return fmt.Errorf("claude mcp %s failed with status %d: %s", subcommand, exit.ExitCode(), line)
	}
	if err != nil {
		return fmt.Errorf("claude mcp %s: %w", subcommand, err)
	}
	return nil
}

// InstallMCP registers the registered sok with the claude command unless its registration is current.
func (s Setup) InstallMCP() (MCPInstall, error) {
	sok, err := s.registeredSok()
	if err != nil {
		return MCPInstall{}, err
	}
	if err := RequireWritableVolume(sok); err != nil {
		return MCPInstall{}, err
	}
	claude, err := findOnPath(s.Environment.path(), "claude")
	if err != nil {
		return MCPInstall{}, err
	}
	if claude == "" {
		return MCPInstall{}, fmt.Errorf("the claude command is not on PATH; register the MCP server \"%s mcp\" (standard input and output) with the agent", sok)
	}
	file, err := s.claudeConfigFile()
	if err != nil {
		return MCPInstall{}, err
	}
	entry, err := readRegistration(file)
	if err != nil {
		return MCPInstall{}, err
	}
	result := MCPInstall{State: "current"}
	if sok != s.Sok {
		result.Running = s.Sok
	}
	if !registrationCurrent(entry, sok) {
		if entry != nil {
			if err := s.runClaude(claude, "remove", "--scope", "user", registrationName); err != nil {
				return MCPInstall{}, err
			}
		}
		if err := s.runClaude(claude, "add", "--scope", "user", registrationName, "--", sok, "mcp"); err != nil {
			if entry != nil {
				return MCPInstall{}, fmt.Errorf("%w; the earlier registration %s was removed", err, registrationCommand(entry))
			}
			return MCPInstall{}, err
		}
		if entry, err = readRegistration(file); err != nil {
			return MCPInstall{}, err
		}
		if !registrationCurrent(entry, sok) {
			return MCPInstall{}, fmt.Errorf("claude mcp add did not write the registration to %s", file)
		}
		result.State = "registered"
	}
	result.Registration = entry
	return result, nil
}

// mcpPart is the setup part of the registration, and false when the claude command is not on PATH.
func (s Setup) mcpPart() (SetupPart, bool, error) {
	claude, err := findOnPath(s.Environment.path(), "claude")
	if err != nil || claude == "" {
		return SetupPart{}, false, err
	}
	file, err := s.claudeConfigFile()
	if err != nil {
		return SetupPart{}, false, err
	}
	part := SetupPart{Part: "mcp", File: file, Step: StepOf(s.Sok) + " mcp install"}
	sok, err := s.registeredSok()
	var entry json.RawMessage
	if err == nil {
		entry, err = readRegistration(file)
	}
	switch {
	case err != nil:
		part.State, part.Error = "error", err.Error()
	case entry == nil:
		part.State, part.Reason = "missing", "absent"
	case registrationCurrent(entry, sok):
		part.State = "ok"
	default:
		part.State, part.Reason = "missing", "differs"
	}
	return part, true, nil
}
