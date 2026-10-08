package host_test

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
)

// debugConfig is a configuration folder with an application log and a capture under logs/ and a file outside it.
func debugConfig(t *testing.T) string {
	t.Helper()
	config := t.TempDir()
	write := func(path, text string) {
		full := filepath.Join(config, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("logs/application.log", "started\n")
	write("logs/captures/still-1/window.png", "png")
	write("plugins/installed.json", "{}")
	return config
}

// contract: debug.files.lists-the-logs-folder
func TestDebugFilesListTheLogsFolder(t *testing.T) {
	files, err := host.DebugFiles(debugConfig(t))
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, file := range files {
		got = append(got, file.Path+" "+strings.Repeat("#", int(file.Size)))
		if file.Modified <= 0 {
			t.Fatalf("%s has no modification time", file.Path)
		}
	}
	if want := "logs/application.log ######## logs/captures/still-1/window.png ###"; strings.Join(got, " ") != want {
		t.Fatalf("files %q, want %q", strings.Join(got, " "), want)
	}
}

// contract: debug.save.copies-a-file-of-the-logs-folder-only
func TestDebugCopyCopiesAFileOfTheLogsFolderOnly(t *testing.T) {
	config := debugConfig(t)
	destination := filepath.Join(t.TempDir(), "application.log")
	if err := host.DebugCopy(config, "logs/application.log", destination); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(destination); string(data) != "started\n" {
		t.Fatalf("copied %q", data)
	}
	for path, want := range map[string]string{
		"plugins/installed.json": "debug: plugins/installed.json is not a file under logs/",
		"logs/../plugins/installed.json": "debug: logs/../plugins/installed.json is not a file under logs/",
		"logs/missing.log": "debug: logs/missing.log is not a file under logs/",
		"logs/captures": "debug: logs/captures is not a file under logs/",
	} {
		if err := host.DebugCopy(config, path, filepath.Join(t.TempDir(), "copy")); err == nil || err.Error() != want {
			t.Fatalf("copy %s: %v, want %q", path, err, want)
		}
	}
}

// contract: debug.save-all.writes-the-logs-folder-as-tar
func TestDebugWriteLogsTarWritesTheLogsFolder(t *testing.T) {
	config := debugConfig(t)
	destination := filepath.Join(t.TempDir(), "debug.tar.gz")
	if err := host.DebugWriteLogsTar(config, destination); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(destination)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	reader := tar.NewReader(compressed)
	var names []string
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		data, _ := io.ReadAll(reader)
		names = append(names, header.Name+"="+string(data))
	}
	if want := "logs/application.log=started\n logs/captures/still-1/window.png=png"; strings.Join(names, " ") != want {
		t.Fatalf("entries %q, want %q", strings.Join(names, " "), want)
	}
}

// contract: debug.record.writes-the-state-file
func TestDebugWriteStateWritesTheStateFile(t *testing.T) {
	config := debugConfig(t)
	at := time.Date(2026, 10, 9, 1, 2, 3, 0, time.UTC)
	path, err := host.DebugWriteState(config, at, map[string]any{"host": "wailsv3"})
	if err != nil {
		t.Fatal(err)
	}
	if path != "logs/state-20261009T010203Z.json" {
		t.Fatalf("path %q", path)
	}
	data, err := os.ReadFile(filepath.Join(config, path))
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(data, &state); err != nil || state["host"] != "wailsv3" || state["time"] != "20261009T010203Z" {
		t.Fatalf("state %s: %v", data, err)
	}
}
