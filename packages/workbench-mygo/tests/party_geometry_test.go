package workbench_test

import (
	"encoding/json"
	"math"
	"testing"
)

// The geometry of a party in the Shell, read from the statuses core.parties and core.rail. The stroke of an outline is not read here:
// a unit test has no painter that records strokes, so the stroke is verified by the window check F908-9.

type partyOutlineRead struct {
	ID      string         `json:"id"`
	Outline [][][2]float64 `json:"outline"`
}

type railLoopsRead struct {
	Groups []struct {
		Loops [][]struct {
			X float64 `json:"x"`
			Y float64 `json:"y"`
		} `json:"loops"`
	} `json:"groups"`
}

// segmentDistance is the distance of point p from the segment a-b.
func segmentDistance(p, a, b [2]float64) float64 {
	dx, dy := b[0]-a[0], b[1]-a[1]
	length := dx*dx + dy*dy
	t := 0.0
	if length > 0 {
		t = math.Max(0, math.Min(1, ((p[0]-a[0])*dx+(p[1]-a[1])*dy)/length))
	}
	return math.Hypot(p[0]-(a[0]+t*dx), p[1]-(a[1]+t*dy))
}

// tabAndSidebarShell is a surface shell whose plugins are the sidebar fixture plus the tab plugin textprobe of the view fixture, so
// one shell has a tab plugin for the cards and a window sidebar plugin for the rail.
func tabAndSidebarShell(t *testing.T) *shellFixture {
	t.Helper()
	var sides, views struct {
		Plugins []json.RawMessage `json:"plugins"`
	}
	if err := json.Unmarshal([]byte(sidebarsInstalled), &sides); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(installedDocument), &views); err != nil {
		t.Fatal(err)
	}
	for _, raw := range views.Plugins {
		var entry struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &entry); err != nil {
			t.Fatal(err)
		}
		if entry.ID == "textprobe" {
			sides.Plugins = append(sides.Plugins, raw)
		}
	}
	installed, err := json.Marshal(sides)
	if err != nil {
		t.Fatal(err)
	}
	f, _ := surfaceShellOf(t, string(installed))
	return f
}

// TestPartyOutlineNeverCoincidesWithTheRail checks the rule of docs/spec/parties.md#drawing: the outline of a party and the rail never
// coincide, so no vertex of the party outline lies on a segment of the rail outline. The stroke is not read here: a unit test has no
// painter that records strokes, and the leader border is not in any status, so the leader border rule is verified by the window check
// F908-9 only.
func TestPartyOutlineNeverCoincidesWithTheRail(t *testing.T) {
	f := tabAndSidebarShell(t)
	left := f.tabbedCards()[0]
	made, err := f.answer("core.card.split", map[string]string{"card": left, "side": "right", "plugin": "textprobe"})
	if err != nil {
		t.Fatal(err)
	}
	right := made["card"].(string)
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"top": true}, "scope": "common"})
	f.run("core.settings.link", map[string]any{"place": "window-top", "plugin": "boxprobe", "set": "set-page", "scope": "common"})
	f.run("core.party.create", map[string]any{"cards": []string{left, right}, "leader": left})
	parties := status[[]partyOutlineRead](t, f, "core.parties")
	if len(parties) != 1 || len(parties[0].Outline) == 0 {
		t.Fatalf("core.parties is %v", parties)
	}
	const minimum = 0.5 // pixels: a line that touches the rail within half a pixel is a coincidence.
	closest := math.Inf(1)
	compared := 0
	// The rail of each card that is focused in turn holds its own outline, so each focus is compared with the party outline.
	for _, card := range f.tabbedCards() {
		f.run("core.card.focus", map[string]string{"card": card})
		rail := status[railLoopsRead](t, f, "core.rail")
		for _, loop := range parties[0].Outline {
			for _, vertex := range loop {
				for _, group := range rail.Groups {
					for _, railLoop := range group.Loops {
						for i := range railLoop {
							a := railLoop[i]
							b := railLoop[(i+1)%len(railLoop)]
							closest = math.Min(closest, segmentDistance(vertex, [2]float64{a.X, a.Y}, [2]float64{b.X, b.Y}))
							compared++
						}
					}
				}
			}
		}
	}
	// Without a rail segment the distance is infinite and the rule holds vacuously, so the test fails when nothing was compared.
	if compared == 0 {
		t.Fatal("core.rail has no outline segment to compare with the party outline")
	}
	if closest < minimum {
		t.Fatalf("the party outline comes %.3f px from the rail outline, which must stay at least %.1f px away (%d segments compared)", closest, minimum, compared)
	}
	t.Logf("compared %d rail segments; closest distance %.3f px", compared, closest)
}
