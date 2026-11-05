package workbench_test

import (
	"bytes"
	"image"
	"image/png"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

func debugEntries() []workbench.DebugEntry {
	return []workbench.DebugEntry{
		{Path: "logs/app.log", Size: 512, Modified: 2000},
		{Path: "logs/state-20261104T000000Z.json", Size: 2048, Modified: 2000},
		{Path: "logs/old.log", Size: 3 * 1024 * 1024, Modified: 1000},
	}
}

func drawDebug(view *workbench.DebugView, errors *workbench.ShownErrors, binder *workbench.Binder) *ui.Tester {
	view.CardWidth, view.CardMaxHeight = 640, 880
	view.Style = workbench.DebugStyle{HeadH: 40, ActW: 56, RowH: 30, TextControl: 12, TextSmall: 11, LineHeight: 1.45,
		Close: func(_ *ui.Context, button ui.Element, title string) { button.Size(24, 24).Label(title) }}
	return ui.NewTester(func(c *ui.Context) {
		workbench.DrawDebugView(c, binder, *view, errors)
	}, 1000, 900)
}

func TestTheDebugFilesAreNewestFirstAndThenByPath(t *testing.T) {
	entries := []workbench.DebugEntry{{Path: "b", Modified: 2}, {Path: "c", Modified: 3}, {Path: "a", Modified: 2}}
	got := workbench.NewestFirst(entries)
	want := []workbench.DebugEntry{{Path: "c", Modified: 3}, {Path: "a", Modified: 2}, {Path: "b", Modified: 2}}
	if !slices.Equal(got, want) {
		t.Fatalf("order %+v, want %+v", got, want)
	}
	if entries[0].Path != "b" {
		t.Fatal("the order changed its argument")
	}
}

func TestTheDebugViewListsEachFileWithItsActions(t *testing.T) {
	var calls []call
	view := workbench.DebugView{Entries: debugEntries()}
	tt := drawDebug(&view, noErrors(), recorder(t, &calls, screenCommands...))
	positional(t, tt, "core.debug.card", 0)
	positional(t, tt, "core.debug.scrim", 0)
	positional(t, tt, "core.debug.file", 2)
	for _, want := range []string{"디버그", "logs/app.log", "512 B", "2.0 KB", "3.0 MB", "모두 저장", "타임라인"} {
		if !hasPart(tt, want) {
			t.Errorf("no text %q in %q", want, tt.Texts())
		}
	}
	pressPositional(t, tt, "core.debug.view", 1)
	pressPositional(t, tt, "core.debug.save", 2)
	pressPositional(t, tt, "core.debug.state", 0)
	pressPositional(t, tt, "core.debug.save-all", 0)
	pressPositional(t, tt, "core.debug.timeline", 0)
	pressPositional(t, tt, "core.debug.close", 0)
	want := []call{
		{"core.debug.view", map[string]any{"path": "logs/state-20261104T000000Z.json"}},
		{"core.debug.save", map[string]any{"path": "logs/old.log"}},
		{"core.debug.state", map[string]any{"path": "logs/state-20261104T000000Z.json"}},
		{"core.debug.save-all", map[string]any{}},
		{"core.debug.timeline", map[string]any{}},
		{"core.debug.close", map[string]any{}},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v, want %+v", calls, want)
	}
}

func hasPart(tt *ui.Tester, part string) bool {
	return slices.ContainsFunc(tt.Texts(), func(text string) bool { return strings.Contains(text, part) })
}

func TestAFailedStepShowsItsErrorInTheView(t *testing.T) {
	var lines []string
	errors := workbench.NewShownErrors(func(line string) { lines = append(lines, line) })
	failure := "list: no folder"
	view := workbench.DebugView{Failure: &failure}
	tt := drawDebug(&view, errors, recorder(t, new([]call), screenCommands...))
	if !tt.HasText(failure) || !slices.Equal(lines, []string{"debug: list: no folder"}) {
		t.Fatalf("texts %q, written %q", tt.Texts(), lines)
	}
	view.Failure = nil
	tt.Frame()
	if _, shown := errors.Text("debug"); shown {
		t.Fatal("the error stays after the failure ended")
	}
}

func TestASaveOfTheLogsFolderShowsItsProgressAndDisablesItsButton(t *testing.T) {
	var calls []call
	view := workbench.DebugView{Operation: &workbench.DebugOperation{Action: "save-all", State: "running", Written: 1024 * 1024, Total: 4 * 1024 * 1024, Writing: true}}
	tt := drawDebug(&view, noErrors(), recorder(t, &calls, screenCommands...))
	positional(t, tt, "core.debug.progress", 0)
	if !hasPart(tt, "1.0 / 4.0 MB") {
		t.Fatalf("the progress shows %q", tt.Texts())
	}
	pressPositional(t, tt, "core.debug.save-all", 0)
	if len(calls) != 0 {
		t.Fatalf("a running save ran %+v", calls)
	}
}

func TestAShownTextFileHasItsPathTextAndCut(t *testing.T) {
	var calls []call
	view := workbench.DebugView{Viewing: &workbench.DebugShown{Path: "logs/app.log", Size: 512, Truncated: true, Kind: "text", Text: "line one"}}
	tt := drawDebug(&view, noErrors(), recorder(t, &calls, screenCommands...))
	if node := positional(t, tt, "core.debug.text", 0); node.Label != "line one" {
		t.Fatalf("the text is %q", node.Label)
	}
	for _, want := range []string{"logs/app.log · 512 B", "앞부분 생략"} {
		if !hasPart(tt, want) {
			t.Errorf("no text %q in %q", want, tt.Texts())
		}
	}
	pressPositional(t, tt, "core.debug.list", 0)
	if want := []call{{"core.debug.list", map[string]any{}}}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v", calls)
	}
	if !absent(tt, "core.debug.file") {
		t.Fatal("the list shows beside a shown file")
	}
}

