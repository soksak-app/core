// The shared cases of the activities of a window (docs/spec/cases/activity.json, docs/spec/activity.md). tabActivity and windowActivity
// of packages/workbench/activity.js run the same cases of tabs and windows, so a case is one statement that both workbenches meet; the
// hosts run the cases of records.
package workbench_test

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// activityCases reads the case table of the activities.
func activityCases(t *testing.T) (tabs []struct {
	Name     string                     `json:"name"`
	Plugin   string                     `json:"plugin"`
	Tab      string                     `json:"tab"`
	Statuses []workbench.ActivityStatus `json:"statuses"`
	Returns  struct {
		Activity *string `json:"activity"`
		Error    *string `json:"error"`
	} `json:"returns"`
}, windows []struct {
	Name     string                      `json:"name"`
	Projects []workbench.ActivityProject `json:"projects"`
	Tabs     map[string]string           `json:"tabs"`
	Returns  json.RawMessage             `json:"returns"`
}) {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "spec", "cases", "activity.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Description string `json:"description"`
		Tabs        []struct {
			Name     string                     `json:"name"`
			Plugin   string                     `json:"plugin"`
			Tab      string                     `json:"tab"`
			Statuses []workbench.ActivityStatus `json:"statuses"`
			Returns  struct {
				Activity *string `json:"activity"`
				Error    *string `json:"error"`
			} `json:"returns"`
		} `json:"tabs"`
		Windows []struct {
			Name     string                      `json:"name"`
			Projects []workbench.ActivityProject `json:"projects"`
			Tabs     map[string]string           `json:"tabs"`
			Returns  json.RawMessage             `json:"returns"`
		} `json:"windows"`
		Records json.RawMessage `json:"records"`
	}
	decoder := json.NewDecoder(bytes.NewReader(text))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&file); err != nil {
		t.Fatal(err)
	}
	if len(file.Tabs) == 0 || len(file.Windows) == 0 {
		t.Fatal("the activity case table holds no case")
	}
	return file.Tabs, file.Windows
}

func TestActivityCases(t *testing.T) {
	tabs, windows := activityCases(t)
	for _, kase := range tabs {
		t.Run("tab: "+kase.Name, func(t *testing.T) {
			want, failure := "", ""
			if kase.Returns.Activity != nil {
				want = *kase.Returns.Activity
			}
			if kase.Returns.Error != nil {
				failure = *kase.Returns.Error
			}
			got, err := workbench.TabActivity(kase.Plugin, kase.Tab, kase.Statuses)
			text := ""
			if err != nil {
				text = err.Error()
			}
			if got != want || text != failure {
				t.Fatalf("the activity is %q with the error %q, want %q with %q", got, text, want, failure)
			}
		})
	}
	for _, kase := range windows {
		t.Run("window: "+kase.Name, func(t *testing.T) {
			state, err := workbench.WindowActivity(kase.Projects, kase.Tabs)
			if err != nil {
				t.Fatal(err)
			}
			got, err := json.Marshal(state)
			if err != nil {
				t.Fatal(err)
			}
			var gotValue, wantValue any
			if err := json.Unmarshal(got, &gotValue); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(kase.Returns, &wantValue); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(gotValue, wantValue) {
				t.Fatalf("the activities of the window are %s, want %s", got, kase.Returns)
			}
		})
	}
}

// activityWindow is the stored form of a window of one project whose one space holds the tabs of textprobe in one card.
func activityWindow(tabs ...string) []workbench.ActivityProject {
	held := make([]map[string]string, 0, len(tabs))
	for _, tab := range tabs {
		held = append(held, map[string]string{"id": tab, "plugin": "textprobe"})
	}
	layout, err := json.Marshal(map[string]any{"state": map[string]any{"root": map[string]any{"card": "card-1", "data": map[string]any{"tabs": held}}}})
	if err != nil {
		panic(err)
	}
	return []workbench.ActivityProject{{ID: "p1", Spaces: []workbench.ActivitySpace{{ID: "s1", Layout: layout}}}}
}

