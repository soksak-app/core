package workbench

import (
	"encoding/json"
	"testing"
)

// The answer of pluginsState carries the number of plugin folders as folders, the same name as the other hosts
// (docs/spec/installation.md#plugin-operations-in-the-application). The shell reads it into its plugin state.
// contract: plugins.folders.count-follows-a-folder-added-or-removed
func TestThePluginStateReadsTheFolderCount(t *testing.T) {
	var state PluginsState
	if err := json.Unmarshal([]byte(`{"core":"1.0.0","folders":2,"installed":{"format":3,"plugins":{},"sidecars":{}}}`), &state); err != nil {
		t.Fatal(err)
	}
	if state.Folders != 2 {
		t.Fatalf("folders %d, want 2", state.Folders)
	}
}
