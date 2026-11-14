package host

import (
	"encoding/json"
	"fmt"
	"testing"
)

// windowFactsText is the native window facts text of a window with member, a JSON object member that ends with a comma or is
// empty, and the members that every reading holds.
func windowFactsText(member string) string {
	return `{"pageProcess":0,` + member + `"nativeSurfaces":[],"webviews":[],"activationObservation":{"registered":false,"count":"0"}}`
}

// windowStatusMembers is the host.window value of the native facts text of a window with no surface and no document, as its
// members.
func windowStatusMembers(t *testing.T, text string, mainPage bool) (map[string]json.RawMessage, error) {
	t.Helper()
	s := &Surfaces{host: &Host{quit: &Quit{}}}
	state, err := s.windowStatusFromFacts(text, mainPage, nil, nil, nil)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	var members map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &members); err != nil {
		t.Fatal(err)
	}
	return members, nil
}

// contract: window.page-process.null-without-a-main-page
func TestAWindowWithoutAMainPageReportsNoPageProcess(t *testing.T) {
	s := &Surfaces{host: &Host{quit: &Quit{}}}
	status, err := s.windowStatusFromFacts(windowFactsText(""), false, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if status.PageProcess != nil {
		t.Fatalf("a window without a main page reports the page process %d, want null", *status.PageProcess)
	}
	if processes := performanceProcessesOf(status); processes.Page != nil {
		t.Fatalf("the sampler reads the page process %d of a window without a main page", *processes.Page)
	}
}

// contract: window.page-process.null-without-a-main-page
func TestAWindowWithAMainPageReportsItsPageProcess(t *testing.T) {
	for _, pid := range []int{0, 4321} {
		s := &Surfaces{host: &Host{quit: &Quit{}}}
		text := fmt.Sprintf(`{"pageProcess":%d,"nativeSurfaces":[],"webviews":[],"activationObservation":{"registered":false,"count":"0"}}`, pid)
		status, err := s.windowStatusFromFacts(text, true, nil, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		if status.PageProcess == nil || *status.PageProcess != pid {
			t.Fatalf("a window with the page process %d reports %v", pid, status.PageProcess)
		}
		if processes := performanceProcessesOf(status); processes.Page == nil || *processes.Page != pid {
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
