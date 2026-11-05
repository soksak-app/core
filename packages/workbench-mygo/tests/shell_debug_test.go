// The debug view of a window: what the host calls answer reaches the dialog, and the commands of the view change it
// (docs/spec/debug.md).
package workbench_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

const debugStateText = `{"time":"t","host":"mygo","versions":{"core":"1"},"workbench":[],"windows":[]}`

// debugHost answers the debug host calls: the files by path, and the pages of logQuery in order.
type debugHost struct {
	files   map[string]string
	pages   []string
	queries []map[string]any
	records []string
	saved   []string
	texts   []string
	failing map[string]error
	saveAll string
}

// fixtureElements are the elements of the tester of a fixture, which is made after its shell.
type fixtureElements struct{ f *shellFixture }

func (e fixtureElements) ElementTree() ([]ui.ElementNode, error) {
	e.f.treeReads++
	tree := e.f.tester.ElementTree()
	if e.f.treeEdit != nil {
		e.f.treeEdit(tree)
	}
	return tree, nil
}

func (e fixtureElements) ActElement(id uint64, action ui.Actions, text string) error {
	return drawnElements{e.f.tester}.ActElement(id, action, text)
}

func logRow(seq, ts int) string {
	return fmt.Sprintf(`{"role":"app","boot":"b1","file":"f","offset":0,"event":{"ts_us":%d,"seq":%d,"level":"info","layer":"workbench","event":"step","surface":"s1","cids":["c1","c2"],"fields":{"z":1,"a":"text"}}}`, ts, seq)
}

func logPage(next string, rows ...int) string {
	parts := make([]string, len(rows))
	for index, seq := range rows {
		parts[index] = logRow(seq, seq*1000)
	}
	return fmt.Sprintf(`{"rows":[%s],"next":%s,"tail":{"app-b1":%d},"scanned":{}}`, strings.Join(parts, ","), next, slices.Max(append(rows, 0)))
}

func (h *debugHost) serve(table map[string]workbench.HostCall) {
	failure := func(name string) error { return h.failing[name] }
	table["debugRecord"] = func(_ context.Context, argument json.RawMessage) (any, error) {
		h.records = append(h.records, string(argument))
		return map[string]string{"path": "logs/state-b.json"}, failure("debugRecord")
	}
	table["debugFiles"] = func(context.Context, json.RawMessage) (any, error) {
		entries := []map[string]any{}
		for _, path := range slices.Sorted(mapKeys(h.files)) {
			entries = append(entries, map[string]any{"path": path, "size": len(h.files[path]), "modified": 1})
		}
		return entries, failure("debugFiles")
	}
	table["debugRead"] = func(_ context.Context, argument json.RawMessage) (any, error) {
		var request struct{ Path string }
		if err := json.Unmarshal(argument, &request); err != nil {
			return nil, err
		}
		text, found := h.files[request.Path]
		if !found {
			return nil, errors.New("no file " + request.Path)
		}
		if strings.HasSuffix(request.Path, ".png") {
			image := "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte(text))
			return map[string]any{"path": request.Path, "size": len(text), "kind": "image", "text": "", "image": image}, nil
		}
		return map[string]any{"path": request.Path, "size": len(text), "kind": "text", "text": text}, nil
	}
	table["logQuery"] = func(_ context.Context, argument json.RawMessage) (any, error) {
		var query map[string]any
		if err := json.Unmarshal(argument, &query); err != nil {
			return nil, err
		}
		h.queries = append(h.queries, query)
		if err := failure("logQuery"); err != nil {
			return nil, err
		}
		page := h.pages[0]
		h.pages = h.pages[1:]
		return json.RawMessage(page), nil
	}
	table["debugSave"] = func(_ context.Context, argument json.RawMessage) (any, error) {
		h.saved = append(h.saved, string(argument))
		return map[string]any{"saved": "/saved"}, failure("debugSave")
	}
	table["debugSaveText"] = func(_ context.Context, argument json.RawMessage) (any, error) {
		var request struct{ Name, Text string }
		if err := json.Unmarshal(argument, &request); err != nil {
			return nil, err
		}
		h.texts = append(h.texts, request.Text)
		return map[string]any{"saved": "/saved"}, nil
	}
	table["debugSaveAll"] = func(context.Context, json.RawMessage) (any, error) {
		return map[string]any{"saved": h.saveAll, "total": 2048}, nil
	}
}

