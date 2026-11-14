package sok

// The texts that an agent reads (docs/spec/cli.md#agent-sources). agents/ of this package holds them in one copy for both
// implementations: go:embed reads only files below the folder of this package, and the Rust crate includes the same files.

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"go.yaml.in/yaml/v3"
)

// SkillText is the agent skill (docs/spec/cli.md#agent-skill).
//
//go:embed agents/SKILL.md
var SkillText string

// MCPSources is `{instructions, tools}` of the MCP server, the file agents/mcp.json.
var MCPSources = mcpSource

// Bounds of the agent sources: an agent keeps the description of a skill and the instructions of a server in its context.
const (
	skillName              = "soksak"
	skillDescriptionValues = 1024
	mcpInstructionsBytes   = 4096
)

// CheckAgentSources checks the skill and the MCP sources: the front matter names the skill soksak with a description of at most
// 1024 Unicode scalar values, and the instructions have at most 4096 bytes of UTF-8.
func CheckAgentSources(skill string, mcp []byte) error {
	rest, found := strings.CutPrefix(skill, "---\n")
	matter, _, closed := strings.Cut(rest, "\n---\n")
	if !found || !closed {
		return errors.New("the skill has no front matter")
	}
	var front struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
	}
	if err := yaml.Unmarshal([]byte(matter), &front); err != nil {
		return fmt.Errorf("the skill front matter: %w", err)
	}
	if front.Name != skillName {
		return fmt.Errorf("the skill front matter names %s, not %s", front.Name, skillName)
	}
	if count := utf8.RuneCountInString(front.Description); count > skillDescriptionValues {
		return fmt.Errorf("the skill description has %d Unicode scalar values, more than %d", count, skillDescriptionValues)
	}
	var server struct {
		Instructions *string `json:"instructions"`
	}
	if err := json.Unmarshal(mcp, &server); err != nil || server.Instructions == nil {
		return fmt.Errorf("the MCP sources have no instructions: %v", err)
	}
	if size := len(*server.Instructions); size > mcpInstructionsBytes {
		return fmt.Errorf("the MCP instructions have %d bytes of UTF-8, more than %d", size, mcpInstructionsBytes)
	}
	return nil
}
