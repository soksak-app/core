package workbench_test

import (
	"encoding/json"
	"math"
	"testing"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// The geometry of a party in the Shell, read from the statuses core.parties and core.rail. The stroke of an outline is read from the
// pixels of the frame by party_drawing_test.go.

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
// coincide, so no vertex of the party outline lies on a segment of the rail outline. The stroke and the leader border are read from the
// pixels of the frame by party_drawing_test.go.
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

type railGridRead struct {
	Gap   float64 `json:"gap"`
	Cards []struct {
		ID string  `json:"id"`
		X  float64 `json:"x"`
		Y  float64 `json:"y"`
		W  float64 `json:"w"`
		H  float64 `json:"h"`
	} `json:"cards"`
}

// axisSide is a horizontal or vertical side of a loop: the line at at, from from to to on the other axis.
type axisSide struct {
	vertical     bool
	at, from, to float64
}

// axisSides returns the horizontal and vertical sides of closed loops; a side of a rounded corner is no axis side.
func axisSides(loops [][][2]float64) []axisSide {
	const same = 0.01
	sides := []axisSide{}
	for _, loop := range loops {
		for i := range loop {
			a, b := loop[i], loop[(i+1)%len(loop)]
			switch {
			case math.Abs(a[0]-b[0]) < same && math.Abs(a[1]-b[1]) >= same:
				sides = append(sides, axisSide{true, a[0], math.Min(a[1], b[1]), math.Max(a[1], b[1])})
			case math.Abs(a[1]-b[1]) < same && math.Abs(a[0]-b[0]) >= same:
				sides = append(sides, axisSide{false, a[1], math.Min(a[0], b[0]), math.Max(a[0], b[0])})
			}
		}
	}
	return sides
}

func sideOverlap(a, b axisSide) float64 { return math.Min(a.to, b.to) - math.Max(a.from, b.from) }

// TestNoPartyColourShowsOutsideTheRailOfAFocusedLeader checks the rule of docs/spec/parties.md#drawing for the focused leader: both
// lines stay at their places, the rail is drawn over the party line and no party colour shows outside the rail. For each side of the
// party outline on an edge of the leader card that the rail also outlines, the outer edge of the rail band, of the stroke bw of the
// theme, is not nearer the card than the outer edge of the party band, of the party width. core.parties does not change with the focus,
// and the pixel where the two bands overlap shows the rail colour, because the shell paints the rail after the parties.
func TestNoPartyColourShowsOutsideTheRailOfAFocusedLeader(t *testing.T) {
	f := tabAndSidebarShell(t)
	left := f.tabbedCards()[0]
	made, err := f.answer("core.card.split", map[string]string{"card": left, "side": "right", "plugin": "textprobe"})
	if err != nil {
		t.Fatal(err)
	}
	right := made["card"].(string)
	f.run("core.settings.set", map[string]any{"patch": map[string]any{"top": true}, "scope": "common"})
	f.run("core.settings.link", map[string]any{"place": "window-top", "plugin": "boxprobe", "set": "set-page", "scope": "common"})
	// The leader is the card that the rail outlines with the window sidebar top when it is focused: the card whose tab is of boxprobe,
	// whose override the link names. The other card of the party is a card of the split row that touches it.
	leader := ""
	for _, card := range f.tabbedCards() {
		f.run("core.card.focus", map[string]string{"card": card})
		if len(status[railLoopsRead](t, f, "core.rail").Groups) > 0 {
			leader = card
			break
		}
	}
	if leader == "" || leader == left || leader == right {
		t.Fatalf("the rail outlines the card %q, expected a card other than the split cards %s and %s", leader, left, right)
	}
	f.run("core.card.focus", map[string]string{"card": left})
	f.run("core.party.create", map[string]any{"cards": []string{leader, left}, "leader": leader})
	before, err := json.Marshal(status[json.RawMessage](t, f, "core.parties"))
	if err != nil {
		t.Fatal(err)
	}
	f.run("core.card.focus", map[string]string{"card": leader})
	f.settle()
	after, err := json.Marshal(status[json.RawMessage](t, f, "core.parties"))
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatalf("core.parties changed with the focus: %s, then %s", before, after)
	}
	declared, err := workbench.ReadDeclarations()
	if err != nil {
		t.Fatal(err)
	}
	partyWidth := declared.ChromeNumber("theme-rail-w", "px")
	palette := f.palette()
	bw := float64(palette.BorderWidth)
	parties := status[[]partyOutlineRead](t, f, "core.parties")
	rail := status[railLoopsRead](t, f, "core.rail")
	grid := status[railGridRead](t, f, "core.grid")
	if len(parties) != 1 || len(rail.Groups) == 0 {
		t.Fatalf("core.parties is %v and core.rail has %d groups", parties, len(rail.Groups))
	}
	railLoops := [][][2]float64{}
	for _, group := range rail.Groups {
		for _, loop := range group.Loops {
			points := [][2]float64{}
			for _, point := range loop {
				points = append(points, [2]float64{point.X, point.Y})
			}
			railLoops = append(railLoops, points)
		}
	}
	railSides, partySides := axisSides(railLoops), axisSides(parties[0].Outline)
	// The four edges of the leader card, each with the sign of the direction out of the card.
	type edge struct {
		side    axisSide
		outward float64
	}
	var edges []edge
	var plane [2]float64
	for _, card := range grid.Cards {
		if card.ID == leader {
			edges = []edge{
				{axisSide{true, card.X, card.Y, card.Y + card.H}, -1},
				{axisSide{true, card.X + card.W, card.Y, card.Y + card.H}, 1},
				{axisSide{false, card.Y, card.X, card.X + card.W}, -1},
				{axisSide{false, card.Y + card.H, card.X, card.X + card.W}, 1},
			}
			// The plane origin in the window: the card element of the leader stands at its plane rectangle.
			box := f.box("core.card", leader)
			plane = [2]float64{float64(box.X) - card.X, float64(box.Y) - card.Y}
		}
	}
	if edges == nil {
		t.Fatalf("core.grid has no card %s", leader)
	}
	onEdge := func(side, edge axisSide) bool {
		return side.vertical == edge.vertical && math.Abs(side.at-edge.at) <= grid.Gap/2+0.01 && sideOverlap(side, edge) >= 0.01
	}
	// The device pixels of the frame per window point, as pixelOf reads them.
	scale := float64(f.tester.Image().Bounds().Dx()) / float64(f.tester.ElementTree()[0].Bounds.W)
	compared, painted := 0, 0
	for _, edge := range edges {
		for _, railSide := range railSides {
			if !onEdge(railSide, edge.side) {
				continue
			}
			for _, partySide := range partySides {
				if !onEdge(partySide, edge.side) || sideOverlap(partySide, railSide) < 0.01 {
					continue
				}
				compared++
				railOuter := (railSide.at-edge.side.at)*edge.outward + bw/2
				partyOuter := (partySide.at-edge.side.at)*edge.outward + partyWidth/2
				if railOuter-partyOuter < -0.01 {
					t.Errorf("the party band reaches %.3f px out of the card, past the rail band at %.3f px: party side %+v, rail side %+v", partyOuter, railOuter, partySide, railSide)
				}
				// A device pixel that the rail band covers whole, in the middle of the stretch that both sides share, shows the rail colour.
				// A rail band that covers no whole device pixel is blended with what lies under it, so it does not show the order.
				origin := plane[1]
				if railSide.vertical {
					origin = plane[0]
				}
				lo, hi := (origin+railSide.at-bw/2)*scale, (origin+railSide.at+bw/2)*scale
				index := math.Ceil(lo - 0.001)
				if index+1 > hi+0.001 {
					continue
				}
				across := (index + 0.5) / scale
				middle := (math.Max(partySide.from, railSide.from) + math.Min(partySide.to, railSide.to)) / 2
				x, y := across, plane[1]+middle
				if !railSide.vertical {
					x, y = plane[0]+middle, across
				}
				painted++
				if got, want := f.pixelOf(float32(x), float32(y)), opaque(palette.Rail); !near(got, want) {
					t.Errorf("the pixel (%.2f, %.2f) where the rail side %+v and the party side %+v overlap is %v, want the rail colour %v", x, y, railSide, partySide, got, want)
				}
			}
		}
	}
	if compared == 0 {
		t.Fatalf("no side of the party outline lies on an edge of %s that the rail outlines: rail %v, party %v", leader, railSides, partySides)
	}
	if painted == 0 {
		t.Fatalf("no rail side on an edge of %s covers a whole device pixel at scale %.1f, so the order of the rail and the party is not shown", leader, scale)
	}
}
