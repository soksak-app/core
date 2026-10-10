package host

// The records of the host (docs/spec/logging.md#writers): an error or an observation of the host, and a record that the
// page reports, are events `<layer>.record.<level>` with the fields `where` and `text`. A bounded start buffer holds the
// records written before the writer of the host exists.

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"
)

// StartBufferRecords is the number of records that the start buffer holds; a record beyond it is refused and counted.
const StartBufferRecords = 1024

type bufferedRecord struct {
	tsMicros int64
	layer    string
	level    Level
	event    string
	fields   json.RawMessage
}

// records guards the writer of the records and the start buffer, so a record written while the writer is attached keeps its
// place in the order.
var records struct {
	sync.Mutex
	log       *EventLog
	buffer    []bufferedRecord
	lostCount uint64
	lostBytes uint64
}

// UseHostEventLog makes log the writer of the records of the host and hands it the records of the start buffer in their
// order and with the time they were written; the records that the buffer refused are counted in the writer. A nil log
// detaches the writer and clears the buffer.
func UseHostEventLog(log *EventLog) {
	records.Lock()
	defer records.Unlock()
	records.log = log
	buffered, lost, lostBytes := records.buffer, records.lostCount, records.lostBytes
	records.buffer, records.lostCount, records.lostBytes = nil, 0, 0
	if log == nil {
		return
	}
	for _, record := range buffered {
		if _, err := log.EmitRelayed(record.tsMicros, record.layer, record.level, record.event, record.fields); err != nil {
			fmt.Fprintf(os.Stderr, "event writer: a buffered record cannot be stored: %v\n", err)
		}
	}
	log.CountLoss(lost, lostBytes)
}

// emitRecord stores an entry as the event `<layer>.record.<level>`.
func emitRecord(e Entry) {
	var level Level
	switch e.Level {
	case "error":
		level = LevelError
	case "info":
		level = LevelInfo
	default:
		fmt.Fprintf(os.Stderr, "event writer: the record %q of %s has the level %q, which is not error or info\n", e.Where, e.Layer, e.Level)
		return
	}
	fields, err := json.Marshal(map[string]string{"where": e.Where, "text": fmt.Sprint(e.Text)})
	if err != nil {
		fmt.Fprintf(os.Stderr, "event writer: the record %q of %s cannot be serialized: %v\n", e.Where, e.Layer, err)
		return
	}
	name := e.Layer + ".record." + e.Level
	now := time.Now().UnixMicro()
	records.Lock()
	defer records.Unlock()
	if records.log == nil {
		if len(records.buffer) >= StartBufferRecords {
			records.lostCount++
			records.lostBytes += uint64(len(fields) + len(name))
			return
		}
		records.buffer = append(records.buffer, bufferedRecord{tsMicros: now, layer: e.Layer, level: level, event: name, fields: fields})
		return
	}
	if _, err := records.log.EmitRelayed(now, e.Layer, level, name, fields); err != nil {
		fmt.Fprintf(os.Stderr, "event writer: the record %q of %s cannot be stored: %v\n", e.Where, e.Layer, err)
	}
}

// FlushRecords waits until the records written so far are in the event log, at most deadline. The paths that end the process
// call it, so the record of the failure is stored before the process ends. Without an attached writer there is nothing to
// wait for: the records wait in the start buffer, and the standard error holds the failure.
func FlushRecords(deadline time.Duration) error {
	records.Lock()
	log := records.log
	records.Unlock()
	if log == nil {
		return nil
	}
	return log.Flush(deadline)
}
