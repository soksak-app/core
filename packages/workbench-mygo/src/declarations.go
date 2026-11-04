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
	// exposes holds the declarations under the keys of the declaration file, and params the parameter schema of each command.
	exposes map[string][]map[string]any
	params  map[string]any
	many    map[string]bool
	chrome  map[string]string
	themes  []declaredTheme
	fonts   map[string]string
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

// PageTheme returns the theme that a view reads: the scheme and the token values of the first declared theme, as pageTheme of
// packages/workbench/settings.js builds them.
func (d *Declarations) PageTheme() (map[string]any, error) {
	if len(d.themes) == 0 {
		return nil, errors.New("workbench.json declares no theme")
	}
	theme := d.themes[0]
	number := func(name string) (float64, error) {
		value, err := strconv.ParseFloat(strings.TrimSuffix(theme.Shape[name], "px"), 64)
		if err != nil {
			return 0, fmt.Errorf("theme %s: shape %s: %w", theme.Name, name, err)
		}
		return value, nil
	}
	gap, err := number("gap")
	if err != nil {
		return nil, err
	}
	if gap == 0 {
		// A theme without a gap has the half of a border between its cards, as halfGap of settings.js takes.
		width, err := number("bw")
		if err != nil {
			return nil, err
		}
		gap = width / 2
	}
	font, ok := d.fonts[theme.Shape["font"]]
	if !ok {
		return nil, fmt.Errorf("theme %s: unknown font %s", theme.Name, theme.Shape["font"])
	}
	tokens := map[string]string{"--r": theme.Shape["r"], "--half-gap": strconv.FormatFloat(gap, 'f', -1, 64) + "px", "--bw": theme.Shape["bw"],
		"--font": font, "--size": theme.Shape["size"]}
	for name, value := range theme.Dark {
		tokens["--"+name] = value
	}
	return map[string]any{"scheme": "dark", "tokens": tokens}, nil
}

// Declared returns the declarations of the embedded copies.
var Declared = sync.OnceValues(func() (*Declarations, error) {
	var exposure struct {
		Exposes map[string][]map[string]any `json:"exposes"`
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
		Themes []declaredTheme   `json:"themes"`
		Fonts  []struct {
			ID    string `json:"id"`
			Stack string `json:"stack"`
		} `json:"fonts"`
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
	params := make(map[string]any, len(exposure.Exposes["commands"]))
	for _, entry := range exposure.Exposes["commands"] {
		params[entry["name"].(string)] = entry["params"]
	}
	many := map[string]bool{}
	for _, entry := range exposure.Exposes["dom"] {
		many[entry["name"].(string)] = entry["many"] == true
	}
	fonts := make(map[string]string, len(values.Fonts))
	for _, font := range values.Fonts {
		fonts[font.ID] = font.Stack
	}
	return &Declarations{
		Statuses: names(exposure.Exposes["status"]), Commands: names(exposure.Exposes["commands"]), Elements: names(exposure.Exposes["dom"]),
		fonts: fonts, Shortcuts: shortcuts.Shortcuts, exposes: exposure.Exposes, params: params, many: many, chrome: values.Chrome, themes: values.Themes,
	}, nil
})
