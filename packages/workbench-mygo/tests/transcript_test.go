// The diagnostic transcript and the diagnostic hold of surface replies of the native workbench, which act on the workbench of the
// window on every host (docs/spec/endpoint.md, docs/spec/logging.md), and the records of its focus transitions.
package workbench_test

import (
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

func TestTheTranscriptSendsEachAnsweredCallInTheOrderOfTheAnswers(t *testing.T) {
	var lines []string
	var sent []func()
	transcript := workbench.NewTranscript(func(line string, done func()) {
		lines = append(lines, line)
		sent = append(sent, done)
	})
	transcript.Record("theme", nil, nil, nil)
	if len(lines) != 0 {
		t.Fatalf("a transcript that is off sent %q", lines)
	}
	transcript.Set(true)
	transcript.Record("theme", nil, map[string]any{}, nil)
	transcript.Record("settingsSave", map[string]any{"path": "<a&b>"}, []int{1}, nil)
	transcript.Record("workspace", nil, nil, errors.New("refused"))
	transcript.Record("log", map[string]any{"action": "batch"}, nil, nil)
	if !slices.Equal(lines, []string{"host theme null -> null"}) {
		t.Fatalf("the transcript sent %q before the first line was sent", lines)
	}
	sent[0]()
	want := []string{"host theme null -> null", `host settingsSave {"path":"<a&b>"} -> [1]`}
	if !slices.Equal(lines, want) {
		t.Fatalf("the transcript sent %q, want %q", lines, want)
	}
	sent[1]()
	transcript.Set(false)
	transcript.Record("theme", nil, nil, nil)
	if len(lines) != 2 {
		t.Fatalf("a transcript turned off sent %q", lines)
	}
}

func TestDiagnosticsTranscriptSendsTheHostCallsOfTheWorkbenchToTheHostLog(t *testing.T) {
	stored := &storedHost{}
	f := newShell(t, stored)
	if got := stored.transcriptLines(); len(got) != 0 {
		t.Fatalf("the host received transcript lines %q before the transcript was on", got)
	}
	f.reply("diagnostics.transcript", `{"on":true}`)
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"dim": true}, "scope": "common"})
	f.pending.until(t, func() bool { return len(stored.transcriptLines()) > 0 })
	line := regexp.MustCompile(`^host [A-Za-z]+ (null|[\[{"].*) -> .+$`)
	start := stored.written("workbench.start")[0]["start"]
	for _, sent := range stored.transcripts() {
		if !line.MatchString(sent.Line) || strings.HasPrefix(sent.Line, "host log ") {
			t.Fatalf("the transcript sent the line %q", sent.Line)
		}
		if sent.Start != start {
			t.Fatalf("the line %q names the start %q, not the start %v of the workbench", sent.Line, sent.Start, start)
		}
	}
	f.reply("diagnostics.transcript", `{"on":false}`)
	count := len(stored.transcriptLines())
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"dim": false}, "scope": "common"})
	if got := stored.transcriptLines(); len(got) != count {
		t.Fatalf("a transcript turned off sent %q", got[count:])
	}
}

func TestAFocusTransitionOfTheWorkbenchIsAnInformationRecord(t *testing.T) {
	stored := &storedHost{classes: traceClasses(), common: map[string]any{"diagnostics.log": traceClasses()}}
	f := newShell(t, stored)
	f.run("core.focus.set", map[string]any{"name": "core.library.search"})
	focusIn := func() bool {
		for _, event := range stored.written("workbench.record.info") {
			fields := event["fields"].(map[string]any)
			if fields["where"] == "workbench" && fields["text"] == "focus in core.library.search" {
				return true
			}
		}
		return false
	}
	f.pending.until(t, focusIn)
}

func TestASurfaceReplyHoldSendsTheHeldRepliesAfterTheSurfaceClosed(t *testing.T) {
	var lines []string
	hold := workbench.NewSurfaceReplyHold(func(line string) { lines = append(lines, line) })
	if err := hold.Hold(""); err == nil || err.Error() != "diagnostics.surface.hold requires surface" {
		t.Fatalf("a hold without a surface failed with %v", err)
	}
	if err := hold.Hold("tab-a"); err != nil {
		t.Fatal(err)
	}
	if err := hold.Hold("tab-a"); err == nil || err.Error() != `exposure replies of surface "tab-a" are already held` {
		t.Fatalf("a second hold failed with %v", err)
	}
	var held []error
	hold.Held("tab-a", func(err error) { held = append(held, err) })
	if len(held) != 0 {
		t.Fatal("a hold without a reply answered diagnostics.surface.held")
	}
	var sends []func()
	var order []string
	hold.Gate("tab-a", func(done func()) { order = append(order, "first"); sends = append(sends, done) })
	hold.Gate("tab-a", func(done func()) { order = append(order, "second"); sends = append(sends, done) })
	hold.Gate("tab-b", func(done func()) { order = append(order, "other"); done() })
	if !slices.Equal(order, []string{"other"}) || len(held) != 1 || held[0] != nil {
		t.Fatalf("the hold sent %q and answered held with %v", order, held)
	}
	hold.Held("tab-a", func(err error) { held = append(held, err) })
	if len(held) != 2 || held[1] != nil {
		t.Fatalf("a hold with a reply answered held with %v", held)
	}
	hold.Closed("tab-a")
	if !slices.Equal(order, []string{"other", "first", "second"}) || len(lines) != 0 {
		t.Fatalf("the closed surface sent %q and wrote %q before the host answered", order, lines)
	}
	sends[0]()
	sends[1]()
	want := []string{`held exposure replies of surface "tab-a" were sent after the surface closed (2)`}
	if !slices.Equal(lines, want) {
		t.Fatalf("the hold wrote %q, want %q", lines, want)
	}
	hold.Held("tab-a", func(err error) { held = append(held, err) })
	if len(held) != 3 || held[2] == nil || held[2].Error() != `exposure replies of surface "tab-a" are not held` {
		t.Fatalf("held of an ended hold answered %v", held)
	}
	if err := hold.Hold("tab-c"); err != nil {
		t.Fatal(err)
	}
	hold.Held("tab-c", func(err error) { held = append(held, err) })
	hold.Closed("tab-c")
	if len(held) != 4 || held[3] == nil || held[3].Error() != `surface "tab-c" closed before it held an exposure reply` {
		t.Fatalf("held of a surface that closed first answered %v", held)
	}
}

