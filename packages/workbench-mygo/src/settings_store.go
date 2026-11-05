package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"
)

// The settings of the workbench (docs/spec/settings.md): the values of workbench.json, the common values, the overrides
// of the shown project, and the plugin settings, in one store that every change goes through.

// eventClasses are the classes of the event log, as packages/workbench/event-classes.js holds them.
var eventClasses = []string{"lifecycle", "input", "call", "io", "frame"}

// logLevels are the levels of the log policy.
var logLevels = []string{"off", "error", "warn", "info", "debug", "trace"}

// SettingDefinition is a setting that a plugin declares.
type SettingDefinition struct {
	Key, Plugin, Type, Label, Description string
	// Values are the choices of an enum, Minimum and Maximum the bounds of an integer, and MaxLength the length of a string.
	Values           []string
	Minimum, Maximum float64
	MaxLength        int
	Default          any
}

// CatalogFont is a font of workbench.json.
type CatalogFont struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Stack string `json:"stack"`
}

// CatalogLanguage is a language of the application menu.
type CatalogLanguage struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// CatalogTheme is a theme of workbench.json with both modes.
type CatalogTheme struct {
	Name  string            `json:"name"`
	Shape map[string]string `json:"shape"`
	Dark  map[string]string `json:"dark"`
	Light map[string]string `json:"light"`
}

// SettingsCatalog is what workbench.json declares for the settings.
type SettingsCatalog struct {
	Themes        []CatalogTheme    `json:"themes"`
	Modes         []string          `json:"modes"`
	Fonts         []CatalogFont     `json:"fonts"`
	MenuLanguages []CatalogLanguage `json:"menuLanguages"`
	Default       string            `json:"defaultLanguage"`
	Settings      struct {
		Defaults         map[string]any        `json:"defaults"`
		LayoutRanges     map[string][2]float64 `json:"layoutRanges"`
		ShapeRanges      map[string][2]float64 `json:"shapeRanges"`
		MemorySaverDelay [2]float64            `json:"memorySaverDelay"`
		Choices          map[string][]string   `json:"choices"`
		TextSteps        []float64             `json:"textSteps"`
		Switches         []string              `json:"switches"`
		CommonOnly       []string              `json:"commonOnly"`
	} `json:"settings"`
}

// Stack returns the font stack of the font id, empty for an id that the catalog does not hold.
func (c *SettingsCatalog) Stack(id string) string {
	for _, font := range c.Fonts {
		if font.ID == id {
			return font.Stack
		}
	}
	return ""
}

// AppLanguages returns the languages that the application is written in: the languages of its menu, the default language first.
func (c *SettingsCatalog) AppLanguages() []string {
	languages := []string{c.Default}
	for _, language := range c.MenuLanguages {
		if language.ID != c.Default {
			languages = append(languages, language.ID)
		}
	}
	return languages
}

// ReadSettingsCatalog reads the embedded workbench.json.
func ReadSettingsCatalog() (*SettingsCatalog, error) {
	var catalog SettingsCatalog
	if err := json.Unmarshal(workbenchFile, &catalog); err != nil {
		return nil, fmt.Errorf("workbench.json: %w", err)
	}
	if len(catalog.Themes) == 0 {
		return nil, errors.New("workbench.json declares no theme")
	}
	return &catalog, nil
}

// Theme returns the theme name.
func (c *SettingsCatalog) Theme(name string) (*CatalogTheme, error) {
	for i := range c.Themes {
		if c.Themes[i].Name == name {
			return &c.Themes[i], nil
		}
	}
	return nil, fmt.Errorf("unknown theme: %s", name)
}

// choices returns the listed values of key.
func (c *SettingsCatalog) choices(key string) []string {
	switch key {
	case "theme":
		names := make([]string, len(c.Themes))
		for i, theme := range c.Themes {
			names[i] = theme.Name
		}
		return names
	case "mode":
		return c.Modes
	case "font":
		ids := make([]string, len(c.Fonts))
		for i, font := range c.Fonts {
			ids[i] = font.ID
		}
		return ids
	case "language":
		ids := []string{"auto"}
		for _, language := range c.MenuLanguages {
			ids = append(ids, language.ID)
		}
		return ids
	}
	return c.Settings.Choices[key]
}

// bounds returns the range of the integer setting key.
func (c *SettingsCatalog) bounds(key string) ([2]float64, bool) {
	if value, ok := c.Settings.LayoutRanges[key]; ok {
		return value, true
	}
	value, ok := c.Settings.ShapeRanges[key]
	return value, ok
}

