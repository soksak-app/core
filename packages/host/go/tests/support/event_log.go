package support

import (
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
)

// EventLogOptions are the options of a writer of the tests in directory: a small queue, short batches, and bounds that no test
// reaches unless it sets its own.
func EventLogOptions(directory string) host.EventLogOptions {
	return host.EventLogOptions{
		Directory: directory, Role: "host", Boot: "b1", QueueEvents: 64, QueueBytes: 64 * 1024,
		BatchInterval: 20 * time.Millisecond, RotateBytes: 1 << 30, RetentionBytes: 1 << 40,
	}
}

// UseEventLog starts a writer, makes it the writer of the records of the host, and detaches it when the test ends.
func UseEventLog(t *testing.T) *host.EventLog {
	t.Helper()
	// Records that earlier tests wrote while no writer was attached wait in the start buffer; they are not this test's.
	host.UseHostEventLog(nil)
	log, err := host.StartEventLog(EventLogOptions(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	StoreEveryLevel(t, log)
	host.UseHostEventLog(log)
	// The writer ends before the folder of the test is removed; a writer that outlives the test writes into a removed folder.
	t.Cleanup(func() { host.UseHostEventLog(nil); log.Close() })
	return log
}

// UseRoomyEventLog is UseEventLog with a queue that holds the records of a flood of messages.
func UseRoomyEventLog(t *testing.T) *host.EventLog {
	t.Helper()
	host.UseHostEventLog(nil)
	options := EventLogOptions(t.TempDir())
	options.QueueEvents, options.QueueBytes = 1<<16, 64<<20
	log, err := host.StartEventLog(options)
	if err != nil {
		t.Fatal(err)
	}
	StoreEveryLevel(t, log)
	host.UseHostEventLog(log)
	t.Cleanup(func() {
		host.UseHostEventLog(nil)
		if err := log.Flush(); err != nil {
			t.Errorf("flush event log before closing: %v", err)
		}
		log.Close()
	})
	return log
}

// CaptureLog attaches a writer of events to the records of the host until the test ends and returns a function that gives
// the records written so far, one line each in the text form `<time> <level> <layer> <where>: <text>`.
func CaptureLog(t *testing.T) func() string {
	log := UseEventLog(t)
	return func() string {
		if err := log.Flush(); err != nil {
			t.Fatal(err)
		}
		return TextOf(ReadEvents(t, log.Path()))
	}
}

// CaptureLogAwait is CaptureLog with a wait: await(text) returns the records once they hold text. The writer tells each batch
// that it wrote (SetOnWrite), and the records are read again after each batch, so a record that a goroutine of the host writes
// ends the wait when its batch is written; a record that never comes leaves the check to the limit of its runner.
func CaptureLogAwait(t *testing.T) (written func() string, await func(text string) string) {
	log := UseEventLog(t)
	wrote := make(chan struct{}, 1)
	log.SetOnWrite(func(string, int64) {
		select {
		case wrote <- struct{}{}:
		default:
		}
	})
	written = func() string {
		if err := log.Flush(); err != nil {
			t.Fatal(err)
		}
		return TextOf(ReadEvents(t, log.Path()))
	}
	await = func(text string) string {
		t.Helper()
		for {
			records := written()
			if strings.Contains(records, text) {
				return records
			}
			<-wrote
		}
	}
	return written, await
}

// BufferDrops flushes the writer and returns the fields of the events `host.buffer.dropped`.
func BufferDrops(t *testing.T, log *host.EventLog) []map[string]any {
	t.Helper()
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	var drops []map[string]any
	for _, event := range ReadEvents(t, log.Path()) {
		if event["event"] == "host.buffer.dropped" {
			if event["level"] != "warn" || event["layer"] != "host" {
				t.Fatalf("event %v is not a warning of the layer host", event)
			}
			drops = append(drops, event["fields"].(map[string]any))
		}
	}
	return drops
}

// WriteWaits flushes the writer and returns the fields of the events `host.sidecar.write_wait`.
func WriteWaits(t *testing.T, log *host.EventLog) []map[string]any {
	t.Helper()
	if err := log.Flush(); err != nil {
		t.Fatal(err)
	}
	var waits []map[string]any
	for _, event := range ReadEvents(t, log.Path()) {
		if event["event"] == "host.sidecar.write_wait" {
			if event["level"] != "info" || event["layer"] != "host" {
				t.Fatalf("event %v is not an info of the layer host", event)
			}
			waits = append(waits, event["fields"].(map[string]any))
		}
	}
	return waits
}