func mapKeys(files map[string]string) func(yield func(string) bool) {
	return func(yield func(string) bool) {
		for path := range files {
			if !yield(path) {
				return
			}
		}
	}
}

func (f *shellFixture) status(name string) string {
	f.t.Helper()
	value, err := f.shell.Registry().Read(name)
	if err != nil {
		f.t.Fatal(err)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		f.t.Fatal(err)
	}
	return string(encoded)
}

// later runs a command that may answer in a later step and returns its failure.
func (f *shellFixture) later(name string, params any) error {
	f.t.Helper()
	raw, err := json.Marshal(params)
	if err != nil {
		f.t.Fatal(err)
	}
	var failed error
	f.shell.Registry().RunLater(name, raw, func(_ any, err error) { failed = err })
	f.flush()
	return failed
}

// flush runs the steps and the frames of a command that may show an error, which settle does not accept.
func (f *shellFixture) flush() {
	f.t.Helper()
	f.pending.drain(f.t)
	f.tester.Frame()
	f.pending.drain(f.t)
	f.tester.Frame()
}

func (f *shellFixture) do(name string, params any) {
	f.t.Helper()
	if err := f.later(name, params); err != nil {
		f.t.Fatal(err)
	}
	f.settle()
}

func debugShell(t *testing.T) (*shellFixture, *surfaceHost) {
	t.Helper()
	f, stored := surfaceShell(t)
	stored.debug.files = map[string]string{"logs/app.log": "first line", "logs/state-a.json": debugStateText, "logs/state-b.json": debugStateText}
	f.do("core.debug.open", nil)
	return f, stored
}

func TestTheHelpMenuOpensTheDebugView(t *testing.T) {
	f, stored := surfaceShell(t)
	stored.debug.files = map[string]string{"logs/app.log": "first line"}
	f.shell.Event("menu-command", []any{map[string]any{"name": "core.debug.open"}})
	f.settle()
	if !f.tester.HasText("logs/app.log") {
		t.Fatalf("no file in %q", f.tester.Texts())
	}
	status := f.status("core.debug")
	if !strings.Contains(status, `"open":true`) || !strings.Contains(status, `"recorded":"logs/state-b.json"`) {
		t.Fatalf("the status is %s", status)
	}
	if screen := f.status("core.screen"); !strings.Contains(screen, `"modal":"debug"`) {
		t.Fatalf("the screen is %s", screen)
	}
	if len(stored.debug.records) != 1 || !strings.Contains(stored.debug.records[0], `"name":"core.debug"`) {
		t.Fatalf("the record is %v", stored.debug.records)
	}
	f.audit()
	f.run("core.debug.close", nil)
	if f.tester.HasText("logs/app.log") {
		t.Fatal("the closed view is drawn")
	}
}

func TestAFailedStepOfOpeningIsShownAndTheNextStepRuns(t *testing.T) {
	f, stored := surfaceShell(t)
	stored.debug.files = map[string]string{"logs/app.log": "first line"}
	stored.debug.failing = map[string]error{"debugRecord": errors.New("no state")}
	if err := f.later("core.debug.open", nil); err != nil {
		t.Fatal(err)
	}
	if !f.tester.HasText("record: no state") || !f.tester.HasText("logs/app.log") {
		t.Fatalf("the view shows %q", f.tester.Texts())
	}
}

func TestSettingsCloseTheDebugView(t *testing.T) {
	f, _ := debugShell(t)
	f.run("core.settings.open", nil)
	if status := f.status("core.debug"); !strings.Contains(status, `"open":false`) {
		t.Fatalf("the status is %s", status)
	}
	f.do("core.debug.open", nil)
	if screen := f.status("core.screen"); !strings.Contains(screen, `"modal":"debug"`) {
		t.Fatalf("the screen is %s", screen)
	}
}