// shapeOf returns the settings that a theme sets.
func shapeOf(theme *CatalogTheme) (map[string]any, error) {
	number := func(name string) (float64, error) {
		value, err := strconv.ParseFloat(strings.TrimSuffix(theme.Shape[name], "px"), 64)
		if err != nil {
			return 0, fmt.Errorf("theme %s: shape %s: %w", theme.Name, name, err)
		}
		return value, nil
	}
	gap, gapErr := number("gap")
	radius, radiusErr := number("r")
	size, sizeErr := number("size")
	if err := errors.Join(gapErr, radiusErr, sizeErr); err != nil {
		return nil, err
	}
	return map[string]any{"gap": gap, "radius": radius, "font": theme.Shape["font"], "size": size}, nil
}

// SaveSettings writes a change to the host: the patch and the removed keys of the common values, or of the overrides of
// project when it is not empty.
type SaveSettings func(project string, patch map[string]any, remove []string)

// SettingsStatus is the value of the status core.settings.
type SettingsStatus struct {
	Values     map[string]any `json:"values"`
	Project    *string        `json:"project"`
	Overridden []string       `json:"overridden"`
	Saving     bool           `json:"saving"`
}

// SettingsStore holds the settings of one window.
type SettingsStore struct {
	Catalog     *SettingsCatalog
	Definitions []SettingDefinition

	defaults, common, overrides map[string]any
	project                     string
	saving                      int
	save                        SaveSettings
	begun                       bool
	loaded                      map[string]bool
}

// NewSettingsStore returns the store of the catalog and the plugin settings definitions.
func NewSettingsStore(definitions []SettingDefinition, save SaveSettings) (*SettingsStore, error) {
	catalog, err := ReadSettingsCatalog()
	if err != nil {
		return nil, err
	}
	defaults := maps.Clone(catalog.Settings.Defaults)
	shape, err := shapeOf(&catalog.Themes[0])
	if err != nil {
		return nil, err
	}
	maps.Copy(defaults, shape)
	for _, definition := range definitions {
		if _, taken := defaults[definition.Key]; taken {
			return nil, fmt.Errorf("duplicate setting: %s", definition.Key)
		}
		defaults[definition.Key] = definition.Default
	}
	store := &SettingsStore{Catalog: catalog, Definitions: definitions, defaults: defaults, common: map[string]any{}, overrides: map[string]any{}, save: save, loaded: map[string]bool{}}
	for _, definition := range definitions {
		if err := store.validate(definition.Key, definition.Default); err != nil {
			return nil, err
		}
	}
	return store, nil
}

// SidebarDefaults makes the declared sets and links the defaults of the settings `sets` and `links`. It runs before the stored
// settings begin, and a window without declared sidebars keeps the empty defaults.
func (s *SettingsStore) SidebarDefaults(sets []SidebarSet, links []SidebarLink) error {
	if len(sets) > 0 {
		value, err := decode[any](sets)
		if err != nil {
			return fmt.Errorf("sidebar defaults: %w", err)
		}
		s.defaults["sets"] = value
	}
	if len(links) > 0 {
		value, err := decode[any](links)
		if err != nil {
			return fmt.Errorf("sidebar defaults: %w", err)
		}
		s.defaults["links"] = value
	}
	return nil
}

// Loaded records a plugin that the window loaded, whose stored settings the store checks.
func (s *SettingsStore) Loaded(plugin string) { s.loaded[plugin] = true }

// kept tells that key is a stored setting of a plugin that is not loaded, which stays in the file unapplied
// (docs/spec/plugins.md).
func (s *SettingsStore) kept(key string) bool {
	_, known := s.defaults[key]
	plugin, _, dotted := strings.Cut(key, ".")
	return !known && dotted && plugin != "" && !s.loaded[plugin]
}

// Begin takes the stored values of the common settings and of the overrides of project.
func (s *SettingsStore) Begin(common, overrides map[string]any, project string) error {
	for where, values := range map[string]map[string]any{"settings.json": common, "project settings": overrides} {
		for key, value := range values {
			if s.kept(key) {
				continue
			}
			if _, known := s.defaults[key]; !known {
				return fmt.Errorf("%s: unknown setting %s", where, key)
			}
			if err := s.validate(key, value); err != nil {
				return err
			}
		}
	}
	for _, key := range s.Catalog.Settings.CommonOnly {
		if _, ok := overrides[key]; ok {
			return fmt.Errorf("project settings: %s is common-only", key)
		}
	}
	if err := s.check(s.effective(common, overrides)); err != nil {
		return err
	}
	s.common, s.overrides, s.project = orEmpty(common), orEmpty(overrides), project
	s.begun = true
	return nil
}

