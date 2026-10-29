package host

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// frontRecord records the calls that show a window, in place of the native window.
type frontRecord struct{ calls []string }

func (r *frontRecord) Show() application.Window {
	r.calls = append(r.calls, "show")
	return nil
}

func (r *frontRecord) Focus() { r.calls = append(r.calls, "focus") }

// contract: project.open.other-owner-is-shown-without-activation
func TestProjectOpenShowsTheOtherOwnerWithoutActivation(t *testing.T) {
	host, _, _, ctx := projectOpenFixture(t)
	fronts := &frontRecord{}
	var events []string
	other := &Surfaces{projects: map[string]string{}, fronts: fronts, titles: &titleRecord{}, host: host}
	other.events = func(name string, data any) { events = append(events, fmt.Sprintf("%s %v", name, data)) }
	host.owners["prj-two"] = other
	request, err := json.Marshal(ProjectOpen{ID: "prj-two", Root: t.TempDir()})
	if err != nil {
		t.Fatalf("marshal project open: %v", err)
	}
	opened, err := host.ProjectOpen(ctx, request)
	if err != nil {
		t.Fatalf("open project: %v", err)
	}
	if opened.Local {
		t.Fatal("a project owned by another window was reported as local")
	}
	if strings.Join(events, ",") != "project-activate prj-two" {
		t.Fatalf("the owner window received %q, want one project-activate for prj-two", events)
	}
	if strings.Join(fronts.calls, ",") != "show" {
		t.Fatalf("the owner window received %q, want show without the focus that activates the application", fronts.calls)
	}
}
