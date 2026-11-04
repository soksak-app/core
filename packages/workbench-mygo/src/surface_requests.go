package workbench

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

// The requests for the names that surfaces register (docs/spec/exposure.md#relay). The registry of the page holds the declarations
// of the plugins, the surfaces that registered each name and the watches of their statuses, chooses the surface of a request and
// forwards the request to it; this file holds the same steps for a window of the native workbench.

// SurfaceLinks are what the registry asks the window about its surfaces. They run on the main thread.
type SurfaceLinks struct {
	// Plugin returns the id of the plugin of a surface, and an empty string for a surface that the window does not hold.
	Plugin func(surface string) string
	// Preferred returns the order in which the surfaces answer a request that names none (docs/spec/exposure.md#choosing-a-surface).
	Preferred func() []string
	// Unloaded tells whether the memory saver released the tab of a surface.
	Unloaded func(surface string) bool
	// Frame returns the origin of a surface in its window, and false when it has no applied frame.
	Frame func(surface string) (x, y float64, ok bool)
	// Forward makes the host call exposureForward and gives answer its reply in a later step.
	Forward func(request map[string]any, answer func(value any, err error))
	// Changed sends the value of a watched status to the host. surface is the surface that the watch names, and nil for none.
	Changed func(name string, surface *string, value any)
	// Failed receives the failure of an observation.
	Failed func(err error)
}

// SurfaceRegistered is the value of the event exposure-registered: an entry that a surface registered, or the end of the surface.
type SurfaceRegistered struct {
	Surface string `json:"surface"`
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	Closed  bool   `json:"closed"`
}

// SurfaceChange is a value that a surface sent for a watched status.
type SurfaceChange struct {
	Surface string          `json:"surface"`
	Name    string          `json:"name"`
	Value   json.RawMessage `json:"value"`
	Version int64           `json:"version"`
}

// surfaceWatch is one watch of a status of a surface: the surface that it follows, the surface that the request named, the last
// delivered version, whether a request of the host holds it and the observers of this window that follow it.
type surfaceWatch struct {
	surface   string
	requested *string
	name      string
	version   int64
	external  bool
	local     []*surfaceObserver
}

// surfaceObserver follows a status inside this window. It moves with the registrations: wanted is the surface that it wants, exact
// tells that it follows no other, and surface is the surface that it follows, or nil.
type surfaceObserver struct {
	name    string
	wanted  *string
	exact   bool
	fn      func(value any)
	placed  bool
	surface *string
	watch   *surfaceWatch
}

// surfaceTable holds what the registry knows of the plugins and the surfaces of its window.
type surfaceTable struct {
	links SurfaceLinks
	// declared holds the declaration keys of the plugins, exposes their entries in the format of the declaration file, and timeouts
	// the declared time limit of each command that has one.
	declared map[string]bool
	exposes  map[string][]map[string]any
	timeouts map[string]int64
	// owners holds the surfaces that registered each declaration key, in registration order.
	owners map[string][]string
	// watches holds the watches by watchKey, and observers the observers of this window.
	watches   map[string]*surfaceWatch
	observers []*surfaceObserver
	forwards  uint64
}

func newSurfaceTable() surfaceTable {
	return surfaceTable{declared: map[string]bool{}, exposes: map[string][]map[string]any{}, timeouts: map[string]int64{},
		owners: map[string][]string{}, watches: map[string]*surfaceWatch{}}
}

// The time limits of a command in milliseconds: the limit of one that declares none, and the largest declared limit
// (docs/spec/exposure.md, command timeout).
const (
	defaultCommandTimeout = 10000
	maxCommandTimeout     = 600000
)

// exposeKinds gives the entry kind of each key of the declaration file.
var exposeKinds = map[string]string{"status": "status", "commands": "command", "dom": "dom"}

func declarationKey(kind, name string) string { return kind + " " + name }