func TestViewShowsATextFileAndListReturns(t *testing.T) {
	f, _ := debugShell(t)
	f.do("core.debug.view", map[string]string{"path": "logs/app.log"})
	if !f.tester.HasText("first line") {
		t.Fatalf("no text in %q", f.tester.Texts())
	}
	if status := f.status("core.debug"); !strings.Contains(status, `"viewing":{"path":"logs/app.log","size":10,"truncated":false,"kind":"text","length":10}`) {
		t.Fatalf("the status is %s", status)
	}
	f.run("core.debug.list", nil)
	if f.tester.HasText("first line") {
		t.Fatal("the list still shows the file")
	}
}

func TestViewOfAnUnknownFileIsShown(t *testing.T) {
	f, _ := debugShell(t)
	if err := f.later("core.debug.view", map[string]string{"path": "logs/none"}); err == nil {
		t.Fatal("the read did not fail")
	}
	if !f.tester.HasText("view: no file logs/none") {
		t.Fatalf("the view shows %q", f.tester.Texts())
	}
}

func TestViewShowsAnImageOfTheDataURL(t *testing.T) {
	f, stored := debugShell(t)
	stored.debug.files["logs/captures/a.png"] = string(onePixel(t))
	f.do("core.debug.view", map[string]string{"path": "logs/captures/a.png"})
	if status := f.status("core.debug"); !strings.Contains(status, `"kind":"image"`) {
		t.Fatalf("the status is %s", status)
	}
	positional(t, f.tester, "core.debug.image", 0)
}

func TestACommandOfAClosedViewIsRefused(t *testing.T) {
	f, _ := surfaceShell(t)
	for _, name := range []string{"core.debug.view", "core.debug.state", "core.debug.timeline", "core.debug.save"} {
		if err := f.later(name, map[string]string{"path": "x"}); err == nil || err.Error() != "the debug view is not open" {
			t.Errorf("%s fails with %v", name, err)
		}
	}
	if err := f.later("core.debug.timeline.follow", map[string]bool{"on": true}); err == nil {
		t.Error("follow ran")
	}
}

func TestStateShowsTheTreeAndComparesAnotherFile(t *testing.T) {
	f, stored := debugShell(t)
	stored.debug.files["logs/state-b.json"] = strings.Replace(debugStateText, `"core":"1"`, `"core":"2"`, 1)
	f.do("core.debug.open", nil)
	f.do("core.debug.state", map[string]string{"path": "logs/state-a.json"})
	f.do("core.debug.state.compare", map[string]string{"with": "logs/state-b.json"})
	status := f.status("core.debug")
	if !strings.Contains(status, `"with":"logs/state-b.json","differences":1`) {
		t.Fatalf("the status is %s", status)
	}
	if !f.tester.HasText(`versions.core: "1" -> "2"`) {
		t.Fatalf("no difference in %q", f.tester.Texts())
	}
	f.do("core.debug.state.compare", map[string]string{"with": ""})
	if status := f.status("core.debug"); !strings.Contains(status, `"with":null,"differences":0`) {
		t.Fatalf("the status is %s", status)
	}
	if err := f.later("core.debug.state.compare", map[string]string{"with": "logs/state-a.json"}); err == nil {
		t.Fatal("the shown file compared with itself")
	}
	if err := f.later("core.debug.state", map[string]string{"path": "logs/app.log"}); err == nil {
		t.Fatal("a file outside the state files was shown")
	}
}

func timelineShell(t *testing.T, pages ...string) (*shellFixture, *surfaceHost) {
	t.Helper()
	f, stored := debugShell(t)
	stored.debug.pages = pages
	f.do("core.debug.timeline", nil)
	return f, stored
}

