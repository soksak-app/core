package tests

// Checks the agent sources (docs/spec/cli.md#agent-sources): sok embeds the files of packages/sok/go/src/agents, and the bounds of
// the skill description and of the MCP instructions count alike for every text.

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/go/src"
)

// contract: cli.agents.embeds-the-sources
func TestSokEmbedsTheAgentSources(t *testing.T) {
	if sok.SkillText != skillSource(t) {
		t.Fatal("the skill text of sok differs from packages/sok/go/src/agents/SKILL.md")
	}
	var source, embedded any
	if err := json.Unmarshal([]byte(fileText(t, repositoryFile(t, "packages/sok/go/src/agents/mcp.json"))), &source); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(sok.MCPSources, &embedded); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(source, embedded) {
		t.Fatal("the MCP sources of sok differ from packages/sok/go/src/agents/mcp.json")
	}
	if err := sok.CheckAgentSources(sok.SkillText, sok.MCPSources); err != nil {
		t.Fatal(err)
	}
}

// contract: cli.agents.embeds-the-sources
func TestTheAgentSourceBoundsCountScalarValuesAndBytes(t *testing.T) {
	skill := func(name, description string) string {
		return "---\nname: " + name + "\ndescription: " + description + "\n---\n\n# text\n"
	}
	mcp := func(instructions string) []byte {
		text, _ := json.Marshal(map[string]any{"instructions": instructions, "tools": []any{}})
		return text
	}
	cases := []struct {
		skill string
		mcp   []byte
		want  string
	}{
		{skill("soksak", strings.Repeat("한", 1024)), mcp(strings.Repeat("한", 1365) + "a"), ""},
		{skill("soksak", strings.Repeat("한", 1025)), mcp("a"), "the skill description has 1025 Unicode scalar values, more than 1024"},
		{skill("soksak", "a"), mcp(strings.Repeat("한", 1366)), "the MCP instructions have 4098 bytes of UTF-8, more than 4096"},
		{skill("other", "a"), mcp("a"), "the skill front matter names other, not soksak"},
		{"# no front matter\n", mcp("a"), "the skill has no front matter"},
	}
	for _, c := range cases {
		err := sok.CheckAgentSources(c.skill, c.mcp)
		if (c.want == "" && err != nil) || (c.want != "" && (err == nil || err.Error() != c.want)) {
			t.Fatalf("%.40q: %v, want %q", c.skill, err, c.want)
		}
	}
}
