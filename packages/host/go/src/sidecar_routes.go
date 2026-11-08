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
func viewSidecarMessage(id string, cids []string, body json.RawMessage) []byte {
	// default: a string always marshals.
	quoted, _ := json.Marshal(id)
	message := make([]byte, 0, len(body)+len(quoted)+64)
	message = append(message, `{"sok":1,"event":"sidecar.message","data":{"id":`...)
	message = append(message, quoted...)
	if len(cids) > 0 {
		// default: a list of strings always marshals.
		listed, _ := json.Marshal(cids)
		message = append(message, `,"cids":`...)
		message = append(message, listed...)
	}
	message = append(message, `,"body":`...)
	message = append(message, body...)
	return append(message, "}}"...)
}

func nonEmpty(call, field, text string) error {
	if text == "" {
		return fmt.Errorf("%s requires a non-empty %s", call, field)
	}
	return nil
}

// SidecarListenRequest is the call sidecarListen {sidecar, id, on} of the main page; the argument decoder checks its form.
type SidecarListenRequest struct {
	Sidecar string `json:"sidecar"`
	ID      string `json:"id"`
	On      bool   `json:"on"`
}

func sidecarListenRequestFrom(raw json.RawMessage) (SidecarListenRequest, error) {
	const call = "sidecarListen"
	req, err := argument[SidecarListenRequest]("request", raw)
	if err != nil {
		return SidecarListenRequest{}, err
	}
	for _, field := range []struct{ name, text string }{{"sidecar", req.Sidecar}, {"id", req.ID}} {
		if err := nonEmpty(call, field.name, field.text); err != nil {
			return SidecarListenRequest{}, err
		}
	}
	return req, nil
}

// ViewSidecarRouteRequest is the call viewSidecarRoute {surface, generation, sidecar, id, on} of the main page; the argument decoder
// checks its form.
type ViewSidecarRouteRequest struct {
	Surface    string `json:"surface"`
	Generation uint64 `json:"generation"`
	Sidecar    string `json:"sidecar"`
	ID         string `json:"id"`
	On         bool   `json:"on"`
}

func viewSidecarRouteRequestFrom(raw json.RawMessage) (ViewSidecarRouteRequest, error) {
	const call = "viewSidecarRoute"
	req, err := argument[ViewSidecarRouteRequest]("request", raw)
	if err != nil {
		return ViewSidecarRouteRequest{}, err
	}
	if err := nonEmpty(call, "surface", req.Surface); err != nil {
		return ViewSidecarRouteRequest{}, err
	}
	if req.Generation == 0 {
		return ViewSidecarRouteRequest{}, fmt.Errorf("%s has no source generation", call)
	}
	if req.Generation > maxSourceGeneration {
		return ViewSidecarRouteRequest{}, fmt.Errorf("%s source generation exceeds the JavaScript safe integer limit", call)
	}
	for _, field := range []struct{ name, text string }{{"sidecar", req.Sidecar}, {"id", req.ID}} {
		if err := nonEmpty(call, field.name, field.text); err != nil {
			return ViewSidecarRouteRequest{}, err
		}
	}
	return req, nil
}

// ViewSidecarSendRequest is the private source-bound view-host wire.
type ViewSidecarSendRequest struct {
	Source     string          `json:"source"`
	Generation uint64          `json:"generation"`
	Sidecar    string          `json:"sidecar"`
	Surface    string          `json:"surface"`
	Body       json.RawMessage `json:"body,nullvalue"`
	Cids       []string        `json:"cids,omitempty"`
}

func viewSidecarSendRequestFrom(raw json.RawMessage) (ViewSidecarSendRequest, error) {
	const call = "viewSidecarSend"
	req, err := argument[ViewSidecarSendRequest]("request", raw)
	if err != nil {
		return ViewSidecarSendRequest{}, err
	}
	for _, field := range []struct{ name, text string }{{"source", req.Source}, {"surface", req.Surface}, {"sidecar", req.Sidecar}} {
		if err := nonEmpty(call, field.name, field.text); err != nil {
			return ViewSidecarSendRequest{}, err
		}
	}
	if req.Generation == 0 {
		return ViewSidecarSendRequest{}, fmt.Errorf("%s has no source generation", call)
	}
	if req.Generation > maxSourceGeneration {
		return ViewSidecarSendRequest{}, fmt.Errorf("%s source generation exceeds the JavaScript safe integer limit", call)
	}
	if req.Source != req.Surface {
		return ViewSidecarSendRequest{}, fmt.Errorf("surface %s cannot send to sidecar surface %s", req.Source, req.Surface)
	}
	return req, nil
}
