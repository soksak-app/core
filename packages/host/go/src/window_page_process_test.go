package host

import (
	"encoding/json"
	"testing"

	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// pageProcessPlatform reports the window facts of a window with a page process of pid.
type pageProcessPlatform struct {
	pagelessPlatform
	pid int
}

func (p *pageProcessPlatform) WindowFacts(platform.Window) (string, error) {
	text, err := json.Marshal(map[string]any{"pageProcess": p.pid, "nativeSurfaces": []any{}, "webviews": []any{}, "activationObservation": map[string]any{"registered": false, "count": "0"}})
	return string(text), err
}

// mainPageFramework is pagelessFramework with a main page.
type mainPageFramework struct{ pagelessFramework }

func (mainPageFramework) MainPage() bool { return true }

func pageProcessSurfaces(t *testing.T, selected Framework, pid int) *Surfaces {
	t.Helper()
	window := &elementWindow{}
	window.native = platform.Window(1)
	previousFramework, previousSystem := framework, system
	framework, system = selected, &pageProcessPlatform{pid: pid}
	t.Cleanup(func() { framework, system = previousFramework, previousSystem })
	s := NewSurfaces(window, nil)
	s.name = "main"
	s.host = &Host{quit: &Quit{}}
	return s
}

// contract: window.page-process.null-without-a-main-page
func TestAWindowWithoutAMainPageReportsNoPageProcess(t *testing.T) {
	s := pageProcessSurfaces(t, pagelessFramework{}, 0)
	status, err := s.windowState()
	if err != nil {
		t.Fatal(err)
	}
	if status.PageProcess != nil {
		t.Fatalf("a window without a main page reports the page process %d, want null", *status.PageProcess)
	}
	processes, err := s.performanceProcesses()
	if err != nil {
		t.Fatal(err)
	}
	if processes.Page != nil {
		t.Fatalf("the sampler reads the page process %d of a window without a main page", *processes.Page)
	}
}

// contract: window.page-process.null-without-a-main-page
func TestAWindowWithAMainPageReportsItsPageProcess(t *testing.T) {
	for _, pid := range []int{0, 4321} {
		s := pageProcessSurfaces(t, mainPageFramework{}, pid)
		status, err := s.windowState()
		if err != nil {
			t.Fatal(err)
		}
		if status.PageProcess == nil || *status.PageProcess != pid {
			t.Fatalf("a window with the page process %d reports %v", pid, status.PageProcess)
		}
		processes, err := s.performanceProcesses()
		if err != nil {
			t.Fatal(err)
		}
		if processes.Page == nil || *processes.Page != pid {
			t.Fatalf("the sampler reads %v for the page process %d", processes.Page, pid)
		}
	}
}

// contract: window.page-process.null-without-a-main-page
func TestHostWindowDeclaresAPageProcessThatCanBeNull(t *testing.T) {
	properties := hostStatus["host.window"].Schema["properties"].(map[string]any)
	declared, _ := properties["pageProcess"].(map[string]any)
	types, _ := declared["type"].([]any)
	if len(types) != 2 || types[0] != "integer" || types[1] != "null" {
		t.Fatalf("host.window declares pageProcess as %v", declared)
	}
}
