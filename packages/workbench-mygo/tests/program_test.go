// The program state of a tab (docs/spec/program-state.md): the workbench follows the status that a plugin declares as surface.program on
// the surface of each tab by a watch, reports the state of each tab, and refuses another value with the error text of the spec.
package workbench_test

import (
	"encoding/json"
	"slices"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// TestTabProgramCases states the program state of a tab from a value: an object whose only members are state and pid, null for none, and
// the error text for any other value.
func TestTabProgramCases(t *testing.T) {
	const status = "textprobe.program"
	const errSuffix = ` is not null or an object with only the members state and pid, where state is one of idle, working, blocked and pid is a positive integer or null`
	for _, c := range []struct {
		value   string
		want    string
		errText string
	}{
		{`{"state":"blocked","pid":42}`, `{"state":"blocked","pid":42}`, ""},
		{`{"state":"idle","pid":null}`, `{"state":"idle","pid":null}`, ""},
		{`null`, `null`, ""},
		{`{"state":"busy","pid":1}`, ``, `textprobe exposes textprobe.program on tab tab-a: program value {"pid":1,"state":"busy"}` + errSuffix},
		{`{"state":"idle"}`, ``, `textprobe exposes textprobe.program on tab tab-a: program value {"state":"idle"}` + errSuffix},
		{`{"state":"idle","pid":0}`, ``, `textprobe exposes textprobe.program on tab tab-a: program value {"pid":0,"state":"idle"}` + errSuffix},
		{`{"state":"idle","pid":1.5}`, ``, `textprobe exposes textprobe.program on tab tab-a: program value {"pid":1.5,"state":"idle"}` + errSuffix},
		{`{"state":"idle","pid":1,"extra":1}`, ``, `textprobe exposes textprobe.program on tab tab-a: program value {"extra":1,"pid":1,"state":"idle"}` + errSuffix},
		{`"working"`, ``, `textprobe exposes textprobe.program on tab tab-a: program value "working"` + errSuffix},
	} {
		var value any
		if err := json.Unmarshal([]byte(c.value), &value); err != nil {
			t.Fatal(err)
		}
		program, err := workbench.TabProgram("textprobe", status, "tab-a", value)
		if c.errText == "" {
			if err != nil {
				t.Fatalf("%s: unexpected error %v", c.value, err)
			}
			got, marshalErr := json.Marshal(program)
			if marshalErr != nil {
				t.Fatal(marshalErr)
			}
			if string(got) != c.want {
				t.Fatalf("%s: program %s, want %s", c.value, got, c.want)
			}
			continue
		}
		if err == nil || err.Error() != c.errText || program != nil {
			t.Fatalf("%s: got program %+v and error %v, want error %q", c.value, program, err, c.errText)
		}
	}
}

// TestTheProgramStateOfATabFollowsTheWatchOfItsSurface drives one tab through its program states, an invalid value and its removal.
func TestTheProgramStateOfATabFollowsTheWatchOfItsSurface(t *testing.T) {
	f := newSurfaceRequests(t)
	f.reply = func(map[string]any) (any, error) { return nil, nil }
	if err := f.registry.Declare("programprobe", workbench.Exposes{Status: []json.RawMessage{json.RawMessage(`{"name": "programprobe.program",
		"description": "the program state", "schema": {"type": ["object", "null"], "required": ["state"],
		"properties": {"state": {"type": "string", "enum": ["idle", "working", "blocked"]}, "pid": {"type": ["integer", "null"]}}}}`)}}); err != nil {
		t.Fatal(err)
	}
	f.plugins["tab-a"] = "programprobe"
	f.register("tab-a", "status", "programprobe.program")
	projects := programWindow("tab-a", "programprobe")
	var shown [][2]string
	follow := workbench.NewActivityFollow(func(name, surface string, fn func(value any)) func() {
		return f.registry.Observe(name, &surface, true, fn)
	},
		func(plugin string) []string { return nil },
		func(plugin string) string {
			if plugin != "programprobe" {
				return ""
			}
			return "programprobe.program"
		},
		func() ([]workbench.ActivityProject, error) { return projects, nil }, func() {},
		func(tab, text string) {},
		func(tab, text string) { shown = append(shown, [2]string{tab, text}) },
		func(err error) { t.Error(err) },
		func(id string, spaces map[string]workbench.ActivitySpaceState) {})
	follow.Sync()
	if got := follow.Programs(); len(got) != 0 {
		t.Fatalf("a program state before a value is %v", got)
	}
	f.deliver("tab-a", "programprobe.program", `{"state":"working","pid":101}`, 1)
	if got := follow.Programs()["tab-a"]; got == nil || got.State != "working" || got.Pid == nil || *got.Pid != 101 {
		t.Fatalf("the program state after working is %+v", got)
	}
	f.deliver("tab-a", "programprobe.program", `{"state":"busy","pid":101}`, 2)
	want := `programprobe exposes programprobe.program on tab tab-a: program value {"pid":101,"state":"busy"} is not null or an object with only the members state and pid, where state is one of idle, working, blocked and pid is a positive integer or null`
	if !slices.Equal(shown[len(shown)-1:], [][2]string{{"tab-a", want}}) {
		t.Fatalf("the shown program errors are %q", shown)
	}
	if got := follow.Programs(); len(got) != 0 {
		t.Fatalf("an invalid value gives the tab no program state, got %v", got)
	}
	f.deliver("tab-a", "programprobe.program", `{"state":"blocked","pid":null}`, 3)
	if got := follow.Programs()["tab-a"]; got == nil || got.State != "blocked" || got.Pid != nil {
		t.Fatalf("the program state after blocked is %+v", got)
	}
	if shown[len(shown)-1] != ([2]string{"tab-a", ""}) {
		t.Fatalf("a valid value withdraws the error, shown %q", shown)
	}
	projects = nil
	follow.Sync()
	if got := follow.Programs(); len(got) != 0 {
		t.Fatalf("a tab that left the window keeps program state %v", got)
	}
}

// programWindow is one project whose one space holds the tab in one card, held by the plugin.
func programWindow(tab, plugin string) []workbench.ActivityProject {
	layout, err := json.Marshal(map[string]any{"state": map[string]any{"root": map[string]any{"card": "card-1",
		"data": map[string]any{"tabs": []map[string]string{{"id": tab, "plugin": plugin}}}}}})
	if err != nil {
		panic(err)
	}
	return []workbench.ActivityProject{{ID: "p1", Spaces: []workbench.ActivitySpace{{ID: "s1", Layout: layout}}}}
}