func TestTheTimelineDrawsTheNewestPageAsLines(t *testing.T) {
	f, stored := timelineShell(t, logPage("null", 2, 1))
	query := stored.debug.queries[0]
	if query["channel"] != "other" || query["level"] != "trace" || query["order"] != "desc" || query["limit"] != float64(500) || query["layer"] != nil {
		t.Fatalf("the query is %v", query)
	}
	want := `1970-01-01T00:00:00.001000Z info workbench step surface=s1 cids=c1,c2 z=1 a="text"`
	if !f.tester.HasText(want) {
		t.Fatalf("no line %q in %q", want, f.tester.Texts())
	}
	if status := f.status("core.debug"); !strings.Contains(status, `"following":true,"appended":0,"held":2`) {
		t.Fatalf("the status is %s", status)
	}
}

func TestANoticeOfAnEventFileAppendsWhatGrewOnce(t *testing.T) {
	f, stored := timelineShell(t, logPage("null", 2, 1))
	stored.debug.pages = []string{logPage("null", 2, 3)}
	f.shell.Event("debug-log-changed", []any{map[string]any{"path": "logs/app-b1.jsonl"}})
	f.settle()
	query := stored.debug.queries[1]
	if query["order"] != "asc" || query["since"] == nil {
		t.Fatalf("the query is %v", query)
	}
	if status := f.status("core.debug"); !strings.Contains(status, `"appended":1,"held":3`) {
		t.Fatalf("the status is %s", status)
	}
	f.shell.Event("debug-log-changed", []any{map[string]any{"path": "logs/other.txt"}})
	f.settle()
	if len(stored.debug.queries) != 2 {
		t.Fatalf("a file that is no event file asked %v", stored.debug.queries)
	}
}

func TestAFailedFollowStopsFollowing(t *testing.T) {
	f, stored := timelineShell(t, logPage("null", 1))
	stored.debug.failing = map[string]error{"logQuery": errors.New("no log")}
	f.shell.Event("debug-log-changed", []any{map[string]any{"path": "logs/app-b1.jsonl"}})
	f.flush()
	status := f.status("core.debug")
	if !strings.Contains(status, `"following":false`) || !strings.Contains(status, `"error":"follow: no log"`) {
		t.Fatalf("the status is %s", status)
	}
}

func TestOlderPutsThePageInFrontOfTheRows(t *testing.T) {
	cursor := `{"ts_us":3000,"role":"app","boot":"b1","seq":3}`
	f, stored := timelineShell(t, logPage(cursor, 5, 4), logPage("null", 3, 2))
	f.do("core.debug.timeline.older", nil)
	after, _ := stored.debug.queries[1]["after"].(map[string]any)
	if after["seq"] != float64(4) || stored.debug.queries[1]["limit"] != float64(500) {
		t.Fatalf("the query is %v", stored.debug.queries[1])
	}
	if status := f.status("core.debug"); !strings.Contains(status, `"held":4,"older":false`) {
		t.Fatalf("the status is %s", status)
	}
}

func TestTheFilterAsksForTheNewestPageWithItsMembers(t *testing.T) {
	f, stored := timelineShell(t, logPage("null", 1), logPage("null", 1))
	f.do("core.debug.timeline.filter", map[string]string{"text": "step", "from": "2026-10-08T22:53:20.5Z"})
	query := stored.debug.queries[1]
	if query["text"] != "step" || query["from_us"] != float64(1791500000500000) {
		t.Fatalf("the query is %v", query)
	}
	if status := f.status("core.debug"); !strings.Contains(status, `"text":"step"`) {
		t.Fatalf("the status is %s", status)
	}
}

func TestTheFilterRefusesWhatItDoesNotHold(t *testing.T) {
	f, _ := timelineShell(t, logPage("null", 1))
	for _, test := range []struct {
		change map[string]any
		want   string
	}{
		{map[string]any{"none": "x"}, "timeline filter has no member none"},
		{map[string]any{}, "timeline filter needs channel, level, class, layer, text, event, event_prefix, surface, session, cid, run, from, to"},
		{map[string]any{"text": 1}, "log query text must be a string, found 1"},
		{map[string]any{"from": "2026-02-30T00:00:00Z"}, `log query from "2026-02-30T00:00:00Z" is not a UTC time like 2026-10-08T22:53:20.123456Z`},
	} {
		if err := f.later("core.debug.timeline.filter", test.change); err == nil || err.Error() != test.want {
			t.Errorf("%v fails with %v, want %s", test.change, err, test.want)
		}
	}
}

