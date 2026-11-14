package host

import (
	"testing"
)

// host.window carries the WebContent processes without a page that the native facts report, with whether WebKit ends each, and
// null when the facts of the platform do not report them.
// contract: window.facts.pageless-processes
func TestWindowReportsTheProcessesWithoutAPage(t *testing.T) {
	for _, c := range []struct {
		name     string
		pageless string
		want     string
	}{
		{name: "processes without a page", pageless: `[{"pid":4101,"ending":true},{"pid":4102,"ending":false}]`,
			want: `[{"pid":4101,"ending":true},{"pid":4102,"ending":false}]`},
		{name: "none", pageless: `[]`, want: `[]`},
		{name: "a platform that does not report them", want: `null`},
	} {
		t.Run(c.name, func(t *testing.T) {
			member := ""
			if c.pageless != "" {
				member = `"pagelessProcesses":` + c.pageless + `,`
			}
			status, err := windowStatusMembers(t, windowFactsText(member), false)
			if err != nil {
				t.Fatal(err)
			}
			if got := string(status["pagelessProcesses"]); got != c.want {
				t.Fatalf("host.window pagelessProcesses is %s, want %s", got, c.want)
			}
		})
	}
	for _, invalid := range []string{`{}`, `[{"pid":0,"ending":true}]`, `[{"pid":4101}]`, `[{"pid":"4101","ending":true}]`} {
		if _, err := windowStatusMembers(t, windowFactsText(`"pagelessProcesses":`+invalid+`,`), false); err == nil {
			t.Fatalf("host.window accepted the pageless processes %s", invalid)
		}
	}
	if _, declared := hostStatus["host.window"].Schema["properties"].(map[string]any)["pagelessProcesses"]; !declared {
		t.Fatal("host.window does not declare pagelessProcesses")
	}
}
