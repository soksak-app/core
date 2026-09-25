package host_test

import (
	"strings"
	"testing"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

// contract: notifications.request.accepts-tab-notices
func TestNotificationAcceptsTabNotices(t *testing.T) {
	request := host.NotificationRequest{Surface: "tab-1", Title: strings.Repeat("t", 256), Body: strings.Repeat("한", 1024)}
	if err := host.ValidateNotification(request, false); err != nil {
		t.Fatalf("a tab notice was rejected: %v", err)
	}
	if err := host.ValidateNotification(host.NotificationRequest{Surface: "tab-1"}, true); err != nil {
		t.Fatalf("a removal with only the surface was rejected: %v", err)
	}
}

// contract: notifications.request.rejects-invalid-fields
func TestNotificationRejectsInvalidFields(t *testing.T) {
	cases := map[string]host.NotificationRequest{
		"surface": {Surface: "", Title: "title", Body: "body"},
		"title":   {Surface: "tab-1", Title: strings.Repeat("t", 257), Body: "body"},
		"body":    {Surface: "tab-1", Title: "title", Body: "a\nb"},
	}
	for field, request := range cases {
		err := host.ValidateNotification(request, false)
		if err == nil || !strings.Contains(err.Error(), field) {
			t.Fatalf("an invalid %s was not rejected by name: %v", field, err)
		}
	}
	if err := host.ValidateNotification(host.NotificationRequest{Surface: strings.Repeat("s", 257)}, true); err == nil || !strings.Contains(err.Error(), "surface") {
		t.Fatalf("a removal with a too long surface was not rejected: %v", err)
	}
	if err := host.ValidateNotification(host.NotificationRequest{Surface: "tab-1", Title: "title", Body: strings.Repeat("b", 1025)}, false); err == nil {
		t.Fatal("a body over 1024 characters was accepted")
	}
}