func ownerOf(name string) string {
	owner, _, _ := strings.Cut(name, ".")
	return owner
}

// registeredBySurface tells whether a surface document registers the name: a plugin name or one of the core document entries.
func registeredBySurface(name string) bool { return ownerOf(name) != "core" || surfaceNames[name] }

// sectionSurface tells whether a surface id names a section, `<space id>/<sidebar id>/<section id>`. A tab id has no "/".
func sectionSurface(surface string) bool { return strings.Contains(surface, "/") }

// Link gives the registry the surfaces of its window.
func (r *Registry) Link(links SurfaceLinks) { r.surfaces.links = links }

// Declare adds the declarations of a plugin. A name of another owner and a name that is declared are refused, and then nothing
// of exposes is added.
func (r *Registry) Declare(owner string, exposes Exposes) error {
	type entry struct {
		key, kind string
		fields    map[string]any
		timeout   int64
	}
	var read []entry
	seen := map[string]bool{}
	for _, list := range []struct {
		key     string
		entries []json.RawMessage
	}{{"status", exposes.Status}, {"commands", exposes.Commands}, {"dom", exposes.Dom}} {
		kind := exposeKinds[list.key]
		for _, raw := range list.entries {
			fields := map[string]any{}
			decoder := json.NewDecoder(strings.NewReader(string(raw)))
			decoder.UseNumber()
			if err := decoder.Decode(&fields); err != nil {
				return fmt.Errorf("%s declaration of %s: %w", kind, owner, err)
			}
			name, _ := fields["name"].(string) // silent: an absent name is refused below as an empty one.
			if name == "" {
				return fmt.Errorf("%s declaration of %s has no name", kind, owner)
			}
			key := declarationKey(kind, name)
			if r.surfaces.declared[key] || seen[key] {
				return fmt.Errorf("%s is declared twice", key)
			}
			if ownerOf(name) != owner {
				return fmt.Errorf("%s does not belong to %s", key, owner)
			}
			seen[key] = true
			each := entry{key: key, kind: list.key, fields: fields}
			if number, present := fields["timeout"]; present {
				text, _ := number.(json.Number) // silent: a value of another form is refused below.
				timeout, err := text.Int64()
				if err != nil || timeout < 1 || timeout > maxCommandTimeout {
					return fmt.Errorf("%s timeout must be an integer from 1 to %d ms", key, maxCommandTimeout)
				}
				each.timeout = timeout
			}
			read = append(read, each)
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, each := range read {
		r.surfaces.declared[each.key] = true
		r.surfaces.exposes[each.kind] = append(r.surfaces.exposes[each.kind], each.fields)
		if each.timeout != 0 {
			r.surfaces.timeouts[each.fields["name"].(string)] = each.timeout
		}
	}
	return nil
}

// CommandTimeout returns the time limit of the plugin command name.
func (r *Registry) CommandTimeout(name string) time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	if timeout, declared := r.surfaces.timeouts[name]; declared {
		return time.Duration(timeout) * time.Millisecond
	}
	return defaultCommandTimeout * time.Millisecond
}

// isDeclared tells whether the core or a plugin declares the name of kind.
func (r *Registry) isDeclared(kind, name string) bool {
	core := map[string]map[string]bool{"status": r.declared.Statuses, "command": r.declared.Commands, "dom": r.declared.Elements}[kind]
	return core[name] || r.surfaces.declared[declarationKey(kind, name)]
}

// Registered applies a registration or the end of a surface. A registration that does not match the declaration is not applied and
// is an error. A surface that the window no longer holds registers nothing, and its end follows.
func (r *Registry) Registered(event SurfaceRegistered) error {
	if err := r.applyRegistration(event); err != nil {
		return err
	}
	r.mu.Lock()
	observers := slices.Clone(r.surfaces.observers)
	r.mu.Unlock()
	for _, observer := range observers {
		r.reattach(observer)
	}
	return nil
}

func (r *Registry) applyRegistration(event SurfaceRegistered) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	table := &r.surfaces
	if event.Closed {
		for key, owners := range table.owners {
			table.owners[key] = slices.DeleteFunc(owners, func(surface string) bool { return surface == event.Surface })
		}
		for key, watched := range table.watches {
			if watched.surface == event.Surface {
				delete(table.watches, key)
			}
		}
		return nil
	}
	if !r.isDeclared(event.Kind, event.Name) || !registeredBySurface(event.Name) {
		return fmt.Errorf("surface %s registered undeclared %s %s", event.Surface, event.Kind, event.Name)
	}
	plugin := table.links.Plugin(event.Surface)
	if plugin == "" {
		return nil
	}
	if owner := ownerOf(event.Name); owner != "core" && owner != plugin {
		return fmt.Errorf("surface %s of plugin %s cannot register %s", event.Surface, plugin, event.Name)
	}
	key := declarationKey(event.Kind, event.Name)
	owners := slices.DeleteFunc(table.owners[key], func(surface string) bool { return surface == event.Surface })
	table.owners[key] = append(owners, event.Surface)
	return nil
}

