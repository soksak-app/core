package host_test

import (
	"strings"
	"testing"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

func TestAuthorizeSurfaceCallerIdentities(t *testing.T) {
	if err := host.AuthorizeSurfaceCaller("", "tab-1", 42, 42); err != nil {
		t.Fatalf("known main caller rejected: %v", err)
	}
	if err := host.AuthorizeSurfaceCaller("", "tab-1", 41, 42); err == nil {
		t.Fatal("unknown caller accepted as main")
	}
	if err := host.AuthorizeSurfaceCaller("tab-2", "tab-1", 7, 42); err == nil {
		t.Fatal("cross-surface caller accepted")
	}
	if err := host.AuthorizeSurfaceCaller("tab-1", "tab-1", 7, 42); err != nil {
		t.Fatalf("own surface caller rejected: %v", err)
	}
}

func TestDocumentCheckStillRejectsUnknownCaller(t *testing.T) {
	_, err := host.CheckDocument("", host.DocumentRequest{Surface: "tab-1", Document: "page"})
	if err == nil || !strings.Contains(err.Error(), "not surface") {
		t.Fatalf("unknown caller accepted: %v", err)
	}
}
