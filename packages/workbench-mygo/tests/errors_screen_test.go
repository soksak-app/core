package workbench_test

import (
	"slices"
	"testing"

	"github.com/egoist/mygo/ui"

	workbench "github.com/soksak-app/core/packages/workbench-mygo/src"
)

func TestAnErrorIsWrittenWhenTheErrorOfItsPlaceChanges(t *testing.T) {
	var lines []string
	errors := workbench.NewShownErrors(func(line string) { lines = append(lines, line) })
	errors.Show("workbench", "layout failed", " @ grid.go:1")
	errors.Show("workbench", "layout failed", " @ grid.go:1")
	errors.Show("workbench", "another failure", "")
	errors.Show("debug", "layout failed", "")
	want := []string{"workbench: layout failed @ grid.go:1", "workbench: another failure", "debug: layout failed"}
	if !slices.Equal(lines, want) {
		t.Fatalf("written lines %q, want %q", lines, want)
	}
}

func TestAWithdrawnErrorIsWrittenAgainWhenItIsShownAgain(t *testing.T) {
	var lines []string
	errors := workbench.NewShownErrors(func(line string) { lines = append(lines, line) })
	errors.Show("debug", "no file", "")
	errors.Hide("debug")
	if text, shown := errors.Text("debug"); shown {
		t.Fatalf("a withdrawn error still shows %q", text)
	}
	errors.Show("debug", "no file", "")
	if len(lines) != 2 {
		t.Fatalf("written lines %q, want the error twice", lines)
	}
}

func TestTheErrorBannerShowsTheErrorOfTheWorkbench(t *testing.T) {
	errors := workbench.NewShownErrors(func(string) {})
	tt := ui.NewTester(func(c *ui.Context) { workbench.DrawErrorBanner(c, errors) }, 480, 120)
	if len(tt.Texts()) != 0 {
		t.Fatalf("a workbench without an error shows %q", tt.Texts())
	}
	errors.Show("workbench", "surface presentation failed: gone", "")
	tt.Frame()
	if !tt.HasText("surface presentation failed: gone") {
		t.Fatalf("the banner shows %q", tt.Texts())
	}
	if !hasRole(tt.ElementTree(), ui.RoleStatus) {
		t.Fatalf("no element of the banner has the role status: %+v", tt.ElementTree())
	}
	errors.Hide("workbench")
	tt.Frame()
	if len(tt.Texts()) != 0 {
		t.Fatalf("a withdrawn error still shows %q", tt.Texts())
	}
}

func hasRole(nodes []ui.ElementNode, role ui.Role) bool {
	for _, node := range nodes {
		if node.Role == role || hasRole(node.Children, role) {
			return true
		}
	}
	return false
}