func TestTheActivityOfATabFollowsTheWatchOfItsSurface(t *testing.T) {
	f := newSurfaceRequests(t)
	f.reply = func(map[string]any) (any, error) { return nil, nil }
	f.register("tab-a", "status", "textprobe.screen")
	projects := activityWindow("tab-a", "tab-b")
	changes := 0
	var shown [][2]string
	var published []string
	publish := func(id string, spaces map[string]workbench.ActivitySpaceState) {
		text, err := json.Marshal(spaces)
		if err != nil {
			t.Fatal(err)
		}
		published = append(published, id+" "+string(text))
	}
	follow := workbench.NewActivityFollow(func(name, surface string, fn func(value any)) func() {
		return f.registry.Observe(name, &surface, true, fn)
	},
		func(plugin string) []string {
			if plugin != "textprobe" {
				return nil
			}
			return []string{"textprobe.screen"}
		},
		func() ([]workbench.ActivityProject, error) { return projects, nil }, func() { changes++ },
		func(tab, text string) { shown = append(shown, [2]string{tab, text}) }, func(err error) { t.Error(err) }, publish)
	follow.Sync()
	if len(f.forwards) != 1 || f.forwards[0]["method"] != "status.watch" || f.forwards[0]["surface"] != "tab-a" {
		t.Fatalf("the sync forwarded %v", f.forwards)
	}
	state := func() string {
		t.Helper()
		text, err := json.Marshal(follow.State())
		if err != nil {
			t.Fatal(err)
		}
		return string(text)
	}
	if got := state(); got != `{"spaces":{},"tabs":{}}` {
		t.Fatalf("the activities before a value are %s", got)
	}
	if len(published) != 0 {
		t.Fatalf("a project without an activity that was never published was published: %q", published)
	}
	f.deliver("tab-a", "textprobe.screen", `"running"`, 1)
	running := `p1 {"s1":{"activity":"running","cards":{"card-1":"running"},"groups":{}}}`
	if got := state(); got != `{"spaces":{"p1":{"s1":{"activity":"running","cards":{"card-1":"running"},"groups":{}}}},"tabs":{"tab-a":"running"}}` {
		t.Fatalf("the activities after running are %s", got)
	}
	if !slices.Equal(published, []string{running}) {
		t.Fatalf("the publications after running are %q", published)
	}
	// tab-b registers after the sync; its registration starts its watch, and its value raises the project to attention.
	f.register("tab-b", "status", "textprobe.screen")
	if last := f.last(); last["method"] != "status.watch" || last["surface"] != "tab-b" {
		t.Fatalf("the registration forwarded %v", last)
	}
	f.deliver("tab-b", "textprobe.screen", `"attention"`, 1)
	// A value that is no activity gives tab-a none and shows its error until a valid value withdraws it.
	f.deliver("tab-a", "textprobe.screen", `"busy"`, 2)
	want := "textprobe exposes textprobe.screen on tab tab-a: activity value \"busy\" is not one of attention, running, failed, idle"
	if !slices.Equal(shown, [][2]string{{"tab-a", want}}) {
		t.Fatalf("the shown errors are %q", shown)
	}
	f.deliver("tab-a", "textprobe.screen", `null`, 3)
	if !slices.Equal(shown, [][2]string{{"tab-a", want}, {"tab-a", ""}}) {
		t.Fatalf("the shown errors after null are %q", shown)
	}
	if got := state(); got != `{"spaces":{"p1":{"s1":{"activity":"attention","cards":{"card-1":"attention"},"groups":{}}}},"tabs":{"tab-b":"attention"}}` {
		t.Fatalf("the activities after attention and null are %s", got)
	}
	attention := `p1 {"s1":{"activity":"attention","cards":{"card-1":"attention"},"groups":{}}}`
	if !slices.Equal(published, []string{running, attention}) {
		t.Fatalf("the window derives no activity of the project, only of its spaces, and publishes each change once: %q", published)
	}
	// tab-a leaves the layouts, so its watch ends and nothing that core.activity reports changes.
	projects = activityWindow("tab-b")
	follow.Sync()
	if last := f.last(); last["method"] != "status.unwatch" || last["surface"] != "tab-a" {
		t.Fatalf("the leave of tab-a forwarded %v", last)
	}
	if changes != 3 {
		t.Fatalf("core.activity changed %d times, want 3", changes)
	}
	// tab-b ends with null, so the project has no activity and is withdrawn with empty spaces.
	f.deliver("tab-b", "textprobe.screen", `null`, 2)
	if !slices.Equal(published, []string{running, attention, "p1 {}"}) {
		t.Fatalf("the publications after the end of the activity are %q", published)
	}
	// A project that leaves the window is not published: the host removes its entry with the release.
	f.deliver("tab-b", "textprobe.screen", `"failed"`, 3)
	projects = nil
	follow.Sync()
	if len(published) != 4 {
		t.Fatalf("a project that left the window was published: %q", published)
	}
}

