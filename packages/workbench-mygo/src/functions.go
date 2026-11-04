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
	registry.Status("core.text", func() any { return f.Text.Status() })
	registry.Status("core.focus", func() any { return f.Focus.Status() })
	registry.Status("core.pointer", func() any { return f.Pointer.Status() })
	registry.Status("core.contributions", func() any { return f.Contributions.Status() })
	registry.Status("core.verify", func() any { return f.Verification.Status() })
	change := func(direction int) Command {
		return func(json.RawMessage) (any, error) { return nil, f.Text.Change(direction) }
	}
	registry.Command("core.text.larger", change(1))
	registry.Command("core.text.smaller", change(-1))
	registry.Command("core.text.reset", change(0))
	registry.Command("core.focus.set", func(params json.RawMessage) (any, error) {
		var target struct {
			Name  string `json:"name"`
			Index int    `json:"index"`
		}
		if err := json.Unmarshal(params, &target); err != nil {
			return nil, fmt.Errorf("core.focus.set: %w", err)
		}
		return nil, f.Focus.Set(target.Name, target.Index)
	})
}
