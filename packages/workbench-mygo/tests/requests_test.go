// A request of the endpoint reaches the registry of the workbench and its answer returns through the host call exposureReply, in
// the shapes that the relay of docs/spec/exposure.md gives the main page.
package workbench_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// relay is the host side of one window: it delivers requests to the workbench and records the calls that come back.
type relay struct {
	t        *testing.T
	queue    steps
	requests *workbench.Requests
	replies  chan string
	changes  chan string
	failures []string
}

func newRelay(t *testing.T, registry *workbench.Registry) *relay {
	r := &relay{t: t, queue: make(steps, 64), replies: make(chan string, 8), changes: make(chan string, 8)}
	record := func(into chan string) workbench.HostCall {
		return func(_ context.Context, argument json.RawMessage) (any, error) {
			into <- string(argument)
			return nil, nil
		}
	}
	calls := workbench.NewCalls(map[string]workbench.HostCall{
		"exposureReply":   record(r.replies),
		"exposureChanged": record(r.changes),
	}, r.queue.post)
	r.requests = workbench.NewRequests(registry, calls, r.queue.post, func(line string) { r.failures = append(r.failures, line) })
	return r
}

// ask delivers one request as the event exposure-request of the host and answers with the reply that the host receives.
func (r *relay) ask(method, params string) map[string]any {
	r.t.Helper()
	r.requests.Deliver(map[string]any{"id": uint64(7), "method": method, "params": json.RawMessage(params)})
	r.queue.run()
	var reply map[string]any
	if err := json.Unmarshal([]byte(<-r.replies), &reply); err != nil {
		r.t.Fatal(err)
	}
	r.queue.run()
	return reply
}

// refused returns the code and the message of a reply, and fails when the reply carries a result.
func (r *relay) refused(reply map[string]any) (int, string) {
	r.t.Helper()
	if _, carries := reply["result"]; carries {
		r.t.Fatalf("the reply %v carries a result", reply)
	}
	failure, ok := reply["error"].(map[string]any)
	if !ok {
		r.t.Fatalf("the reply %v has no error", reply)
	}
	return int(failure["code"].(float64)), failure["message"].(string)
}

func TestACommandRequestRunsInAStepAndItsResultReachesTheHost(t *testing.T) {
	declared := registry(t)
	r := newRelay(t, declared)
	var received string
	inStep := false
	stepping := false
	declared.Command("core.card.split", func(params json.RawMessage) (any, error) {
		received, inStep = string(params), stepping
		return map[string]any{"card": "c2", "tab": "t2"}, nil
	})
	r.requests.Deliver(map[string]any{"id": uint64(7), "method": "command.run",
		"params": json.RawMessage(`{"name":"core.card.split","params":{"card":"c1","side":"right"}}`)})
	if received != "" {
		t.Fatal("the command ran outside a step")
	}
	stepping = true
	r.queue.run()
	stepping = false
	if !inStep {
		t.Fatal("the command did not run in a step")
	}
	if received != `{"card":"c1","side":"right"}` {
		t.Fatalf("the command received %s", received)
	}
	var reply map[string]any
	if err := json.Unmarshal([]byte(<-r.replies), &reply); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"id": float64(7), "result": map[string]any{"card": "c2", "tab": "t2"}}
	if !reflect.DeepEqual(reply, want) {
		t.Fatalf("the reply is %v, want %v", reply, want)
	}
}

