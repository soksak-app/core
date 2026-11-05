package workbench

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/egoist/mygo/ui"
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
	// Icons are the SVG elements of the icons of a card head.
	Icons map[string]string
	// surface holds the entries of surfaceNames under the keys of the declaration file, and params the parameter schema of each
	// command.
	surface map[string][]map[string]any
	params  map[string]any
	many    map[string]bool
	chrome  map[string]string
	themes  []declaredTheme
}

// declaredTheme is a theme of workbench.json.
type declaredTheme struct {
	Name  string            `json:"name"`
	Shape map[string]string `json:"shape"`
	Dark  map[string]string `json:"dark"`
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

// Share returns the chrome metric name, which is a percentage, as a ratio, and false when the metric does not exist or holds another
// unit.
func (d *Declarations) Share(name string) (float64, bool) {
	value, ok := strings.CutSuffix(d.chrome[name], "%")
	if !ok {
		return 0, false
	}
	number, err := strconv.ParseFloat(value, 64)
	return number / 100, err == nil
}

// Seconds returns the chrome metric name, which is a time in seconds, and false when the metric does not exist or holds another unit.
func (d *Declarations) Seconds(name string) (float64, bool) {
	value, ok := strings.CutSuffix(d.chrome[name], "s")
	if !ok {
		return 0, false
	}
	number, err := strconv.ParseFloat(value, 64)
	return number, err == nil
}

// HeightMetric returns the chrome metric name, which is a share of the window height in vh, as a ratio, and false when the metric does
// not exist or holds another unit.
func (d *Declarations) HeightMetric(name string) (float64, bool) {
	value, ok := strings.CutSuffix(d.chrome[name], "vh")
	if !ok {
		return 0, false
	}
	number, err := strconv.ParseFloat(value, 64)
	return number / 100, err == nil
}

// Palette is the colors and the shape of a theme in one mode.
type Palette struct {
	Bg, Card, Fg, Muted, Edge, Rule, Rail, Focus, No ui.Color
	Radius, Gap, BorderWidth                         float32
}

// DefaultPalette is the palette of the first theme of the declaration in its first mode.
func (d *Declarations) DefaultPalette() (Palette, error) {
	if len(d.themes) == 0 {
		return Palette{}, errors.New("workbench.json declares no theme")
	}
	theme := d.themes[0]
	var failed error
	color := func(name string) ui.Color {
		text, ok := theme.Dark[name]
		if !ok {
			failed = fmt.Errorf("theme %s has no color %s", theme.Name, name)
			return ui.Color{}
		}
		return ui.Hex(text)
	}
	length := func(name string) float32 {
		number, err := strconv.ParseFloat(strings.TrimSuffix(theme.Shape[name], "px"), 32)
		if err != nil {
			failed = fmt.Errorf("theme %s: shape %s: %w", theme.Name, name, err)
		}
		return float32(number)
	}
	return Palette{Bg: color("bg"), Card: color("card"), Fg: color("fg"), Muted: color("muted"), Edge: color("edge"), Rule: color("rule"),
		Rail: color("rail"), Focus: color("focus"), No: color("no"), Radius: length("r"), Gap: length("gap"), BorderWidth: length("bw")}, failed
}

// Declared returns the declarations of the embedded copies.
var Declared = sync.OnceValues(ReadDeclarations)

// ReadDeclarations reads the embedded copies. It keeps what the workbench reads while it runs, and readExposures reads the
// rest when a request asks for it.
func ReadDeclarations() (*Declarations, error) {
	exposes, err := readExposures()
	if err != nil {
		return nil, err
	}
	var shortcuts struct {
		Shortcuts []Shortcut `json:"shortcuts"`
	}
	if err := json.Unmarshal(shortcutsFile, &shortcuts); err != nil {
		return nil, fmt.Errorf("shortcuts.json: %w", err)
	}
	var values struct {
		Icons  map[string]string `json:"icons"`
		Chrome map[string]string `json:"chrome"`
		Themes []declaredTheme   `json:"themes"`
	}
	if err := json.Unmarshal(workbenchFile, &values); err != nil {
		return nil, fmt.Errorf("workbench.json: %w", err)
	}
	names := func(entries []map[string]any) map[string]bool {
		set := make(map[string]bool, len(entries))
		for _, entry := range entries {
			set[entry["name"].(string)] = true
		}
		return set
	}
	params := make(map[string]any, len(exposes["commands"]))
	for _, entry := range exposes["commands"] {
		params[entry["name"].(string)] = entry["params"]
	}
	many := map[string]bool{}
	for _, entry := range exposes["element"] {
		many[entry["name"].(string)] = entry["many"] == true
	}
	surface := map[string][]map[string]any{}
	for key, entries := range exposes {
		for _, entry := range entries {
			if surfaceNames[entry["name"].(string)] {
				surface[key] = append(surface[key], entry)
			}
		}
	}
	return &Declarations{
		Statuses: names(exposes["status"]), Commands: names(exposes["commands"]), Elements: names(exposes["element"]),
		Icons: values.Icons, Shortcuts: shortcuts.Shortcuts, surface: surface, params: params, many: many, chrome: values.Chrome, themes: values.Themes,
	}, nil
}

// readExposures reads the declarations under the keys of the declaration file.
func readExposures() (map[string][]map[string]any, error) {
	var exposure struct {
		Exposes map[string][]map[string]any `json:"exposes"`
	}
	if err := json.Unmarshal(exposureFile, &exposure); err != nil {
		return nil, fmt.Errorf("exposure.json: %w", err)
	}
	return exposure.Exposes, nil
}
