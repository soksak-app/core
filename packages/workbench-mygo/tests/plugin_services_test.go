package workbench_test

// The services that a view of a plugin calls: its project data, the files dropped on it and its notices.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"
)

// terminalSurface returns a surface of the plugin terminal, which the view calls of these tests name.
func terminalSurface(t *testing.T, stored *surfaceHost) string {
	t.Helper()
	for id, surface := range stored.lastSurfaces(t) {
		if surface["plugin"] == "textprobe" {
			return id
		}
	}
	t.Fatal("no surface of the plugin textprobe")
	return ""
}

// dataEvents returns the keys that the view events of surface report as changed.
func dataEvents(t *testing.T, stored *surfaceHost, surface string) []string {
	t.Helper()
	keys := []string{}
	for _, line := range stored.hostName {
		text, found := strings.CutPrefix(line, "viewEvent ")
		if !found {
			continue
		}
		var event struct {
			Surface string `json:"surface"`
			Event   string `json:"event"`
			Data    struct {
				Key string `json:"key"`
			} `json:"data"`
		}
		if err := json.Unmarshal([]byte(text), &event); err != nil {
			t.Fatal(err)
		}
		if event.Surface == surface && event.Event == "data" {
			keys = append(keys, event.Data.Key)
		}
	}
	return keys
}

func failure(t *testing.T, reply map[string]any) string {
	t.Helper()
	refused, ok := reply["error"].(map[string]any)
	if !ok {
		t.Fatalf("the reply %v is no refusal", reply)
	}
	return refused["message"].(string)
}

func storedData(t *testing.T, stored *surfaceHost) string {
	t.Helper()
	text, err := json.Marshal(stored.projects[0]["plugins"])
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

// contract: project-data.write.keeps-the-keys-before-it
func TestTwoWritesInARowKeepBothKeys(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	for id, write := range []map[string]any{{"key": "marks", "value": []string{"one"}}, {"key": "notes", "value": "two"}} {
		f.shell.Event("view-call", []any{map[string]any{"surface": surface, "plugin": "textprobe", "generation": 1, "id": id + 1, "command": "runtime.data.set", "params": write}})
	}
	f.settle()
	if got := storedData(t, stored); got != `{"textprobe":{"marks":{"format":1,"value":["one"]},"notes":{"format":2,"value":"two"}}}` {
		t.Fatalf("the project stores %s", got)
	}
}

// contract: project-data.replace.changed-value-writes-nothing
func TestTwoReplacesFromOneReadKeepTheFirstAndTheSecondAnswersFalse(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	for id, value := range []string{"first", "second"} {
		f.shell.Event("view-call", []any{map[string]any{"surface": surface, "plugin": "textprobe", "generation": 1, "id": id + 1,
			"command": "runtime.data.replace", "params": map[string]any{"key": "marks", "base": []string{"start"}, "value": []string{value}}}})
	}
	f.settle()
	answers := map[float64]any{}
	for _, reply := range stored.replies {
		answers[reply["id"].(float64)] = reply["result"]
	}
	if answers[1] != true || answers[2] != false {
		t.Fatalf("the replaces answer %v", answers)
	}
	if got := storedData(t, stored); !strings.Contains(got, `"value":["first"]`) {
		t.Fatalf("the project stores %s", got)
	}
}

// projectDataValues returns the stored values and bases that every host answers alike.
func projectDataValues(t *testing.T) []struct {
	Stored string `json:"stored"`
	Base   string `json:"base"`
	Same   bool   `json:"same"`
} {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "spec", "cases", "project-data", "values.json"))
	if err != nil {
		t.Fatal(err)
	}
	var values []struct {
		Stored string `json:"stored"`
		Base   string `json:"base"`
		Same   bool   `json:"same"`
	}
	if err := json.Unmarshal(text, &values); err != nil {
		t.Fatal(err)
	}
	return values
}