func orEmpty(values map[string]any) map[string]any {
	if values == nil {
		return map[string]any{}
	}
	return maps.Clone(values)
}

// effective is the settings in the order defaults, common values, project overrides. projectOpening has only a common value.
func (s *SettingsStore) effective(common, overrides map[string]any) map[string]any {
	values := maps.Clone(s.defaults)
	for _, layer := range []map[string]any{common, overrides} {
		for key := range layer {
			if !s.kept(key) {
				values[key] = s.effectiveValue(common, overrides, key)
			}
		}
	}
	return values
}

// effectiveValue is the value of key in effective, read without building the other values.
func (s *SettingsStore) effectiveValue(common, overrides map[string]any, key string) any {
	if s.kept(key) {
		return nil
	}
	if key != "projectOpening" {
		if value, ok := overrides[key]; ok {
			return value
		}
	}
	if value, ok := common[key]; ok {
		return value
	}
	return s.defaults[key]
}

// Project returns the project that project changes apply to.
func (s *SettingsStore) Project() string { return s.project }

// Defaults returns the default value of each setting.
func (s *SettingsStore) Defaults() map[string]any { return maps.Clone(s.defaults) }

// Common returns the common settings as they stand now.
func (s *SettingsStore) Common() map[string]any { return s.common }

// Value returns the effective value of key.
func (s *SettingsStore) Value(key string) any { return s.effectiveValue(s.common, s.overrides, key) }

// ProjectValue is the value of key for a project with overrides, which need not be the selected project.
func (s *SettingsStore) ProjectValue(overrides map[string]any, key string) any {
	return s.effectiveValue(s.common, overrides, key)
}

// Scoped returns the value of key that the scope shows.
func (s *SettingsStore) Scoped(key, scope string) any {
	if scope != "common" {
		return s.Value(key)
	}
	if value, ok := s.common[key]; ok {
		return value
	}
	return s.defaults[key]
}

// Overridden tells that the shown project overrides key.
func (s *SettingsStore) Overridden(key string) bool {
	_, ok := s.overrides[key]
	return ok
}

// Status is the value of core.settings.
func (s *SettingsStore) Status() SettingsStatus {
	var project *string
	if s.project != "" {
		project = &s.project
	}
	overridden := slices.Sorted(maps.Keys(s.overrides))
	return SettingsStatus{Values: s.effective(s.common, s.overrides), Project: project, Overridden: overridden, Saving: s.saving > 0}
}

// BeginSave counts a write that the host has not answered, and EndSave its answer.
func (s *SettingsStore) BeginSave() { s.saving++ }

// EndSave is the answer of a write.
func (s *SettingsStore) EndSave() { s.saving-- }

func jsonText(value any) string {
	text, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	return string(text)
}

func integer(value any) (float64, bool) {
	number, ok := value.(float64)
	return number, ok && number == math.Trunc(number)
}

func (s *SettingsStore) validate(key string, value any) error {
	catalog := s.Catalog
	if choices := catalog.choices(key); choices != nil {
		text, ok := value.(string)
		if !ok || !slices.Contains(choices, text) {
			named := make([]string, len(choices))
			for i, choice := range choices {
				named[i] = jsonText(choice)
			}
			return fmt.Errorf("Invalid setting %s: %s is not one of %s", key, jsonText(value), strings.Join(named, ", "))
		}
	}
	if key == "textSize" {
		number, ok := value.(float64)
		if !ok || !slices.Contains(catalog.Settings.TextSteps, number) {
			return fmt.Errorf("Invalid setting %s: %s is not a text size step", key, jsonText(value))
		}
	}
	if slices.Contains(catalog.Settings.Switches, key) {
		if _, ok := value.(bool); !ok {
			return fmt.Errorf("Invalid setting %s: %s is not a boolean", key, jsonText(value))
		}
	}
	if key == "diagnostics.log" {
		if err := validateLogPolicy(value); err != nil {
			return fmt.Errorf("Invalid setting %s: %w", key, err)
		}
	}
	if key == "memorySaverDelay" {
		number, ok := integer(value)
		if bounds := catalog.Settings.MemorySaverDelay; !ok || number < bounds[0] || number > bounds[1] {
			return fmt.Errorf("Invalid setting memorySaverDelay: %s", jsonText(value))
		}
	}
	if bounds, ok := catalog.bounds(key); ok {
		number, whole := integer(value)
		if !whole || number < bounds[0] || number > bounds[1] {
			return fmt.Errorf("Invalid setting %s: %s is not an integer from %v to %v", key, jsonText(value), bounds[0], bounds[1])
		}
	}
	for _, definition := range s.Definitions {
		if definition.Key == key {
			return validateDeclared(definition, value)
		}
	}
	return nil
}

