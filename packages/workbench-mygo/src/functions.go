package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
)

// TextSteps returns the declared scale of the text size.
func TextSteps() ([]float64, error) {
	var values struct {
		Settings struct {
			TextSteps []float64 `json:"textSteps"`
		} `json:"settings"`
	}
	if err := json.Unmarshal(workbenchFile, &values); err != nil {
		return nil, fmt.Errorf("workbench.json: %w", err)
	}
	if len(values.Settings.TextSteps) == 0 {
		return nil, errors.New("workbench.json: settings.textSteps is empty")
	}
	return values.Settings.TextSteps, nil
}

// Functions are the workbench functions of a window.
type Functions struct {
	Text          *TextSize
	Focus         *Focus
	Pointer       *PointerSequence
	Contributions *Contributions
	Verification  *Verification
}

// Register registers the statuses and the commands of the functions.
func (f Functions) Register(registry *Registry) {
	f.Text.Register(registry)
	f.Focus.Register(registry)
	registry.Status("core.pointer", func() any { return f.Pointer.Status() })
	registry.Status("core.contributions", func() any { return f.Contributions.Status() })
	registry.Status("core.verify", func() any { return f.Verification.Status() })
}