// storePoint stores the JSON text of a value of the key point, as the store answers it, and lets the window read it.
func storePoint(f *shellFixture, stored *surfaceHost, text string) {
	stored.projects[0]["plugins"] = map[string]any{"textprobe": map[string]any{"point": map[string]any{"format": 1, "value": json.RawMessage(text)}}}
	f.shell.Event("workspace-changed", nil)
	f.settle()
}

// contract: project-data.replace.compares-json-values
func TestAReplaceComparesJSONValuesWhateverTheFormOfTheirText(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	for _, value := range projectDataValues(t) {
		storePoint(f, stored, value.Stored)
		reply := viewCall(t, f, stored, surface, "runtime.data.replace", map[string]any{"key": "point", "base": json.RawMessage(value.Base), "value": map[string]any{"next": 1}})
		if reply["result"] != value.Same {
			t.Errorf("%s against %s: the reply is %v", value.Stored, value.Base, reply)
		}
	}
}

// contract: project-data.replace.read-value-is-its-base
func TestTheValueThatAReadAnsweredIsABaseThatAReplaceAccepts(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	for _, value := range projectDataValues(t) {
		storePoint(f, stored, value.Stored)
		read := viewCall(t, f, stored, surface, "runtime.data.get", map[string]any{"key": "point"})
		reply := viewCall(t, f, stored, surface, "runtime.data.replace", map[string]any{"key": "point", "base": read["result"], "value": map[string]any{"next": 1}})
		if reply["result"] != true {
			t.Errorf("%s: the reply is %v", value.Stored, reply)
		}
	}
}

// contract: project-data.replace.refusal-answers-the-view
func TestAStoreThatRefusesAReplaceAnswersTheViewAndKeepsTheValue(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	refused := errors.New("the disk is full")
	stored.failing = map[string]error{"workspace": refused}
	reply := viewCall(t, f, stored, surface, "runtime.data.replace", map[string]any{"key": "marks", "base": []string{"start"}, "value": []string{"lost"}})
	stored.failing = nil
	if got := failure(t, reply); got != refused.Error() {
		t.Fatalf("the replace is refused with %q", got)
	}
	reply = viewCall(t, f, stored, surface, "runtime.data.get", map[string]any{"key": "marks"})
	if text, _ := json.Marshal(reply["result"]); string(text) != `["start"]` {
		t.Fatalf("the reply is %v", reply)
	}
}

// contract: project-data.replace.requires-base
func TestAReplaceRequiresItsBase(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	reply := viewCall(t, f, stored, surface, "runtime.data.replace", map[string]any{"key": "marks", "value": []string{"next"}})
	if got := failure(t, reply); got != "view call runtime.data.replace requires base" {
		t.Fatalf("the replace is refused with %q", got)
	}
}

// contract: project-data.write.refusal-answers-the-view
func TestAStoreThatRefusesAWriteAnswersTheViewAndKeepsTheValue(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	refused := errors.New("the disk is full")
	stored.failing = map[string]error{"workspace": refused}
	reply := viewCall(t, f, stored, surface, "runtime.data.set", map[string]any{"key": "marks", "value": []string{"lost"}})
	stored.failing = nil
	if got := failure(t, reply); got != refused.Error() {
		t.Fatalf("the write is refused with %q", got)
	}
	reply = viewCall(t, f, stored, surface, "runtime.data.get", map[string]any{"key": "marks"})
	if text, _ := json.Marshal(reply["result"]); string(text) != `["start"]` {
		t.Fatalf("the reply is %v", reply)
	}
}

func TestAWriteOfAnotherWindowReachesTheViewsThatFollowTheData(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	viewCall(t, f, stored, surface, "runtime.data.on", nil)
	stored.projects[0]["plugins"] = map[string]any{"textprobe": map[string]any{"marks": map[string]any{"format": 1, "value": []string{"other"}}}}
	f.shell.Event("workspace-changed", nil)
	f.settle()
	if got := dataEvents(t, stored, surface); len(got) != 1 || got[0] != "marks" {
		t.Fatalf("the view heard %v", got)
	}
	reply := viewCall(t, f, stored, surface, "runtime.data.get", map[string]any{"key": "marks"})
	if text, _ := json.Marshal(reply["result"]); string(text) != `["other"]` {
		t.Fatalf("the reply is %v", reply)
	}
	f.shell.Event("workspace-changed", nil)
	f.settle()
	if got := dataEvents(t, stored, surface); len(got) != 1 {
		t.Fatalf("a store without a change was heard: %v", got)
	}
}