func TestTheContextOfARowBringsItsNeighboursAsContext(t *testing.T) {
	f, stored := timelineShell(t, logPage("null", 3), logPage("null", 2, 3, 4))
	f.do("core.debug.timeline.context", map[string]int{"row": 0})
	query := stored.debug.queries[1]
	if query["earlier"] != float64(5) || query["later"] != float64(5) || query["around"] == nil {
		t.Fatalf("the query is %v", query)
	}
	if status := f.status("core.debug"); !strings.Contains(status, `"context":2`) {
		t.Fatalf("the status is %s", status)
	}
	if !f.tester.HasText(`  1970-01-01T00:00:00.002000Z info workbench step surface=s1 cids=c1,c2 z=1 a="text"`) {
		t.Fatalf("no context line in %q", f.tester.Texts())
	}
}

func TestTheSelectedRowsAreSavedInTimelineOrder(t *testing.T) {
	f, stored := timelineShell(t, logPage("null", 2, 1))
	f.run("core.debug.timeline.select", map[string]any{"row": 1, "selected": true})
	f.run("core.debug.timeline.select", map[string]any{"row": 0, "selected": true})
	f.do("core.debug.timeline.save", nil)
	lines := strings.Split(strings.TrimSpace(stored.debug.texts[0]), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "1970-01-01T00:00:00.001000Z") {
		t.Fatalf("saved %q", lines)
	}
	if status := f.status("core.debug"); !strings.Contains(status, `"action":"save-rows"`) || !strings.Contains(status, `"state":"done"`) {
		t.Fatalf("the status is %s", status)
	}
}

func TestASaveWithoutASelectedRowFails(t *testing.T) {
	f, _ := timelineShell(t, logPage("null", 1))
	if err := f.later("core.debug.timeline.save", nil); err == nil || err.Error() != "no timeline row is selected" {
		t.Fatalf("the save fails with %v", err)
	}
	if status := f.status("core.debug"); !strings.Contains(status, `"error":"save-rows: no timeline row is selected"`) {
		t.Fatalf("the status is %s", status)
	}
}

func TestSaveAllFollowsTheEventsOfTheHost(t *testing.T) {
	f, stored := debugShell(t)
	stored.debug.saveAll = "/saved/logs.tgz"
	f.do("core.debug.save-all", nil)
	if err := f.later("core.debug.save-all", nil); err == nil || !strings.Contains(err.Error(), "is running: /saved/logs.tgz") {
		t.Fatalf("the second save fails with %v", err)
	}
	f.shell.Event("debug-save-progress", []any{map[string]any{"saved": "/saved/logs.tgz", "written": 1024, "total": 2048}})
	f.flush()
	f.shell.Event("debug-save-done", []any{map[string]any{"saved": "/saved/logs.tgz", "error": nil}})
	f.flush()
	if status := f.status("core.debug"); !strings.Contains(status, `"state":"done","written":2048,"total":2048`) {
		t.Fatalf("the status is %s", status)
	}
}

func TestASaveOfAFileIsAnOperation(t *testing.T) {
	f, stored := debugShell(t)
	f.do("core.debug.save", map[string]string{"path": "logs/app.log"})
	if len(stored.debug.saved) != 1 {
		t.Fatalf("saved %v", stored.debug.saved)
	}
	stored.debug.failing = map[string]error{"debugSave": errors.New("no room")}
	if err := f.later("core.debug.save", map[string]string{"path": "logs/app.log"}); err == nil {
		t.Fatal("the save did not fail")
	}
	if !f.tester.HasText("save: no room") {
		t.Fatalf("the view shows %q", f.tester.Texts())
	}
}

// The first focus of the debug view is its card, so a key presses no control before Tab or a press reaches one.
func TestEnterInAnOpenedDebugViewClosesNothing(t *testing.T) {
	f, _ := debugShell(t)
	f.tester.Key(0, ui.KeyEnter)
	f.settle()
	if !strings.Contains(f.status("core.debug"), `"open":true`) {
		t.Fatal("Enter closed the debug view")
	}
}

