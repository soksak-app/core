package host

// The sidecar routes of a window (docs/spec/native-surfaces.md#view-surfaces). The main page registers the receivers of the messages
// of each pair of a sidecar and a session id: whether the main page listens, and the views of surfaces at their view source generations.
// The host delivers a message only to those receivers, so a message to a view does not pass through the main page.

import (
	"encoding/json"
	"fmt"
	"slices"
	"sync"
)

type sidecarRouteKey struct {
	sidecar string
	id      string
}

// sidecarRouteView is a view that receives the messages of a pair: its surface and its view source generation.
type sidecarRouteView struct {
	surface    string
	generation uint64
}

type sidecarRoute struct {
	page  bool
	views []sidecarRouteView
}

// sidecarRoutes holds the routes of one window by sidecar and session id. Its zero value has no route.
type sidecarRoutes struct {
	mu     sync.Mutex
	routes map[sidecarRouteKey]*sidecarRoute
}

func (r *sidecarRoutes) change(sidecar, id string, apply func(*sidecarRoute)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.routes == nil {
		r.routes = map[sidecarRouteKey]*sidecarRoute{}
	}
	key := sidecarRouteKey{sidecar, id}
	route := r.routes[key]
	if route == nil {
		route = &sidecarRoute{}
		r.routes[key] = route
	}
	apply(route)
	if !route.page && len(route.views) == 0 {
		delete(r.routes, key)
	}
}

// listen sets whether the main page receives the messages of the pair. A repeated value changes nothing.
func (r *sidecarRoutes) listen(sidecar, id string, on bool) {
	r.change(sidecar, id, func(route *sidecarRoute) { route.page = on })
}

// routeView adds or removes the view of surface at generation as a receiver of the pair. A repeated call changes nothing.
func (r *sidecarRoutes) routeView(surface string, generation uint64, sidecar, id string, on bool) {
	view := sidecarRouteView{surface, generation}
	r.change(sidecar, id, func(route *sidecarRoute) {
		index := slices.Index(route.views, view)
		switch {
		case on && index < 0:
			route.views = append(route.views, view)
		case !on && index >= 0:
			route.views = slices.Delete(route.views, index, index+1)
		}
	})
}

// removeView removes the route of a view whose generation is no longer current.
func (r *sidecarRoutes) removeView(sidecar, id, surface string, generation uint64) {
	r.routeView(surface, generation, sidecar, id, false)
}

// targets returns whether the main page listens to the pair and the views that receive its messages.
func (r *sidecarRoutes) targets(sidecar, id string) (bool, []sidecarRouteView) {
	r.mu.Lock()
	defer r.mu.Unlock()
	route := r.routes[sidecarRouteKey{sidecar, id}]
	if route == nil {
		return false, nil
	}
	return route.page, slices.Clone(route.views)
}

// clear removes every route; a load of the main document does this, because the new document registers its own receivers.
func (r *sidecarRoutes) clear() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.routes = nil
}

// viewSidecarMessage returns the message that the host posts to a view for a sidecar message:
// {"sok":1,"event":"sidecar.message","data":{"id","body"}}, composed around the raw body that the sidecar sent, which is not parsed again.
func viewSidecarMessage(id string, body json.RawMessage) []byte {
	// default: a string always marshals.
	quoted, _ := json.Marshal(id)
	message := make([]byte, 0, len(body)+len(quoted)+64)
	message = append(message, `{"sok":1,"event":"sidecar.message","data":{"id":`...)
	message = append(message, quoted...)
	message = append(message, `,"body":`...)
	message = append(message, body...)
	return append(message, "}}"...)
}

// routeFields returns the members of a call; a value that is not an object has none, so the first field that the call requires is
// refused, as in the Tauri host.
func routeFields(raw json.RawMessage) map[string]json.RawMessage {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil
	}
	return fields
}

func routeText(call string, fields map[string]json.RawMessage, name string) (string, error) {
	var text string
	if err := json.Unmarshal(fields[name], &text); err != nil || text == "" {
		return "", fmt.Errorf("%s requires a non-empty %s", call, name)
	}
	return text, nil
}

func routeOn(call string, fields map[string]json.RawMessage) (bool, error) {
	var on bool
	if raw, ok := fields["on"]; !ok || json.Unmarshal(raw, &on) != nil {
		return false, fmt.Errorf("%s requires on as a boolean", call)
	}
	return on, nil
}

// sidecarListenRequest is the call sidecarListen {sidecar, id, on} of the main page.
type sidecarListenRequest struct {
	sidecar, id string
	on          bool
}

func sidecarListenRequestFrom(raw json.RawMessage) (sidecarListenRequest, error) {
	const call = "sidecarListen"
	fields := routeFields(raw)
	var req sidecarListenRequest
	var err error
	if req.sidecar, err = routeText(call, fields, "sidecar"); err != nil {
		return sidecarListenRequest{}, err
	}
	if req.id, err = routeText(call, fields, "id"); err != nil {
		return sidecarListenRequest{}, err
	}
	if req.on, err = routeOn(call, fields); err != nil {
		return sidecarListenRequest{}, err
	}
	return req, nil
}

// viewSidecarRouteRequest is the call viewSidecarRoute {surface, generation, sidecar, id, on} of the main page.
type viewSidecarRouteRequest struct {
	surface     string
	generation  uint64
	sidecar, id string
	on          bool
}

func viewSidecarRouteRequestFrom(raw json.RawMessage) (viewSidecarRouteRequest, error) {
	const call = "viewSidecarRoute"
	fields := routeFields(raw)
	var req viewSidecarRouteRequest
	var err error
	if req.surface, err = routeText(call, fields, "surface"); err != nil {
		return viewSidecarRouteRequest{}, err
	}
	if json.Unmarshal(fields["generation"], &req.generation) != nil || req.generation == 0 {
		return viewSidecarRouteRequest{}, fmt.Errorf("%s has no source generation", call)
	}
	if req.generation > maxSourceGeneration {
		return viewSidecarRouteRequest{}, fmt.Errorf("%s source generation exceeds the JavaScript safe integer limit", call)
	}
	if req.sidecar, err = routeText(call, fields, "sidecar"); err != nil {
		return viewSidecarRouteRequest{}, err
	}
	if req.id, err = routeText(call, fields, "id"); err != nil {
		return viewSidecarRouteRequest{}, err
	}
	if req.on, err = routeOn(call, fields); err != nil {
		return viewSidecarRouteRequest{}, err
	}
	return req, nil
}