func TestARequestIsRefusedAsThePageRefusesIt(t *testing.T) {
	declared := registry(t)
	declared.Command("core.card.split", func(json.RawMessage) (any, error) { return nil, nil })
	r := newRelay(t, declared)
	const cidsText = "command cids must be an array of non-empty strings without a quote, a backslash or a control character"
	for _, row := range []struct {
		method, params string
		code           int
		message        string
	}{
		{"command.run", `{"name":"core.card.close","params":{}}`, 1002, "command core.card.close is not registered"},
		{"command.run", `{"name":"core.absent","params":{}}`, 1001, "unknown command core.absent"},
		{"command.run", `{"name":"plugin.absent.run","params":{}}`, 1001, "unknown command plugin.absent.run"},
		{"command.run", `{"params":{}}`, -32602, "command.run requires name"},
		{"command.run", `{"name":7}`, -32602, "command.run requires name"},
		{"command.run", `[]`, -32602, "command.run requires name"},
		{"command.run", `{"name":"core.card.split"}`, -32602, "command.run for core.card.split requires params"},
		{"command.run", `{"name":"core.card.split","params":[]}`, -32602, "command.run for core.card.split requires params"},
		{"command.run", `{"name":"core.card.split","params":{"side":"middle"}}`, -32602, "invalid params for core.card.split"},
		{"command.run", `{"name":"core.card.split","params":{},"cids":[""]}`, -32602, "command.run for core.card.split: " + cidsText},
		{"command.run", `{"name":"core.card.split","params":{},"cids":"a"}`, -32602, "command.run for core.card.split: " + cidsText},
		{"status.get", `{"name":"core.screen"}`, 1002, "status core.screen is not registered"},
		{"status.get", `{"name":"core.absent"}`, 1001, "unknown status core.absent"},
		{"status.watch", `{"name":"core.screen"}`, 1002, "status core.screen is not registered"},
		{"status.watch", `{"name":"core.absent"}`, 1001, "unknown status core.absent"},
		{"element.rect", `{"name":"core.card"}`, 1002, "element core.card has no element"},
		{"element.act", `{"name":"core.card","action":"click"}`, 1002, "element core.card has no element"},
		{"element.rect", `{"name":"core.absent"}`, 1001, "unknown element core.absent"},
		{"element.rect", `{"name":"core.card","address":"a"}`, -32602, "element core.card takes no address"},
		{"element.rect", `{"name":"core.card","address":"a","index":1}`, -32602, "a request gives index or address, not both"},
		{"diagnostics.fixture", `{}`, -32601, "unknown method diagnostics.fixture"},
	} {
		code, message := r.refused(r.ask(row.method, row.params))
		if code != row.code || message != row.message {
			t.Errorf("%s %s: refused with %d %q, want %d %q", row.method, row.params, code, message, row.code, row.message)
		}
	}
}

func TestAFailedCommandAnswersWithItsCode(t *testing.T) {
	declared := registry(t)
	declared.Command("core.card.split", func(json.RawMessage) (any, error) {
		return nil, workbench.Refuse(workbench.InvalidParams, "card %s does not exist", "c9")
	})
	declared.Command("core.card.close", func(json.RawMessage) (any, error) { return nil, errors.New("the grid refused") })
	r := newRelay(t, declared)
	if code, message := r.refused(r.ask("command.run", `{"name":"core.card.split","params":{}}`)); code != -32602 || message != "card c9 does not exist" {
		t.Fatalf("a refusal answered %d %q", code, message)
	}
	if code, message := r.refused(r.ask("command.run", `{"name":"core.card.close","params":{}}`)); code != -32000 || message != "the grid refused" {
		t.Fatalf("a failure answered %d %q", code, message)
	}
}

func TestACommandWithoutAResultAnswersNull(t *testing.T) {
	declared := registry(t)
	declared.Command("core.card.close", func(json.RawMessage) (any, error) { return nil, nil })
	r := newRelay(t, declared)
	reply := r.ask("command.run", `{"name":"core.card.close","params":{}}`)
	if value, carries := reply["result"]; !carries || value != nil {
		t.Fatalf("the reply is %v", reply)
	}
}

func TestAStatusRequestAnswersItsValue(t *testing.T) {
	declared := registry(t)
	declared.Status("core.screen", func() any { return map[string]any{"screen": "workspace", "modal": nil} })
	r := newRelay(t, declared)
	want := map[string]any{"id": float64(7), "result": map[string]any{"screen": "workspace", "modal": nil}}
	if reply := r.ask("status.get", `{"name":"core.screen"}`); !reflect.DeepEqual(reply, want) {
		t.Fatalf("the reply is %v, want %v", reply, want)
	}
}

func TestTheListGivesEveryDeclarationWithItsRegistration(t *testing.T) {
	declared := registry(t)
	declared.Command("core.card.split", func(json.RawMessage) (any, error) { return nil, nil })
	declared.Status("core.screen", func() any { return nil })
	r := newRelay(t, declared)
	reply := r.ask("exposure.list", `{}`)
	list, ok := reply["result"].(map[string]any)
	if !ok {
		t.Fatalf("the reply is %v", reply)
	}
	names, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	for key, count := range map[string]int{"status": len(names.Statuses), "commands": len(names.Commands), "element": len(names.Elements)} {
		if entries, _ := list[key].([]any); len(entries) != count {
			t.Fatalf("%s lists %d entries, want %d", key, len(entries), count)
		}
	}
	find := func(key, name string) map[string]any {
		for _, entry := range list[key].([]any) {
			if entry.(map[string]any)["name"] == name {
				return entry.(map[string]any)
			}
		}
		t.Fatalf("%s does not list %s", key, name)
		return nil
	}
	split := find("commands", "core.card.split")
	if split["registered"] != true || !strings.HasPrefix(split["description"].(string), "Splits a card") {
		t.Fatalf("the entry is %v", split)
	}
	if _, declares := split["params"].(map[string]any)["properties"].(map[string]any)["side"]; !declares {
		t.Fatalf("the entry has lost its params: %v", split)
	}
	if find("commands", "core.card.close")["registered"] != false || find("status", "core.screen")["registered"] != true ||
		find("element", "core.card")["registered"] != false {
		t.Fatalf("the registrations are wrong: %v", list)
	}
}

