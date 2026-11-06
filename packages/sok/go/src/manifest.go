package sok

// The plugin.json checks of the page reader (validateManifest of packages/plugin-api/index.js). ValidateManifest applies the
// reader's checks in the reader's order with the reader's error texts, so pack and install refuse exactly the manifests that
// the page refuses (docs/spec/installation.md#plugin-release). The reader checks the members of each object in sorted key
// order, and so does this file, so the first refused member is the same in both. The checks use the reader's own rules:
// the version regular expressions of the reader and the UTF-16 length that the reader's string length counts.

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
)

var (
	idPattern         = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	packagePattern    = regexp.MustCompile(`^(@[a-z0-9-]+/)?[a-z0-9-]+$`)
	regionPattern     = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	tokenPattern      = regexp.MustCompile(`^--[a-z][a-z0-9-]*$`)
	settingPattern    = regexp.MustCompile(`^[a-z][A-Za-z0-9-]*(\.[a-z][A-Za-z0-9-]*)*$`)
	versionPattern    = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
	boundedRangeRe    = regexp.MustCompile(`^>=(\S+) <(\S+)$`)
	lowerRangeRe      = regexp.MustCompile(`^>=(\S+)$`)
	barePattern       = regexp.MustCompile(`^(@[a-z0-9-]+/)?[a-z0-9][a-z0-9._-]*(/[A-Za-z0-9._-]+)*$`)
	exposeNamePattern = regexp.MustCompile(`^[a-z0-9]+([.-][a-z0-9]+)*$`)
	extensionPattern  = regexp.MustCompile(`^[a-z0-9]+$`)
	addressPattern    = regexp.MustCompile(`(?i)^https?://[^/]`)
)

// The limits that the reader names (PLUGIN_DESCRIPTION_MAX, SETTING_LABEL_MAX, SETTING_DESCRIPTION_MAX, ADDRESS_MAX,
// SET_TITLE_MAX, COMMAND_TIMEOUT_MAX).
const (
	pluginDescriptionMax  = 200
	settingLabelMax       = 40
	settingDescriptionMax = 200
	addressMax            = 2048
	setTitleMax           = 40
	menuTitleMax          = 40
	commandTimeoutMax     = 600000
)

// topLevelKeys are the members that plugin.json may hold (validateManifest).
var topLevelKeys = []string{"id", "name", "description", "mark", "icon", "surface", "sections", "preview", "dependencies", "background",
	"exposes", "settings", "data", "sidebars", "extends", "contributes", "events"}

// utf16Length is the length of a string in UTF-16 code units, the length that the reader's string checks count.
func utf16Length(s string) int {
	return len(utf16.Encode([]rune(s)))
}

