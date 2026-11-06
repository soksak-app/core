package workbench_test

import (
	"fmt"
	"image/color"
	"math"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

// groupLabeled returns the first element of the tree with the label that holds other elements.
func groupLabeled(nodes []ui.ElementNode, label string) (ui.ElementNode, bool) {
	for _, node := range nodes {
		if node.Label == label && len(node.Children) > 0 {
			return node, true
		}
		if found, ok := groupLabeled(node.Children, label); ok {
			return found, true
		}
	}
	return ui.ElementNode{}, false
}

// The folder caption of the project scope shows the whole path inside the pane: a line breaks at a space, after a hyphen and after a
// path separator, and a name wider than the line breaks at the end of the line; nothing runs past the pane (docs/spec/settings.md).
// The caption is laid out again with the font, the size and the line height it is drawn with, at the width of the pane, so the lines
// it is drawn in are the lines read here.
func TestTheFolderCaptionBreaksAfterItsSeparatorsInsideThePane(t *testing.T) {
	root := "/Users/someone/work-tree/a b/name\\with/" + strings.Repeat("abcdefgh", 14) + "/end"
	project := storedProject(tab("tab-aaaaaa", "other"))
	// A stored project is the folder whose identity the host answers for its root, as a project opened at that root.
	project["root"], project["identity"] = root, "identity of "+root
	f := newTabShell(t, &storedHost{projects: []map[string]any{project}})
	f.open(t)
	f.click("core.chrome.settings", "")
	f.shellFixture.run("core.settings-modal.scope", map[string]any{"scope": "project"})
	nodes := f.tester.ElementTree()
	folder, ok := exposedNode(nodes, "core.settings-modal.folder", "")
	if !ok {
		t.Fatalf("the project scope has no element core.settings-modal.folder; the texts are %q", f.tester.Texts())
	}
	if folder.Label != root {
		t.Fatalf("the caption shows %q, not the whole path %q", folder.Label, root)
	}
	tabs, ok := groupLabeled(nodes, "설정 범위")
	if !ok {
		t.Fatal("no group of the scope buttons")
	}
	pane := tabs.Bounds
	if folder.Bounds.X < pane.X-0.5 || folder.Bounds.X+folder.Bounds.W > pane.X+pane.W+0.5 {
		t.Fatalf("the caption %+v runs past the pane %+v", folder.Bounds, pane)
	}
	declared, err := workbench.Declared()
	if err != nil {
		t.Fatal(err)
	}
	small, _ := declared.Metric("text-small-at-base")
	base, _ := declared.Metric("text-base")
	// The card sets the line height of the chrome for all of its text.
	leading, _ := declared.Metric("line-height")
	catalog, err := workbench.ReadSettingsCatalog()
	if err != nil {
		t.Fatal(err)
	}
	values := status[map[string]any](t, f.shellFixture, "core.settings")["values"].(map[string]any)
	stack := catalog.Stack(values["font"].(string))
	size := float32(values["size"].(float64) * small / base)
	layout := ui.ShapeRichTextWith([]ui.Span{{Text: root, Font: stack, Size: size}}, ui.Font{Family: stack, Size: size, LineHeight: float32(leading)},
		ui.TextShape{Width: pane.W, KeepAll: true})
	lines := layout.Lines()
	if len(lines) < 3 {
		t.Fatalf("the path of %d letters takes %d lines of %v", len(root), len(lines), pane.W)
	}
	last := lines[len(lines)-1]
	if tall := last.Rect.Y + last.Rect.H - lines[0].Rect.Y; math.Abs(float64(folder.Bounds.H-tall)) > 1 {
		t.Fatalf("the caption is drawn %v tall, its %d lines at the width of the pane are %v\ndrawn %s\nlaid out %s\nwith the font of the window %s",
			folder.Bounds.H, len(lines), tall, f.inkLines(folder.Bounds, pane), laidOut(root, units(root), lines),
			laidOut(root, units(root), ui.ShapeRichTextWith([]ui.Span{{Text: root, Size: size}}, ui.Font{Size: size, LineHeight: float32(leading)},
				ui.TextShape{Width: pane.W, KeepAll: true}).Lines()))
	}
	encoded := units(root)
	for index, line := range lines[:len(lines)-1] {
		text := string(utf16.Decode(encoded[line.Start:line.End]))
		if strings.ContainsRune(" -/\\", rune(encoded[line.End-1])) {
			continue
		}
		// A line that ends inside a name holds only a part of a name wider than the line.
		if strings.ContainsAny(text, " -/\\") {
			t.Errorf("line %d %q ends inside a name although it holds a place to break", index, text)
		}
	}
}

func units(text string) []uint16 { return utf16.Encode([]rune(text)) }

// laidOut lists the lines of a layout of text: the text of each and its width.
func laidOut(text string, units []uint16, lines []ui.TextLine) string {
	var parts []string
	for _, line := range lines {
		parts = append(parts, fmt.Sprintf("%q %.1f", string(utf16.Decode(units[line.Start:line.End])), line.Rect.W))
	}
	return fmt.Sprintf("%d lines: %s", len(lines), strings.Join(parts, " | "))
}

// inkLines lists the drawn lines of the text in box: the rows that hold ink, and for each run of them where its ink starts and ends.
func (f *shellFixture) inkLines(box, pane ui.Rect) string {
	image := f.tester.Image()
	scale := float32(image.Bounds().Dx()) / f.tester.ElementTree()[0].Bounds.W
	fill := image.RGBAAt(int((box.X-2)*scale), int((box.Y+1)*scale))
	differs := func(c color.RGBA) bool { return c != fill }
	var parts []string
	start, left, right := -1, 0, 0
	for row := int(box.Y * scale); row <= int((box.Y+box.H)*scale); row++ {
		first, last := -1, -1
		for column := int(pane.X * scale); column < int((pane.X+pane.W+40)*scale) && column < image.Bounds().Dx(); column++ {
			if differs(image.RGBAAt(column, row)) {
				if first < 0 {
					first = column
				}
				last = column
			}
		}
		if first >= 0 {
			if start < 0 {
				start, left, right = row, first, last
			}
			left, right = min(left, first), max(right, last)
			continue
		}
		if start >= 0 {
			parts = append(parts, fmt.Sprintf("rows %.1f-%.1f ink %.1f-%.1f", float32(start)/scale, float32(row)/scale, float32(left)/scale, float32(right+1)/scale))
			start = -1
		}
	}
	return fmt.Sprintf("box %+v pane %+v, %d lines: %s", box, pane, len(parts), strings.Join(parts, " | "))
}