func dropText(t *testing.T, x, y float64) string {
	t.Helper()
	text, err := json.Marshal(map[string]any{"urls": []string{"file:///work/a.txt"}, "x": x, "y": y})
	if err != nil {
		t.Fatal(err)
	}
	return string(text)
}

func dropStatus(t *testing.T, f *shellFixture) map[string]any {
	t.Helper()
	value, err := f.shell.Registry().Read("core.drop")
	if err != nil {
		t.Fatal(err)
	}
	text, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var status map[string]any
	if err := json.Unmarshal([]byte(text), &status); err != nil {
		t.Fatal(err)
	}
	return status
}

// droppedWith settles a drop that ended in a failure, which the shell writes to the application log.
func droppedWith(t *testing.T, f *shellFixture, line string) {
	t.Helper()
	f.pending.drain(t)
	if len(f.lines) != 1 || f.lines[0] != line {
		t.Fatalf("the shell reported %q", f.lines)
	}
	f.lines = nil
	f.settle()
}

func middle(surface map[string]any) (float64, float64) {
	return surface["x"].(float64) + surface["w"].(float64)/2, surface["y"].(float64) + surface["h"].(float64)/2
}

func TestAFileDroppedOnAViewRunsTheDropCommandOfItsPlugin(t *testing.T) {
	r := newViewRelay(t)
	f, stored := r.f, r.stored
	surface := terminalSurface(t, stored)
	r.call(surface, "runtime.command.register", map[string]any{"name": "textprobe.drop"})
	x, y := middle(stored.lastSurfaces(t)[surface])
	f.shell.Event("files-dropped", []any{dropText(t, x, y)})
	request := r.request(0)
	if request["surface"] != surface || request["command"] != "textprobe.drop" {
		t.Fatalf("the view took %v", request)
	}
	if text, _ := json.Marshal(request["params"]); string(text) != `{"urls":["file:///work/a.txt"]}` {
		t.Fatalf("the command took %s", text)
	}
	f.shell.Event("view-reply", []any{map[string]any{"surface": surface, "id": request["id"], "result": nil}})
	var status map[string]any
	f.until(func() bool {
		status = dropStatus(t, f)
		return status["command"] != nil
	})
	if status["surface"] != surface || status["command"] != "textprobe.drop" || status["error"] != nil || status["x"] != x {
		t.Fatalf("core.drop is %v", status)
	}
}

func TestADropOutsideEveryViewIsRecordedAsItsReason(t *testing.T) {
	f, _ := surfaceShell(t)
	f.shell.Event("files-dropped", []any{dropText(t, 1, 1)})
	droppedWith(t, f, "drop: no surface is under the drop point")
	if status := dropStatus(t, f); status["error"] != "no surface is under the drop point" || status["surface"] != nil {
		t.Fatalf("core.drop is %v", status)
	}
}

func TestADropOfTextThatIsNoDropIsRecordedAsItsReason(t *testing.T) {
	f, _ := surfaceShell(t)
	f.shell.Event("files-dropped", []any{`{"urls":[],"x":1,"y":1}`})
	droppedWith(t, f, "drop: the application sent an invalid file drop")
	if status := dropStatus(t, f); status["error"] != "the application sent an invalid file drop" {
		t.Fatalf("core.drop is %v", status)
	}
}

func TestADropOnAViewWhosePluginDeclaresNoDropIsRecordedAsItsReason(t *testing.T) {
	f, stored := surfaceShellOf(t, strings.ReplaceAll(installedDocument, `"drop": "textprobe.drop", `, ""))
	x, y := middle(stored.lastSurfaces(t)[terminalSurface(t, stored)])
	f.shell.Event("files-dropped", []any{dropText(t, x, y)})
	droppedWith(t, f, "drop: plugin textprobe declares no drop command")
	if status := dropStatus(t, f); status["error"] != "plugin textprobe declares no drop command" {
		t.Fatalf("core.drop is %v", status)
	}
}