func validateLogPolicy(value any) error {
	policy, err := decode[map[string]any](value)
	if err != nil || policy == nil {
		return fmt.Errorf("%s is not an object", jsonText(value))
	}
	for name, level := range policy {
		if !slices.Contains(eventClasses, name) {
			return fmt.Errorf("the class %s is not one of %s", name, strings.Join(eventClasses, ", "))
		}
		if text, ok := level.(string); !ok || !slices.Contains(logLevels, text) {
			return fmt.Errorf("the level %s of the class %s is not one of %s", jsonText(level), name, strings.Join(logLevels, ", "))
		}
	}
	return nil
}

func validateDeclared(definition SettingDefinition, value any) error {
	key := definition.Key
	switch definition.Type {
	case "enum":
		if text, ok := value.(string); !ok || !slices.Contains(definition.Values, text) {
			return fmt.Errorf("Invalid setting %s: value is not declared", key)
		}
	case "integer":
		if number, ok := integer(value); !ok || number < definition.Minimum || number > definition.Maximum {
			return fmt.Errorf("Invalid setting %s: integer value is outside its declared range", key)
		}
	case "string":
		if text, ok := value.(string); !ok || text == "" || len([]rune(text)) > definition.MaxLength {
			return fmt.Errorf("Invalid setting %s: string value must be non-empty and at most %d characters", key, definition.MaxLength)
		}
	case "address":
		text, ok := value.(string)
		if !ok || text != "" && !strings.HasPrefix(text, "http://") && !strings.HasPrefix(text, "https://") {
			return fmt.Errorf("Invalid setting %s: address value must be empty or an http or https address", key)
		}
	}
	return nil
}

// check holds what no single value tells: the widths in order, and each link to a set that exists.
func (s *SettingsStore) check(values map[string]any) error {
	least, _ := values["sidebarMinWidth"].(float64)
	width, _ := values["sidebarWidth"].(float64)
	most, _ := values["sidebarMaxWidth"].(float64)
	if !(least <= width && width <= most) {
		return errors.New("Invalid setting: sidebarMinWidth <= sidebarWidth <= sidebarMaxWidth does not hold")
	}
	sets, err := decode[[]StoredSet](values["sets"])
	if err != nil {
		return fmt.Errorf("Invalid setting sets: %w", err)
	}
	links, err := decode[[]StoredLink](values["links"])
	if err != nil {
		return fmt.Errorf("Invalid setting links: %w", err)
	}
	known := map[string]bool{}
	for _, set := range sets {
		if known[set.ID] {
			return fmt.Errorf("Invalid setting sets: the id %s repeats", set.ID)
		}
		known[set.ID] = true
	}
	for _, link := range links {
		if !known[link.Set] {
			return fmt.Errorf("Invalid setting links: link points at a set that is gone: %s", link.Set)
		}
	}
	return nil
}

// Set changes part of the settings in the scope, which is the project of the window while there is one when it is empty. A
// nil value removes the key. It is the only path of a change: it checks the patch, applies it and writes it.
func (s *SettingsStore) Set(patch map[string]any, scope string) error {
	if scope == "" && s.project != "" {
		scope = "project"
	}
	project := ""
	if scope == "project" {
		project = s.project
		if project == "" {
			return errors.New("No project is selected")
		}
		for _, key := range s.Catalog.Settings.CommonOnly {
			if _, ok := patch[key]; ok {
				return fmt.Errorf("%s is common-only", key)
			}
		}
	}
	for _, key := range slices.Sorted(maps.Keys(patch)) {
		if _, known := s.defaults[key]; !known {
			return fmt.Errorf("Unknown setting: %s", key)
		}
		if value := patch[key]; value != nil {
			if err := s.validate(key, value); err != nil {
				return err
			}
		}
	}
	target := s.common
	if project != "" {
		target = s.overrides
	}
	changed := maps.Clone(target)
	values, remove := map[string]any{}, []string(nil)
	for _, key := range slices.Sorted(maps.Keys(patch)) {
		if value := patch[key]; value == nil {
			delete(changed, key)
			remove = append(remove, key)
		} else {
			changed[key] = value
			values[key] = value
		}
	}
	common, overrides := s.common, s.overrides
	if project != "" {
		overrides = changed
	} else {
		common = changed
	}
	if err := s.check(s.effective(common, overrides)); err != nil {
		return err
	}
	s.common, s.overrides = common, overrides
	s.save(project, values, remove)
	return nil
}

