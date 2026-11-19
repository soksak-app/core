package host

import (
	"strings"
	"testing"
)

// contract: sidecars.environment.sok-folder-first-on-path
func TestASidecarEnvironmentPutsTheSokFolderFirstOnPath(t *testing.T) {
	const sokFolder = "/fixture/soksak.app/Contents/MacOS"
	c, err := NewSidecars(nil, "")
	if err != nil {
		t.Fatalf("sidecars: %v", err)
	}
	c.sokFolder = sokFolder
	c.SetEnvironment(func() (map[string]string, error) {
		return map[string]string{"PATH": "/usr/bin:" + sokFolder + ":/opt/bin"}, nil
	})
	environment, err := c.environment()
	if err != nil {
		t.Fatalf("environment: %v", err)
	}
	var path string
	count := 0
	for _, entry := range environment {
		if strings.HasPrefix(entry, "PATH=") {
			path = strings.TrimPrefix(entry, "PATH=")
			count++
		}
	}
	const want = sokFolder + ":/usr/bin:/opt/bin"
	if count != 1 || path != want {
		t.Fatalf("sidecar PATH: %d entries, %q, want one entry %q", count, path, want)
	}
}