// otherCard splits the focused card, so that the view of the first card is not visible as a notice sees it.
func otherCard(t *testing.T, f *shellFixture, stored *surfaceHost) string {
	t.Helper()
	surface := terminalSurface(t, stored)
	f.run("core.card.split", map[string]string{"card": f.tabbedCards()[0], "side": "right", "plugin": "textprobe"})
	f.run("core.card.focus", map[string]string{"card": f.tabbedCards()[1]})
	return surface
}

func notifications(t *testing.T, f *shellFixture) map[string]any {
	t.Helper()
	value, err := f.shell.Registry().Read("core.notifications")
	if err != nil {
		t.Fatal(err)
	}
	text, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var status map[string]any
	if err := json.Unmarshal([]byte(text), &status); err != nil {
		t.Fatal(err)
	}
	return status
}

func hostCalls(stored *surfaceHost, name string) []string {
	calls := []string{}
	for _, line := range stored.hostName {
		if text, found := strings.CutPrefix(line, name+" "); found {
			calls = append(calls, text)
		}
	}
	return calls
}

func TestANoticeOfTheVisibleTabChangesNothing(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	if reply := viewCall(t, f, stored, surface, "tab.notify", map[string]any{"text": "done", "policy": "system"}); reply["error"] != nil {
		t.Fatalf("the reply is %v", reply)
	}
	if got := hostCalls(stored, "notify"); len(got) != 0 {
		t.Fatalf("the visible tab posted %v", got)
	}
}

func TestANoticeOfASystemPolicyIsPostedAndLeavesWhenItsTabIsShown(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := otherCard(t, f, stored)
	viewCall(t, f, stored, surface, "tab.notify", map[string]any{"text": "the build ended", "policy": "system"})
	posted := hostCalls(stored, "notify")
	if len(posted) != 1 || !strings.Contains(posted[0], `"surface":"`+surface+`"`) || !strings.Contains(posted[0], `"body":"the build ended"`) {
		t.Fatalf("the host took %v", posted)
	}
	viewCall(t, f, stored, surface, "tab.notify", map[string]any{"text": "the build ended", "policy": "system"})
	if got := hostCalls(stored, "notify"); len(got) != 1 {
		t.Fatalf("the same notice is posted again: %v", got)
	}
	f.shell.Event("notification-posted", []any{map[string]any{"surface": surface}})
	f.settle()
	if status := notifications(t, f); len(status["posted"].([]any)) != 1 {
		t.Fatalf("core.notifications is %v", status)
	}
	f.run("core.card.focus", map[string]string{"card": f.tabbedCards()[0]})
	f.settle()
	if got := hostCalls(stored, "notificationRemove"); len(got) != 1 || !strings.Contains(got[0], surface) {
		t.Fatalf("the host removed %v", got)
	}
	if status := notifications(t, f); len(status["posted"].([]any)) != 0 {
		t.Fatalf("core.notifications is %v", status)
	}
}

func TestPressingANotificationSelectsItsTab(t *testing.T) {
	f, _ := surfaceShell(t)
	f.shell.Event("notification-activated", []any{map[string]any{"surface": "tab-gone"}})
	f.settle()
	if status := notifications(t, f); !strings.HasPrefix(status["error"].(string), "activate: ") {
		t.Fatalf("core.notifications is %v", status)
	}
	f.shell.Event("notification-state", []any{map[string]any{"authorization": "denied"}})
	f.settle()
	if status := notifications(t, f); status["authorization"] != "denied" || status["error"] != nil {
		t.Fatalf("core.notifications is %v", status)
	}
}