func TestAWatchSendsTheCurrentValueAndEachChange(t *testing.T) {
	declared := registry(t)
	screen := "library"
	declared.Status("core.screen", func() any { return map[string]any{"screen": screen} })
	r := newRelay(t, declared)
	reply := r.ask("status.watch", `{"name":"core.screen"}`)
	if value, carries := reply["result"]; !carries || value != nil {
		t.Fatalf("the watch answered %v", reply)
	}
	change := func() string {
		t.Helper()
		line := <-r.changes
		r.queue.run()
		return line
	}
	if line := change(); line != `{"name":"core.screen","value":{"screen":"library"}}` {
		t.Fatalf("the first value is %s", line)
	}
	declared.Changed()
	if len(r.changes) != 0 {
		t.Fatal("an unchanged value was sent")
	}
	screen = "workspace"
	declared.Changed()
	if line := change(); line != `{"name":"core.screen","value":{"screen":"workspace"}}` {
		t.Fatalf("the change is %s", line)
	}
	if reply := r.ask("status.unwatch", `{"name":"core.screen"}`); reply["result"] != nil {
		t.Fatalf("the end of the watch answered %v", reply)
	}
	screen = "library"
	declared.Changed()
	if len(r.changes) != 0 {
		t.Fatal("a value was sent after the watch ended")
	}
	if reply := r.ask("status.unwatch", `{"name":"core.window.workbench"}`); reply["result"] != nil || reply["error"] != nil {
		t.Fatalf("the end of an absent watch answered %v", reply)
	}
}

func TestARefusedReplyIsReported(t *testing.T) {
	declared := registry(t)
	queue := make(steps, 8)
	calls := workbench.NewCalls(map[string]workbench.HostCall{
		"exposureReply": func(context.Context, json.RawMessage) (any, error) { return nil, errors.New("no matching request") },
	}, queue.post)
	var failures []string
	requests := workbench.NewRequests(declared, calls, queue.post, func(line string) { failures = append(failures, line) })
	requests.Deliver(map[string]any{"id": uint64(7), "method": "exposure.list", "params": json.RawMessage(`{}`)})
	queue.run()
	queue.run()
	if !reflect.DeepEqual(failures, []string{"exposure reply: no matching request"}) {
		t.Fatalf("the failures are %v", failures)
	}
}

func TestARequestThatCannotBeReadIsReported(t *testing.T) {
	r := newRelay(t, registry(t))
	r.requests.Deliver()
	r.requests.Deliver(map[string]any{"id": "seven"})
	r.queue.run()
	r.queue.run()
	if len(r.failures) != 2 || !strings.HasPrefix(r.failures[0], "exposure request: ") || !strings.HasPrefix(r.failures[1], "exposure request: ") {
		t.Fatalf("the failures are %v", r.failures)
	}
}

// drawnElements are the elements of a Tester, as a window gives them to the registry.
type drawnElements struct{ tester *ui.Tester }

func (d drawnElements) ElementTree() ([]ui.ElementNode, error) { return d.tester.ElementTree(), nil }

func (d drawnElements) ActElement(id uint64, action ui.Actions, text string) error {
	return d.tester.ActElement(id, action, text)
}

// elementScene draws two cards, a name that the declaration does not mark many twice, a button that a screen named, and a text
// field, and answers with the relay of its registry, the tester, the commands that ran and the value of the field.
func elementScene(t *testing.T) (*relay, *ui.Tester, *[]string, *string) {
	declared := registry(t)
	var ran []string
	declared.Command("core.card.focus", func(params json.RawMessage) (any, error) {
		ran = append(ran, string(params))
		return nil, nil
	})
	binder := workbench.NewBinder(declared, func(_ string, err error) { t.Error(err) })
	value := "before"
	tester := ui.NewTester(func(c *ui.Context) {
		ui.Column(c).Fill().Children(func() {
			for _, card := range []string{"c1", "c2"} {
				binder.Press(c, "core.card", "core.card.focus", card, map[string]string{"card": card}).Role(ui.RoleGroup).Label(card).Size(100, 40)
			}
			ui.Button(c.Key(workbench.Exposed{Name: "core.debug.close"}), "close")
			ui.Button(c.Key(workbench.Exposed{Name: "core.library.add", Item: "one"}), "add one")
			ui.Button(c.Key(workbench.Exposed{Name: "core.library.add", Item: "two"}), "add two")
			c.Key(workbench.Exposed{Name: "core.library.form.name"})
			ui.TextInput(c, &value).Label("name")
		})
	}, 400, 300)
	declared.Elements(drawnElements{tester})
	return newRelay(t, declared), tester, &ran, &value
}