// The debug view has the card of the settings window: its place, the head with the close switch, and the rows of the page.
func TestTheDebugViewIsDrawnAsThePage(t *testing.T) {
	f, _ := debugShell(t)
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	metric := func(name string) float32 {
		value, ok := declared.Metric(name)
		if !ok {
			t.Fatalf("no metric %s", name)
		}
		return float32(value)
	}
	card := f.box("core.debug.card", "")
	if card.Y != metric("set-card-top") || card.W != metric("dbg-card-w") {
		t.Fatalf("the card is at %v wide %v", card.Y, card.W)
	}
	closing := f.box("core.debug.close", "")
	if closing.W != metric("act-w") || closing.H != metric("act-h") {
		t.Fatalf("the close switch is %v by %v", closing.W, closing.H)
	}
	row := f.box("core.debug.file", "logs/app.log")
	if row.H != metric("dbg-row-h") {
		t.Fatalf("the row of a file is %v high", row.H)
	}
	view := f.box("core.debug.view", "logs/app.log")
	save := f.box("core.debug.save", "logs/app.log")
	if view.W != metric("dbg-act-w") || save.X-view.X != metric("dbg-act-w")+metric("space-2") {
		t.Fatalf("the actions of a file are %+v and %+v", view, save)
	}
}

// A filter of the timeline is an input of the page without a look of its own: the control background of its color scheme.
func TestAFilterOfTheTimelineHasTheBackgroundOfThePage(t *testing.T) {
	f, _ := timelineShell(t, logPage("null", 2, 1))
	node, ok := exposedNode(f.tester.ElementTree(), "core.debug.timeline.class", "")
	if !ok {
		t.Fatalf("no filter in %q", f.tester.Texts())
	}
	want := controlBackground(t)
	if got := f.pixelOf(node.Bounds.X+node.Bounds.W-6, node.Bounds.Y+node.Bounds.H/2); got != want {
		t.Fatalf("the filter has the background %v, not %v", got, want)
	}
}

// The filters of the timeline flow as those of the page (.dbg-card__filters): an input starts as wide as twenty figures and grows
// into what its line leaves, and a select is as wide as its longest option.
func TestTheFiltersOfTheTimelineFlowAsOnThePage(t *testing.T) {
	f, _ := timelineShell(t, logPage("null", 2, 1))
	bounds := func(name string) ui.Rect {
		t.Helper()
		node, ok := exposedNode(f.tester.ElementTree(), "core.debug.timeline."+name, "")
		if !ok {
			t.Fatalf("no filter %s in %q", name, f.tester.Texts())
		}
		return node.Bounds
	}
	channel, level, layer, text := bounds("channel"), bounds("level"), bounds("layer"), bounds("text")
	class, event, prefix, surface := bounds("class"), bounds("event"), bounds("event-prefix"), bounds("surface")
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	if height := declared.PlainControl("h"); fmt.Sprintf("%gpx", class.H) != height {
		t.Fatalf("an input is %v high, not %s", class.H, height)
	}
	if channel.W != level.W || layer.W <= channel.W {
		t.Fatalf("the selects are %v, %v and %v wide", channel.W, level.W, layer.W)
	}
	if text.Y+text.H/2 != layer.Y+layer.H/2 || text.X <= layer.X {
		t.Fatalf("the text stands at %+v after the select at %+v", text, layer)
	}
	if class.Y <= text.Y || class.X != channel.X {
		t.Fatalf("the class stands at %+v under the first line at %+v", class, channel)
	}
	if event.Y != class.Y || prefix.Y != class.Y || event.W != class.W || prefix.W != class.W || surface.Y <= class.Y {
		t.Fatalf("three inputs do not share the line: %+v %+v %+v, then %+v", class, event, prefix, surface)
	}
	if end := text.X + text.W - prefix.X - prefix.W; end < -.5 || end > .5 {
		t.Fatalf("the text ends at %v and the line under it at %v", text.X+text.W, prefix.X+prefix.W)
	}
}
