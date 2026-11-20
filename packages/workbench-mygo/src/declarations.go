package workbench

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"strconv"
	"strings"
	"sync"

	"github.com/egoist/mygo/ui"
)

// The copies of the declarations of packages/workbench, which make check-exposure holds equal to their source
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
	// CardTools are the names of the card tools and the reasons of their refusals (docs/spec/example-model.md#card-tools).
	CardTools map[string]string
	// surface holds the entries of surfaceNames under the keys of the declaration file, and params the parameter schema of each
	// command.
	surface map[string][]map[string]any
	params  map[string]json.RawMessage
	many    map[string]bool
	chrome  map[string]string
	plain   map[string]string
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

// PlainControl returns the value name of the look of a control that the page takes from its browser, which no stylesheet declares.
func (d *Declarations) PlainControl(name string) string { return d.plain[name] }

// ChromeValue returns the chrome value name as it is declared. A draw reads a value that the build declares, so a name that it does
// not hold is refused, as an element name that is not declared is refused.
func (d *Declarations) ChromeValue(name string) string {
	value, ok := d.chrome[name]
	if !ok {
		panic(fmt.Sprintf("the chrome value %s is not declared", name))
	}
	return value
}

// WithChrome returns a copy of the declarations whose chrome value name is value, as a build whose workbench.json declares that value
// reads it.
func (d *Declarations) WithChrome(name, value string) *Declarations {
	out := *d
	out.chrome = maps.Clone(d.chrome)
	out.chrome[name] = value
	return &out
}

// ChromeNumber returns the number of the chrome value name, which holds the unit or no unit.
func (d *Declarations) ChromeNumber(name, unit string) float64 {
	return declaredNumber("chrome", name, d.ChromeValue(name), unit)
}

// PlainNumber returns the number of the plain control value name, which holds the unit or no unit.
func (d *Declarations) PlainNumber(name, unit string) float64 {
	value, ok := d.plain[name]
	if !ok {
		panic(fmt.Sprintf("the plain control value %s is not declared", name))
	}
	return declaredNumber("plain control", name, value, unit)
}

// declaredNumber is the number of a declared value, which the build states, so a value of another form is refused.
func declaredNumber(kind, name, value, unit string) float64 {
	number, err := strconv.ParseFloat(strings.TrimSuffix(value, unit), 64)
	if err != nil {
		panic(fmt.Sprintf("the %s value %s is %q, not a number of %s", kind, name, value, unit))
	}
	return number
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
	// Gap is the gap setting: the full distance between two adjacent cards, 0 for the seam (docs/spec/settings.md#values).
	Radius, Gap, BorderWidth float32
}

// GroupLook is the colors of a group card (docs/spec/groups.md#drawing): Head is its header, Line the line under its header and Body the
// area inside its frame around its members.
type GroupLook struct {
	Head, Line, Body ui.Color
}

// GroupLook is the colors of a group card whose members stand on level with the chrome value group-fill-fade (fade), groupLook of
// packages/workbench/group-look.js (docs/spec/cases/group-look.json): the header is card, as the head of a content card; the line under
// it is edge with a gap and rule at the seam, as under the head of a content card; the body is bg mixed into card by fade to the power
// of level, each channel rounded, so each nesting level stands one step nearer to card.
func (p Palette) GroupLook(level int, fade float64) GroupLook {
	share := math.Pow(fade, float64(level))
	blend := func(a, b uint8) uint8 { return uint8(math.Round(float64(a)*share + float64(b)*(1-share))) }
	body := ui.Color{R: blend(p.Bg.R, p.Card.R), G: blend(p.Bg.G, p.Card.G), B: blend(p.Bg.B, p.Card.B), A: 255}
	line := p.Edge
	if p.Seam() {
		line = p.Rule
	}
	return GroupLook{Head: p.Card, Line: line, Body: body}
}

// Seam is whether the cards share one line: the gap is 0 (seam of packages/workbench/settings.js).
func (p Palette) Seam() bool { return p.Gap == 0 }

// HalfGap is half the distance between two adjacent cards, halfGap of packages/workbench/settings.js: at the seam it is half the border
// width, so the cards stand one line apart and that line is the border that they share.
func (p Palette) HalfGap() float32 {
	if p.Seam() {
		return p.BorderWidth / 2
	}
	return p.Gap / 2
}

// PlaneGap is the gap of the plane: the gap setting, or the border width at the seam.
func (p Palette) PlaneGap() float64 { return float64(2 * p.HalfGap()) }

// StagePad is the margin between the plane and the edge of the stage, stagePad of packages/workbench/settings.js: half the gap, and 0
// at the seam.
func (p Palette) StagePad() float32 {
	if p.Seam() {
		return 0
	}
	return p.HalfGap()
}

// CardBorder is the border width of a card: none at the seam, where the line between two cards is the line of the plane.
func (p Palette) CardBorder() float32 {
	if p.Seam() {
		return 0
	}
	return p.BorderWidth
}

// CardRadius is the corner radius of a card: square at the seam (cardRadius of packages/workbench/settings.js).
func (p Palette) CardRadius() float32 {
	if p.Seam() {
		return 0
	}
	return p.Radius
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
		Icons     map[string]string `json:"icons"`
		CardTools map[string]string `json:"cardTools"`
		Chrome    map[string]string `json:"chrome"`
		Plain     map[string]string `json:"plainControls"`
		Themes    []declaredTheme   `json:"themes"`
	}
	if err := json.Unmarshal(workbenchFile, &values); err != nil {
		return nil, fmt.Errorf("workbench.json: %w", err)
	}
	for _, key := range []string{"add", "split-x", "split-y", "fullscreen", "restore", "close", "close-refused", "layout-held"} {
		if values.CardTools[key] == "" {
			return nil, fmt.Errorf("workbench.json: cardTools declares no %s", key)
		}
	}
	names := func(entries []map[string]any) map[string]bool {
		set := make(map[string]bool, len(entries))
		for _, entry := range entries {
			set[entry["name"].(string)] = true
		}
		return set
	}
	// A schema is kept as its JSON text, which the check of the parameters of a request decodes (host.CommandParamsRefusal).
	params := make(map[string]json.RawMessage, len(exposes["commands"]))
	for _, entry := range exposes["commands"] {
		text, err := json.Marshal(entry["params"])
		if err != nil {
			return nil, fmt.Errorf("exposure.json: params of %v: %w", entry["name"], err)
		}
		params[entry["name"].(string)] = text
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
		Icons: values.Icons, CardTools: values.CardTools, Shortcuts: shortcuts.Shortcuts, surface: surface, params: params, many: many, chrome: values.Chrome, plain: values.Plain, themes: values.Themes,
	}, nil
}

// HeldByView tells whether a declared name is registered by the document of each view and not by the workbench.
func (d *Declarations) HeldByView(name string) bool { return surfaceNames[name] }

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
