// The settings left and right choose whether the fixed sidebars of the window stand in the plane (docs/spec/settings.md).
package workbench_test

import (
	"encoding/json"
	"testing"
)

// fixedProject is a project with the tab a of notes between the two fixed sidebars of the window.
func fixedProject() map[string]any {
	project := storedProject(tab("tab-aaaaaa", "notes"))
	layout := project["spaces"].([]map[string]any)[0]["layout"].(map[string]any)
	main := layout["state"].(map[string]any)["cards"].([]map[string]any)[0]
	main["c0"], main["c1"] = 1, 2
	layout["state"] = map[string]any{"xs": []float64{0, 1. / 3, 2. / 3, 1}, "ys": []float64{0, 1}, "paidBy": map[string]any{},
		"cards": []map[string]any{
			{"id": "left", "c0": 0, "c1": 1, "r0": 0, "r1": 1, "width": 190, "fixed": true},
			main,
			{"id": "right", "c0": 2, "c1": 3, "r0": 0, "r1": 1, "width": 210, "fixed": true},
		}}
	return project
}

// cardWidth returns the drawn width of a card, or 0 when the plane does not hold it.
func cardWidth(f *tabShell, id string) float32 {
	node, ok := exposedNode(f.tester.ElementTree(), "core.card", id)
	if !ok {
		return 0
	}
	return node.Bounds.W
}

func TestFoldingAWindowSidebarTakesItsColumnOut(t *testing.T) {
	f := newTabShell(t, &storedHost{projects: []map[string]any{fixedProject()}})
	f.open(t)
	before := cardWidth(f, "main")
	if cardWidth(f, "left") == 0 || before == 0 {
		t.Fatalf("the cards are left %v and main %v", cardWidth(f, "left"), before)
	}
	f.click("core.sidebar.fold", "left")
	f.settle()
	if width := cardWidth(f, "left"); width != 0 {
		t.Fatalf("the left sidebar still stands, %v wide", width)
	}
	if after := cardWidth(f, "main"); after <= before {
		t.Fatalf("main stayed %v wide after %v", after, before)
	}
	if cardWidth(f, "right") == 0 {
		t.Fatal("the right sidebar went with the left one")
	}
}

func TestAWindowSidebarComesBackWithItsWidth(t *testing.T) {
	f := newTabShell(t, &storedHost{projects: []map[string]any{fixedProject()}})
	f.open(t)
	before := cardWidth(f, "right")
	f.run(t, "core.settings.set", `{"patch":{"right":false}}`)
	if width := cardWidth(f, "right"); width != 0 {
		t.Fatalf("the right sidebar still stands, %v wide", width)
	}
	f.run(t, "core.settings.set", `{"patch":{"right":true}}`)
	if width := cardWidth(f, "right"); width != before {
		t.Fatalf("the right sidebar came back %v wide, want %v", width, before)
	}
}

func TestASpaceStoresTheWidthsOfItsWindowSidebars(t *testing.T) {
	f := newTabShell(t, &storedHost{projects: []map[string]any{fixedProject()}})
	f.open(t)
	f.run(t, "core.settings.set", `{"patch":{"left":false}}`)
	f.settle()
	var layout struct {
		WindowSidebars map[string]struct {
			Width float64 `json:"width"`
		} `json:"windowSidebars"`
	}
	value, err := f.shell.Registry().Read("core.layout")
	if err != nil {
		t.Fatal(err)
	}
	text, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(text, &layout); err != nil {
		t.Fatal(err)
	}
	if layout.WindowSidebars["left"].Width != 190 || layout.WindowSidebars["right"].Width != 210 {
		t.Fatalf("the space stores %s", text)
	}
}