func TestAnElementRequestAnswersFromTheElementTree(t *testing.T) {
	r, tester, _, _ := elementScene(t)
	var second ui.ElementNode
	for _, node := range tester.ElementTree() {
		if node.Label == "c2" {
			second = node
		}
	}
	want := map[string]any{"x": float64(second.Bounds.X), "y": float64(second.Bounds.Y), "width": float64(second.Bounds.W),
		"height": float64(second.Bounds.H), "zoom": float64(1), "document": map[string]any{"x": float64(0), "y": float64(0)}}
	if reply := r.ask("element.rect", `{"name":"core.card","index":1}`); !reflect.DeepEqual(reply["result"], want) {
		t.Fatalf("the rectangle is %v, want %v", reply, want)
	}
	if reply := r.ask("element.rect", `{"name":"core.debug.close"}`); reply["error"] != nil {
		t.Fatalf("an element that a screen named answered %v", reply)
	}
	if second.Bounds.H <= 0 {
		t.Fatalf("the card has the box %+v", second.Bounds)
	}
}

func TestAnElementRequestIsRefusedAsThePageRefusesIt(t *testing.T) {
	r, _, _, _ := elementScene(t)
	for _, row := range []struct {
		method, params string
		code           int
		message        string
	}{
		{"element.rect", `{"name":"core.library.return"}`, 1002, "element core.library.return has no element"},
		{"element.rect", `{"name":"core.library.add"}`, 1002, "element core.library.add has 2 elements"},
		{"element.rect", `{"name":"core.card","index":2}`, 1002, "element core.card has no element at index 2"},
		{"element.rect", `{"name":"core.card","index":-1}`, -32602, "index must be a non-negative integer"},
		{"element.rect", `{"name":"core.card","index":1.5}`, -32602, "index must be a non-negative integer"},
		{"element.rect", `{"name":"core.card","index":null}`, -32602, "index must be a non-negative integer"},
		{"element.act", `{"name":"core.library.form.name","action":"input"}`, -32602, "input requires a string value"},
		{"element.act", `{"name":"core.card","action":"dispatch","event":{"type":"click"}}`, -32000, "the mygo workbench has no DOM events"},
		{"element.act", `{"name":"core.card","action":"hover"}`, -32602, "unknown action hover"},
		{"element.act", `{"name":"core.card"}`, -32602, "unknown action undefined"},
		{"element.act", `{"name":"core.card","action":"input","value":"x"}`, -32000, "element core.card takes no input"},
	} {
		code, message := r.refused(r.ask(row.method, row.params))
		if code != row.code || message != row.message {
			t.Errorf("%s %s: refused with %d %q, want %d %q", row.method, row.params, code, message, row.code, row.message)
		}
	}
}

func TestAnElementActionReachesTheElement(t *testing.T) {
	r, tester, ran, value := elementScene(t)
	if reply := r.ask("element.act", `{"name":"core.card","index":1,"action":"click"}`); reply["error"] != nil || reply["result"] != nil {
		t.Fatalf("the click answered %v", reply)
	}
	tester.Frame()
	if !reflect.DeepEqual(*ran, []string{`{"card":"c2"}`}) {
		t.Fatalf("the commands that ran are %v", *ran)
	}
	if reply := r.ask("element.act", `{"name":"core.library.form.name","action":"input","value":"after"}`); reply["error"] != nil {
		t.Fatalf("the input answered %v", reply)
	}
	tester.Frame()
	tester.Frame()
	if *value != "after" {
		t.Fatalf("the field holds %q", *value)
	}
}

func TestTheListReportsADrawnElementAsRegistered(t *testing.T) {
	r, _, _, _ := elementScene(t)
	list := r.ask("exposure.list", `{}`)["result"].(map[string]any)
	registered := map[string]any{}
	for _, entry := range list["element"].([]any) {
		registered[entry.(map[string]any)["name"].(string)] = entry.(map[string]any)["registered"]
	}
	if registered["core.card"] != true || registered["core.library.return"] != false {
		t.Fatalf("core.card is %v and core.library.return is %v", registered["core.card"], registered["core.library.return"])
	}
}
