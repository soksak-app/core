// The shared layout cases of docs/spec/cases/layout/groups.json run against the group tree of the Go layout model
// (docs/spec/groups.md).
package layout_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// storedGroups is the stored form of a space layout: the tree of the grid with the group cards as boxes, the leader of the root level and
// lastCard, each absent as nil, and groups, the group list of the earlier form, which the reader refuses.
type storedGroups struct {
	State    layout.State    `json:"state"`
	Groups   json.RawMessage `json:"groups"`
	Leader   json.RawMessage `json:"leader"`
	LastCard json.RawMessage `json:"lastCard"`
}

// groupStep is one step of groups.json: a call with its named arguments and the value it returns or the text it throws.
type groupStep struct {
	Call    string          `json:"call"`
	Args    json.RawMessage `json:"args"`
	Returns json.RawMessage `json:"returns"`
	Throws  *string         `json:"throws"`
}

// groupArgs are the named arguments of a step.
type groupArgs struct {
	Card     string      `json:"card"`
	Group    string      `json:"group"`
	Target   string      `json:"target"`
	Side     string      `json:"side"`
	Name     string      `json:"name"`
	Axis     layout.Axis `json:"axis"`
	Line     int         `json:"line"`
	Position float64     `json:"position"`
	X        float64     `json:"x"`
	Y        float64     `json:"y"`
	Arrange  bool        `json:"arrange"`
}

// TestGroupCases runs each case of groups.json.
func TestGroupCases(t *testing.T) {
	var file struct {
		Description string `json:"description"`
		Cases       []struct {
			Name    string `json:"name"`
			Options struct {
				Gap     float64 `json:"gap"`
				MinSize float64 `json:"minSize"`
				Head    float64 `json:"head"`
				Width   float64 `json:"width"`
				Height  float64 `json:"height"`
			} `json:"options"`
			Layout storedGroups `json:"layout"`
			Throws *string      `json:"throws"`
			Steps  []groupStep  `json:"steps"`
		} `json:"cases"`
	}
	caseFile(t, "groups.json", &file)
	for _, kase := range file.Cases {
		t.Run(kase.Name, func(t *testing.T) {
			o := kase.Options
			grid, err := layout.New(nil, layout.Options{Gap: &o.Gap, MinSize: &o.MinSize, Width: &o.Width, Height: &o.Height})
			if err != nil {
				t.Fatal(err)
			}
			tree, err := layout.ReadTree(kase.Layout.State, kase.Layout.Groups, kase.Layout.Leader, kase.Layout.LastCard,
				layout.GroupOptions{Head: o.Head}, grid)
			if kase.Throws != nil {
				if err == nil || err.Error() != *kase.Throws {
					t.Fatalf("the read throws %v, not %q", err, *kase.Throws)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for i, s := range kase.Steps {
				var args groupArgs
				decoder := json.NewDecoder(bytes.NewReader(s.Args))
				decoder.DisallowUnknownFields()
				if err := decoder.Decode(&args); err != nil {
					t.Fatalf("step %d %s: %v", i+1, s.Call, err)
				}
				checkStep(t, step{Call: s.Call, Returns: s.Returns, Throws: s.Throws}, fmt.Sprintf("step %d %s", i+1, s.Call),
					func() (any, bool, error) { return groupCall(t, tree, s.Call, args) })
			}
		})
	}
}

// groupCall runs one step on the group tree.
func groupCall(t *testing.T, tree *layout.GroupTree, call string, a groupArgs) (any, bool, error) {
	t.Helper()
	switch call {
	case "boundary":
		return map[string]float64{"position": tree.MoveBoundaryTo(a.Axis, a.Line, a.Position)}, true, nil
	case "balance":
		return nil, false, tree.Balance(a.Arrange)
	case "create":
		group, born, err := tree.CreateGroup(a.Card, a.Side, nil)
		return map[string]string{"group": group, "card": born}, true, err
	case "split":
		born, err := tree.Split(a.Card, a.Side, nil)
		return map[string]string{"card": born}, true, err
	case "close":
		_, err := tree.Close(a.Card)
		return map[string]bool{"closed": true}, true, err
	case "dissolve":
		return map[string]bool{"dissolved": true}, true, tree.Dissolve(a.Group)
	case "rename":
		named, err := tree.Rename(a.Group, a.Name)
		return map[string]string{"group": a.Group, "name": named}, true, err
	case "leader":
		group, err := tree.SetLeader(a.Card)
		var holder any
		if group != "" {
			holder = group
		}
		return map[string]any{"card": a.Card, "group": holder}, true, err
	case "add":
		born, err := tree.AddCard(a.Group, nil)
		return map[string]string{"card": born}, true, err
	case "move":
		return map[string]string{"card": a.Card}, true, tree.Move(a.Card, a.Target, a.Side)
	case "grid":
		grid := tree.Grid()
		cards := []map[string]any{}
		for _, card := range grid.Cards() {
			cards = append(cards, map[string]any{"id": card.ID, "c0": card.C0, "c1": card.C1, "r0": card.R0, "r1": card.R1, "fixed": card.Fixed})
		}
		return map[string]any{"xs": grid.Lines("x"), "ys": grid.Lines("y"), "cards": cards}, true, nil
	case "stored":
		state, leader, last := tree.Stored()
		return map[string]any{"state": state, "leader": leader, "lastCard": last}, true, nil
	case "rect":
		rect, ok := tree.Rect(a.Card)
		return rect, ok, nil
	case "path":
		path := []map[string]string{}
		for _, group := range tree.Groups(a.Card) {
			path = append(path, map[string]string{"card": group, "name": tree.GroupName(group)})
		}
		return path, true, nil
	case "level":
		return tree.Level(a.Card), true, nil
	case "drop":
		hit := tree.DropAt(a.X, a.Y, layout.ZoneOptions{}, "")
		if hit == nil {
			return nil, true, nil
		}
		return map[string]string{"card": hit.ID, "zone": hit.Zone}, true, nil
	}
	t.Fatalf("unknown call %s", call)
	return nil, false, nil
}