// ownersOf returns the surfaces that registered the entry, in registration order.
func (r *Registry) ownersOf(kind, name string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.surfaces.owners[declarationKey(kind, name)])
}

// pick returns the surface that receives a request among the surfaces that registered the entry: the surface that the request
// names, the first preferred surface, or the surface registered last. A section answers only a request that names it.
func (r *Registry) pick(kind, name string, requested json.RawMessage) (string, error) {
	owners := r.ownersOf(kind, name)
	links := r.surfaces.links
	if requested != nil {
		var surface *string
		if json.Unmarshal(requested, &surface) != nil || surface == nil {
			return "", Refuse(InvalidParams, "surface must be a string")
		}
		if slices.Contains(owners, *surface) {
			return *surface, nil
		}
		if links.Unloaded(*surface) {
			return "", Refuse(Unregistered, "tab %s is unloaded", *surface)
		}
		return "", Refuse(Unregistered, "surface %s has not registered %s %s", *surface, kind, name)
	}
	choices := slices.DeleteFunc(owners, sectionSurface)
	if len(choices) == 0 {
		return "", Refuse(Unregistered, "%s %s is not registered", kind, name)
	}
	for _, surface := range links.Preferred() {
		if slices.Contains(choices, surface) {
			return surface, nil
		}
	}
	return choices[len(choices)-1], nil
}

// watchKey is the key of one watch. A watch that names a surface and a watch that does not are different.
func watchKey(name string, requested json.RawMessage) string {
	return name + " " + string(requested)
}

// replySurface answers a request for a name that a surface registers, and tells whether the request is one.
func (r *Registry) replySurface(method string, params json.RawMessage, answer func(result any, err error)) bool {
	kind, known := methodKinds[method]
	if !known {
		return false
	}
	var fields map[string]json.RawMessage
	var name *string
	if json.Unmarshal(params, &fields) != nil || json.Unmarshal(fields["name"], &name) != nil || name == nil {
		return false
	}
	if !r.isDeclared(kind, *name) || !registeredBySurface(*name) {
		return false
	}
	requested := fields["surface"]
	key := watchKey(*name, requested)
	r.mu.Lock()
	current := r.surfaces.watches[key]
	observed := current != nil && len(current.local) > 0
	switch {
	case method == "status.unwatch" && observed:
		current.external = false
	case method == "status.unwatch":
		delete(r.surfaces.watches, key)
	case method == "status.watch" && current != nil:
		current.external = true
	}
	r.mu.Unlock()
	switch {
	case method == "status.unwatch" && current != nil && !observed:
		r.release(current, answer)
		return true
	case method == "status.unwatch", method == "status.watch" && current != nil:
		answer(nil, nil)
		return true
	}
	surface, err := r.pick(kind, *name, requested)
	if err != nil {
		answer(nil, err)
		return true
	}
	if method != "status.watch" {
		r.forward(surface, method, params, answer)
		return true
	}
	// The watch exists before the surface answers, because the surface sends the current value as it starts the watch.
	watched := &surfaceWatch{surface: surface, name: *name, external: true}
	if requested != nil {
		watched.requested = &surface
	}
	r.mu.Lock()
	r.surfaces.watches[key] = watched
	r.mu.Unlock()
	r.forward(surface, method, nameOnly(*name), func(result any, err error) {
		if err != nil {
			r.mu.Lock()
			if r.surfaces.watches[key] == watched {
				delete(r.surfaces.watches, key)
			}
			r.mu.Unlock()
		}
		answer(result, err)
	})
	return true
}