func TestATabNoticeIsRefusedOutsideItsForm(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	for params, want := range map[string]string{
		`{"text":""}`:                                  "a tab notice must be 1 to 1024 characters without control characters",
		`{"text":"a\u0007"}`:                           "a tab notice must be 1 to 1024 characters without control characters",
		`{"text":"a","policy":"loud"}`:                 "unknown tab notice policy: loud",
		`{"text":"` + strings.Repeat("a", 1025) + `"}`: "a tab notice must be 1 to 1024 characters without control characters",
	} {
		if got := failure(t, viewCall(t, f, stored, surface, "tab.notify", json.RawMessage(params))); got != want {
			t.Fatalf("%.40s is refused with %q", params, got)
		}
	}
}

// labelled tells whether an element of nodes carries the label.
func labelled(nodes []ui.ElementNode, label string) bool {
	for _, node := range nodes {
		if node.Label == label || labelled(node.Children, label) {
			return true
		}
	}
	return false
}

func TestATabNoticeMarksItsTabUntilItIsShown(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := otherCard(t, f, stored)
	viewCall(t, f, stored, surface, "tab.notify", map[string]any{"text": "look"})
	if len(hostCalls(stored, "notify")) != 0 {
		t.Fatal("a tab notice reached the notification center")
	}
	if !labelled(f.tester.ElementTree(), "look") {
		t.Fatal("the tab shows no mark")
	}
	f.run("core.card.focus", map[string]string{"card": f.tabbedCards()[0]})
	f.settle()
	if labelled(f.tester.ElementTree(), "look") {
		t.Fatal("the mark stays on a tab that is shown")
	}
}

func TestAPressOfTheHostFocusesTheCardOfItsView(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := otherCard(t, f, stored)
	f.shell.Event("surface-pressed", []any{surface})
	f.settle()
	reply := viewCall(t, f, stored, surface, "tab.notify", map[string]any{"text": "seen", "policy": "system"})
	if reply["error"] != nil || len(hostCalls(stored, "notify")) != 0 {
		t.Fatalf("the pressed view is not the visible tab: %v %v", reply, hostCalls(stored, "notify"))
	}
}

func TestADropOnAViewBehindTheDebugViewIsRecordedAsItsReason(t *testing.T) {
	f, stored := surfaceShell(t)
	x, y := middle(stored.lastSurfaces(t)[terminalSurface(t, stored)])
	f.do("core.debug.open", nil)
	f.shell.Event("files-dropped", []any{dropText(t, x, y)})
	droppedWith(t, f, "drop: no surface is under the drop point")
}

func TestANotificationIsNamedAsItsTabIsNamed(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := otherCard(t, f, stored)
	viewCall(t, f, stored, surface, "tab.title", "builds")
	viewCall(t, f, stored, surface, "tab.modified", true)
	viewCall(t, f, stored, surface, "tab.notify", map[string]any{"text": "the build ended", "policy": "system"})
	posted := hostCalls(stored, "notify")
	if len(posted) != 1 || !strings.Contains(posted[0], `"title":"● builds"`) {
		t.Fatalf("the host took %v", posted)
	}
}

// contract: project-data.write.outran-read-keeps-the-write
func TestASnapshotThatAWriteOutranKeepsTheWrite(t *testing.T) {
	f, stored := surfaceShell(t)
	surface := terminalSurface(t, stored)
	viewCall(t, f, stored, surface, "runtime.data.on", nil)
	write := func(id int, key string, value any) {
		f.shell.Event("view-call", []any{map[string]any{"surface": surface, "plugin": "textprobe", "generation": 1, "id": id,
			"command": "runtime.data.set", "params": map[string]any{"key": key, "value": value}}})
	}
	// The store answers the first write with its event, whose read stands in the order before the second write.
	write(1, "marks", []string{"one"})
	f.shell.Event("workspace-changed", nil)
	write(2, "notes", "two")
	f.settle()
	viewCall(t, f, stored, surface, "runtime.data.set", map[string]any{"key": "marks", "value": []string{"three"}})
	if got := storedData(t, stored); !strings.Contains(got, `"notes":{"format":2,"value":"two"}`) {
		t.Fatalf("the project stores %s", got)
	}
	if got := strings.Join(dataEvents(t, stored, surface), " "); got != "marks notes marks" {
		t.Fatalf("the view heard %s", got)
	}
}
