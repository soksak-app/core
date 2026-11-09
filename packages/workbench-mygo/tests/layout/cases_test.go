// The shared layout cases of docs/spec/cases/layout run against the Go layout model. The tests of packages/soksak and
// packages/workbench run the same files, so a case is one statement of the layout that the implementations meet.
package layout_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// tolerance is the relative difference under which two numbers of a case are the same.
const tolerance = 1e-9

// caseFile reads a file of docs/spec/cases/layout and decodes it into out, refusing a member that out does not name.
func caseFile(t *testing.T, name string, out any) {
	t.Helper()
	text, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "spec", "cases", "layout", name))
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(text))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

// step is one call of a case: the call, its arguments, and the value it returns or the message it throws. A step with neither
// returns no value. Returns holds the text of the member, so a member of null is a value and an absent member is empty.
type step struct {
	Call    string            `json:"call"`
	Args    []json.RawMessage `json:"args"`
	Returns json.RawMessage   `json:"returns"`
	Throws  *string           `json:"throws"`
}

// same reports the first difference between actual and expected, both decoded from JSON, with numbers compared within tolerance.
func same(actual, expected any, where string) error {
	switch want := expected.(type) {
	case float64:
		got, ok := actual.(float64)
		if !ok {
			return fmt.Errorf("%s: %v is not a number", where, actual)
		}
		if math.Abs(got-want) > tolerance*math.Max(1, math.Max(math.Abs(got), math.Abs(want))) {
			return fmt.Errorf("%s: %v is not %v", where, got, want)
		}
		return nil
	case []any:
		got, ok := actual.([]any)
		if !ok {
			return fmt.Errorf("%s: %v is not a list", where, actual)
		}
		if len(got) != len(want) {
			return fmt.Errorf("%s: %d items, not %d", where, len(got), len(want))
		}
		for i := range want {
			if err := same(got[i], want[i], fmt.Sprintf("%s[%d]", where, i)); err != nil {
				return err
			}
		}
		return nil
	case map[string]any:
		got, ok := actual.(map[string]any)
		if !ok {
			return fmt.Errorf("%s: %v is not an object", where, actual)
		}
		keys := func(m map[string]any) []string {
			out := make([]string, 0, len(m))
			for k := range m {
				out = append(out, k)
			}
			sort.Strings(out)
			return out
		}
		if fmt.Sprint(keys(got)) != fmt.Sprint(keys(want)) {
			return fmt.Errorf("%s: the keys %v are not %v", where, keys(got), keys(want))
		}
		for k := range want {
			if err := same(got[k], want[k], where+"."+k); err != nil {
				return err
			}
		}
		return nil
	default:
		if fmt.Sprint(actual) != fmt.Sprint(expected) || (actual == nil) != (expected == nil) {
			return fmt.Errorf("%s: %v is not %v", where, actual, expected)
		}
		return nil
	}
}