// nameOnly returns the params of a status request.
func nameOnly(name string) json.RawMessage {
	encoded, err := json.Marshal(map[string]string{"name": name})
	if err != nil {
		panic(err) // A map of strings has a JSON form.
	}
	return encoded
}

// release ends the watch of the surface when no other watch follows the same surface.
func (r *Registry) release(watched *surfaceWatch, answer func(result any, err error)) {
	r.mu.Lock()
	shared := false
	for _, other := range r.surfaces.watches {
		shared = shared || other.surface == watched.surface && other.name == watched.name
	}
	r.mu.Unlock()
	if shared {
		answer(nil, nil)
		return
	}
	r.forward(watched.surface, "status.unwatch", nameOnly(watched.name), answer)
}

// forward sends a request to a surface. A command whose declaration has a timeout gives it to the host, which waits that long.
func (r *Registry) forward(surface, method string, params json.RawMessage, answer func(result any, err error)) {
	r.mu.Lock()
	r.surfaces.forwards++
	request := map[string]any{"id": r.surfaces.forwards, "surface": surface, "method": method, "params": params}
	if name, command := commandOf(method, params); command {
		if timeout, declared := r.surfaces.timeouts[name]; declared {
			request["timeout"] = timeout
		}
	}
	r.mu.Unlock()
	r.surfaces.links.Forward(request, func(value any, err error) {
		if err != nil {
			answer(nil, err)
			return
		}
		reply, err := decode[struct {
			Result json.RawMessage `json:"result"`
			Error  *Refusal        `json:"error"`
		}](value)
		if err != nil {
			answer(nil, fmt.Errorf("forward to surface %s: %w", surface, err))
			return
		}
		if reply.Error != nil {
			answer(nil, reply.Error)
			return
		}
		if method == "dom.rect" && len(reply.Result) > 0 && string(reply.Result) != "null" {
			answer(r.placedRect(surface, reply.Result))
			return
		}
		if len(reply.Result) == 0 {
			answer(nil, nil)
			return
		}
		answer(reply.Result, nil)
	})
}

// placedRect moves the rectangle of an element of a view from its document into the window. The zoom of a view page is 1.
func (r *Registry) placedRect(surface string, local json.RawMessage) (any, error) {
	x, y, ok := r.surfaces.links.Frame(surface)
	if !ok {
		return nil, Refuse(Failed, "surface %s has no valid applied frame", surface)
	}
	var rect map[string]any
	if err := json.Unmarshal(local, &rect); err != nil {
		return nil, fmt.Errorf("rectangle of surface %s: %w", surface, err)
	}
	left, okLeft := rect["x"].(float64)
	top, okTop := rect["y"].(float64)
	if !okLeft || !okTop {
		return nil, Refuse(Failed, "surface %s has no valid rectangle", surface)
	}
	rect["x"], rect["y"], rect["document"] = left+x, top+y, map[string]any{"x": 0, "y": 0}
	return rect, nil
}

