package host_test

import (
	"archive/tar"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

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
		"plugins/installed.json":         "debug: plugins/installed.json is not a file under logs/",
		"logs/../plugins/installed.json": "debug: logs/../plugins/installed.json is not a file under logs/",
		"logs/missing.log":               "debug: logs/missing.log is not a file under logs/",
		"logs/captures":                  "debug: logs/captures is not a file under logs/",
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

// contract: debug.read.returns-the-end-of-a-text-file
func TestDebugReadReturnsTheEndOfATextFile(t *testing.T) {
	config := debugConfig(t)
	read, err := host.DebugRead(config, "logs/application.log")
	if err != nil {
		t.Fatal(err)
	}
	if read.Path != "logs/application.log" || read.Kind != "text" || read.Size != 8 || read.Truncated || read.Text != "started\n" {
		t.Fatalf("read %+v", read)
	}
	// 100000 characters of three bytes: the last 262144 bytes start inside a character.
	big := strings.Repeat("끝", 100000)
	if err := os.WriteFile(filepath.Join(config, "logs", "big.log"), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	read, err = host.DebugRead(config, "logs/big.log")
	if err != nil {
		t.Fatal(err)
	}
	if !read.Truncated || read.Size != int64(len(big)) || !strings.HasSuffix(read.Text, "끝") || len(read.Text) > 262144 || len(read.Text) < 262142 {
		t.Fatalf("truncated read has size %d, truncated %v, length %d", read.Size, read.Truncated, len(read.Text))
	}
	// The cut starts after the character that it divides.
	if !utf8.ValidString(read.Text) {
		t.Fatal("the cut text is not valid UTF-8")
	}
}

// contract: debug.read.refuses-a-path-outside-logs-and-a-file-that-is-not-text
func TestDebugReadRefusesAPathOutsideLogsAndAFileThatIsNotText(t *testing.T) {
	config := debugConfig(t)
	if err := os.WriteFile(filepath.Join(config, "logs", "binary.bin"), []byte{0xff, 0xfe, 0x00, 0x01}, 0o644); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{
		"plugins/installed.json":         "debug: plugins/installed.json is not a file under logs/",
		"logs/../plugins/installed.json": "debug: logs/../plugins/installed.json is not a file under logs/",
		"logs/missing.log":               "debug: logs/missing.log is not a file under logs/",
		"logs/binary.bin":                "debug: logs/binary.bin is not text",
	} {
		if _, err := host.DebugRead(config, path); err == nil || err.Error() != want {
			t.Fatalf("read %s: %v, want %q", path, err, want)
		}
	}
}

// contract: debug.read.returns-a-png-file-as-an-image
func TestDebugReadReturnsAPNGFileAsAnImage(t *testing.T) {
	config := debugConfig(t)
	png := append([]byte("\x89PNG\r\n\x1a\n"), []byte("data")...)
	if err := os.WriteFile(filepath.Join(config, "logs", "captures", "still-1", "window.png"), png, 0o644); err != nil {
		t.Fatal(err)
	}
	read, err := host.DebugRead(config, "logs/captures/still-1/window.png")
	if err != nil {
		t.Fatal(err)
	}
	want := "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	if read.Kind != "image" || read.Image != want || read.Size != int64(len(png)) || read.Truncated || read.Text != "" {
		t.Fatalf("read %+v", read)
	}
	// The fixture file of debugConfig is named .png and does not start with the signature.
	if _, err := host.DebugRead(config, "logs/captures/still-1/window.png"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(config, "logs", "captures", "still-1", "fake.png"), []byte("not a png"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := host.DebugRead(config, "logs/captures/still-1/fake.png"); err == nil || err.Error() != "debug: logs/captures/still-1/fake.png is not a PNG file" {
		t.Fatalf("fake png: %v", err)
	}
	large := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 16*1024*1024)...)
	if err := os.WriteFile(filepath.Join(config, "logs", "captures", "still-1", "large.png"), large, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := host.DebugRead(config, "logs/captures/still-1/large.png"); err == nil || err.Error() != "debug: logs/captures/still-1/large.png is larger than 16 MB" {
		t.Fatalf("large png: %v", err)
	}
}

// contract: debug.record.keeps-the-newest-20-state-files
func TestDebugWriteStateKeepsTheNewest20StateFiles(t *testing.T) {
	config := debugConfig(t)
	// 22 earlier state files, one for each minute of the hour 00 of 2026-10-09, and a file that is not a state file.
	for minute := 0; minute < 22; minute++ {
		name := fmt.Sprintf("state-20261009T00%02d00Z.json", minute)
		if err := os.WriteFile(filepath.Join(config, "logs", name), []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	at := time.Date(2026, 10, 9, 1, 0, 0, 0, time.UTC)
	if _, err := host.DebugWriteState(config, at, map[string]any{"host": "wailsv3"}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Join(config, "logs"))
	if err != nil {
		t.Fatal(err)
	}
	var states []string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "state-") {
			states = append(states, entry.Name())
		}
	}
	if len(states) != 20 || states[0] != "state-20261009T000300Z.json" || states[19] != "state-20261009T010000Z.json" {
		t.Fatalf("state files %v", states)
	}
	if _, err := os.Stat(filepath.Join(config, "logs", "application.log")); err != nil {
		t.Fatalf("the application log was removed: %v", err)
	}
}

// contract: debug.save-text.writes-the-text-to-the-destination
func TestDebugWriteTextWritesTheTextOfTheRequest(t *testing.T) {
	destination := filepath.Join(t.TempDir(), "rows.txt")
	request := host.DebugTextRequest{Name: "rows.txt", Text: "first\nsecond 한글\n"}
	if err := host.DebugWriteText(destination, request); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(destination); string(data) != request.Text {
		t.Fatalf("wrote %q, want %q", data, request.Text)
	}
}

// contract: debug.save-text.refuses-a-name-that-is-not-a-file-name-and-text-that-is-empty-or-too-large
func TestDebugTextRequestRefusesWhatIsNotAFileNameAndTextOfNoUse(t *testing.T) {
	for request, want := range map[host.DebugTextRequest]string{
		{Name: "", Text: "x"}:                                   `debug: name "" is not a file name`,
		{Name: "../rows.txt", Text: "x"}:                        `debug: name "../rows.txt" is not a file name`,
		{Name: "logs/rows.txt", Text: "x"}:                      `debug: name "logs/rows.txt" is not a file name`,
		{Name: "..", Text: "x"}:                                 `debug: name ".." is not a file name`,
		{Name: "rows.txt", Text: ""}:                            "debug: text is empty",
		{Name: "rows.txt", Text: strings.Repeat("x", 16<<20+1)}: "debug: text is 16777217 bytes, over the limit of 16777216",
	} {
		if err := request.Validate(); err == nil || err.Error() != want {
			t.Fatalf("validate %q (%d bytes): %v, want %q", request.Name, len(request.Text), err, want)
		}
	}
	if err := (host.DebugTextRequest{Name: "rows.txt", Text: "x"}).Validate(); err != nil {
		t.Fatal(err)
	}
}

// contract: debug.read-range.returns-whole-lines-from-an-offset
func TestDebugReadRangeReturnsTheWholeLinesFromAnOffset(t *testing.T) {
	config := t.TempDir()
	logs := filepath.Join(config, "logs")
	if err := os.MkdirAll(logs, 0o700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(logs, "host-1-2.jsonl")
	if err := os.WriteFile(file, []byte("first\n한글 둘째\nthird no end"), 0o600); err != nil {
		t.Fatal(err)
	}
	read := func(offset int64) host.DebugRangeResult {
		t.Helper()
		result, err := host.DebugReadRange(config, "logs/host-1-2.jsonl", offset)
		if err != nil {
			t.Fatalf("offset %d: %v", offset, err)
		}
		return result
	}
	first := read(0)
	if first.Text != "first\n한글 둘째\n" || first.Next != int64(len("first\n한글 둘째\n")) || first.Size != int64(len("first\n한글 둘째\nthird no end")) {
		t.Fatalf("first read = %+v", first)
	}
	// The line that is not written to its end waits until its end is written.
	waiting := read(first.Next)
	if waiting.Text != "" || waiting.Next != first.Next {
		t.Fatalf("waiting read = %+v", waiting)
	}
	appended, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := appended.WriteString("\nfourth\n"); err != nil {
		t.Fatal(err)
	}
	appended.Close()
	rest := read(first.Next)
	if rest.Text != "third no end\nfourth\n" || rest.Next != rest.Size {
		t.Fatalf("rest read = %+v", rest)
	}
	for offset, want := range map[int64]string{
		-1:            "debug: offset -1 is not in logs/host-1-2.jsonl (0 to 40)",
		rest.Size + 1: "debug: offset 41 is not in logs/host-1-2.jsonl (0 to 40)",
		int64(7):      "debug: offset 7 is not at the start of a character of logs/host-1-2.jsonl",
	} {
		if _, err := host.DebugReadRange(config, "logs/host-1-2.jsonl", offset); err == nil || err.Error() != want {
			t.Fatalf("offset %d: %v, want %q", offset, err, want)
		}
	}
	if _, err := host.DebugReadRange(config, "plugins/installed.json", 0); err == nil {
		t.Fatal("a path outside logs/ was read")
	}
}