// activityIcon is a drawn element: its item, its role and its label.
type activityIcon struct {
	item  string
	role  ui.Role
	label string
}

// activityIcons returns each element of name in tree order.
func activityIcons(nodes []ui.ElementNode, name string) []activityIcon {
	icons := []activityIcon{}
	for _, node := range nodes {
		if exposed, ok := node.Key.(workbench.Exposed); ok && exposed.Name == name {
			icons = append(icons, activityIcon{exposed.Item, node.Role, node.Label})
		}
		icons = append(icons, activityIcons(node.Children, name)...)
	}
	return icons
}

// The icon of an activity stands on the tab, the group header, the space tab and the project tab that hold it, as an image named by the
// activity, and leaves with the activity (docs/spec/activity.md#drawing).
func TestTheIconsOfAnActivityStandOnItsHolders(t *testing.T) {
	declared := strings.Replace(installedDocument, `{"name": "textprobe.screen", "description": "the screen", "schema": {"type": "object", "properties": {}}}`,
		`{"name": "textprobe.screen", "description": "the screen", "schema": {"type": ["string", "null"]}, "activity": true}`, 1)
	if declared == installedDocument {
		t.Fatal("the test document declares no textprobe.screen")
	}
	r := newViewRelayWith(t, &surfaceHost{storedHost: storedHost{installed: declared}}, declared)
	surface := r.surface()
	var card string
	for _, entry := range status[gridRead](t, r.f, "core.grid").Cards {
		for _, tab := range entry.Tabs {
			if tab.ID == surface {
				card = entry.ID
			}
		}
	}
	r.f.run("core.group.create", map[string]any{"card": card, "side": "right", "plugin": "boxprobe"})
	r.call(surface, "runtime.native.on", map[string]any{"name": "exposure-request"})
	r.call(surface, "runtime.native.call", map[string]any{"name": "registered", "payload": map[string]any{"kind": "status", "name": "textprobe.screen"}})
	// The registration starts the watch of the activities, which reaches the view.
	var watch map[string]any
	r.f.until(func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		for _, each := range r.pushed {
			if data, ok := each["data"].(map[string]any); ok && data["method"] == "status.watch" {
				watch = data
			}
		}
		return watch != nil
	})
	r.call(surface, "runtime.native.call", map[string]any{"name": "exposureReply", "payload": map[string]any{"id": watch["id"]}})
	r.call(surface, "runtime.native.call", map[string]any{"name": "changed", "payload": map[string]any{"name": "textprobe.screen", "value": "attention", "version": 1}})
	r.f.settle()
	// The host sends the record of the project activities that the publication changed (docs/spec/activity.md#activity-of-a-project).
	r.f.shell.Event("project-activity", []any{r.stored.activities.Record()})
	r.f.settle()
	state := status[workbench.ActivityState](t, r.f, "core.activity")
	project := status[map[string]any](t, r.f, "core.project")
	projectID, spaceID := project["id"].(string), project["activeSpaceId"].(string)
	groups := state.Projects[projectID].Spaces[spaceID].Groups
	if state.Tabs[surface] != "attention" || len(groups) != 1 {
		t.Fatalf("core.activity is %+v", state)
	}
	var group string
	for id := range groups {
		group = id
	}
	tree := r.f.tester.ElementTree()
	for name, item := range map[string]string{"core.activity.tab": surface, "core.activity.group": group, "core.activity.space": spaceID, "core.activity.project": projectID} {
		if got := activityIcons(tree, name); !slices.Equal(got, []activityIcon{{item, ui.RoleImage, "응답 대기"}}) {
			t.Errorf("the icons of %s are %v, want the image of %s named 응답 대기", name, got, item)
		}
	}
	// Each icon is the declared share of the text size of its name, so the four holders draw it at one ratio
	// (docs/spec/activity.md#drawing).
	chrome := declaredChrome(t)
	iconEm, base := chrome["activity-icon-em"], chrome["text-base"]
	small, control := 13*chrome["text-small-at-base"]/base, 13*chrome["text-control-at-base"]/base
	for name, item := range map[string]string{"core.activity.tab": surface, "core.activity.group": group, "core.activity.space": spaceID, "core.activity.project": projectID} {
		text := small
		if name == "core.activity.space" || name == "core.activity.project" {
			text = control
		}
		box, ok := exposedAll(tree, name)[item]
		if !ok || math.Abs(float64(box.W-iconEm*text)) > 0.01 || math.Abs(float64(box.H-iconEm*text)) > 0.01 {
			t.Errorf("the icon of %s is %v×%v, want %v of the text size %v", name, box.W, box.H, iconEm, text)
		}
	}
	// The project tabs in the column keep the icon of the project.
	r.f.run("core.settings.set", map[string]any{"patch": map[string]any{"projectTabs": "left"}})
	if got := activityIcons(r.f.tester.ElementTree(), "core.activity.project"); !slices.Equal(got, []activityIcon{{projectID, ui.RoleImage, "응답 대기"}}) {
		t.Errorf("the icons of the column are %v, want the image of %s named 응답 대기", got, projectID)
	}
	// A null value ends the activity, so every icon leaves.
	r.call(surface, "runtime.native.call", map[string]any{"name": "changed", "payload": map[string]any{"name": "textprobe.screen", "value": nil, "version": 2}})
	r.f.settle()
	r.f.shell.Event("project-activity", []any{r.stored.activities.Record()})
	r.f.settle()
	tree = r.f.tester.ElementTree()
	for _, name := range []string{"core.activity.tab", "core.activity.group", "core.activity.space", "core.activity.project"} {
		if got := activityIcons(tree, name); len(got) != 0 {
			t.Errorf("the icons of %s after the activity ended are %v", name, got)
		}
	}
}