func TestAShownStateFileHasItsTreeAndDifferences(t *testing.T) {
	var calls []call
	a := "1"
	view := workbench.DebugView{Entries: debugEntries(), State: &workbench.DebugStateView{
		Path: "logs/state-a.json", Lines: []string{"time: \"x\"", "windows [1]", "  [0]: 1"}, With: "logs/state-b.json",
		Differences: []workbench.DebugDifference{{Path: "time", A: &a}}, Compare: []string{"logs/state-b.json"},
	}}
	tt := drawDebug(&view, noErrors(), recorder(t, &calls, screenCommands...))
	positional(t, tt, "core.debug.state.tree", 0)
	positional(t, tt, "core.debug.state.differences", 0)
	if node := positional(t, tt, "core.debug.state.line", 2); node.Label != "  [0]: 1" {
		t.Fatalf("the line is %q", node.Label)
	}
	if node := positional(t, tt, "core.debug.state.difference", 0); node.Label != "time: 1 -> (없음)" {
		t.Fatalf("the difference is %q", node.Label)
	}
	pressPositional(t, tt, "core.debug.state.list", 0)
	if want := []call{{"core.debug.list", map[string]any{}}}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v", calls)
	}
	positional(t, tt, "core.debug.state.with", 0)
}

func timelineView() workbench.DebugView {
	return workbench.DebugView{Timeline: &workbench.DebugTimeline{
		Filter: workbench.DebugFilter{Channel: "other", Level: "trace", Layer: "all"}, Following: true, Older: true, Omitted: 3, Drafts: map[string]string{},
		Rows: []workbench.DebugRow{{Line: "t1 info host a"}, {Line: "  t2 info host b", Context: true}, {Line: "t3 info host c", Selected: true}},
	}}
}

func TestTheTimelineHasItsRowsAndTheirButtons(t *testing.T) {
	var calls []call
	view := timelineView()
	tt := drawDebug(&view, noErrors(), recorder(t, &calls, screenCommands...))
	if node := positional(t, tt, "core.debug.timeline.row", 1); node.Label != "  t2 info host b" {
		t.Fatalf("the row is %q", node.Label)
	}
	for _, want := range []string{"앞쪽 3행은 보관하지 않음", "따라가기 멈춤", "저장한 파일에는 입력한 글자가 들어 있을 수 있다."} {
		if !hasPart(tt, want) {
			t.Errorf("no text %q in %q", want, tt.Texts())
		}
	}
	pressPositional(t, tt, "core.debug.timeline.select", 0)
	pressPositional(t, tt, "core.debug.timeline.select", 2)
	pressPositional(t, tt, "core.debug.timeline.context", 1)
	pressPositional(t, tt, "core.debug.timeline.follow", 0)
	pressPositional(t, tt, "core.debug.timeline.older", 0)
	pressPositional(t, tt, "core.debug.timeline.save", 0)
	pressPositional(t, tt, "core.debug.timeline.list", 0)
	want := []call{
		{"core.debug.timeline.select", map[string]any{"row": float64(0), "selected": true}},
		{"core.debug.timeline.select", map[string]any{"row": float64(2), "selected": false}},
		{"core.debug.timeline.context", map[string]any{"row": float64(1)}},
		{"core.debug.timeline.follow", map[string]any{"on": false}},
		{"core.debug.timeline.older", map[string]any{}},
		{"core.debug.timeline.save", map[string]any{}},
		{"core.debug.list", map[string]any{}},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v, want %+v", calls, want)
	}
}