// decoded is a value in the form JSON gives it, so a Go value compares with the value of a case.
func decoded(t *testing.T, value any) any {
	t.Helper()
	text, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(text, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// checkStep runs one step and checks its result: the value of returns, the message of throws, or no value.
func checkStep(t *testing.T, s step, where string, run func() (any, bool, error)) {
	t.Helper()
	value, has, err := run()
	if s.Throws != nil {
		if err == nil || err.Error() != *s.Throws {
			t.Fatalf("%s: throws %v, not %q", where, err, *s.Throws)
		}
		return
	}
	if err != nil {
		t.Fatalf("%s: %v", where, err)
	}
	if len(s.Returns) == 0 {
		if has {
			t.Fatalf("%s: returns %v", where, decoded(t, value))
		}
		return
	}
	var want any
	if err := json.Unmarshal(s.Returns, &want); err != nil {
		t.Fatal(err)
	}
	if !has {
		t.Fatalf("%s: returns no value, not %s", where, s.Returns)
	}
	if err := same(decoded(t, value), want, where); err != nil {
		t.Fatal(err)
	}
}

// arg decodes argument i of a step, or leaves out at its zero value when the step does not give it.
func arg(t *testing.T, s step, i int, out any) bool {
	t.Helper()
	if i >= len(s.Args) {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(s.Args[i]))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		t.Fatalf("%s argument %d: %v", s.Call, i+1, err)
	}
	return true
}

func TestGridCases(t *testing.T) {
	var file struct {
		Description string `json:"description"`
		Cases       []struct {
			Name    string           `json:"name"`
			Options json.RawMessage  `json:"options"`
			State   *json.RawMessage `json:"state"`
			Throws  *string          `json:"throws"`
			Steps   []step           `json:"steps"`
		} `json:"cases"`
	}
	caseFile(t, "grid.json", &file)
	for _, kase := range file.Cases {
		t.Run(kase.Name, func(t *testing.T) {
			options := layout.DefaultOptions()
			if kase.Options != nil {
				decoder := json.NewDecoder(bytes.NewReader(kase.Options))
				decoder.DisallowUnknownFields()
				if err := decoder.Decode(&options); err != nil {
					t.Fatal(err)
				}
			}
			var state *layout.State
			if kase.State != nil {
				state = &layout.State{}
				if err := json.Unmarshal(*kase.State, state); err != nil {
					t.Fatal(err)
				}
			}
			grid, err := layout.New(state, options)
			if kase.Throws != nil {
				if err == nil || err.Error() != *kase.Throws {
					t.Fatalf("the construction throws %v, not %q", err, *kase.Throws)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for i, s := range kase.Steps {
				checkStep(t, s, fmt.Sprintf("step %d %s", i+1, s.Call), func() (any, bool, error) { return gridCall(t, grid, s) })
			}
		})
	}
}

// gridCall runs one step on the grid: get and set read and write a property, any other call is the method of that name.
func gridCall(t *testing.T, g *layout.Grid, s step) (any, bool, error) {
	t.Helper()
	var (
		id, target, axis, side, name string
		line                         int
		px, x, y                     float64
	)
	switch s.Call {
	case "get":
		arg(t, s, 0, &name)
		switch name {
		case "gap":
			return g.Gap(), true, nil
		case "minSize":
			return g.MinSize(), true, nil
		case "fillOrder":
			return g.FillOrder(), true, nil
		case "grabSize":
			return g.GrabSize(), true, nil
		case "snapDistance":
			return g.SnapDistance(), true, nil
		case "snap":
			return g.Snap(), true, nil
		case "width":
			return g.Width(), true, nil
		case "height":
			return g.Height(), true, nil
		case "cards":
			return g.Cards(), true, nil
		}
	case "set":
		arg(t, s, 0, &name)
		switch name {
		case "gap", "minSize", "grabSize", "snapDistance":
			arg(t, s, 1, &px)
			map[string]func(float64){"gap": g.SetGap, "minSize": g.SetMinSize, "grabSize": g.SetGrabSize, "snapDistance": g.SetSnapDistance}[name](px)
			return nil, false, nil
		case "fillOrder", "snap":
			var value string
			arg(t, s, 1, &value)
			map[string]func(string){"fillOrder": g.SetFillOrder, "snap": g.SetSnap}[name](value)
			return nil, false, nil
		}
	case "resize":
		arg(t, s, 0, &x)
		arg(t, s, 1, &y)
		g.Resize(x, y)
		return nil, false, nil
	case "toJSON":
		return g.ToJSON(), true, nil
	case "replace":
		var state layout.State
		arg(t, s, 0, &state)
		return nil, false, g.Replace(state)
	case "card":
		arg(t, s, 0, &id)
		card, ok := g.Card(id)
		return card, ok, nil
	case "setData":
		arg(t, s, 0, &id)
		var data json.RawMessage
		arg(t, s, 1, &data)
		return g.SetData(id, data), true, nil
	case "setFixed":
		var fixed bool
		arg(t, s, 0, &id)
		arg(t, s, 1, &fixed)
		return g.SetFixed(id, fixed), true, nil
	case "setSize":
		var size *float64
		arg(t, s, 0, &id)
		arg(t, s, 1, &axis)
		arg(t, s, 2, &size)
		return g.SetSize(id, axis, size), true, nil
	case "lines":
		arg(t, s, 0, &axis)
		return g.Lines(axis), true, nil
	case "rect":
		arg(t, s, 0, &id)
		rect, ok := g.Rect(id)
		return rect, ok, nil
	case "rects":
		return g.Rects(), true, nil
	case "zoneAt":
		var options layout.ZoneOptions
		arg(t, s, 0, &x)
		arg(t, s, 1, &y)
		arg(t, s, 2, &options)
		hit := g.ZoneAt(x, y, options)
		if hit == nil {
			return nil, true, nil
		}
		return hit, true, nil
	case "cardsCrossing":
		arg(t, s, 0, &axis)
		arg(t, s, 1, &line)
		return g.CardsCrossing(axis, line), true, nil
	case "isVirtual":
		arg(t, s, 0, &axis)
		arg(t, s, 1, &line)
		return g.IsVirtual(axis, line), true, nil
	case "virtualCount":
		return g.VirtualCount(), true, nil
	case "isSlicing":
		return g.IsSlicing(), true, nil
	case "rules":
		return g.Rules(), true, nil
	case "dividers":
		return g.Dividers(), true, nil
	case "boundaryPos":
		arg(t, s, 0, &axis)
		arg(t, s, 1, &line)
		return g.BoundaryPos(axis, line), true, nil
	case "hasBoundary":
		arg(t, s, 0, &axis)
		arg(t, s, 1, &line)
		return g.HasBoundary(axis, line), true, nil
	case "boundaryRange":
		arg(t, s, 0, &axis)
		arg(t, s, 1, &line)
		return g.BoundaryRange(axis, line), true, nil
	case "moveBoundary":
		allowSnap := true
		arg(t, s, 0, &axis)
		arg(t, s, 1, &line)
		arg(t, s, 2, &px)
		arg(t, s, 3, &allowSnap)
		return g.MoveBoundary(axis, line, px, allowSnap), true, nil
	case "centerBoundary":
		arg(t, s, 0, &axis)
		arg(t, s, 1, &line)
		return g.CenterBoundary(axis, line), true, nil
	case "balance":
		balanced, err := g.Balance()
		return balanced, true, err
	case "mergeCoincident":
		arg(t, s, 0, &axis)
		arg(t, s, 1, &line)
		return g.MergeCoincident(axis, line), true, nil
	case "tidy":
		return g.Tidy(), true, nil
	case "canSplit":
		arg(t, s, 0, &id)
		arg(t, s, 1, &axis)
		return g.CanSplit(id, axis), true, nil
	case "split", "splitToward":
		var init layout.SplitInit
		arg(t, s, 0, &id)
		arg(t, s, 1, &side)
		arg(t, s, 2, &init)
		split := g.Split
		if s.Call == "splitToward" {
			split = g.SplitToward
		}
		if born, ok := split(id, side, init); ok {
			return born, true, nil
		}
		return nil, true, nil
	case "fill":
		arg(t, s, 0, &id)
		fill := g.Fill(id)
		if fill == nil {
			return nil, true, nil
		}
		return fill, true, nil
	case "canClose":
		arg(t, s, 0, &id)
		return g.CanClose(id), true, nil
	case "close":
		arg(t, s, 0, &id)
		return g.Close(id), true, nil
	case "canInsertAt":
		arg(t, s, 0, &axis)
		arg(t, s, 1, &line)
		arg(t, s, 2, &id)
		return g.CanInsertAt(axis, line, id), true, nil
	case "insertAt":
		var init layout.InsertInit
		arg(t, s, 0, &axis)
		arg(t, s, 1, &line)
		arg(t, s, 2, &init)
		if born, ok := g.InsertAt(axis, line, init); ok {
			return born, true, nil
		}
		return nil, true, nil
	case "moveTo":
		arg(t, s, 0, &id)
		arg(t, s, 1, &axis)
		arg(t, s, 2, &line)
		return g.MoveTo(id, axis, line), true, nil
	case "standings":
		arg(t, s, 0, &axis)
		arg(t, s, 1, &id)
		return g.Standings(axis, id), true, nil
	case "move", "canMove":
		arg(t, s, 0, &id)
		arg(t, s, 1, &target)
		arg(t, s, 2, &side)
		if s.Call == "canMove" {
			return g.CanMove(id, target, side), true, nil
		}
		return g.Move(id, target, side), true, nil
	}
	t.Fatalf("the grid has no call %s %s", s.Call, name)
	return nil, false, nil
}

func TestOutlineCases(t *testing.T) {
	var file struct {
		Description string `json:"description"`
		Cases       []struct {
			Name    string                `json:"name"`
			Rects   []layout.Rect         `json:"rects"`
			Options layout.OutlineOptions `json:"options"`
			Returns json.RawMessage       `json:"returns"`
		} `json:"cases"`
	}
	caseFile(t, "outline.json", &file)
	for _, kase := range file.Cases {
		t.Run(kase.Name, func(t *testing.T) {
			checkStep(t, step{Call: "outline", Returns: kase.Returns}, "outline", func() (any, bool, error) {
				return layout.ComputeOutline(kase.Rects, kase.Options), true, nil
			})
		})
	}
}

func TestStoredCases(t *testing.T) {
	var file struct {
		Description string              `json:"description"`
		Plugins     []layout.PluginUnit `json:"plugins"`
		Cases       []struct {
			Name    string          `json:"name"`
			Check   string          `json:"check"`
			Layout  json.RawMessage `json:"layout"`
			Records json.RawMessage `json:"records"`
			Returns json.RawMessage `json:"returns"`
			Throws  *string         `json:"throws"`
		} `json:"cases"`
	}
	caseFile(t, "stored.json", &file)
	for _, kase := range file.Cases {
		t.Run(kase.Name, func(t *testing.T) {
			s := step{Call: kase.Check, Returns: kase.Returns, Throws: kase.Throws}
			checkStep(t, s, kase.Check, func() (any, bool, error) {
				switch kase.Check {
				case "storedLayout":
					return nil, false, layout.CheckStoredLayout(kase.Layout, file.Plugins)
				case "windowSidebars":
					records, err := layout.RestoreWindowSidebars(kase.Records)
					return records, err == nil, err
				}
				t.Fatalf("no check %s", kase.Check)
				return nil, false, nil
			})
		})
	}
}

// TestWindowSidebarCases docks the fixed window sidebars of the cases in their order
// (docs/spec/external-sidebars.md#fixed-placement-and-persistence).
func TestWindowSidebarCases(t *testing.T) {
	type spans struct {
		ID     string `json:"id"`
		C0, C1 int
		R0, R1 int
		Fixed  bool `json:"fixed"`
	}
	var file struct {
		Description string         `json:"description"`
		Options     layout.Options `json:"options"`
		Cases       []struct {
			Name    string                          `json:"name"`
			State   layout.State                    `json:"state"`
			Order   []string                        `json:"order"`
			Sides   []string                        `json:"sides"`
			Shown   []string                        `json:"shown"`
			Records map[string]layout.WindowSidebar `json:"records"`
			Initial float64                         `json:"initial"`
			Returns *bool                           `json:"returns"`
			Cards   []struct {
				ID    string `json:"id"`
				C0    int    `json:"c0"`
				C1    int    `json:"c1"`
				R0    int    `json:"r0"`
				R1    int    `json:"r1"`
				Fixed bool   `json:"fixed"`
			} `json:"cards"`
			Keeps  map[string]layout.WindowSidebar `json:"keeps"`
			Throws *string                         `json:"throws"`
		} `json:"cases"`
	}
	caseFile(t, "window-sidebars.json", &file)
	for _, kase := range file.Cases {
		t.Run(kase.Name, func(t *testing.T) {
			state := kase.State
			grid, err := layout.New(&state, file.Options)
			if err != nil {
				t.Fatal(err)
			}
			changed, err := layout.ArrangeWindowSidebars(grid, kase.Order, kase.Sides, kase.Records, kase.Initial, func(edge string) bool {
				for _, shown := range kase.Shown {
					if shown == edge {
						return true
					}
				}
				return false
			})
			if kase.Throws != nil {
				if err == nil || err.Error() != *kase.Throws {
					t.Fatalf("dock: throws %v, not %q", err, *kase.Throws)
				}
				return
			}
			if err != nil {
				t.Fatalf("dock: %v", err)
			}
			if kase.Returns == nil || changed != *kase.Returns {
				t.Fatalf("dock: returns %v", changed)
			}
			got := []spans{}
			for _, card := range grid.Cards() {
				got = append(got, spans{ID: card.ID, C0: card.C0, C1: card.C1, R0: card.R0, R1: card.R1, Fixed: card.Fixed})
			}
			sort.Slice(got, func(i, j int) bool { return got[i].ID < got[j].ID })
			want := []spans{}
			for _, card := range kase.Cards {
				want = append(want, spans{ID: card.ID, C0: card.C0, C1: card.C1, R0: card.R0, R1: card.R1, Fixed: card.Fixed})
			}
			if fmt.Sprint(got) != fmt.Sprint(want) {
				t.Fatalf("cards %v, not %v", got, want)
			}
			if fmt.Sprint(kase.Records) != fmt.Sprint(kase.Keeps) {
				t.Fatalf("records %v, not %v", kase.Records, kase.Keeps)
			}
		})
	}
}

func TestSpaceCases(t *testing.T) {
	var file struct {
		Description string `json:"description"`
		Cases       []struct {
			Name    string          `json:"name"`
			Project json.RawMessage `json:"project"`
			Steps   []step          `json:"steps"`
		} `json:"cases"`
	}
	caseFile(t, "spaces.json", &file)
	for _, kase := range file.Cases {
		t.Run(kase.Name, func(t *testing.T) {
			var project layout.Project
			if err := json.Unmarshal(kase.Project, &project); err != nil {
				t.Fatal(err)
			}
			for i, s := range kase.Steps {
				checkStep(t, s, fmt.Sprintf("step %d %s", i+1, s.Call), func() (any, bool, error) { return spaceCall(t, &project, s) })
			}
		})
	}
}

// spaceCall runs one step on the project record: project reads the record, any other call is the space function of that name.
func spaceCall(t *testing.T, project *layout.Project, s step) (any, bool, error) {
	t.Helper()
	var id, title string
	switch s.Call {
	case "project":
		return project, true, nil
	case "spaceIn":
		arg(t, s, 0, &id)
		space, err := layout.SpaceIn(project, id)
		return space, err == nil, err
	case "appendSpace":
		var stored json.RawMessage
		arg(t, s, 0, &id)
		arg(t, s, 1, &stored)
		return layout.AppendSpace(project, id, stored), true, nil
	case "closingSpace":
		arg(t, s, 0, &id)
		closing, err := layout.ClosingSpace(project, id)
		if closing == nil {
			return nil, err == nil, err
		}
		return closing, true, err
	case "removeSpace":
		arg(t, s, 0, &id)
		removed, err := layout.RemoveSpace(project, id)
		if removed == nil {
			return nil, err == nil, err
		}
		return removed, true, err
	case "renameSpace":
		arg(t, s, 0, &id)
		arg(t, s, 1, &title)
		return nil, false, layout.RenameSpace(project, id, title)
	case "spaceTabIds":
		ids, err := layout.SpaceTabIDs(project)
		return ids, err == nil, err
	}
	t.Fatalf("no space function %s", s.Call)
	return nil, false, nil
}

func TestHeadCases(t *testing.T) {
	var file struct {
		Description string `json:"description"`
		Cases       []struct {
			Name    string          `json:"name"`
			Head    layout.Head     `json:"head"`
			Returns json.RawMessage `json:"returns"`
		} `json:"cases"`
	}
	caseFile(t, "head.json", &file)
	for _, kase := range file.Cases {
		t.Run(kase.Name, func(t *testing.T) {
			checkStep(t, step{Call: "fitHead", Returns: kase.Returns}, "fitHead", func() (any, bool, error) {
				return layout.FitHead(kase.Head), true, nil
			})
		})
	}
}

func TestTabCases(t *testing.T) {
	var file struct {
		Description string `json:"description"`
		Cases       []struct {
			Name string `json:"name"`
			Card struct {
				ID   string          `json:"id"`
				Data json.RawMessage `json:"data"`
			} `json:"card"`
			Steps []step `json:"steps"`
		} `json:"cases"`
		Names []struct {
			Name     string          `json:"name"`
			Tab      layout.Tab      `json:"tab"`
			Reported *string         `json:"reported"`
			Modified bool            `json:"modified"`
			Returns  json.RawMessage `json:"returns"`
		} `json:"names"`
	}
	caseFile(t, "tabs.json", &file)
	for _, kase := range file.Cases {
		t.Run(kase.Name, func(t *testing.T) {
			data, err := layout.DecodeCardData(kase.Card.Data)
			if err != nil {
				t.Fatal(err)
			}
			for i, s := range kase.Steps {
				checkStep(t, s, fmt.Sprintf("step %d %s", i+1, s.Call), func() (any, bool, error) { return tabCall(t, data, s) })
			}
		})
	}
	for _, kase := range file.Names {
		t.Run("name "+kase.Name, func(t *testing.T) {
			checkStep(t, step{Call: "tabName", Returns: kase.Returns}, "tabName", func() (any, bool, error) {
				return layout.TabName(kase.Tab, kase.Reported, kase.Modified), true, nil
			})
		})
	}
}

// tabCall runs one step on the card data: card reads the data, any other call is the tab function of that name.
func tabCall(t *testing.T, data *layout.CardData, s step) (any, bool, error) {
	t.Helper()
	switch s.Call {
	case "card":
		return data, true, nil
	case "tabsOf":
		return data.TabList(), true, nil
	case "activeTab":
		tab := data.ActiveTab()
		return tab, tab != nil, nil
	case "cardTextSize":
		return data.CardTextSize(), true, nil
	case "removeTab":
		var id string
		arg(t, s, 0, &id)
		data.RemoveTab(id)
		return nil, false, nil
	case "appendTab":
		var tab layout.Tab
		arg(t, s, 0, &tab)
		data.AppendTab(tab)
		return nil, false, nil
	case "settleActiveTab":
		data.SettleActiveTab()
		return nil, false, nil
	}
	t.Fatalf("no tab call %s", s.Call)
	return nil, false, nil
}

func TestSidebarCases(t *testing.T) {
	var file struct {
		Description string `json:"description"`
		Cases       []struct {
			Name string `json:"name"`
			Card struct {
				ID   string          `json:"id"`
				Data json.RawMessage `json:"data"`
			} `json:"card"`
			Sets  map[string]json.RawMessage `json:"sets"`
			Steps []step                     `json:"steps"`
		} `json:"cases"`
		Present []struct {
			Name      string                           `json:"name"`
			Requested map[string]layout.SidebarRequest `json:"requested"`
			Rect      layout.Rect                      `json:"rect"`
			Metrics   layout.SidebarMetrics            `json:"metrics"`
			Prefer    map[string]string                `json:"prefer"`
			Returns   json.RawMessage                  `json:"returns"`
			Throws    *string                          `json:"throws"`
		} `json:"present"`
		Grid []struct {
			Name    string          `json:"name"`
			Size    float64         `json:"size"`
			Ratio   float64         `json:"ratio"`
			Returns json.RawMessage `json:"returns"`
			Throws  *string         `json:"throws"`
		} `json:"grid"`
	}
	caseFile(t, "sidebars.json", &file)
	for _, kase := range file.Cases {
		t.Run(kase.Name, func(t *testing.T) {
			data, err := layout.DecodeCardData(kase.Card.Data)
			if err != nil {
				t.Fatal(err)
			}
			for i, s := range kase.Steps {
				checkStep(t, s, fmt.Sprintf("step %d %s", i+1, s.Call), func() (any, bool, error) {
					return sidebarCall(t, kase.Card.ID, data, kase.Sets, s)
				})
			}
		})
	}
	for _, kase := range file.Present {
		t.Run("present "+kase.Name, func(t *testing.T) {
			checkStep(t, step{Call: "presentSidebars", Returns: kase.Returns, Throws: kase.Throws}, "presentSidebars", func() (any, bool, error) {
				shown, err := layout.PresentSidebars(kase.Requested, kase.Rect, kase.Metrics, kase.Prefer)
				return shown, err == nil, err
			})
		})
	}
	for _, kase := range file.Grid {
		t.Run("grid "+kase.Name, func(t *testing.T) {
			checkStep(t, step{Call: "deviceGridSize", Returns: kase.Returns, Throws: kase.Throws}, "deviceGridSize", func() (any, bool, error) {
				size, err := layout.DeviceGridSize(kase.Size, kase.Ratio)
				return size, err == nil, err
			})
		})
	}
}

// sidebarCall runs one step on the card data: card reads the data, any other call is the sidebar function of that name.
func sidebarCall(t *testing.T, id string, data *layout.CardData, sets map[string]json.RawMessage, s step) (any, bool, error) {
	t.Helper()
	var side string
	var defaults layout.SidebarDefaults
	var linked *struct {
		ID string `json:"id"`
	}
	linkedID := func() *string {
		if linked == nil {
			return nil
		}
		return &linked.ID
	}
	switch s.Call {
	case "card":
		return data, true, nil
	case "effectiveSidebar":
		arg(t, s, 0, &side)
		arg(t, s, 1, &defaults)
		arg(t, s, 2, &linked)
		effective, err := layout.EffectiveSidebar(id, data, side, defaults, linkedID())
		return effective, err == nil, err
	case "resolveSidebarSet":
		arg(t, s, 0, &side)
		arg(t, s, 1, &defaults)
		arg(t, s, 2, &linked)
		set, err := layout.ResolveSidebarSet(id, data, side, sets, defaults, linkedID())
		if err != nil {
			return nil, false, err
		}
		if set == nil {
			return nil, true, nil
		}
		return set, true, nil
	case "setSidebar":
		var choice string
		arg(t, s, 0, &side)
		arg(t, s, 1, &choice)
		return nil, false, layout.SetSidebar(id, data, side, choice, sets)
	case "toggleSidebar":
		var shownCollapsed bool
		arg(t, s, 0, &side)
		arg(t, s, 1, &defaults)
		arg(t, s, 2, &linked)
		arg(t, s, 3, &shownCollapsed)
		return nil, false, layout.ToggleSidebar(id, data, side, defaults, linkedID(), shownCollapsed)
	case "sizeSidebar":
		var size float64
		arg(t, s, 0, &side)
		arg(t, s, 1, &size)
		arg(t, s, 2, &defaults)
		arg(t, s, 3, &linked)
		return nil, false, layout.SizeSidebar(id, data, side, size, defaults, linkedID())
	}
	t.Fatalf("no sidebar call %s", s.Call)
	return nil, false, nil
}