// Deliver gives a value that a surface sent for a watched status to every watch of that surface and name whose last version is
// older. The host may reorder the calls that carry the values, so an older version is not delivered after a newer one.
func (r *Registry) Deliver(change SurfaceChange) {
	r.mu.Lock()
	var following []*surfaceWatch
	for _, watched := range r.surfaces.watches {
		if watched.surface == change.Surface && watched.name == change.Name && change.Version > watched.version {
			watched.version = change.Version
			following = append(following, watched)
		}
	}
	r.mu.Unlock()
	for _, watched := range following {
		if watched.external {
			r.surfaces.links.Changed(change.Name, watched.requested, change.Value)
		}
		for _, observer := range watched.local {
			observer.fn(change.Value)
		}
	}
}

// Observe follows a status that surfaces register: fn receives its value and each change, and nil when no surface holds it. wanted
// is the surface to follow, and nil for the preferred one; exact follows no other surface than wanted. The returned function ends it.
func (r *Registry) Observe(name string, wanted *string, exact bool, fn func(value any)) (stop func()) {
	observer := &surfaceObserver{name: name, wanted: wanted, exact: exact, fn: fn}
	r.mu.Lock()
	r.surfaces.observers = append(r.surfaces.observers, observer)
	r.mu.Unlock()
	r.reattach(observer)
	return func() {
		r.mu.Lock()
		r.surfaces.observers = slices.DeleteFunc(r.surfaces.observers, func(other *surfaceObserver) bool { return other == observer })
		r.mu.Unlock()
		r.detach(observer)
	}
}

// target returns the surface that an observer follows among the surfaces that registered its status.
func (r *Registry) target(observer *surfaceObserver) *string {
	owners := r.ownersOf("status", observer.name)
	if observer.wanted != nil && slices.Contains(owners, *observer.wanted) {
		return observer.wanted
	}
	if observer.exact {
		return nil
	}
	choices := slices.DeleteFunc(owners, sectionSurface)
	if len(choices) == 0 {
		return nil
	}
	for _, surface := range r.surfaces.links.Preferred() {
		if slices.Contains(choices, surface) {
			return &surface
		}
	}
	return &choices[len(choices)-1]
}

// observeKey is the key of the watch of an observer, which is the key of a request that names the same surface.
func observeKey(name, surface string) string {
	return watchKey(name, nameText(surface))
}

// nameText is the JSON of a surface id.
func nameText(surface string) json.RawMessage {
	encoded, err := json.Marshal(surface)
	if err != nil {
		panic(err) // A string has a JSON form.
	}
	return encoded
}

// observeFailed reports the failure of an observation with its name and its surface. A surface that ended is no failure: its end
// decides the observer again.
func (r *Registry) observeFailed(name, surface string, err error) {
	var refusal *Refusal
	if errors.As(err, &refusal) && refusal.Code == Gone {
		return
	}
	r.surfaces.links.Failed(fmt.Errorf("%s on %s: %w", name, surface, err))
}

// reattach decides again which surface an observer follows. When the surface changes, the watch moves.
func (r *Registry) reattach(observer *surfaceObserver) {
	surface := r.target(observer)
	r.mu.Lock()
	live := surface != nil && observer.watch != nil && r.surfaces.watches[observeKey(observer.name, *surface)] == observer.watch
	r.mu.Unlock()
	same := observer.placed && (surface == nil) == (observer.surface == nil) && (surface == nil || *surface == *observer.surface)
	if same && (surface == nil || live) {
		return
	}
	r.detach(observer)
	observer.placed, observer.surface = true, surface
	if surface == nil {
		observer.fn(nil)
		return
	}
	id, name, key := *surface, observer.name, observeKey(observer.name, *surface)
	r.mu.Lock()
	watched := r.surfaces.watches[key]
	if watched != nil {
		watched.local = append(watched.local, observer)
		observer.watch = watched
		r.mu.Unlock()
		r.forward(id, "status.get", nameOnly(name), func(value any, err error) {
			switch {
			case err != nil:
				r.observeFailed(name, id, err)
			case observer.watch == watched:
				observer.fn(value)
			}
		})
		return
	}
	watched = &surfaceWatch{surface: id, requested: &id, name: name, local: []*surfaceObserver{observer}}
	r.surfaces.watches[key] = watched
	observer.watch = watched
	r.mu.Unlock()
	r.forward(id, "status.watch", nameOnly(name), func(_ any, err error) {
		if err == nil {
			return
		}
		r.mu.Lock()
		if r.surfaces.watches[key] == watched {
			delete(r.surfaces.watches, key)
		}
		r.mu.Unlock()
		r.observeFailed(name, id, err)
	})
}

