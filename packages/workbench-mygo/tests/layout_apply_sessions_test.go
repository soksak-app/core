// A tab of core.layout.apply whose params name an owned session shows that session, as a tab of core.layout.open does
// (docs/spec/plugins.md#owned-sessions): the session must be open, and the new tab becomes the showing tab of core.sessions.
package workbench_test

import (
	"encoding/json"
	"strings"
	"testing"
)

// sessionPlugins holds the plugin term, which declares sessions and one sidecar, and whose tabs take the session in their params.
const sessionPlugins = `{"plugins": [
	{"id": "term", "package": "@scope/plugin-term", "version": "1.0.0", "manifest": {"id": "term", "name": "Term", "description": "term", "mark": "t", "icon": "<path d=\"M1 1h14\"/>",
		"surface": {"composition": {"kind": "view", "page": "ui/index.html"}, "params": {"type": "object", "properties": {"session": {"type": "string"}}}},
		"dependencies": {"` + sessionSidecar + `": "1.0.0"}, "sessions": true}}
]}`

// sessionApplyShell is a window with the card main holding the owner tab tab-owner of term, and the session s-1 that tab-owner opened.
func sessionApplyShell(t *testing.T) (*tabShell, *ownedHost) {
	t.Helper()
	owned := &ownedHost{reply: func(op string, body map[string]any) map[string]any {
		if op == "open" {
			return map[string]any{"session": "s-1", "creation": body["session"].(map[string]any)["creation"]}
		}
		return map[string]any{"session": body["session"], "size": body["size"]}
	}}
	f := newTabShell(t, &storedHost{installed: sessionPlugins, extra: owned.table(),
		projects: []map[string]any{gridProject(oneCard(tab("tab-owner", "term")))}})
	f.open(t)
	var opened any
	var failure error
	f.shell.Registry().RunLaterOn("core.session.open", json.RawMessage(`{"plugin":"term","params":{},"size":{"width":640,"height":384,"scale":2}}`),
		"tab-owner", func(value any, err error) { opened, failure = value, err })
	f.settle()
	if failure != nil {
		t.Fatalf("core.session.open: %v", failure)
	}
	if text, _ := json.Marshal(opened); string(text) != `{"session":"s-1"}` {
		t.Fatalf("core.session.open answered %s", text)
	}
	return f, owned
}

func TestALayoutApplyTabThatNamesASessionShowsIt(t *testing.T) {
	f, owned := sessionApplyShell(t)
	before := len(owned.sent())
	applied, err := f.plan("core.layout.apply", `{"tree":{"direction":"row","children":[{"tabs":[{"tab":"tab-owner"}]},{"tabs":[{"plugin":"term","params":{"session":"s-1"}}]}]}}`)
	if err != nil {
		t.Fatal(err)
	}
	shown := *applied.Cards[1].Tabs[0].Tab
	equal(t, f.status("core.sessions"), `[{"owner":"tab-owner","plugin":"term","program":null,"session":"s-1","shownBy":"`+shown+`"}]`)
	// The showing tab gives the session the size of its card at once.
	sent := owned.sent()[before:]
	if len(sent) != 1 || sent[0].body["operation"] != "resize" || sent[0].body["session"] != "s-1" {
		t.Fatalf("the apply sent %+v, want one resize of s-1", sent)
	}
}

func TestALayoutApplyRefusesATabThatNamesASessionThatIsNotOpen(t *testing.T) {
	f, _ := sessionApplyShell(t)
	_, err := f.plan("core.layout.apply", `{"tree":{"direction":"row","children":[{"tabs":[{"tab":"tab-owner"}]},{"tabs":[{"plugin":"term","params":{"session":"s-9"}}]}]}}`)
	if err == nil || !strings.Contains(err.Error(), "session s-9 is not open") {
		t.Fatalf("the apply answered %v, want the refusal of s-9", err)
	}
	equal(t, f.status("core.sessions"), `[{"owner":"tab-owner","plugin":"term","program":null,"session":"s-1","shownBy":null}]`)
}