// settingType returns the type of the value of key: boolean, number, object or string.
func (s *SettingsStore) settingType(key string) (string, error) {
	catalog := s.Catalog
	_, ranged := catalog.bounds(key)
	switch {
	case slices.Contains(catalog.Settings.Switches, key):
		return "boolean", nil
	case key == "diagnostics.log" || key == "sets" || key == "links":
		return "object", nil
	case ranged || key == "memorySaverDelay" || key == "textSize":
		return "number", nil
	case catalog.choices(key) != nil:
		return "string", nil
	}
	for _, definition := range s.Definitions {
		if definition.Key == key {
			if definition.Type == "integer" {
				return "number", nil
			}
			return "string", nil
		}
	}
	return "", fmt.Errorf("Unknown setting: %s", key)
}

// Change sets one setting from the value of a control: a string becomes the boolean or the number that the setting declares,
// and every other input stays as it is, for the check to refuse.
func (s *SettingsStore) Change(key string, input any, scope string) error {
	kind, err := s.settingType(key)
	if err != nil {
		return err
	}
	if text, ok := input.(string); ok {
		switch {
		case kind == "boolean" && (text == "true" || text == "false"):
			input = text == "true"
		case kind == "number" && strings.TrimSpace(text) != "":
			if number, err := strconv.ParseFloat(strings.TrimSpace(text), 64); err == nil {
				input = number
			}
		}
	}
	if scope == "" {
		scope = "common"
	}
	return s.Set(map[string]any{key: input}, scope)
}

// Reset removes the project override of key.
func (s *SettingsStore) Reset(key string) error { return s.Set(map[string]any{key: nil}, "project") }

// Theme applies the theme name with its shape in the mode, which is the current mode of the scope when it is empty. An empty
// scope is the common scope.
func (s *SettingsStore) Theme(name, mode, scope string) error {
	if scope == "" {
		scope = "common"
	}
	if mode == "" {
		scoped, ok := s.Scoped("mode", scope).(string)
		if !ok {
			return errors.New("the setting mode has no text")
		}
		mode = scoped
	}
	if !slices.Contains(s.Catalog.Modes, mode) {
		return fmt.Errorf("unknown mode: %s", mode)
	}
	theme, err := s.Catalog.Theme(name)
	if err != nil {
		return err
	}
	patch, err := shapeOf(theme)
	if err != nil {
		return err
	}
	patch["theme"], patch["mode"] = theme.Name, mode
	return s.Set(patch, scope)
}

// Debug turns the debug switch on or off: on sets the trace on and every class of the log policy to trace, and off sets the
// trace off and the empty policy, which stores only the errors.
func (s *SettingsStore) Debug(on bool) error {
	policy := map[string]any{}
	if on {
		for _, name := range eventClasses {
			policy[name] = "trace"
		}
	}
	return s.Set(map[string]any{"diagnostics.performance": on, "diagnostics.log": policy}, "common")
}

// DebugOn tells that the trace is on and every class of the policy is at trace.
func (s *SettingsStore) DebugOn() bool {
	if s.Value("diagnostics.performance") != true {
		return false
	}
	policy, err := decode[map[string]string](s.Value("diagnostics.log"))
	if err != nil {
		return false
	}
	for _, name := range eventClasses {
		if policy[name] != "trace" {
			return false
		}
	}
	return true
}

// Sets returns the sidebar sets that the scope shows.
func (s *SettingsStore) Sets(scope string) ([]StoredSet, error) {
	return decode[[]StoredSet](s.Scoped("sets", scope))
}

// Links returns the sidebar links that the scope shows.
func (s *SettingsStore) Links(scope string) ([]StoredLink, error) {
	return decode[[]StoredLink](s.Scoped("links", scope))
}
