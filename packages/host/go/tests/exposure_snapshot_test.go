package host_test

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// snapshotWindow is the window main of a project with a page that follows its exchanges, and host statuses that answer their own
// name, except host.dock, whose read fails.
type snapshotWindow struct {
	*casePage
}

func (w snapshotWindow) Windows() []host.WindowEntry {
	project := "/p"
	return []host.WindowEntry{{Window: "main", Title: "soksak", Project: &project, Key: true, Ready: true}}
}

func (w snapshotWindow) HostStatus(_, name string) (any, error) {
	if name == "host.dock" {
		return nil, fmt.Errorf("the dock menu is unread")
	}
	return map[string]any{"status": name}, nil
}

// serveSnapshot serves the window of a snapshot whose page follows exchanges; a deviation from them fails the test.
func serveSnapshot(t *testing.T, exchanges ...casePageExchange) string {
	t.Helper()
	page := newTierBackend([]string{"main"})
	page.script = exchanges
	_, address, _ := serve(t, snapshotWindow{page})
	t.Cleanup(func() {
		for _, problem := range page.finish() {
			t.Errorf("the page of the endpoint: %s", problem)
		}
	})
	return address
}

// pagePart is a part of the main page in a snapshot: its layout, its plugins, the group of core and one surface group.
const pagePart = `{"layout": {"space": "s", "focused": null, "root": null}, "plugins": [], "groups": [
	{"owner": "core", "status": [], "commands": [], "element": []},
	{"owner": "surface", "surface": "tab-a", "plugin": "probe", "kind": "tab", "state": "loaded", "visible": true, "status": [], "commands": [], "element": []}],
	"unregistered": [{"kind": "status", "name": "core.drop"}]}`

// contract: endpoint.exposure-snapshot.host-adds-the-window-and-its-group
func TestTheSnapshotHoldsTheWindowAndTheHostGroupBeforeThePageGroups(t *testing.T) {
	address := serveSnapshot(t,
		pageExchange("exposure.snapshot", `{}`, pagePart),
		pageExchange("exposure.snapshot", `{"surface": "tab-a"}`, `{"layout": null, "plugins": [], "groups": [
			{"owner": "surface", "surface": "tab-a", "plugin": "probe", "kind": "tab", "state": "loaded", "visible": true, "status": [], "commands": [], "element": []}],
			"unregistered": []}`),
		pageExchange("exposure.snapshot", `{}`, `[]`),
		pageExchange("exposure.snapshot", `{}`, `{"layout": null, "plugins": [], "groups": {}, "unregistered": []}`),
		pageExchange("exposure.snapshot", `{}`, `{"layout": null, "plugins": [], "groups": []}`))
	conn := dial(t, address)
	got := call(t, conn, 1, "exposure.snapshot", map[string]any{"window": "main"})
	if got.Error != nil {
		t.Fatalf("the snapshot failed: %v", got.Error)
	}
	var result map[string]any
	if err := json.Unmarshal(got.Result, &result); err != nil {
		t.Fatal(err)
	}
	var page map[string]any
	if err := json.Unmarshal([]byte(pagePart), &page); err != nil {
		t.Fatal(err)
	}
	if want := map[string]any{"window": "main", "title": "soksak", "project": "/p"}; !reflect.DeepEqual(result["window"], want) {
		t.Fatalf("the window is %v, want %v", result["window"], want)
	}
	for _, member := range []string{"layout", "plugins", "unregistered"} {
		if !reflect.DeepEqual(result[member], page[member]) {
			t.Fatalf("the %s is %v, the page answered %v", member, result[member], page[member])
		}
	}
	groups := result["groups"].([]any)
	if len(groups) != 3 || !reflect.DeepEqual(groups[1:], page["groups"]) {
		t.Fatalf("the groups are %v, want the host group and the groups of the page %v", groups, page["groups"])
	}
	// The host group holds the host entries of exposure.list, without registered, with the value or the error of each status.
	listed := call(t, conn, 2, "exposure.list", map[string]any{"window": "main", "owner": "host"})
	var declared map[string][]map[string]any
	if err := json.Unmarshal(listed.Result, &declared); err != nil {
		t.Fatal(err)
	}
	status := []any{}
	for _, entry := range declared["status"] {
		delete(entry, "registered")
		if entry["name"] == "host.dock" {
			entry["error"] = "the dock menu is unread"
		} else {
			entry["value"] = map[string]any{"status": entry["name"]}
		}
		status = append(status, entry)
	}
	commands := []any{}
	for _, entry := range declared["commands"] {
		delete(entry, "registered")
		commands = append(commands, entry)
	}
	want := map[string]any{"owner": "host", "status": status, "commands": commands, "element": []any{}}
	if wantText, gotText := mustText(t, want), mustText(t, groups[0]); gotText != wantText {
		t.Fatalf("the host group is\n%s\nwant\n%s", gotText, wantText)
	}

	// With surface, the result holds only the group of that surface: the host adds the window and no group.
	one := call(t, conn, 3, "exposure.snapshot", map[string]any{"window": "main", "surface": "tab-a"})
	var only struct {
		Window map[string]any   `json:"window"`
		Groups []map[string]any `json:"groups"`
	}
	if err := json.Unmarshal(one.Result, &only); err != nil || len(only.Groups) != 1 || only.Groups[0]["surface"] != "tab-a" || only.Window["window"] != "main" {
		t.Fatalf("the snapshot of tab-a is %s: %v", one.Result, err)
	}

	// A part of the page that is no object, whose groups are no array or that lacks a member is refused.
	for i, message := range []string{
		"page exposure.snapshot is [], not an object",
		"page exposure.snapshot groups is {}, not an array",
		"page exposure.snapshot has no unregistered",
	} {
		refused := call(t, conn, 4+i, "exposure.snapshot", map[string]any{"window": "main"})
		if refused.Error == nil || refused.Error.Code != -32603 || refused.Error.Message != message {
			t.Fatalf("the part %d gave %s %v, want -32603 %s", i, refused.Result, refused.Error, message)
		}
	}
}

// mustText is value as JSON text.
func mustText(t *testing.T, value any) string {
	t.Helper()
	text, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}
