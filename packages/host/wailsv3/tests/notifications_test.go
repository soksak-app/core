package host_test

import (
	"slices"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
)

// contract: notifications.event.records-each-event-and-failure
func TestEachNotificationEventAndFailureIsRecorded(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	h := &host.Host{}
	for _, raw := range []string{
		`{"type":"state","authorization":"granted","error":null}`,
		`{"type":"state","authorization":"denied","error":"post refused"}`,
		`{"type":"posted","identifier":"[\"w1\",\"tab-1\"]"}`,
		`{"type":"activated","identifier":"nope"}`,
		`not json`,
		`{"type":"other"}`,
	} {
		host.HandleNotificationEvent(h, raw)
	}
	if err := log.Flush(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	var seen, failures []string
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		fields, _ := event["fields"].(map[string]any)
		switch event["event"] {
		case "host.notification.event":
			seen = append(seen, strings.Join([]string{fields["type"].(string), fields["authorization"].(string), fields["window"].(string), fields["surface"].(string)}, "|"))
		case "host.record.error":
			if fields["where"] == "notification" {
				failures = append(failures, fields["text"].(string))
			}
		}
	}
	if want := []string{"state|granted||", "state|denied||", "posted||w1|tab-1"}; !slices.Equal(seen, want) {
		t.Fatalf("host.notification.event events = %q, want %q", seen, want)
	}
	wants := []string{`post refused`, `the window "w1" of a posted notification is closed`, `activated notification "nope" has no window and surface`, `notification event "not json"`, `has an unknown type`}
	if len(failures) != len(wants) {
		t.Fatalf("notification failures = %q, want %d", failures, len(wants))
	}
	for index, want := range wants {
		if !strings.Contains(failures[index], want) {
			t.Fatalf("notification failure %d = %q, want it to contain %q", index, failures[index], want)
		}
	}
}

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
