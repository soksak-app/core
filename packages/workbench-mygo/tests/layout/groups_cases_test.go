// The shared layout cases of docs/spec/cases/layout/groups.json run against the tree of planes of the Go layout model
// (docs/spec/groups.md).
package layout_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/soksak-app/core/packages/workbench-mygo/src/layout"
)

// storedTree is the stored form of the tree of a space: the root plane, its leader and lastCard, each absent as nil.
type storedTree struct {
	State    layout.State    `json:"state"`
	Leader   json.RawMessage `json:"leader"`
	LastCard json.RawMessage `json:"lastCard"`
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
			Layout storedTree `json:"layout"`
			Throws *string    `json:"throws"`
			Steps  []step     `json:"steps"`
		} `json:"cases"`
	}
	caseFile(t, "groups.json", &file)
	for _, kase := range file.Cases {
		t.Run(kase.Name, func(t *testing.T) {
			o := kase.Options
			root, err := layout.New(&layout.State{Xs: []float64{0, 1}, Ys: []float64{0, 1}, Cards: []layout.Card{{ID: "card", C1: 1, R1: 1}}},
				layout.Options{Gap: &o.Gap, MinSize: &o.MinSize, Width: &o.Width, Height: &o.Height})
			if err != nil {
				t.Fatal(err)
			}
			planes, err := layout.ReadPlanes(kase.Layout.State, kase.Layout.Leader, kase.Layout.LastCard,
				layout.PlaneOptions{Gap: o.Gap, MinSize: o.MinSize, Head: o.Head}, root)
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
				checkStep(t, s, fmt.Sprintf("step %d %s", i+1, s.Call), func() (any, bool, error) { return groupCall(t, planes, s) })
			}
		})
	}
}

// groupCall runs one step on the tree of planes.
func groupCall(t *testing.T, p *layout.Planes, s step) (any, bool, error) {
	t.Helper()
	var (
		id, target, side, name string
		data                   json.RawMessage
		x, y                   float64
		even                   bool
	)
	switch s.Call {
	case "create":
		arg(t, s, 0, &id)
		arg(t, s, 1, &side)
		arg(t, s, 2, &data)
		arg(t, s, 3, &even)
		group, born, err := p.CreateGroup(id, side, data, even)
		return []string{group, born}, true, err
	case "split":
		arg(t, s, 0, &id)
		arg(t, s, 1, &side)
		arg(t, s, 2, &data)
		arg(t, s, 3, &even)
		born, err := p.Split(id, side, data, even)
		return born, true, err
	case "addCard":
		arg(t, s, 0, &id)
		arg(t, s, 1, &data)
		born, err := p.AddCard(id, data)
		return born, true, err
	case "close":
		arg(t, s, 0, &id)
		ended, err := p.Close(id)
		return ended, true, err
	case "dissolve":
		arg(t, s, 0, &id)
		return nil, false, p.Dissolve(id)
	case "rename":
		arg(t, s, 0, &id)
		arg(t, s, 1, &name)
		named, err := p.Rename(id, name)
		return named, true, err
	case "leader":
		arg(t, s, 0, &id)
		key, err := p.SetLeader(id)
		if key == layout.RootPlane {
			return nil, true, err
		}
		return key, true, err
	case "move":
		arg(t, s, 0, &id)
		arg(t, s, 1, &target)
		arg(t, s, 2, &side)
		return nil, false, p.Move(id, target, side)
	case "smallest":
		arg(t, s, 0, &id)
		w, h := p.Smallest(id)
		return []float64{w, h}, true, nil
	case "rect":
		arg(t, s, 0, &id)
		rect, ok := p.Rect(id)
		return rect, ok, nil
	case "groups":
		arg(t, s, 0, &id)
		return p.Groups(id), true, nil
	case "group":
		arg(t, s, 0, &id)
		group, ok := p.Group(id)
		return group, ok, nil
	case "planeCards":
		var key *string
		arg(t, s, 0, &key)
		plane := layout.RootPlane
		if key != nil {
			plane = *key
		}
		return p.PlaneCards(plane), true, nil
	case "drop":
		var options struct {
			layout.ZoneOptions
			Without string `json:"without"`
		}
		arg(t, s, 0, &x)
		arg(t, s, 1, &y)
		arg(t, s, 2, &options)
		hit := p.DropAt(x, y, options.ZoneOptions, options.Without)
		if hit == nil {
			return nil, true, nil
		}
		return hit, true, nil
	case "stored":
		state, leader, last, err := p.Stored()
		return map[string]any{"state": state, "leader": leader, "lastCard": last}, true, err
	}
	t.Fatalf("unknown call %s", s.Call)
	return nil, false, nil
}
