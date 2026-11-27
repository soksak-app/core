package host_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/tests/support"
	sok "github.com/soksak-app/core/packages/sok/go/src"
)

// cloneSource makes a repository with one commit and returns its file address.
func cloneSource(t *testing.T) string {
	t.Helper()
	source := filepath.Join(t.TempDir(), "source")
	if err := os.Mkdir(source, 0755); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"init", "-q"},
		{"commit", "-q", "--allow-empty", "-m", "first"},
	} {
		cmd := exec.Command("git", append([]string{"-C", source}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	return "file://" + source
}

// contract: logging.clone-events
func TestProjectCloneRecordsItsStartLinesAndEndAsEvents(t *testing.T) {
	config := t.TempDir()
	log := support.StartWriter(t, config)
	address := cloneSource(t)
	target := filepath.Join(t.TempDir(), "widget")
	request, err := json.Marshal(map[string]string{"address": address, "target": target})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&host.Host{}).ProjectClone(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	var names []string
	lines := 0
	var end map[string]any
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		name, _ := event["event"].(string)
		if !strings.HasPrefix(name, "host.clone.") {
			continue
		}
		names = append(names, name)
		fields, _ := event["fields"].(map[string]any)
		if strings.Contains(fmt.Sprint(fields), address) {
			t.Fatalf("%s stores the address: %v", name, fields)
		}
		switch name {
		case "host.clone.line":
			lines++
		case "host.clone.end":
			end = fields
		}
	}
	if len(names) < 3 || names[0] != "host.clone.start" || names[len(names)-1] != "host.clone.end" || lines == 0 {
		t.Fatalf("clone events = %v with %d line events, want host.clone.start, the line events and host.clone.end", names, lines)
	}
	if end["status"] != float64(0) || end["target"] != target {
		t.Fatalf("host.clone.end fields = %v, want status 0 and target %s", end, target)
	}
}

// contract: logging.clone-events-default-policy
func TestProjectCloneEventsPassTheDefaultPolicyOfADiagnosticBuild(t *testing.T) {
	config := t.TempDir()
	// The writer keeps its default policy, which stores only errors, so the clone events pass only as named exceptions.
	log, err := host.StartHostEventLog(config)
	if err != nil {
		t.Fatal(err)
	}
	host.UseHostEventLog(log)
	t.Cleanup(func() { host.UseHostEventLog(nil); log.Close() })
	request, err := json.Marshal(map[string]string{"address": cloneSource(t), "target": filepath.Join(t.TempDir(), "widget")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (&host.Host{}).ProjectClone(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, event := range support.ReadEvents(t, support.EventLogPath(t, config)) {
		name, _ := event["event"].(string)
		seen[name] = true
	}
	for _, name := range []string{"host.clone.start", "host.clone.line", "host.clone.end"} {
		// The class table of the host declares each clone event as lifecycle, the class that the catalog declares for it.
		if class, declared := sok.EventClassOf(name); !declared || class != sok.ClassLifecycle {
			t.Errorf("EventClassOf(%s) = %v, %v, want lifecycle", name, class, declared)
		}
		if !seen[name] {
			t.Errorf("the default policy stored no %s event", name)
		}
	}
}
