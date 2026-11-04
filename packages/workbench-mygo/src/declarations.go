package workbench

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
)

// The copies of the declarations of packages/workbench, which make exposure-check holds equal to their source
// (docs/spec/hosts.md#workbench).
var (
	//go:embed exposure.json
	exposureFile []byte
	//go:embed shortcuts.json
	shortcutsFile []byte
	//go:embed workbench.json
	workbenchFile []byte
)

// Shortcut is one row of the shortcut table.
type Shortcut struct {
	Key     string `json:"key"`
	Owner   string `json:"owner"`
	Command string `json:"command"`
	Menu    string `json:"menu"`
	When    string `json:"when"`
}

// Declarations are the names and the values that the workbench reads from its declaration copies.
type Declarations struct {
	// Statuses, Commands and Elements are the declared statuses, commands and element names.
	Statuses, Commands, Elements map[string]bool
	// Shortcuts is the shortcut table.
	Shortcuts []Shortcut
	chrome    map[string]string
}

// Metric returns the chrome metric name as a number of points or a ratio, and false when the metric does not exist or holds
// another unit.
func (d *Declarations) Metric(name string) (float64, bool) {
	value, ok := d.chrome[name]
	if !ok {
		return 0, false
	}
	number, err := strconv.ParseFloat(strings.TrimSuffix(value, "px"), 64)
	return number, err == nil
}

// Declared returns the declarations of the embedded copies.
var Declared = sync.OnceValues(func() (*Declarations, error) {
	var exposure struct {
		Exposes struct {
			Status   []struct{ Name string } `json:"status"`
			Commands []struct{ Name string } `json:"commands"`
			Dom      []struct{ Name string } `json:"dom"`
		} `json:"exposes"`
	}
	if err := json.Unmarshal(exposureFile, &exposure); err != nil {
		return nil, fmt.Errorf("exposure.json: %w", err)
	}
	var shortcuts struct {
		Shortcuts []Shortcut `json:"shortcuts"`
	}
	if err := json.Unmarshal(shortcutsFile, &shortcuts); err != nil {
		return nil, fmt.Errorf("shortcuts.json: %w", err)
	}
	var values struct {
		Chrome map[string]string `json:"chrome"`
	}
	if err := json.Unmarshal(workbenchFile, &values); err != nil {
		return nil, fmt.Errorf("workbench.json: %w", err)
	}
	names := func(entries []struct{ Name string }) map[string]bool {
		set := make(map[string]bool, len(entries))
		for _, entry := range entries {
			set[entry.Name] = true
		}
		return set
	}
	return &Declarations{
		Statuses: names(exposure.Exposes.Status), Commands: names(exposure.Exposes.Commands), Elements: names(exposure.Exposes.Dom),
		Shortcuts: shortcuts.Shortcuts, chrome: values.Chrome,
	}, nil
})
