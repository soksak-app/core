package host

import (
	"testing"
)

// host.window carries the cursor that the application set for the virtual key window, and null when the window is not the
// virtual key window, no cursor was set for it or the platform does not report it.
// contract: window.facts.cursor
func TestWindowReportsTheCursorOfTheVirtualKeyWindow(t *testing.T) {
	for _, c := range []struct{ cursor, want string }{
		{cursor: `"pointingHand"`, want: `"pointingHand"`},
		{cursor: `null`, want: `null`},
		{want: `null`},
	} {
		member := ""
		if c.cursor != "" {
			member = `"cursor":` + c.cursor + `,`
		}
		status, err := windowStatusMembers(t, windowFactsText(member), false)
		if err != nil {
			t.Fatal(err)
		}
		if got := string(status["cursor"]); got != c.want {
			t.Fatalf("host.window cursor for the facts %q is %s, want %s", c.cursor, got, c.want)
		}
	}
	if _, err := windowStatusMembers(t, windowFactsText(`"cursor":3,`), false); err == nil {
		t.Fatal("host.window accepted the cursor 3")
	}
	if _, declared := hostStatus["host.window"].Schema["properties"].(map[string]any)["cursor"]; !declared {
		t.Fatal("host.window does not declare cursor")
	}
}