// detach ends the watch of an observer. When no other observer or request holds the watch, the watch of the surface ends too.
func (r *Registry) detach(observer *surfaceObserver) {
	watched := observer.watch
	observer.watch = nil
	if watched == nil {
		return
	}
	r.mu.Lock()
	watched.local = slices.DeleteFunc(watched.local, func(other *surfaceObserver) bool { return other == observer })
	key := observeKey(observer.name, watched.surface)
	ended := len(watched.local) == 0 && !watched.external && r.surfaces.watches[key] == watched
	if ended {
		delete(r.surfaces.watches, key)
	}
	r.mu.Unlock()
	if ended {
		r.release(watched, func(_ any, err error) {
			if err != nil {
				r.observeFailed(watched.name, watched.surface, err)
			}
		})
	}
}

// commandRequest is the request command.run of a run. A surface and the cids of the cause are members only when given.
func commandRequest(name string, params json.RawMessage, surface string, cids json.RawMessage) (json.RawMessage, error) {
	if len(params) == 0 || string(params) == "null" {
		params = json.RawMessage(`{}`)
	}
	request := map[string]any{"name": name, "params": params}
	if surface != "" {
		request["surface"] = surface
	}
	if len(cids) > 0 {
		request["cids"] = cids
	}
	return json.Marshal(request)
}

// RunOn runs the command name on surface and gives answer its result in a later step. It is the path of a control of the workbench
// that belongs to a surface, as an item of its context menu.
func (r *Registry) RunOn(name string, params json.RawMessage, surface string, answer func(result any, err error)) {
	request, err := commandRequest(name, params, surface, nil)
	if err != nil {
		answer(nil, err)
		return
	}
	r.Reply("command.run", request, nil, answer)
}

// RunOwned runs a command that a surface of the plugin owner registered: on surface when the caller names one, otherwise on caller,
// the surface of the calling view, when it registered the command, otherwise on the preferred tab surface of the owner
// (docs/spec/native-surfaces.md#view-surfaces, view calls). An empty surface or caller names none.
func (r *Registry) RunOwned(name string, params, cids json.RawMessage, owner, surface, caller string, answer func(result any, err error)) {
	owners := r.ownersOf("command", name)
	links := r.surfaces.links
	held := func(candidate string) bool {
		return slices.Contains(owners, candidate) && links.Plugin(candidate) == owner
	}
	chosen := ""
	switch {
	case surface != "" && !held(surface):
		answer(nil, Refuse(Unregistered, "surface %s has not registered command %s", surface, name))
		return
	case surface != "":
		chosen = surface
	case caller != "" && held(caller):
		chosen = caller
	default:
		choices := slices.DeleteFunc(slices.Clone(owners), func(candidate string) bool { return sectionSurface(candidate) || !held(candidate) })
		for _, candidate := range links.Preferred() {
			if slices.Contains(choices, candidate) {
				chosen = candidate
				break
			}
		}
		if chosen == "" && len(choices) > 0 {
			chosen = choices[len(choices)-1]
		}
		if chosen == "" {
			answer(nil, Refuse(Unregistered, "owner %s has not registered command %s", owner, name))
			return
		}
	}
	request, err := commandRequest(name, params, chosen, cids)
	if err != nil {
		answer(nil, err)
		return
	}
	r.Reply("command.run", request, nil, answer)
}