func TestATimelineWithoutOlderRowsAndNotFollowing(t *testing.T) {
	var calls []call
	view := timelineView()
	view.Timeline.Older, view.Timeline.Following, view.Timeline.Omitted = false, false, 0
	tt := drawDebug(&view, noErrors(), recorder(t, &calls, screenCommands...))
	if !absent(tt, "core.debug.timeline.older") {
		t.Fatal("a timeline without older rows has the older button")
	}
	if hasPart(tt, "보관하지 않음") {
		t.Fatalf("no omitted row shows %q", tt.Texts())
	}
	pressPositional(t, tt, "core.debug.timeline.follow", 0)
	if want := []call{{"core.debug.timeline.follow", map[string]any{"on": true}}}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v", calls)
	}
}

func TestATimelineFilterRunsItsCommandWhenTheFieldSubmits(t *testing.T) {
	var calls []call
	view := timelineView()
	tt := drawDebug(&view, noErrors(), recorder(t, &calls, screenCommands...))
	pressPositional(t, tt, "core.debug.timeline.event", 0)
	tt.Type("host.start")
	tt.Key(0, ui.KeyEnter)
	want := []call{{"core.debug.timeline.filter", map[string]any{"event": "host.start"}}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v, want %+v", calls, want)
	}
}

func TestAShownImageHasItsElement(t *testing.T) {
	source, err := ui.DecodeImage(onePixel(t))
	if err != nil {
		t.Fatal(err)
	}
	view := workbench.DebugView{Viewing: &workbench.DebugShown{Path: "logs/captures/a.png", Size: 70, Kind: "image", Image: source}}
	tt := drawDebug(&view, noErrors(), recorder(t, new([]call), screenCommands...))
	positional(t, tt, "core.debug.image", 0)
}

