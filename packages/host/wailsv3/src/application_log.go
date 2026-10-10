package host

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// logRotateBytes is the size at which the log file moves to the previous generation, and logGenerations is the number of previous generations kept
// (docs/spec/diagnostics.md#files). More records are better, so the size is large enough to cover one session.
const (
	logRotateBytes = 100 * 1024 * 1024
	logGenerations = 5
)

// rotateGenerations moves path to the previous generation path.1, shifts each previous generation back by one, and deletes the last generation.
func rotateGenerations(path string) error {
	last := fmt.Sprintf("%s.%d", path, logGenerations)
	if err := os.Remove(last); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove %s: %w", last, err)
	}
	for generation := logGenerations - 1; generation >= 1; generation-- {
		from := fmt.Sprintf("%s.%d", path, generation)
		if err := os.Rename(from, fmt.Sprintf("%s.%d", path, generation+1)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("rotate %s: %w", from, err)
		}
	}
	if err := os.Rename(path, path+".1"); err != nil {
		return fmt.Errorf("rotate %s: %w", path, err)
	}
	return nil
}

// Entry is one text record without a time: level (error or info), layer (page, host, native, sidecar), where (the name of the operation or
// target), and text (the content). One record is one line (docs/spec/diagnostics.md#forms).
type Entry struct {
	Level, Layer, Where string
	Text                any
}

// Line is the record without its time, `<level> <layer> <where>: <text>`. A line break in text is written as the two characters `\n`.
func (e Entry) Line() string {
	return fmt.Sprintf("%s %s %s: %s", e.Level, e.Layer, e.Where, strings.ReplaceAll(fmt.Sprint(e.Text), "\n", `\n`))
}

// TranscriptEntry is the record that the application log also receives for the diagnostic transcript line line of the window window. The diagnostic transcript
// goes only to the connection that enabled it, so without this record the line is lost when no connection exists.
func TranscriptEntry(window, line string) Entry {
	return Entry{"info", "host", "transcript " + window, line}
}

// TranscriptFailure is the error record that the application log receives for the error err that the diagnostic transcript of the window window carries. where is
// the failed operation.
func TranscriptFailure(window, where string, err error) Entry {
	return Entry{"error", "host", where + " " + window, err}
}

// Log stores a record as an event of the writer of the host (event_record.go).
func Log(e Entry) {
	emitRecord(e)
}

// ErrorLine is the line of an error record of the host without its time. where is the failed operation or target and text is the failure content.
func ErrorLine(where string, text any) string {
	return Entry{"error", "host", where, text}.Line()
}

// LogError writes one error record of the host.
func LogError(where string, text any) {
	Log(Entry{"error", "host", where, text})
}

// LogInfo writes one observation record of the host. An observation records an expected state and is not a failure.
func LogInfo(where string, text any) {
	Log(Entry{"info", "host", where, text})
}

// fatalError writes an error record and ends the process with status 1. A fatal failure after the log is open uses it.
func fatalError(where string, text any) {
	LogError(where, text)
	if err := FlushRecords(2 * time.Second); err != nil {
		fmt.Fprintf(os.Stderr, "event writer: the record of the failure is not stored: %v\n", err)
	}
	os.Exit(1)
}

// ServiceLogPath is the log path that receives the standard error of the persistent service program.
func ServiceLogPath(config, program string) string {
	return filepath.Join(config, "logs", filepath.Base(program)+".log")
}

// OpenLog opens the log file path for appending with mode 0600. A file of 10 MB or more is first
// moved to path.1, which replaces the previous generation. Call it only when no other process writes to that file.
func OpenLog(path string) (*os.File, error) {
	system, err := platform.Current()
	if err != nil {
		return nil, err
	}
	if err := system.CreatePrivateDirectories(filepath.Dir(path)); err != nil {
		return nil, fmt.Errorf("create logs directory: %w", err)
	}
	if info, err := os.Stat(path); err == nil && info.Size() >= logRotateBytes {
		if err := rotateGenerations(path); err != nil {
			return nil, err
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("inspect %s: %w", path, err)
	}
	file, err := system.AppendPrivateFile(path)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	return file, nil
}

// StartStandardError opens the stderr file of this run, `logs/host-<boot>.stderr`, makes it the standard error of the process
// and of its children, and stores the run record (docs/spec/logging.md#files). The file holds only what no writer
// of the contract writes: the crash output of the runtime and the fatal lines of the native library. Call it once, after the
// process lock of the configuration directory is held.
func StartStandardError(config, identifier string) error {
	system, err := platform.Current()
	if err != nil {
		return err
	}
	file, err := OpenLog(StandardErrorPath(config))
	if err != nil {
		return fmt.Errorf("standard error file: %w", err)
	}
	// The standard error holds a duplicate of the descriptor, so the opened file is closed.
	replaceErr := system.ReplaceStandardError(file)
	closeErr := file.Close()
	if err := errors.Join(replaceErr, closeErr); err != nil {
		return fmt.Errorf("standard error file: %w", err)
	}
	LogInfo("run", fmt.Sprintf("%s pid %d", identifier, os.Getpid()))
	return nil
}