// jsValueText writes a value the way the reader's template text shows it: null as null, a list joined by commas with
// null entries empty, and an object as [object Object].
func jsValueText(value any) string {
	switch v := value.(type) {
	case nil:
		return "null"
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case json.Number:
		return v.String()
	case []any:
		parts := make([]string, len(v))
		for i, item := range v {
			if item != nil {
				parts[i] = jsValueText(item)
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// jsFieldText writes a member of an object the way the reader's template text shows it: undefined when it is absent.
func jsFieldText(m map[string]any, key string) string {
	value, ok := m[key]
	if !ok {
		return "undefined"
	}
	return jsValueText(value)
}

// integerValue reports whether the value is a JSON number with an integer value, and returns it.
func integerValue(value any) (float64, bool) {
	n, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := n.Float64()
	if err != nil || f != math.Trunc(f) {
		return 0, false
	}
	return f, true
}

// isText reports whether the value is a non-empty string (isText of the reader).
func isText(value any) bool {
	s, ok := value.(string)
	return ok && s != ""
}

// isModulePath reports whether the value is a JavaScript path inside the package (isModulePath of the reader).
func isModulePath(value any) bool {
	path, ok := value.(string)
	return ok && path != "" && !strings.HasPrefix(path, "/") && !slices.Contains(strings.Split(path, "/"), "..") && strings.HasSuffix(path, ".js")
}

// compareVersion compares two versions by their numeric parts, the first differing part deciding. The parts have no
// leading zeros (versionPattern), so a longer part is the larger number and equal lengths compare as text.
func compareVersion(a, b string) int {
	x, y := strings.Split(a, "."), strings.Split(b, ".")
	for i := range x {
		if len(x[i]) != len(y[i]) {
			if len(x[i]) < len(y[i]) {
				return -1
			}
			return 1
		}
		if x[i] != y[i] {
			if x[i] < y[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// isRange reports whether the value is a version range of docs/spec/installation.md#versions-and-ranges, with the reader's
// forms: `*`, `x.y.z`, `^x.y.z`, `~x.y.z`, `>=x.y.z`, and `>=x.y.z <a.b.c` whose lower bound is below the upper bound, or a
// union of such forms joined by rangeSeparator.
func isRange(value any) bool {
	s, ok := value.(string)
	if !ok {
		return false
	}
	return !slices.ContainsFunc(strings.Split(s, rangeSeparator), func(part string) bool { return !isRangeForm(part) })
}

// isRangeForm reports whether the text is one form of a range, as isRange reads it.
func isRangeForm(s string) bool {
	if s == "*" {
		return true
	}
	if m := boundedRangeRe.FindStringSubmatch(s); m != nil {
		return versionPattern.MatchString(m[1]) && versionPattern.MatchString(m[2]) && compareVersion(m[1], m[2]) < 0
	}
	if m := lowerRangeRe.FindStringSubmatch(s); m != nil {
		return versionPattern.MatchString(m[1])
	}
	return versionPattern.MatchString(strings.TrimPrefix(strings.TrimPrefix(s, "^"), "~"))
}

// sameJSON reports whether two values are equal as JSON values: objects have the same members whatever their order, and
// numbers have the same value.
func sameJSON(a, b any) bool {
	switch x := a.(type) {
	case nil:
		return b == nil
	case string:
		y, ok := b.(string)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case json.Number:
		y, ok := b.(json.Number)
		if !ok {
			return false
		}
		f, errX := x.Float64()
		g, errY := y.Float64()
		return errX == nil && errY == nil && f == g
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for i := range x {
			if !sameJSON(x[i], y[i]) {
				return false
			}
		}
		return true
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok || len(x) != len(y) {
			return false
		}
		for key, value := range x {
			other, ok := y[key]
			if !ok || !sameJSON(value, other) {
				return false
			}
		}
		return true
	}
	return false
}

// schemaTypes are the names that a schema type may use (SCHEMA_TYPES of packages/plugin-api).
var schemaTypes = []string{"string", "number", "integer", "boolean", "object", "array", "null"}

// schemaKeywords are the keywords that a schema may hold (checkSchema of packages/plugin-api).
var schemaKeywords = []string{"type", "properties", "items", "enum"}

// checkSchema checks a schema the way the reader does: only the keywords of schemaKeywords, a type that is a name of
// schemaTypes or a non-empty list of them, an object of properties, a schema of items, and a non-empty list of enum.
// where names the schema in the error.
func checkSchema(where string, value any) error {
	schema, ok := value.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: schema must be an object", where)
	}
	if err := only(where, schema, schemaKeywords...); err != nil {
		return err
	}
	if raw, ok := schema["type"]; ok && !validSchemaType(raw) {
		return fmt.Errorf("%s: unknown schema type %s", where, quote(raw))
	}
	if raw, ok := schema["properties"]; ok {
		properties, ok := raw.(map[string]any)
		if !ok {
			return fmt.Errorf("%s: properties must be an object", where)
		}
		for _, key := range sortedKeys(properties) {
			if err := checkSchema(where+"."+key, properties[key]); err != nil {
				return err
			}
		}
	}
	if raw, ok := schema["items"]; ok {
		if err := checkSchema(where+"[]", raw); err != nil {
			return err
		}
	}
	if raw, ok := schema["enum"]; ok {
		if list, ok := raw.([]any); !ok || len(list) == 0 {
			return fmt.Errorf("%s: enum must be a non-empty array", where)
		}
	}
	return nil
}

// validSchemaType reports whether a type is a name of schemaTypes, or a non-empty list of such names.
func validSchemaType(raw any) bool {
	names, ok := raw.([]any)
	if !ok {
		names = []any{raw}
	}
	if len(names) == 0 {
		return false
	}
	for _, name := range names {
		if s, ok := name.(string); !ok || !slices.Contains(schemaTypes, s) {
			return false
		}
	}
	return true
}

// schemaTypeMatches reports whether a value has the type name (the matchers of SCHEMA_TYPES).
func schemaTypeMatches(name string, value any) bool {
	switch name {
	case "string":
		_, ok := value.(string)
		return ok
	case "number":
		n, ok := value.(json.Number)
		if !ok {
			return false
		}
		f, err := n.Float64()
		return err == nil && !math.IsInf(f, 0)
	case "integer":
		_, ok := integerValue(value)
		return ok
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "object":
		_, ok := value.(map[string]any)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	case "null":
		return value == nil
	}
	return false
}

// matchesSchema reports whether a value satisfies a schema that checkSchema accepted (matchesSchema of the reader).
// properties checks only the members that the value has.
func matchesSchema(schema map[string]any, value any) bool {
	if raw, ok := schema["enum"]; ok {
		// default: checkSchema refused an enum that is not a non-empty list before a value is matched.
		list, _ := raw.([]any)
		if !slices.ContainsFunc(list, func(item any) bool { return sameJSON(item, value) }) {
			return false
		}
	}
	if raw, ok := schema["type"]; ok {
		names, isList := raw.([]any)
		if !isList {
			names = []any{raw}
		}
		if !slices.ContainsFunc(names, func(name any) bool {
			// default: checkSchema refused a type name that is not text before a value is matched; no value matches it.
			s, _ := name.(string)
			return schemaTypeMatches(s, value)
		}) {
			return false
		}
	}
	if raw, ok := schema["properties"]; ok {
		if object, isObject := value.(map[string]any); isObject {
			// default: checkSchema refused properties that are not an object before a value is matched.
			properties, _ := raw.(map[string]any)
			for _, key := range sortedKeys(properties) {
				if sub, has := object[key]; has && !matchesSchema(properties[key].(map[string]any), sub) {
					return false
				}
			}
		}
	}
	if raw, ok := schema["items"]; ok {
		if list, isList := value.([]any); isList {
			for _, item := range list {
				if !matchesSchema(raw.(map[string]any), item) {
					return false
				}
			}
		}
	}
	return true
}

// installedPluginsFile names the installed plugin document in the errors of its checks.
const installedPluginsFile = "installed-plugins.json"

// operationFieldPattern is the form of the field that names the operation of a sidecar message.
var operationFieldPattern = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]*$`)

// AcceptedInstalled is what a window keeps of the installed plugin document: the accepted plugins, the error of each refusal, and the
// ids of the refused plugins.
type AcceptedInstalled struct {
	Plugins []any
	Errors  []string
	Refused []string
}

// AcceptInstalledPlugins checks a parsed installed plugin document with the rules of the page reader (acceptInstalledPlugins of
// packages/plugin-api/index.js). A plugin that is refused is left out, and its id is in Refused when it is text. An { error } document
// accepts no plugin and answers its error. A document of another form, and two accepted plugins with one id or package, are errors.
func AcceptInstalledPlugins(value any) (AcceptedInstalled, error) {
	accepted := AcceptedInstalled{Plugins: []any{}, Errors: []string{}, Refused: []string{}}
	document, ok := value.(map[string]any)
	if !ok {
		return accepted, fmt.Errorf("%s: expected an object", installedPluginsFile)
	}
	if failure, ok := document["error"]; ok {
		if !isText(failure) {
			return accepted, fmt.Errorf("%s: error must be text", installedPluginsFile)
		}
		accepted.Errors = append(accepted.Errors, "installed plugins: "+failure.(string))
		return accepted, nil
	}
	if err := only(installedPluginsFile, document, "plugins"); err != nil {
		return accepted, err
	}
	plugins, ok := document["plugins"].([]any)
	if !ok {
		return accepted, fmt.Errorf("%s: plugins must be an array", installedPluginsFile)
	}
	for _, plugin := range plugins {
		err := checkInstalledPlugin(plugin)
		if err == nil {
			accepted.Plugins = append(accepted.Plugins, plugin)
			continue
		}
		accepted.Errors = append(accepted.Errors, err.Error())
		if entry, ok := plugin.(map[string]any); ok && isText(entry["id"]) {
			accepted.Refused = append(accepted.Refused, entry["id"].(string))
		}
	}
	ids := map[string]bool{}
	packages := map[string]bool{}
	for _, plugin := range accepted.Plugins {
		entry := plugin.(map[string]any)
		id, name := entry["id"].(string), entry["package"].(string)
		if ids[id] {
			return accepted, fmt.Errorf("%s: plugin %s appears twice", installedPluginsFile, id)
		}
		if packages[name] {
			return accepted, fmt.Errorf("%s: package %s appears twice", installedPluginsFile, name)
		}
		ids[id], packages[name] = true, true
	}
	return accepted, nil
}

// checkInstalledPlugin checks one entry of the installed plugin document: { id, package, version, manifest, sidecars?, diagnostics? }.
// The error names the plugin.
func checkInstalledPlugin(value any) error {
	plugin, ok := value.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: every plugin must be an object", installedPluginsFile)
	}
	id := jsFieldText(plugin, "id")
	if err := only(installedPluginsFile+" plugin "+id, plugin, "id", "package", "version", "manifest", "sidecars", "diagnostics"); err != nil {
		return err
	}
	if !isText(plugin["id"]) || !idPattern.MatchString(id) {
		return fmt.Errorf("%s: plugin id %s is invalid", installedPluginsFile, id)
	}
	if name, ok := plugin["package"].(string); !ok || !packagePattern.MatchString(name) {
		return fmt.Errorf("%s: plugin %s package must be a package.json name", installedPluginsFile, id)
	}
	if !isText(plugin["version"]) {
		return fmt.Errorf("%s: plugin %s version is required", installedPluginsFile, id)
	}
	if _, ok := plugin["manifest"]; !ok {
		return fmt.Errorf("%s: plugin %s manifest is required", installedPluginsFile, id)
	}
	manifest, ok := plugin["manifest"].(map[string]any)
	if !ok || manifest["id"] != plugin["id"] {
		return fmt.Errorf("%s: plugin %s has a plugin.json with id %s", installedPluginsFile, id, jsFieldText(manifest, "id"))
	}
	if err := ValidateManifest(manifest); err != nil {
		// States which installed plugin the rejected manifest belongs to.
		return fmt.Errorf("installed plugin %s %s (%s): %w", id, plugin["version"], plugin["package"], err)
	}
	if sidecars, ok := plugin["sidecars"]; ok {
		// silent: ValidateManifest checked the form, and a plugin without dependencies has no sidecar whose facts are checked.
		dependencies, _ := manifest["dependencies"].(map[string]any)
		if err := checkSidecarFacts(installedPluginsFile+": plugin "+id, sidecars, dependencies); err != nil {
			return err
		}
	}
	if diagnostics, ok := plugin["diagnostics"]; ok {
		if _, ok := diagnostics.(map[string]any); !ok {
			return fmt.Errorf("%s: plugin %s diagnostics must be an object", installedPluginsFile, id)
		}
	}
	return nil
}

// checkSidecarFacts checks the sidecar facts of an installed plugin: each sidecar dependency maps to the message form of its
// sidecar.json. A name that is not a dependency is refused.
func checkSidecarFacts(where string, raw any, dependencies map[string]any) error {
	sidecars, ok := raw.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: sidecars must map sidecars to facts", where)
	}
	for _, name := range sortedKeys(sidecars) {
		if _, ok := dependencies[name]; !ok {
			return fmt.Errorf("%s: sidecars %s is not a dependency", where, name)
		}
		sidecarWhere := where + " sidecar " + name
		facts, ok := sidecars[name].(map[string]any)
		if !ok {
			return fmt.Errorf("%s: facts must be an object", sidecarWhere)
		}
		if err := only(sidecarWhere, facts, "message"); err != nil {
			return err
		}
		if declared, ok := facts["message"]; ok {
			message, ok := declared.(map[string]any)
			if !ok {
				return fmt.Errorf("%s: message must be an object", sidecarWhere)
			}
			if err := only(sidecarWhere+" message", message, "form", "operationField"); err != nil {
				return err
			}
			if message["form"] != "json-object" {
				return fmt.Errorf("%s: message form must be json-object", sidecarWhere)
			}
			if field, ok := message["operationField"].(string); !ok || !operationFieldPattern.MatchString(field) {
				return fmt.Errorf("%s: message operationField must be a field name", sidecarWhere)
			}
		}
	}
	return nil
}

// ValidateManifest checks a parsed plugin.json with the rules of the page reader and returns the first refused member
// as the reader's error text (validateManifest of packages/plugin-api/index.js).
func ValidateManifest(value any) error {
	manifest, ok := value.(map[string]any)
	if !ok {
		return fmt.Errorf("plugin.json: expected an object")
	}
	if _, ok := manifest["state"]; ok {
		return fmt.Errorf("plugin %s: state is removed; a plugin declares its project data with data (docs/spec/plugins.md#project-data)", jsFieldText(manifest, "id"))
	}
	// The plugin host members are removed: a section is a view of the plugin (docs/spec/plugins.md#sections).
	for _, member := range []string{"host", "hostOperations"} {
		if _, ok := manifest[member]; ok {
			return fmt.Errorf("plugin %s: %s is removed; a section is a view of the plugin", jsFieldText(manifest, "id"), member)
		}
	}
	if err := only("plugin.json", manifest, topLevelKeys...); err != nil {
		return err
	}
	if events, ok := manifest["events"]; ok {
		if !isText(events) || strings.HasPrefix(events.(string), "/") || slices.Contains(strings.Split(events.(string), "/"), "..") {
			return fmt.Errorf("plugin.json: events must be a path inside the package")
		}
	}
	id, ok := manifest["id"].(string)
	if !ok || !idPattern.MatchString(id) {
		return fmt.Errorf("plugin.json: invalid id %s", jsFieldText(manifest, "id"))
	}
	if id == "core" {
		return fmt.Errorf("plugin.json: plugin id core is reserved for the core root")
	}
	where := "plugin " + id
	if !isText(manifest["name"]) {
		return fmt.Errorf("%s: name is required", where)
	}
	if description, ok := manifest["description"].(string); !ok || description == "" || utf16Length(description) > pluginDescriptionMax {
		return fmt.Errorf("%s: description must be 1 to %d characters", where, pluginDescriptionMax)
	}
	_, hasSurface := manifest["surface"]
	_, hasSections := manifest["sections"]
	_, hasContributes := manifest["contributes"]
	if err := checkData(where, manifest); err != nil {
		return err
	}
	dependencies := map[string]any{}
	if raw, ok := manifest["dependencies"]; ok {
		if !hasSurface && !hasSections && !hasContributes {
			return fmt.Errorf("%s: dependencies require a surface, sections or contributes", where)
		}
		deps, err := checkDependencies(where, raw)
		if err != nil {
			return err
		}
		dependencies = deps
	}
	sidecars := sortedKeys(dependencies)
	if raw, ok := manifest["extends"]; ok {
		if !hasSurface {
			return fmt.Errorf("%s: extends requires a surface", where)
		}
		if err := checkExtends(where, raw); err != nil {
			return err
		}
	}
	if raw, ok := manifest["contributes"]; ok {
		if err := checkContributes(where, id, raw); err != nil {
			return err
		}
	}
	if raw, ok := manifest["background"]; ok {
		if !hasSurface {
			return fmt.Errorf("%s: background requires a surface", where)
		}
		if err := checkBackground(where, raw, sidecars, manifest["settings"]); err != nil {
			return err
		}
	}
	if raw, ok := manifest["surface"]; ok {
		if err := checkSurface(where, manifest, raw, sidecars); err != nil {
			return err
		}
	}
	if raw, ok := manifest["sections"]; ok {
		if err := checkSections(where, id, sidecars, raw); err != nil {
			return err
		}
	}
	if raw, ok := manifest["preview"]; ok {
		if !hasSurface {
			return fmt.Errorf("%s: preview requires a surface", where)
		}
		if err := checkPreview(where, raw); err != nil {
			return err
		}
	}
	if raw, ok := manifest["exposes"]; ok {
		if !hasSurface && !hasSections {
			return fmt.Errorf("%s: exposes require a surface or sections", where)
		}
		// The member dom is removed: an exposed element is declared in exposes.element (docs/spec/exposure.md#declarations).
		if exposes, isObject := raw.(map[string]any); isObject {
			if _, has := exposes["dom"]; has {
				return fmt.Errorf("%s: exposes.dom is removed; an exposed element is declared in exposes.element", where)
			}
		}
		if err := checkExposes(id, raw); err != nil {
			return err
		}
	}
	if raw, ok := manifest["settings"]; ok {
		if err := checkSettings(where, raw); err != nil {
			return err
		}
	}
	if !hasSurface && !hasSections && !hasContributes {
		return fmt.Errorf("%s: a plugin requires a surface, sections or contributes", where)
	}
	if raw, ok := manifest["sidebars"]; ok {
		if err := checkSidebarDefaults(where, manifest, raw); err != nil {
			return err
		}
	}
	return nil
}

// checkData checks the data declarations (validateManifest): a surface or sections is required, and each key holds a schema
// and a default that matches it, with a positive integer format.
func checkData(where string, manifest map[string]any) error {
	raw, ok := manifest["data"]
	if !ok {
		return nil
	}
	_, hasSurface := manifest["surface"]
	_, hasSections := manifest["sections"]
	if !hasSurface && !hasSections {
		return fmt.Errorf("%s: data requires a surface or sections", where)
	}
	data, ok := raw.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: data must be an object", where)
	}
	for _, key := range sortedKeys(data) {
		if !idPattern.MatchString(key) {
			return fmt.Errorf("%s: invalid data key %s", where, key)
		}
		entry, ok := data[key].(map[string]any)
		if !ok {
			return fmt.Errorf("%s: data %s requires schema and default", where, key)
		}
		schema, isSchema := entry["schema"].(map[string]any)
		_, hasDefault := entry["default"]
		if !isSchema || !hasDefault {
			return fmt.Errorf("%s: data %s requires schema and default", where, key)
		}
		if err := only(where+" data "+key, entry, "schema", "default", "format"); err != nil {
			return err
		}
		if err := checkSchema(where+" data "+key+" schema", entry["schema"]); err != nil {
			return err
		}
		if !matchesSchema(schema, entry["default"]) {
			return fmt.Errorf("%s: data %s default does not match its schema", where, key)
		}
		if format, has := entry["format"]; has {
			if f, isInteger := integerValue(format); !isInteger || f < 1 {
				return fmt.Errorf("%s: data %s format must be a positive integer", where, key)
			}
		}
	}
	return nil
}

// checkDependencies checks the dependencies of plugin.json and returns them as a map.
func checkDependencies(where string, raw any) (map[string]any, error) {
	deps, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s: dependencies must map sidecars and plugins to version ranges", where)
	}
	for _, name := range sortedKeys(deps) {
		if !packagePattern.MatchString(name) {
			return nil, fmt.Errorf("%s: dependencies: %s is not a sidecar or plugin name", where, name)
		}
		if !isRange(deps[name]) {
			return nil, fmt.Errorf("%s: dependencies %s: invalid range %s", where, name, jsValueText(deps[name]))
		}
	}
	return deps, nil
}

// checkExtends checks the extension point declarations of a provider (checkExtends of the reader).
func checkExtends(where string, raw any) error {
	points, ok := raw.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: extends must be an object", where)
	}
	for _, name := range sortedKeys(points) {
		if !idPattern.MatchString(name) {
			return fmt.Errorf("%s: invalid extension point %s", where, name)
		}
		at := where + " extension point " + name
		point, ok := points[name].(map[string]any)
		if !ok {
			return fmt.Errorf("%s: must be an object", at)
		}
		if err := only(at, point, "version", "schema", "modules"); err != nil {
			return err
		}
		if version, ok := point["version"].(string); !ok || !versionPattern.MatchString(version) {
			return fmt.Errorf("%s version must be x.y.z", at)
		}
		if err := checkSchema(at+" schema", point["schema"]); err != nil {
			return err
		}
		if raw, ok := point["modules"]; ok {
			modules, ok := raw.(map[string]any)
			if !ok {
				return fmt.Errorf("%s: modules must be an object", at)
			}
			for _, specifier := range sortedKeys(modules) {
				if !barePattern.MatchString(specifier) {
					return fmt.Errorf("%s module %s is not a bare specifier", at, specifier)
				}
				if !isModulePath(modules[specifier]) {
					return fmt.Errorf("%s module %s must be a JavaScript path inside the package", at, specifier)
				}
			}
		}
	}
	return nil
}

// checkContributes checks the contributions of a contributor (checkContributes of the reader).
func checkContributes(where, id string, raw any) error {
	contributes, ok := raw.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: contributes must be an object", where)
	}
	for _, name := range sortedKeys(contributes) {
		dot := strings.Index(name, ".")
		if dot < 0 || !idPattern.MatchString(name[:dot]) || !idPattern.MatchString(name[dot+1:]) {
			return fmt.Errorf("%s: contributes %s must be <plugin id>.<point>", where, name)
		}
		if name[:dot] == id {
			return fmt.Errorf("%s: contributes to its own extension point %s", where, name)
		}
		items, ok := contributes[name].([]any)
		if !ok || len(items) == 0 {
			return fmt.Errorf("%s: contributes %s must be a non-empty array", where, name)
		}
		for index, item := range items {
			at := fmt.Sprintf("%s: contributes %s item %d", where, name, index+1)
			entry, ok := item.(map[string]any)
			if !ok {
				return fmt.Errorf("%s must be an object", at)
			}
			if !isRange(entry["range"]) {
				return fmt.Errorf("%s range %s is invalid", at, jsFieldText(entry, "range"))
			}
			if !isModulePath(entry["module"]) {
				return fmt.Errorf("%s module must be a JavaScript path inside the package", at)
			}
		}
	}
	return nil
}

// checkBackground checks the background declaration (checkBackground of the reader). sidecars are the dependency names.
func checkBackground(where string, raw any, sidecars []string, settings any) error {
	background, ok := raw.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: background must be an object", where)
	}
	if err := only(where+" background", background, "sidecar", "operation", "settings"); err != nil {
		return err
	}
	// default: settings that are not an object declare no setting, so no background field names one.
	declared, _ := settings.(map[string]any)
	if raw, ok := background["settings"]; ok {
		fields, ok := raw.(map[string]any)
		if !ok {
			return fmt.Errorf("%s background: settings must map request fields to setting names", where)
		}
		for _, field := range sortedKeys(fields) {
			if field == "operation" {
				return fmt.Errorf("%s background: a setting cannot replace operation", where)
			}
			setting, isText := fields[field].(string)
			if _, has := declared[setting]; !isText || !has {
				return fmt.Errorf("%s background: setting %s is not declared by the plugin", where, jsValueText(fields[field]))
			}
		}
	}
	sidecar, ok := background["sidecar"].(string)
	if !ok || !slices.Contains(sidecars, sidecar) {
		return fmt.Errorf("%s background: sidecar must be declared by the plugin", where)
	}
	if operation, ok := background["operation"].(string); !ok || operation == "" {
		return fmt.Errorf("%s background: operation must be a non-empty string", where)
	}
	return nil
}

// declaredCommands returns the names of the commands of exposes (`exposes.commands` when it is a list, else none).
func declaredCommands(manifest map[string]any) []string {
	// default: exposes that is not an object declares no command; the menu, save and drop checks then refuse the name.
	exposes, _ := manifest["exposes"].(map[string]any)
	// default: commands that are not a list declare no command; the menu, save and drop checks then refuse the name.
	commands, _ := exposes["commands"].([]any)
	var names []string
	for _, item := range commands {
		if command, ok := item.(map[string]any); ok {
			if name, ok := command["name"].(string); ok {
				names = append(names, name)
			}
		}
	}
	return names
}

// checkSurface checks the surface declaration (validateManifest of the reader).
func checkSurface(where string, manifest map[string]any, raw any, sidecars []string) error {
	surface, ok := raw.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: surface must be an object", where)
	}
	if err := only(where+" surface", surface, "module", "composition", "drop", "params", "opens", "save", "menu", "unload"); err != nil {
		return err
	}
	commands := declaredCommands(manifest)
	if raw, ok := surface["menu"]; ok {
		if err := checkMenu(where, raw, commands); err != nil {
			return err
		}
	}
	if raw, ok := surface["save"]; ok {
		if name, isText := raw.(string); !isText || !slices.Contains(commands, name) {
			return fmt.Errorf("%s: surface save must name a command declared in exposes", where)
		}
	}
	if raw, ok := surface["params"]; ok {
		schema, isSchema := raw.(map[string]any)
		if !isSchema || schema["type"] != "object" {
			return fmt.Errorf("%s: surface params must be a schema of type object", where)
		}
		if err := checkSchema(where+" surface params", raw); err != nil {
			return err
		}
	}
	if raw, ok := surface["opens"]; ok {
		if err := checkOpens(where, raw, surface["params"]); err != nil {
			return err
		}
	}
	if raw, ok := surface["drop"]; ok {
		if name, isText := raw.(string); !isText || !slices.Contains(commands, name) {
			return fmt.Errorf("%s: surface drop must name a command declared in exposes", where)
		}
	}
	if _, ok := surface["module"]; ok {
		return fmt.Errorf("%s: surface module is removed; a surface is a view (docs/spec/plugins.md#view-surfaces)", where)
	}
	composition, ok := surface["composition"]
	if !ok {
		return fmt.Errorf("%s: surface requires a composition", where)
	}
	if err := checkComposition(where+" surface", composition, sidecars); err != nil {
		return err
	}
	if raw, ok := surface["unload"]; ok {
		if _, hasBackground := manifest["background"]; hasBackground {
			return fmt.Errorf("%s: surface unload is forbidden beside background", where)
		}
		if err := checkUnload(where, "surface", raw); err != nil {
			return err
		}
	}
	if !isText(manifest["mark"]) {
		return fmt.Errorf("%s: mark is required with a surface", where)
	}
	if !isText(manifest["icon"]) {
		return fmt.Errorf("%s: icon is required with a surface", where)
	}
	return nil
}

// checkUnload checks an unload declaration of a surface or a section: {format, maxBytes} with positive integers
// (docs/spec/plugins.md#memory-saver). label names the owner in the messages.
func checkUnload(where, label string, raw any) error {
	unload, ok := raw.(map[string]any)
	format, isFormat := integerValue(unload["format"])
	maxBytes, isMax := integerValue(unload["maxBytes"])
	if !ok || !isFormat || format < 1 || !isMax || maxBytes < 1 {
		return fmt.Errorf("%s: %s unload must be {format, maxBytes} with positive integers", where, label)
	}
	return only(where+" "+label+" unload", unload, "format", "maxBytes")
}

// checkMenu checks the context menu of a surface (validateManifest of the reader).
func checkMenu(where string, raw any, commands []string) error {
	menu, ok := raw.([]any)
	if !ok || len(menu) == 0 || len(menu) > 16 {
		return fmt.Errorf("%s: surface menu must be an array of 1 to 16 items", where)
	}
	seen := map[string]bool{}
	for _, item := range menu {
		entry, ok := item.(map[string]any)
		if !ok {
			return fmt.Errorf("%s: a surface menu item must be an object", where)
		}
		if err := only(where+" surface menu item", entry, "command", "title"); err != nil {
			return err
		}
		command, isText := entry["command"].(string)
		if !isText || command == "" || !slices.Contains(commands, command) {
			return fmt.Errorf("%s: surface menu command %s must name a command declared in exposes", where, jsFieldText(entry, "command"))
		}
		if seen[command] {
			return fmt.Errorf("%s: surface menu command %s is repeated", where, command)
		}
		seen[command] = true
		if title, ok := entry["title"].(string); !ok || utf16Length(title) < 1 || utf16Length(title) > menuTitleMax {
			return fmt.Errorf("%s: surface menu title of %s must be 1 to %d characters", where, command, menuTitleMax)
		}
	}
	return nil
}

// checkOpens checks the files that a surface opens (validateManifest of the reader). params is the surface params.
func checkOpens(where string, raw any, params any) error {
	opens, ok := raw.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: surface opens must be an object", where)
	}
	if err := only(where+" surface opens", opens, "extensions"); err != nil {
		return err
	}
	pathType := ""
	if schema, ok := params.(map[string]any); ok {
		if properties, ok := schema["properties"].(map[string]any); ok {
			if path, ok := properties["path"].(map[string]any); ok {
				if typeName, isString := path["type"].(string); isString {
					pathType = typeName
				}
			}
		}
	}
	if pathType != "string" {
		return fmt.Errorf("%s: surface opens requires surface params with a string property path", where)
	}
	extensions, ok := opens["extensions"].([]any)
	if !ok || len(extensions) == 0 {
		return fmt.Errorf("%s: surface opens extensions must be a non-empty array", where)
	}
	seen := map[string]bool{}
	for _, item := range extensions {
		extension, isText := item.(string)
		if !isText || !extensionPattern.MatchString(extension) {
			return fmt.Errorf("%s: surface opens extension %s must be lowercase letters and digits", where, jsValueText(item))
		}
		if seen[extension] {
			return fmt.Errorf("%s: surface opens extension %s is repeated", where, extension)
		}
		seen[extension] = true
	}
	return nil
}

// checkSections checks the sections of plugin.json (validateManifest of the reader). A section is a view with a composition and a
// height.
func checkSections(where, id string, sidecars []string, raw any) error {
	sections, ok := raw.([]any)
	if !ok {
		return fmt.Errorf("%s: sections must be an array", where)
	}
	seen := map[string]bool{}
	for _, item := range sections {
		section, ok := item.(map[string]any)
		if !ok {
			return fmt.Errorf("%s: section must be an object", where)
		}
		// The status, module and fill members are removed (docs/spec/plugins.md#sections).
		for _, field := range []string{"fill", "module", "status"} {
			if _, has := section[field]; has {
				return fmt.Errorf("%s: section %s %s is removed; a section takes composition and height", where, jsFieldText(section, "id"), field)
			}
		}
		if err := only(where+" section", section, "id", "name", "composition", "height", "unload"); err != nil {
			return err
		}
		sectionID, ok := section["id"].(string)
		if !ok || !strings.HasPrefix(sectionID, id+".") || !idPattern.MatchString(sectionID[len(id)+1:]) {
			return fmt.Errorf("%s: section id %s must be %s.<name>", where, jsFieldText(section, "id"), id)
		}
		if seen[sectionID] {
			return fmt.Errorf("%s: duplicate section %s", where, sectionID)
		}
		seen[sectionID] = true
		if !isText(section["name"]) {
			return fmt.Errorf("%s: section %s requires a name", where, sectionID)
		}
		composition, has := section["composition"]
		if !has {
			return fmt.Errorf("%s: section %s requires composition", where, sectionID)
		}
		if err := checkComposition(where+" section "+sectionID, composition, sidecars); err != nil {
			return err
		}
		height, has := section["height"]
		if !has {
			return fmt.Errorf("%s: section %s requires height", where, sectionID)
		}
		keyword, isKeyword := height.(string)
		count, isCount := integerValue(height)
		if !(isKeyword && keyword == "fill") && (!isCount || count < 1) {
			return fmt.Errorf("%s: section %s height must be \"fill\" or a positive integer", where, sectionID)
		}
		// default: unload is optional; a section without it is never unloaded.
		if raw, has := section["unload"]; has {
			if err := checkUnload(where, "section "+sectionID, raw); err != nil {
				return err
			}
		}
	}
	return nil
}

// checkPreview checks the preview colors (validateManifest of the reader).
func checkPreview(where string, raw any) error {
	preview, ok := raw.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: preview must be an object", where)
	}
	if err := only(where+" preview", preview, "ink"); err != nil {
		return err
	}
	if ink, ok := preview["ink"].(string); !ok || !tokenPattern.MatchString(ink) {
		return fmt.Errorf("%s: preview.ink must be a theme token name", where)
	}
	return nil
}

// checkSettings checks the setting declarations (checkSettings of the reader).
func checkSettings(where string, raw any) error {
	settings, ok := raw.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: settings must be an object", where)
	}
	for _, key := range sortedKeys(settings) {
		if !settingPattern.MatchString(key) {
			return fmt.Errorf("%s: invalid setting name %s", where, key)
		}
		if err := checkSettingDeclaration(where+"."+key, settings[key]); err != nil {
			return err
		}
	}
	return nil
}

// isSettingAddress reports whether the value is an empty string or an http or https address of at most 2048 characters.
func isSettingAddress(value any) bool {
	if value == "" {
		return true
	}
	s, ok := value.(string)
	return ok && utf16Length(s) <= addressMax && addressPattern.MatchString(s)
}

// checkSettingDeclaration checks one setting declaration (checkSettingDeclaration of the reader).
func checkSettingDeclaration(where string, raw any) error {
	full, ok := raw.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: setting must be an object", where)
	}
	if label, ok := full["label"].(string); !ok || utf16Length(label) < 1 || utf16Length(label) > settingLabelMax {
		return fmt.Errorf("%s: label must be 1 to %d characters", where, settingLabelMax)
	}
	if raw, has := full["description"]; has {
		if description, ok := raw.(string); !ok || utf16Length(description) < 1 || utf16Length(description) > settingDescriptionMax {
			return fmt.Errorf("%s: description must be 1 to %d characters", where, settingDescriptionMax)
		}
	}
	declaration := map[string]any{}
	for key, value := range full {
		if key != "label" && key != "description" {
			declaration[key] = value
		}
	}
	switch declaration["type"] {
	case "enum":
		if err := only(where, declaration, "type", "default", "values"); err != nil {
			return err
		}
		values, ok := declaration["values"].([]any)
		if !ok || len(values) == 0 {
			return fmt.Errorf("%s: enum values must be distinct non-empty strings", where)
		}
		seen := map[string]bool{}
		for _, item := range values {
			value, isText := item.(string)
			if !isText || value == "" || seen[value] {
				return fmt.Errorf("%s: enum values must be distinct non-empty strings", where)
			}
			seen[value] = true
		}
		if defaultValue, ok := declaration["default"].(string); !ok || !seen[defaultValue] {
			return fmt.Errorf("%s: default must be one of values", where)
		}
	case "integer":
		if err := only(where, declaration, "type", "default", "minimum", "maximum"); err != nil {
			return err
		}
		def, okDefault := integerValue(declaration["default"])
		low, okMin := integerValue(declaration["minimum"])
		high, okMax := integerValue(declaration["maximum"])
		if !okDefault || !okMin || !okMax || low > high || def < low || def > high {
			return fmt.Errorf("%s: integer default and bounds are invalid", where)
		}
	case "string":
		if err := only(where, declaration, "type", "default", "maxLength"); err != nil {
			return err
		}
		maxLength, okMax := integerValue(declaration["maxLength"])
		value, okDefault := declaration["default"].(string)
		if !okMax || maxLength < 1 || !okDefault || value == "" || float64(utf16Length(value)) > maxLength {
			return fmt.Errorf("%s: string default and maxLength are invalid", where)
		}
	case "address":
		if err := only(where, declaration, "type", "default"); err != nil {
			return err
		}
		if !isSettingAddress(declaration["default"]) {
			return fmt.Errorf("%s: address default must be empty or an http or https address", where)
		}
	default:
		return fmt.Errorf("%s: setting type must be enum, integer, string, or address", where)
	}
	return nil
}

// checkSidebarDefaults checks the sidebar sets and the card and window defaults of plugin.json (validatePluginSidebarDefaults
// and validateSidebars of the reader).
func checkSidebarDefaults(where string, manifest map[string]any, raw any) error {
	sidebars, ok := raw.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: sidebars must be an object", where)
	}
	if err := only(where+" sidebars", sidebars, "sets", "card", "window"); err != nil {
		return err
	}
	sets, ok := sidebars["sets"].([]any)
	if !ok {
		return fmt.Errorf("%s: sidebars requires sets and links", where)
	}
	setIDs := map[string]bool{}
	for _, item := range sets {
		set, ok := item.(map[string]any)
		if !ok || !isText(set["id"]) || !isStringValue(set["title"]) || !isList(set["sections"]) {
			return fmt.Errorf("%s: every set requires id, title, and sections", where)
		}
		setID := set["id"].(string)
		if err := only(where+" set "+setID, set, "id", "title", "sections", "layout"); err != nil {
			return err
		}
		if title := set["title"].(string); utf16Length(title) < 1 || utf16Length(title) > setTitleMax {
			return fmt.Errorf("%s: set %s title must be 1 to %d characters", where, setID, setTitleMax)
		}
		listed := map[string]bool{}
		for _, section := range set["sections"].([]any) {
			sectionID, isText := section.(string)
			if !isText || sectionID == "" {
				return fmt.Errorf("%s: set %s sections must be section ids", where, setID)
			}
			if listed[sectionID] {
				return fmt.Errorf("%s: set %s lists section %s twice", where, setID, sectionID)
			}
			listed[sectionID] = true
		}
		// default: a layout that is not text is not list or tabs, so the check refuses it.
		if layout, _ := set["layout"].(string); layout != "list" && layout != "tabs" {
			return fmt.Errorf("%s: set %s layout must be list or tabs", where, setID)
		}
		if setID == "off" || setID == "inherit" {
			return fmt.Errorf("%s: set id %s is reserved", where, setID)
		}
		if setIDs[setID] {
			return fmt.Errorf("%s: duplicate set %s", where, setID)
		}
		setIDs[setID] = true
	}
	for _, item := range sets {
		setID := item.(map[string]any)["id"].(string)
		if !idPattern.MatchString(setID) {
			return fmt.Errorf("%s: invalid local set id %s", where, setID)
		}
	}
	for _, side := range []struct {
		kind  string
		sides []string
	}{{"card", []string{"top", "bottom", "left", "right"}}, {"window", []string{"left", "right"}}} {
		mapping, present := sidebars[side.kind]
		if !present {
			continue
		}
		if side.kind == "card" {
			if _, hasSurface := manifest["surface"]; !hasSurface {
				return fmt.Errorf("%s: card defaults require a surface", where)
			}
		}
		defaults, ok := mapping.(map[string]any)
		if !ok {
			return fmt.Errorf("%s: sidebar %s defaults must be an object", where, side.kind)
		}
		if err := only(where+" sidebar "+side.kind, defaults, side.sides...); err != nil {
			return err
		}
		for _, name := range sortedKeys(defaults) {
			if target, ok := defaults[name].(string); !ok || !setIDs[target] {
				return fmt.Errorf("%s: %s %s names unknown set %s", where, side.kind, name, jsValueText(defaults[name]))
			}
		}
	}
	return nil
}

func isStringValue(value any) bool {
	_, ok := value.(string)
	return ok
}

func isList(value any) bool {
	_, ok := value.([]any)
	return ok
}

// checkExposes checks the exposes declaration of the plugin owner (validateExposes of the reader): the kinds status,
// commands and element, and for each entry a name `<owner>.<name>`, a description, the schemas of its fields, an object
// params schema of a command, a boolean many of an element entry and a timeout of a command. A name is declared once per kind.
func checkExposes(owner string, raw any) error {
	where := owner + " exposes"
	exposes, ok := raw.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: expected an object", where)
	}
	if err := only(where, exposes, "status", "commands", "element"); err != nil {
		return err
	}
	fields := map[string][]string{"status": {"schema"}, "commands": {"params", "result"}, "element": nil}
	seen := map[string]bool{}
	for _, kind := range sortedKeys(exposes) {
		entries, ok := exposes[kind].([]any)
		if !ok {
			return fmt.Errorf("%s: %s must be an array", where, kind)
		}
		for _, item := range entries {
			entry, ok := item.(map[string]any)
			if !ok {
				return fmt.Errorf("%s: %s entry must be an object", where, kind)
			}
			name, isName := entry["name"].(string)
			if !isName || !strings.HasPrefix(name, owner+".") || !exposeNamePattern.MatchString(name) {
				return fmt.Errorf("%s: name %s must be %s.<name> with lowercase letters, digits, dots, and hyphens", where, jsFieldText(entry, "name"), owner)
			}
			if seen[kind+" "+name] {
				return fmt.Errorf("%s: duplicate %s %s", where, kind, name)
			}
			seen[kind+" "+name] = true
			at := where + " " + name
			allowed := append([]string{"name", "description"}, fields[kind]...)
			if kind == "element" {
				allowed = append(allowed, "many")
			}
			if kind == "commands" {
				allowed = append(allowed, "timeout")
			}
			if err := only(at, entry, allowed...); err != nil {
				return err
			}
			if _, ok := text(entry["description"]); !ok {
				return fmt.Errorf("%s: description is required", at)
			}
			for _, field := range fields[kind] {
				value, has := entry[field]
				if !has {
					return fmt.Errorf("%s: %s is required", at, field)
				}
				if err := checkSchema(at+" "+field, value); err != nil {
					return err
				}
			}
			if kind == "commands" {
				params, isObject := entry["params"].(map[string]any)
				if !isObject || params["type"] != "object" {
					return fmt.Errorf("%s: params must be an object schema", at)
				}
			}
			if raw, has := entry["many"]; has {
				if _, isBool := raw.(bool); !isBool {
					return fmt.Errorf("%s: many must be a boolean", at)
				}
			}
			if raw, has := entry["timeout"]; has && !validTimeout(raw) {
				return fmt.Errorf("%s: timeout must be an integer from 1 to %d milliseconds", at, commandTimeoutMax)
			}
		}
	}
	return nil
}

// validTimeout reports whether a timeout is an integer from 1 to commandTimeoutMax.
func validTimeout(raw any) bool {
	f, ok := integerValue(raw)
	return ok && f >= 1 && f <= commandTimeoutMax
}

// isViewPage reports whether the value is the page of a view: a path inside the release that ends in .html, with no empty,
// `.`, `..` or `.binary` segment (isViewPage of the reader).
func isViewPage(value any) bool {
	page, ok := value.(string)
	if !ok || page == "" || !strings.HasSuffix(page, ".html") {
		return false
	}
	for _, segment := range strings.Split(page, "/") {
		if segment == "" || segment == "." || segment == ".." || segment == ".binary" {
			return false
		}
	}
	return true
}

// checkComposition checks the composition of a surface (checkComposition of the reader). sidecars are the dependency names.
func checkComposition(where string, raw any, sidecars []string) error {
	composition, ok := raw.(map[string]any)
	if !ok {
		return fmt.Errorf("%s: composition must be an object", where)
	}
	switch composition["kind"] {
	case "dom":
		return fmt.Errorf("%s composition: kind dom is removed; the composition takes kind view", where)
	case "view":
		return checkView(where, composition, sidecars)
	case "hybrid":
		return fmt.Errorf("%s composition: kind hybrid is removed; the composition takes kind view", where)
	}
	return fmt.Errorf("%s composition: composition kind must be view", where)
}

// checkView checks the view composition: its page, its regions and its overlays.
func checkView(where string, composition map[string]any, sidecars []string) error {
	if err := only(where+" composition", composition, "kind", "page", "regions", "overlays"); err != nil {
		return err
	}
	page, has := composition["page"]
	if !has {
		return fmt.Errorf("%s composition: view composition requires page", where)
	}
	if !isViewPage(page) {
		return fmt.Errorf("%s composition: page must be a path inside the plugin release that ends in .html", where)
	}
	regions, overlays := []any{}, []any{}
	if raw, has := composition["regions"]; has {
		list, ok := raw.([]any)
		if !ok || len(list) == 0 {
			return fmt.Errorf("%s composition: regions must be a non-empty array", where)
		}
		regions = list
	}
	if raw, has := composition["overlays"]; has {
		list, ok := raw.([]any)
		if !ok {
			return fmt.Errorf("%s composition: overlays must be an array", where)
		}
		overlays = list
	}
	return checkRegions(where, regions, overlays, sidecars)
}

// checkRegions checks the regions and the overlays of a view; the names of both are unique (checkRegions of the reader).
func checkRegions(where string, regions, overlays []any, sidecars []string) error {
	names := map[string]bool{}
	for _, item := range regions {
		region, ok := item.(map[string]any)
		if !ok {
			return fmt.Errorf("%s composition region: expected an object", where)
		}
		name, isName := region["name"].(string)
		if !isName || !regionPattern.MatchString(name) {
			return fmt.Errorf("%s composition: invalid region name %s", where, jsFieldText(region, "name"))
		}
		if names[name] {
			return fmt.Errorf("%s composition: duplicate name %s", where, name)
		}
		names[name] = true
		regionWhere := where + " composition region " + name
		switch region["kind"] {
		case "document":
			if err := only(regionWhere, region, "name", "kind", "input"); err != nil {
				return err
			}
			if region["input"] != "native" {
				return fmt.Errorf("%s: document input must be native", regionWhere)
			}
		case "image":
			if err := only(regionWhere, region, "name", "kind", "sidecar", "present", "input"); err != nil {
				return err
			}
			if region["input"] != "dom" {
				return fmt.Errorf("%s: image input must be dom", regionWhere)
			}
			sidecar, isSidecar := region["sidecar"].(string)
			if !isSidecar || !slices.Contains(sidecars, sidecar) {
				return fmt.Errorf("%s: sidecar must be declared by the plugin", regionWhere)
			}
			// The presentation mode has no default (docs/spec/native-surfaces.md#image-regions).
			if present := region["present"]; present != "copy" && present != "lease" {
				return fmt.Errorf("%s: image present must be copy or lease", regionWhere)
			}
		default:
			return fmt.Errorf("%s: kind must be document or image", regionWhere)
		}
	}
	for _, item := range overlays {
		overlay, isText := item.(string)
		if !isText || !regionPattern.MatchString(overlay) {
			return fmt.Errorf("%s composition: invalid overlay name %s", where, jsValueText(item))
		}
		if names[overlay] {
			return fmt.Errorf("%s composition: duplicate name %s", where, overlay)
		}
		names[overlay] = true
	}
	return nil
}