func onePixel(t *testing.T) []byte {
	t.Helper()
	var out bytes.Buffer
	if err := png.Encode(&out, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestEveryFilterControlOfTheTimelineHasItsName(t *testing.T) {
	view := timelineView()
	tt := drawDebug(&view, noErrors(), recorder(t, new([]call), screenCommands...))
	for _, name := range []string{"channel", "level", "layer", "class", "text", "event", "event-prefix", "surface", "session", "cid", "run", "from", "to"} {
		positional(t, tt, "core.debug.timeline."+name, 0)
	}
}

func TestAStateFileIsReadInFileOrderAsTreeLines(t *testing.T) {
	text := `{"time":"t","host":"mygo","versions":{"core":"1"},"workbench":[],"windows":[{"id":1,"open":{}}],"zeta":null}`
	state, err := workbench.ParseDebugState("logs/state-a.json", text, false)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{`time: "t"`, `host: "mygo"`, "versions {1}", `  core: "1"`, "workbench: []", "windows [1]", "  [0] {2}", "    id: 1", "    open: {}", "zeta: null"}
	if got := workbench.DebugStateLines(state); !slices.Equal(got, want) {
		t.Fatalf("lines %q, want %q", got, want)
	}
}

func TestAStateFileThatBreaksItsFormIsRefusedByName(t *testing.T) {
	const file = "logs/state-a.json"
	good := `"time":"t","host":"mygo","versions":{},"workbench":{},"windows":[]`
	for _, test := range []struct {
		text      string
		truncated bool
		want      string
	}{
		{"{}", true, file + ": the text was cut at the read limit, so the state cannot be read"},
		{"[1]", false, file + ": not a state object: [1]"},
		{`{"host":"mygo"}`, false, file + ": time must be a string, found undefined"},
		{`{"time":"t","host":"other"}`, false, file + `: host "other" is not one of wailsv3, tauriv2, mygo`},
		{`{"time":"t","host":"mygo","versions":[]}`, false, file + ": versions must be an object, found []"},
		{`{"time":"t","host":"mygo","versions":{},"workbench":1}`, false, file + ": workbench must be an object or an array, found 1"},
		{`{"time":"t","host":"mygo","versions":{},"workbench":{},"windows":{}}`, false, file + ": windows must be an array, found {}"},
	} {
		if _, err := workbench.ParseDebugState(file, test.text, test.truncated); err == nil || err.Error() != test.want {
			t.Errorf("%s fails with %v, want %s", test.text, err, test.want)
		}
	}
	if _, err := workbench.ParseDebugState(file, "{"+good+"}", false); err != nil {
		t.Fatal(err)
	}
	if _, err := workbench.ParseDebugState(file, "nope", false); err == nil || !strings.HasPrefix(err.Error(), file+": not JSON: ") {
		t.Fatalf("text that is no JSON fails with %v", err)
	}
}

func TestTwoStatesCompareByPath(t *testing.T) {
	first, err := workbench.ParseDebugState("a", `{"time":"t","host":"mygo","versions":{"a b":1},"workbench":[],"windows":[1,2],"only":{"x-y":true}}`, false)
	if err != nil {
		t.Fatal(err)
	}
	second, err := workbench.ParseDebugState("b", `{"time":"u","host":"mygo","versions":{"a b":1},"workbench":[],"windows":[1,3],"more":0}`, false)
	if err != nil {
		t.Fatal(err)
	}
	line := func(difference workbench.DebugDifference) string {
		value := func(v *string) string {
			if v == nil {
				return "nil"
			}
			return *v
		}
		return difference.Path + " " + value(difference.A) + " " + value(difference.B)
	}
	var got []string
	for _, difference := range workbench.CompareDebugStates(first, second) {
		got = append(got, line(difference))
	}
	want := []string{`time "t" "u"`, "windows[1] 2 3", "only.x-y true nil", "more nil 0"}
	if !slices.Equal(got, want) {
		t.Fatalf("differences %q, want %q", got, want)
	}
}

func TestTheStateFilesOfTheListAreInPathOrder(t *testing.T) {
	entries := []workbench.DebugEntry{{Path: "logs/state-b.json"}, {Path: "logs/app.log"}, {Path: "logs/state-a.json"}, {Path: "logs/sub/state-c.json"}}
	if got := workbench.DebugStateFiles(entries); !slices.Equal(got, []string{"logs/state-a.json", "logs/state-b.json"}) {
		t.Fatalf("state files %q", got)
	}
}

func TestChoosingAStateFileRunsTheComparison(t *testing.T) {
	var calls []call
	view := workbench.DebugView{State: &workbench.DebugStateView{Path: "logs/state-a.json", Compare: []string{"logs/state-b.json"}}}
	tt := drawDebug(&view, noErrors(), recorder(t, &calls, screenCommands...))
	pressPositional(t, tt, "core.debug.state.with", 0)
	if err := tt.Click("logs/state-b.json"); err != nil {
		t.Fatal(err)
	}
	want := []call{{"core.debug.state.compare", map[string]any{"with": "logs/state-b.json"}}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v, want %+v", calls, want)
	}
}

func TestChoosingALevelRunsTheFilter(t *testing.T) {
	var calls []call
	view := timelineView()
	tt := drawDebug(&view, noErrors(), recorder(t, &calls, screenCommands...))
	pressPositional(t, tt, "core.debug.timeline.level", 0)
	if err := tt.Click("warn"); err != nil {
		t.Fatal(err)
	}
	want := []call{{"core.debug.timeline.filter", map[string]any{"level": "warn"}}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v, want %+v", calls, want)
	}
}

func TestALeftFilterFieldRunsTheFilter(t *testing.T) {
	var calls []call
	view := timelineView()
	tt := drawDebug(&view, noErrors(), recorder(t, &calls, screenCommands...))
	pressPositional(t, tt, "core.debug.timeline.session", 0)
	tt.Type("s-1")
	if len(calls) != 0 {
		t.Fatalf("typing ran %+v", calls)
	}
	pressPositional(t, tt, "core.debug.timeline.run", 0)
	want := []call{{"core.debug.timeline.filter", map[string]any{"session": "s-1"}}}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("commands %+v, want %+v", calls, want)
	}
}

// A time reads as the page writes it, in the language of the window.
func TestTheTimeOfADebugFileIsWrittenInTheLanguage(t *testing.T) {
	modified := time.Date(2026, 11, 5, 14, 18, 28, 0, time.Local).UnixMilli()
	for _, want := range []struct{ locale, text string }{
		{"ko", "2026. 11. 5. 오후 2:18:28"},
		{"ko-KR", "2026. 11. 5. 오후 2:18:28"},
		{"en-US", "11/5/2026, 2:18:28 PM"},
		{"", "11/5/2026, 2:18:28 PM"},
	} {
		if got := workbench.TimeText(modified, want.locale); got != want.text {
			t.Errorf("in %q the time is %q, want %q", want.locale, got, want.text)
		}
	}
	morning := time.Date(2026, 1, 2, 0, 5, 6, 0, time.Local).UnixMilli()
	if got := workbench.TimeText(morning, "ko"); got != "2026. 1. 2. 오전 12:05:06" {
		t.Errorf("the morning is %q", got)
	}
}
