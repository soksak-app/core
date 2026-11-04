package workbench

import (
	"fmt"
	"maps"
	"math"
	"reflect"
	"slices"
	"strings"

	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// The contributions to extension points (docs/spec/plugins.md#extension-points). The workbench resolves them from the declarations
// of the installed and enabled plugins when it starts, gives a provider its connected items, and makes only the item whose module
// fails invalid.

// ExtensionPoint is a point that a plugin declares in extends.
type ExtensionPoint struct {
	Version string `json:"version"`
	Schema  any    `json:"schema"`
}

// PluginManifest is the part of plugin.json that the resolution reads.
type PluginManifest struct {
	Contributes map[string][]map[string]any `json:"contributes"`
	Extends     map[string]ExtensionPoint   `json:"extends"`
	Sections    []PluginSection             `json:"sections"`
	Sidebars    *PluginSidebars             `json:"sidebars"`
}

// InstalledPlugin is an installed and enabled plugin.
type InstalledPlugin struct {
	ID       string         `json:"id"`
	Package  string         `json:"package"`
	Version  string         `json:"version"`
	Manifest PluginManifest `json:"manifest"`
}

// ContributionStatus is one item of the status core.contributions.
type ContributionStatus struct {
	Plugin string  `json:"plugin"`
	Point  string  `json:"point"`
	Index  int     `json:"index"`
	State  string  `json:"state"`
	Reason *string `json:"reason"`
}

// ResolvedContribution is a contributed item. A connected item also has its provider, its fields without range and module, and
// the URL of its module.
type ResolvedContribution struct {
	ContributionStatus
	Provider string         `json:"provider,omitempty"`
	Item     map[string]any `json:"item,omitempty"`
	Module   string         `json:"module,omitempty"`
}

// ConnectedItem is an item that a provider receives. Fail makes the item invalid and leaves the other items connected.
type ConnectedItem struct {
	Plugin string
	Index  int
	Item   map[string]any
	Module string
	Fail   func(reason error)
}

// ResolveContributions resolves the contributions of installed, sorted by plugin id, point and index.
func ResolveContributions(installed []InstalledPlugin) ([]ResolvedContribution, error) {
	providers := make(map[string]InstalledPlugin, len(installed))
	for _, plugin := range installed {
		providers[plugin.ID] = plugin
	}
	ordered := slices.Clone(installed)
	slices.SortStableFunc(ordered, func(a, b InstalledPlugin) int { return strings.Compare(a.ID, b.ID) })
	resolved := []ResolvedContribution{}
	for _, plugin := range ordered {
		for _, point := range slices.Sorted(maps.Keys(plugin.Manifest.Contributes)) {
			providerID, name, ok := strings.Cut(point, ".")
			if !ok {
				return nil, fmt.Errorf("plugin %s contributes %s, which is not <plugin id>.<point>", plugin.ID, point)
			}
			provider, installed := providers[providerID]
			declaration, declared := provider.Manifest.Extends[name]
			for index, entry := range plugin.Manifest.Contributes[point] {
				base := ContributionStatus{Plugin: plugin.ID, Point: point, Index: index}
				fail := func(state, reason string) ResolvedContribution {
					status := base
					status.State, status.Reason = state, &reason
					return ResolvedContribution{ContributionStatus: status}
				}
				item := maps.Clone(entry)
				delete(item, "range")
				delete(item, "module")
				itemRange, _ := entry["range"].(string) // silent: a manifest was validated when it was installed.
				module, _ := entry["module"].(string)   // silent: a manifest was validated when it was installed.
				switch {
				case !installed:
					resolved = append(resolved, fail("provider-missing", "plugin "+providerID+" is not installed or not enabled"))
				case !declared:
					resolved = append(resolved, fail("invalid", providerID+" "+provider.Version+" declares no extension point "+name))
				case !sok.Satisfies(declaration.Version, itemRange):
					resolved = append(resolved, fail("version-mismatch", "range "+itemRange+" does not contain "+point+" "+declaration.Version))
				case !MatchesSchema(declaration.Schema, item):
					resolved = append(resolved, fail("invalid", "item does not match the schema of "+point))
				default:
					base.State = "connected"
					resolved = append(resolved, ResolvedContribution{ContributionStatus: base, Provider: providerID, Item: item,
						Module: "/modules/" + plugin.Package + "/" + module})
				}
			}
		}
	}
	return resolved, nil
}

// MatchesSchema reports whether value, as JSON decodes it, matches schema: the keywords enum, type, properties and items.
func MatchesSchema(schema, value any) bool {
	keywords, ok := schema.(map[string]any)
	if !ok {
		return false
	}
	if options, ok := keywords["enum"].([]any); ok && !slices.ContainsFunc(options, func(option any) bool { return reflect.DeepEqual(option, value) }) {
		return false
	}
	if types, ok := keywords["type"]; ok && !matchesType(types, value) {
		return false
	}
	if properties, ok := keywords["properties"].(map[string]any); ok {
		if object, ok := value.(map[string]any); ok {
			for key, sub := range properties {
				if member, ok := object[key]; ok && !MatchesSchema(sub, member) {
					return false
				}
			}
		}
	}
	if items, ok := keywords["items"]; ok {
		if list, ok := value.([]any); ok {
			return !slices.ContainsFunc(list, func(item any) bool { return !MatchesSchema(items, item) })
		}
	}
	return true
}

// matchesType reports whether value has the type or one of the types of a schema.
func matchesType(types, value any) bool {
	list, ok := types.([]any)
	if !ok {
		list = []any{types}
	}
	return slices.ContainsFunc(list, func(name any) bool {
		switch name {
		case "string":
			_, ok := value.(string)
			return ok
		case "number":
			_, ok := value.(float64)
			return ok
		case "integer":
			number, ok := value.(float64)
			return ok && number == math.Trunc(number)
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
	})
}

// Contributions holds the resolved contributions of a workbench.
type Contributions struct {
	resolved  []ResolvedContribution
	declared  map[string]map[string]ExtensionPoint
	listeners []func()
}

// NewContributions makes the contributions of a workbench before it resolves them.
func NewContributions() *Contributions { return &Contributions{} }

// Install resolves the contributions of installed. The workbench calls it once when it starts.
func (c *Contributions) Install(installed []InstalledPlugin) error {
	resolved, err := ResolveContributions(installed)
	if err != nil {
		return err
	}
	c.resolved = resolved
	c.declared = make(map[string]map[string]ExtensionPoint, len(installed))
	for _, plugin := range installed {
		c.declared[plugin.ID] = plugin.Manifest.Extends
	}
	return nil
}

// OnChange runs listener on each change of the state of a contribution.
func (c *Contributions) OnChange(listener func()) { c.listeners = append(c.listeners, listener) }

// Status is the value of the status core.contributions.
func (c *Contributions) Status() []ContributionStatus {
	status := make([]ContributionStatus, 0, len(c.resolved))
	for _, entry := range c.resolved {
		status = append(status, entry.ContributionStatus)
	}
	return status
}

// Of returns the items connected to the extension point point of the plugin provider. A point that the provider does not declare
// is an error.
func (c *Contributions) Of(provider, point string) ([]ConnectedItem, error) {
	if _, declared := c.declared[provider][point]; !declared {
		return nil, fmt.Errorf("extension point %s is not declared by %s", point, provider)
	}
	name := provider + "." + point
	items := []ConnectedItem{}
	for index := range c.resolved {
		entry := &c.resolved[index]
		if entry.Point != name || entry.State != "connected" {
			continue
		}
		items = append(items, ConnectedItem{Plugin: entry.Plugin, Index: entry.Index, Item: maps.Clone(entry.Item), Module: entry.Module,
			Fail: func(reason error) {
				text := "extend failed: " + reason.Error()
				entry.State, entry.Reason = "invalid", &text
				for _, listener := range c.listeners {
					listener()
				}
			}})
	}
	return items, nil
}