func TestDiagnosticsSurfaceHoldRefusesASurfaceThatIsNotMounted(t *testing.T) {
	f := newShell(t, &storedHost{})
	_, err := f.replyOf("diagnostics.surface.hold", `{"surface":"tab-none"}`)
	if err == nil || err.Error() != "surface tab-none is not mounted" {
		t.Fatalf("the hold of an unknown surface failed with %v", err)
	}
	if _, err := f.replyOf("diagnostics.surface.held", `{"surface":"tab-none"}`); err == nil ||
		err.Error() != `exposure replies of surface "tab-none" are not held` {
		t.Fatalf("held of a surface without a hold failed with %v", err)
	}
}

// reply asks the registry for method as the host asks a window and fails when it does not answer null.
func (f *shellFixture) reply(method, params string) {
	f.t.Helper()
	value, err := f.replyOf(method, params)
	if value != nil || err != nil {
		f.t.Fatalf("%s answered %v, %v", method, value, err)
	}
}

// replyOf asks the registry for method as the host asks a window and returns its answer after the steps of the shell ran.
func (f *shellFixture) replyOf(method, params string) (any, error) {
	f.t.Helper()
	var value any
	var failure error
	answered := false
	f.shell.Registry().Reply(method, json.RawMessage(params), nil, func(v any, err error) { answered, value, failure = true, v, err })
	f.pending.until(f.t, func() bool { return answered })
	return value, failure
}

// The tab reports of a view protect its tab from the memory saver as the main page protects it (tabKeeps of
// packages/workbench/tab-reports.js): a modified tab gives keep:modified and a busy tab keep:busy, and busy is the only keep reason.
func TestTheTabReportsOfAViewGiveTheKeepReasonsOfTheMemorySaver(t *testing.T) {
	stored := &surfaceHost{}
	stored.installed = unloadDocument
	stored.projects = []map[string]any{storedProject(tab("tab-aaaaaa", "notes"), tab("tab-bbbbbb", "notes"))}
	f := newTabApp(t, stored, unloadDocument)
	f.command("core.project.activate", map[string]string{"id": "prj-a"})
	call := func(command string, params any) map[string]any {
		t.Helper()
		f.app.Emit(f.window, "view-call", map[string]any{"surface": "tab-aaaaaa", "plugin": "notes", "generation": 1, "id": 9, "command": command, "params": params})
		f.settle()
		return stored.replies[len(stored.replies)-1]
	}
	reasons := func() []string {
		t.Helper()
		reply := f.ask("status.get", map[string]any{"name": "core.tab.memory"})
		for _, item := range reply["result"].(map[string]any)["tabs"].([]any) {
			entry := item.(map[string]any)
			if entry["tab"] == "tab-aaaaaa" {
				var list []string
				for _, reason := range entry["reasons"].([]any) {
					list = append(list, reason.(string))
				}
				return list
			}
		}
		t.Fatalf("core.tab.memory has no tab tab-aaaaaa: %v", reply)
		return nil
	}
	if reply := call("tab.modified", true); reply["error"] != nil {
		t.Fatalf("tab.modified answered %v", reply)
	}
	if got := reasons(); !slices.Contains(got, "keep:modified") {
		t.Fatalf("a modified tab has the reasons %q", got)
	}
	if reply := call("tab.keep", map[string]any{"reason": "busy", "on": true}); reply["error"] != nil {
		t.Fatalf("tab.keep answered %v", reply)
	}
	if got := reasons(); !slices.Contains(got, "keep:modified") || !slices.Contains(got, "keep:busy") {
		t.Fatalf("a modified busy tab has the reasons %q", got)
	}
	call("tab.modified", false)
	if got := reasons(); slices.Contains(got, "keep:modified") {
		t.Fatalf("a tab that is no longer modified has the reasons %q", got)
	}
	reply := call("tab.keep", map[string]any{"reason": "media", "on": true})
	if failure, _ := reply["error"].(map[string]any); failure == nil || failure["message"] != "unknown keep reason: media" {
		t.Fatalf("an unknown keep reason answered %v", reply)
	}
}