// declaredChrome reads the unitless and the point values of the chrome declaration of packages/workbench/workbench.json.
func declaredChrome(t *testing.T) map[string]float32 {
	t.Helper()
	raw, err := os.ReadFile("../src/workbench.json")
	if err != nil {
		t.Fatal(err)
	}
	var declared struct {
		Chrome map[string]string `json:"chrome"`
	}
	if err := json.Unmarshal(raw, &declared); err != nil {
		t.Fatal(err)
	}
	out := map[string]float32{}
	for name, text := range declared.Chrome {
		if value, err := strconv.ParseFloat(strings.TrimSuffix(text, "px"), 32); err == nil {
			out[name] = float32(value)
		}
	}
	return out
}

// Each activity has its own color in every theme and mode: the icons of attention, failed, running and idle take focus, fail, rail
// and muted, four different colors, and none takes the error color no, which belongs to the display of errors
// (docs/spec/activity.md#drawing).
func TestEveryThemeGivesEachActivityItsOwnColor(t *testing.T) {
	raw, err := os.ReadFile("../src/workbench.json")
	if err != nil {
		t.Fatal(err)
	}
	var declared struct {
		Themes []map[string]any `json:"themes"`
	}
	if err := json.Unmarshal(raw, &declared); err != nil {
		t.Fatal(err)
	}
	for _, theme := range declared.Themes {
		for _, mode := range []string{"dark", "light"} {
			colors, _ := theme[mode].(map[string]any)
			seen := map[string]string{}
			for _, key := range []string{"focus", "fail", "rail", "muted", "no"} {
				value, _ := colors[key].(string)
				if value == "" {
					t.Errorf("theme %v %s has no color %s", theme["name"], mode, key)
					continue
				}
				if other, ok := seen[strings.ToLower(value)]; ok {
					t.Errorf("theme %v %s gives %s and %s the same color %s", theme["name"], mode, other, key, value)
				}
				seen[strings.ToLower(value)] = key
			}
		}
	}
}
