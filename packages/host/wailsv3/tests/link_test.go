package host_test

import (
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// contract: links.open.accepts-web-and-mail-schemes
func TestLinkOpenAcceptsWebAndMailURLs(t *testing.T) {
	for _, value := range []string{"http://example.test/a", "https://example.test/a?b=c#d", "mailto:someone@example.test"} {
		if err := host.ValidateLink(value); err != nil {
			t.Fatalf("%s was rejected: %v", value, err)
		}
	}
}

// contract: links.open.rejects-other-schemes
func TestLinkOpenRejectsOtherURLs(t *testing.T) {
	for _, value := range []string{"file:///etc/hosts", "javascript:alert(1)", "ssh://host", "relative/path", "", "https://", "mailto:",
		"http://%zz", "https://example.test/" + strings.Repeat("a", 8192)} {
		if err := host.ValidateLink(value); err == nil {
			t.Fatalf("%q was accepted", value)
		}
	}
}
