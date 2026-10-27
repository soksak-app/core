package host

import (
	"testing"
)

// contract: performance.sampler.reads-plugin-host-process
func TestPluginHostProcessesUseRegisteredHandlesOnly(t *testing.T) {
	processes, err := pluginHostProcessesForFacts([]windowWebviewFacts{
		{View: 11, Process: 101, Main: true},
		{View: 22, Process: 202, Document: true},
		{View: 33, Process: 303},
	}, map[uint64]string{33: "probealpha"})
	if err != nil {
		t.Fatal(err)
	}
	if len(processes) != 1 || processes[0] != (PerformancePluginHostProcess{Plugin: "probealpha", Process: 303}) {
		t.Fatalf("plugin-host processes = %#v, want only the registered view 33", processes)
	}
}

func TestPluginHostProcessesPreserveUnstartedAndMissingStates(t *testing.T) {
	processes, err := pluginHostProcessesForFacts([]windowWebviewFacts{{View: 33, Process: 0}}, map[uint64]string{33: "probealpha"})
	if err != nil {
		t.Fatal(err)
	}
	if len(processes) != 1 || processes[0].Process != 0 || processes[0].Plugin != "probealpha" {
		t.Fatalf("unstarted plugin host = %#v", processes)
	}
	if _, err := pluginHostProcessesForFacts(nil, map[uint64]string{33: "probealpha"}); err == nil {
		t.Fatal("a registered plugin host missing from native facts was silently omitted")
	}
}
