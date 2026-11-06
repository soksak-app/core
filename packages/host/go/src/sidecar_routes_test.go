package host

import (
	"encoding/json"
	"reflect"
	"testing"
)

// contract: sidecar.route.calls
func TestARouteCallOutsideItsFormIsRefusedWithTheFieldItLacks(t *testing.T) {
	listen := func(text string) string {
		if _, err := sidecarListenRequestFrom(json.RawMessage(text)); err != nil {
			return err.Error()
		}
		return ""
	}
	cases := map[string]string{
		`{"sidecar":"probe","id":"tab-a","on":true}`: "",
		`{"sidecar":"","id":"tab-a","on":true}`:      "sidecarListen requires a non-empty sidecar",
		`{"sidecar":"probe","on":true}`:              "argument request.id is missing",
		`{"sidecar":"probe","id":"tab-a","on":1}`:    "argument request.on must be a boolean, not a number",
		`true`: "argument request must be an object, not a boolean",
	}
	for text, want := range cases {
		if got := listen(text); got != want {
			t.Errorf("sidecarListen %s: got %q, want %q", text, got, want)
		}
	}
	route := func(text string) string {
		if _, err := viewSidecarRouteRequestFrom(json.RawMessage(text)); err != nil {
			return err.Error()
		}
		return ""
	}
	routeCases := map[string]string{
		`{"surface":"tab-a","generation":3,"sidecar":"probe","id":"tab-a","on":false}`:               "",
		`{"surface":"","generation":3,"sidecar":"probe","id":"tab-a","on":true}`:                     "viewSidecarRoute requires a non-empty surface",
		`{"surface":"tab-a","generation":0,"sidecar":"probe","id":"tab-a","on":true}`:                "viewSidecarRoute has no source generation",
		`{"surface":"tab-a","generation":9007199254740992,"sidecar":"probe","id":"tab-a","on":true}`: "viewSidecarRoute source generation exceeds the JavaScript safe integer limit",
		`{"surface":"tab-a","generation":3,"sidecar":"probe","id":"","on":true}`:                     "viewSidecarRoute requires a non-empty id",
		`{"surface":"tab-a","generation":3,"sidecar":"probe","id":"tab-a"}`:                          "argument request.on is missing",
	}
	for text, want := range routeCases {
		if got := route(text); got != want {
			t.Errorf("viewSidecarRoute %s: got %q, want %q", text, got, want)
		}
	}
}

// contract: sidecar.route.delivery
func TestAMessageReachesThePageOnlyWhileItListensAndEachRoutedView(t *testing.T) {
	var routes sidecarRoutes
	if page, views := routes.targets("probe", "tab-a"); page || len(views) != 0 {
		t.Fatalf("a pair without a route has no receiver, got page %v views %v", page, views)
	}
	routes.listen("probe", "tab-a", true)
	routes.listen("probe", "tab-a", true)
	routes.routeView("tab-a", 4, "probe", "tab-a", true)
	routes.routeView("tab-a", 4, "probe", "tab-a", true)
	routes.routeView("tab-b", 2, "probe", "tab-a", true)
	page, views := routes.targets("probe", "tab-a")
	if !page {
		t.Fatal("the page listens")
	}
	if want := []sidecarRouteView{{"tab-a", 4}, {"tab-b", 2}}; !reflect.DeepEqual(views, want) {
		t.Fatalf("a repeated call changes nothing: got %v, want %v", views, want)
	}
	if page, _ := routes.targets("other", "tab-a"); page {
		t.Fatal("a route belongs to its sidecar")
	}
	routes.listen("probe", "tab-a", false)
	routes.routeView("tab-b", 2, "probe", "tab-a", false)
	page, views = routes.targets("probe", "tab-a")
	if page || !reflect.DeepEqual(views, []sidecarRouteView{{"tab-a", 4}}) {
		t.Fatalf("the page stopped listening and one view remains: got page %v views %v", page, views)
	}
	routes.removeView("probe", "tab-a", "tab-a", 4)
	if _, views := routes.targets("probe", "tab-a"); len(views) != 0 {
		t.Fatalf("a route of an ended generation is removed, got %v", views)
	}
	routes.listen("probe", "tab-a", true)
	routes.routeView("tab-a", 5, "probe", "tab-a", true)
	routes.clear()
	if page, views := routes.targets("probe", "tab-a"); page || len(views) != 0 {
		t.Fatalf("a load of the main document removes every route, got page %v views %v", page, views)
	}
}

// contract: sidecar.route.delivery
func TestTheViewMessageWrapsTheRawBodyWithoutParsingItAgain(t *testing.T) {
	text := viewSidecarMessage(`tab-"a`, nil, json.RawMessage(`{"event":"screen","rows":2}`))
	if want := `{"sok":1,"event":"sidecar.message","data":{"id":"tab-\"a","body":{"event":"screen","rows":2}}}`; string(text) != want {
		t.Fatalf("got %s, want %s", text, want)
	}
}

// contract: sidecars.protocol.reply-cids-reach-the-owner
func TestTheViewMessageNamesTheIdentifiersOfTheRequestsThatItAnswers(t *testing.T) {
	text := viewSidecarMessage("tab-1", []string{"b1.7", "view-a.1"}, json.RawMessage(`{"ack":true}`))
	if want := `{"sok":1,"event":"sidecar.message","data":{"id":"tab-1","cids":["b1.7","view-a.1"],"body":{"ack":true}}}`; string(text) != want {
		t.Fatalf("got %s, want %s", text, want)
	}
}
