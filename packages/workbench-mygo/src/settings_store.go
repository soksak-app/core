package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// pluginID is the form of a plugin id, which the value of a plugin setting must have (docs/spec/plugins.md#settings-declarations).
var pluginID = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// The settings of the workbench (docs/spec/settings.md): the values of workbench.json, the common values, the overrides
// of the shown project, and the plugin settings, in one store that every change goes through.

// eventClasses are the classes of the event log, as packages/workbench/event-classes.js holds them.
var eventClasses = []string{"lifecycle", "input", "call", "io", "frame"}

// logLevels are the levels of the log policy.
var logLevels = []string{"off", "error", "warn", "info", "debug", "trace"}

// SettingDefinition is a setting that a plugin declares.
type SettingDefinition struct {
	Key, Plugin, Type, Label, Description string
	// Category is the plugin category of a setting of the type plugin (docs/spec/plugins.md#settings-declarations).
	Category string
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
	Rows          declaredRows      `json:"rows"`
	Settings      struct {
		Defaults                   map[string]any        `json:"defaults"`
		LayoutRanges               map[string][2]float64 `json:"layoutRanges"`
		ShapeRanges                map[string][2]float64 `json:"shapeRanges"`
		MemorySaverDelay           [2]float64            `json:"memorySaverDelay"`
		ProblemToastDismissSeconds [2]float64            `json:"problemToastDismissSeconds"`
		Choices                    map[string][]string   `json:"choices"`
		TextSteps                  []float64             `json:"textSteps"`
		Switches                   []string              `json:"switches"`
		// Orders are the settings whose value is an order of their listed values, each once (docs/spec/settings.md#values).
		Orders     map[string][]string `json:"orders"`
		CommonOnly []string            `json:"commonOnly"`
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
	case "textSize":
		steps := make([]string, len(c.Settings.TextSteps))
		for i, step := range c.Settings.TextSteps {
			steps[i] = strconv.FormatFloat(step, 'f', -1, 64)
		}
		return steps
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
	if key == "problemToastDismissSeconds" {
		return c.Settings.ProblemToastDismissSeconds, true
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
// SaveSettings writes a change of the settings. restore puts back the values of the change's keys as they were before the change,
// which the caller runs when the host refuses the write.
type SaveSettings func(project string, patch map[string]any, remove []string, restore func())

// SettingsStatus is the value of the status core.settings.
type SettingsStatus struct {
	Values map[string]any `json:"values"`
	// Common is the common value of every setting: the stored common value, or the default when the common settings store none.
	Common     map[string]any `json:"common"`
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
	// missing maps each plugin setting whose stored value names no loaded plugin of its category to that value. Such a key has no value
	// and keeps its stored value (docs/spec/plugins.md#settings-declarations).
	missing map[string]string
	plugins []LoadedPlugin
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
		if err := store.pluginForm("environment.json: settings "+definition.Key, definition.Key, definition.Default); err != nil {
			return nil, err
		}
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

// Loaded records a plugin that the window loaded, whose stored settings the store checks and whose sections and surface the sets
// and links of the settings reference.
func (s *SettingsStore) Loaded(plugin LoadedPlugin) {
	s.loaded[plugin.ID] = true
	s.plugins = append(s.plugins, plugin)
}

// kept tells that key is a stored setting of a plugin that is not loaded, which stays in the file unapplied
// (docs/spec/plugins.md).
func (s *SettingsStore) kept(key string) bool {
	_, known := s.defaults[key]
	plugin, _, dotted := strings.Cut(key, ".")
	return !known && dotted && plugin != "" && !s.loaded[plugin]
}

// Begin takes the stored values of the common settings and of the overrides of project.
func (s *SettingsStore) Begin(common, overrides map[string]any, project string) error {
	if err := s.Check(common, overrides); err != nil {
		return err
	}
	s.common, s.overrides, s.project = orEmpty(common), orEmpty(overrides), project
	s.missing = s.missingPlugins(s.effective(s.common, s.overrides))
	s.begun = true
	return nil
}

// missingPlugins returns the plugin settings of values whose value names no loaded plugin of their category.
func (s *SettingsStore) missingPlugins(values map[string]any) map[string]string {
	missing := map[string]string{}
	for _, definition := range s.Definitions {
		if definition.Type != "plugin" {
			continue
		}
		// silent: validate checked the form of the stored value before this read.
		if id, ok := values[definition.Key].(string); ok && !s.servesCategory(definition.Category, id) {
			missing[definition.Key] = id
		}
	}
	return missing
}

// Missing returns the plugin setting key whose stored value names no loaded plugin, with that value, and false when key has none.
func (s *SettingsStore) Missing(key string) (string, bool) {
	id, ok := s.missing[key]
	return id, ok
}

// MissingKeys returns the plugin settings whose stored value names no loaded plugin, sorted by key.
func (s *SettingsStore) MissingKeys() []string { return slices.Sorted(maps.Keys(s.missing)) }

// MissingError is the load error of a plugin setting whose stored value names no loaded plugin of its category.
func (s *SettingsStore) MissingError(key string) string {
	return fmt.Sprintf("%s: plugin %s is not a %s plugin", key, s.missing[key], s.pluginSetting(key).Category)
}

// Check refuses the stored values of the common settings and of the overrides of a project that Begin would refuse, and takes
// nothing: a window checks the settings of a project before it opens it, as the page does (selectProject of packages/workbench/settings.js).
func (s *SettingsStore) Check(common, overrides map[string]any) error {
	for where, values := range map[string]map[string]any{"settings.json": common, "project settings": overrides} {
		for key, value := range values {
			if s.kept(key) {
				continue
			}
			if _, known := s.defaults[key]; !known && !s.isPluginOrder(key) {
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
	return s.check(s.effective(common, overrides))
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
	for _, definition := range s.Definitions {
		if definition.Type == "plugin" {
			values[definition.Key] = s.defaultOf(definition.Key)
		}
	}
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
	return s.defaultOf(key)
}

// pluginSetting returns the declaration of the setting of a plugin category that key names, or nil.
func (s *SettingsStore) pluginSetting(key string) *SettingDefinition {
	for i := range s.Definitions {
		if s.Definitions[i].Key == key && s.Definitions[i].Type == "plugin" {
			return &s.Definitions[i]
		}
	}
	return nil
}

// isPluginOrder tells that key is the order of the sides of a loaded plugin's sidebar list: <plugin>.win.order for the window sidebars and
// <plugin>.card.order for the card sidebars (docs/spec/settings.md#plugin-page).
func (s *SettingsStore) isPluginOrder(key string) bool {
	for _, suffix := range []string{".win.order", ".card.order"} {
		if id, ok := strings.CutSuffix(key, suffix); ok && s.loaded[id] {
			return true
		}
	}
	return false
}

// defaultOf returns the default of key. A plugin setting without a declared default takes the one loaded plugin of its category when the
// window loaded exactly one, and no value otherwise (docs/spec/plugins.md#plugin-categories).
func (s *SettingsStore) defaultOf(key string) any {
	if value := s.defaults[key]; value != nil {
		return value
	}
	// The order of the sides of a plugin's sidebar list starts as the order of the window sidebars (docs/spec/settings.md#plugin-page).
	if s.isPluginOrder(key) {
		return s.defaults["sidebarOrder"]
	}
	definition := s.pluginSetting(key)
	if definition == nil {
		return nil
	}
	var served []string
	for _, plugin := range s.plugins {
		if slices.Contains(plugin.Categories, definition.Category) {
			served = append(served, plugin.ID)
		}
	}
	if len(served) == 1 {
		return served[0]
	}
	return nil
}

// pluginForm refuses an environment value of a plugin setting that is not a plugin id. The place names the environment declaration, as
// the reader of the plugin SDK names it; a stored value is refused by validate (docs/spec/plugins.md#settings-declarations).
func (s *SettingsStore) pluginForm(where, key string, value any) error {
	if s.pluginSetting(key) == nil || value == nil {
		return nil
	}
	if text, ok := value.(string); !ok || !pluginID.MatchString(text) {
		return fmt.Errorf("%s: plugin value must be a plugin id", where)
	}
	return nil
}

// servesCategory tells that the loaded plugin id serves category.
func (s *SettingsStore) servesCategory(category, id string) bool {
	return slices.ContainsFunc(s.plugins, func(plugin LoadedPlugin) bool {
		return plugin.ID == id && slices.Contains(plugin.Categories, category)
	})
}

// Project returns the project that project changes apply to.
func (s *SettingsStore) Project() string { return s.project }

// Defaults returns the default value of each setting.
func (s *SettingsStore) Defaults() map[string]any { return maps.Clone(s.defaults) }

// Common returns the common settings as they stand now.
func (s *SettingsStore) Common() map[string]any { return s.common }

// Value returns the effective value of key, which has none while its stored plugin is missing.
func (s *SettingsStore) Value(key string) any {
	if _, missing := s.missing[key]; missing {
		return nil
	}
	return s.effectiveValue(s.common, s.overrides, key)
}

// ProjectValue is the value of key for a project with overrides, which need not be the selected project.
func (s *SettingsStore) ProjectValue(overrides map[string]any, key string) any {
	return s.effectiveValue(s.common, overrides, key)
}

// Scoped returns the value of key that the scope shows.
func (s *SettingsStore) Scoped(key, scope string) any {
	if scope != "common" {
		return s.Value(key)
	}
	if _, missing := s.missing[key]; missing {
		return nil
	}
	if value, ok := s.common[key]; ok {
		return value
	}
	return s.defaultOf(key)
}

// checkPluginPatch refuses a written plugin value that names no loaded plugin of its category (docs/spec/plugins.md#settings-declarations).
func (s *SettingsStore) checkPluginPatch(patch map[string]any) error {
	for _, key := range slices.Sorted(maps.Keys(patch)) {
		definition := s.pluginSetting(key)
		if definition == nil || patch[key] == nil {
			continue
		}
		id, ok := patch[key].(string)
		if !ok {
			return fmt.Errorf("Invalid setting %s: %s is not a plugin id", key, jsonText(patch[key]))
		}
		if !s.servesCategory(definition.Category, id) {
			return fmt.Errorf("%s: plugin %s is not a %s plugin", key, id, definition.Category)
		}
	}
	return nil
}

// Overridden tells that the shown project overrides key.
func (s *SettingsStore) Overridden(key string) bool {
	_, ok := s.overrides[key]
	return ok
}

// Source is the scope that the applied value of key comes from: the project scope while the selected project overrides key, and
// the common scope otherwise (docs/spec/settings.md#scope-of-a-control).
func (s *SettingsStore) Source(key string) string {
	if s.project != "" && s.Overridden(key) {
		return "project"
	}
	return "common"
}

// Status is the value of core.settings.
func (s *SettingsStore) Status() SettingsStatus {
	var project *string
	if s.project != "" {
		project = &s.project
	}
	overridden := nonNil(slices.Sorted(maps.Keys(s.overrides)))
	values := s.effective(s.common, s.overrides)
	common := make(map[string]any, len(values))
	for key := range values {
		common[key] = s.Scoped(key, "common")
	}
	return SettingsStatus{Values: values, Common: common, Project: project, Overridden: overridden, Saving: s.saving > 0}
}

// BeginSave counts a write that the host has not answered, and EndSave its answer.
func (s *SettingsStore) BeginSave() { s.saving++ }

// EndSave is the answer of a write.
func (s *SettingsStore) EndSave() { s.saving-- }

// isOrder is whether value is a list that holds each of values once.
func isOrder(value any, values []string) bool {
	items, ok := value.([]any)
	if !ok || len(items) != len(values) {
		return false
	}
	for _, want := range values {
		if !slices.Contains(items, any(want)) {
			return false
		}
	}
	return true
}

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
	// textSize is a number whose choices are the text size steps; the choices of the select box are their text, which the numeric check
	// below does not take (settingType gives number).
	if choices := catalog.choices(key); choices != nil && key != "textSize" {
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
	values, ordered := catalog.Settings.Orders[key]
	if s.isPluginOrder(key) {
		values, ordered = catalog.Settings.Orders["sidebarOrder"], true
	}
	if ordered && !isOrder(value, values) {
		named := make([]string, len(values))
		for i, item := range values {
			named[i] = jsonText(item)
		}
		return fmt.Errorf("Invalid setting %s: %s is not an order of %s", key, jsonText(value), strings.Join(named, ", "))
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
	case "plugin":
		if text, ok := value.(string); value != nil && (!ok || !pluginID.MatchString(text)) {
			return fmt.Errorf("Invalid setting %s: plugin value must be a plugin id", key)
		}
	}
	return nil
}

// check holds what no single value tells: the widths in order, and the sets and links with the functions of the page that also
// check the sidebars of environment.json (docs/spec/settings.md#stored-sets-and-links).
func (s *SettingsStore) check(values map[string]any) error {
	// A plugin value that names no loaded plugin is not refused here: a load keeps it as a missing setting (missingPlugins), and a
	// write refuses it before this check (checkPluginPatch).
	// A command passes the lists in their typed form, so the check reads each one in its stored form.
	storedSets, err := decode[any](values["sets"])
	if err != nil {
		return fmt.Errorf("settings: %w", err)
	}
	storedLinks, err := decode[any](values["links"])
	if err != nil {
		return fmt.Errorf("settings: %w", err)
	}
	if err := validateSidebars(storedSets, storedLinks, "settings", s.loaded); err != nil {
		return err
	}
	sets, err := decode[[]StoredSet](values["sets"])
	if err != nil {
		return fmt.Errorf("settings: %w", err)
	}
	links, err := decode[[]StoredLink](values["links"])
	if err != nil {
		return fmt.Errorf("settings: %w", err)
	}
	if err := checkSidebarReferences(sets, links, s.plugins, "settings"); err != nil {
		return err
	}
	return nil
}

// checkWidths refuses a change that leaves the first width outside the range from the minimum to the maximum. A stored width outside the
// range loads and is drawn as stored (docs/spec/settings.md#layout-values), so only a change is checked here.
func checkWidths(values map[string]any) error {
	// silent: validate checked the type of each value before this check runs.
	least, _ := values["sidebarMinWidth"].(float64)
	// silent: validate checked the type of each value before this check runs.
	width, _ := values["sidebarWidth"].(float64)
	// silent: validate checked the type of each value before this check runs.
	most, _ := values["sidebarMaxWidth"].(float64)
	if !(least <= width && width <= most) {
		return errors.New("Invalid setting: sidebarMinWidth <= sidebarWidth <= sidebarMaxWidth does not hold")
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
		if _, known := s.defaults[key]; !known && !s.isPluginOrder(key) {
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
	if err := s.checkPluginPatch(patch); err != nil {
		return err
	}
	if err := s.check(s.effective(common, overrides)); err != nil {
		return err
	}
	if err := checkWidths(s.effective(common, overrides)); err != nil {
		return err
	}
	restore := s.restoreOf(project, patch)
	s.common, s.overrides = common, overrides
	s.missing = s.missingPlugins(s.effective(common, overrides))
	s.save(project, values, remove, restore)
	return nil
}

// restoreOf returns the function that puts back the values of the keys of patch in the scope of project, as they were before the
// change. A key is put back only while its value is still the one that the change wrote: a later change of the same key, which is
// still pending, keeps its value. A key without a value before the change is removed again.
func (s *SettingsStore) restoreOf(project string, patch map[string]any) func() {
	scope := func() map[string]any {
		if project != "" {
			return s.overrides
		}
		return s.common
	}
	keys := slices.Sorted(maps.Keys(patch))
	previous, present := map[string]any{}, map[string]bool{}
	for _, key := range keys {
		value, ok := scope()[key]
		previous[key], present[key] = value, ok
	}
	return func() {
		for _, key := range keys {
			current, ok := scope()[key]
			written := patch[key]
			if written == nil && ok || written != nil && (!ok || !reflect.DeepEqual(current, written)) {
				continue
			}
			if present[key] {
				scope()[key] = previous[key]
			} else {
				delete(scope(), key)
			}
		}
		s.missing = s.missingPlugins(s.effective(s.common, s.overrides))
	}
}

// settingType returns the type of the value of key: boolean, number, object or string.
func (s *SettingsStore) settingType(key string) (string, error) {
	catalog := s.Catalog
	_, ranged := catalog.bounds(key)
	switch {
	case slices.Contains(catalog.Settings.Switches, key):
		return "boolean", nil
	case key == "diagnostics.log" || key == "sets" || key == "links" || catalog.Settings.Orders[key] != nil || s.isPluginOrder(key):
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
