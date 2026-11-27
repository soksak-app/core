package host

import "testing"

// The identifier of a notification in the notification center is the JSON list of the window name and the surface, which a click
// returns; its encoding error is returned to the caller instead of being discarded.
// contract: notifications.identifier.window-and-surface
func TestTheNotificationIdentifierIsTheWindowAndTheSurface(t *testing.T) {
	identifier, err := notificationIdentifier("main", `tab-"1`)
	if err != nil {
		t.Fatal(err)
	}
	if want := `["main","tab-\"1"]`; identifier != want {
		t.Fatalf("got %s, want %s", identifier, want)
	}
}
