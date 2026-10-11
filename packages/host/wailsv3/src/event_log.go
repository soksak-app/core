package host

// The event writer of the host (docs/spec/logging.md#writers).
//
// The queue, the bounds, seq, the two files, the policy gate, the batch, the loss record, the flush, the rotation and the line are
// the writer of the tool packages (sok.EventLog), which the tool starts with its own layer and role. The host adds the layer, the
// clock and the entrance of its goroutines, the pull of the native ring, the retention of the runs in the logs folder, and the
// start in the logs folder of the configuration directory.

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/soksak-app/core/packages/host/wailsv3/src/platform"
	"github.com/soksak-app/core/packages/host/wailsv3/src/routine"
	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// EventLogSchema is the schema number of the lines that the writer writes.
const EventLogSchema = sok.EventLogSchema

// monotonicNanos reads the monotonic clock of the records (docs/spec/logging.md#event). A clock that cannot be read is a
// defect of the platform: it is reported on the standard error (once, because every later event repeats it) and the event
// stores 0, which the audit of the contract refuses.
func monotonicNanos() uint64 {
	system, err := platform.Current()
	if err == nil {
		var nanos uint64
		if nanos, err = system.MonotonicNanos(); err == nil {
			return nanos
		}
	}
	clockFailure.Do(func() { fmt.Fprintf(os.Stderr, "event writer: the monotonic clock cannot be read: %v\n", err) })
	return 0
}

var clockFailure sync.Once

// Level is the level of an event.
type Level = sok.Level

// The levels of an event.
const (
	LevelError = sok.LevelError
	LevelWarn  = sok.LevelWarn
	LevelInfo  = sok.LevelInfo
	LevelDebug = sok.LevelDebug
	LevelTrace = sok.LevelTrace
)

// EventLog is the writer of one process.
type EventLog = sok.EventLog

// RelayedEvent is an event that another layer of this process produced, with the clocks and the layer it carries.
type RelayedEvent = sok.RelayedEvent

// EventLogOptions say how a writer of the host is started.
type EventLogOptions struct {
	// Directory is the logs folder.
	Directory string
	// Role is the role of the process.
	Role string
	// Boot is the identifier of this run.
	Boot string
	// QueueEvents is the bound of the queue in events.
	QueueEvents int
	// QueueBytes is the bound of the queue in bytes of serialized fields.
	QueueBytes int
	// BatchInterval is how long the writer waits for more events before it writes a batch.
	BatchInterval time.Duration
	// PolicyPath is the policy file that the writer follows (`<config-dir>/log-policy.json`); it is empty for a writer that has none.
	PolicyPath string
	// RetentionBytes is the bound of the files of the runs in the folder (docs/spec/logging.md#retention): the writer removes the oldest
	// runs when it starts and after each rotation while the files pass it.
	RetentionBytes int64
	// RotateBytes is the size at which the writer starts a new file. Each of the two files of the writer (the main file and the
	// debug file) rotates on its own: the file that was full becomes the next generation (`.1` is the first), and rotation
	// removes no generation.
	RotateBytes int64
	// Pull moves whole records of the native ring into buffer and returns the number of bytes written; nil when the
	// process has no native ring. PullLoss returns the events and bytes that the ring refused in a channel since the last call.
	Pull     func(buffer []byte) (int, error)
	PullLoss func(channel Channel) (events, bytes uint64)
}

// Channel is the set of the files of a process that holds a set of levels.
type Channel = sok.Channel

// The channels of the writer.
const (
	ChannelOther = sok.ChannelOther
	ChannelDebug = sok.ChannelDebug
)

// StartEventLog creates the folder (mode 0700) and the file (mode 0600), writes log.open and starts the writer of the layer
// host. A writer of the host always rotates and always applies the retention.
func StartEventLog(options EventLogOptions) (*EventLog, error) {
	if options.RotateBytes <= 0 {
		return nil, fmt.Errorf("event writer: RotateBytes must be positive, not %d", options.RotateBytes)
	}
	if options.RetentionBytes <= 0 {
		return nil, fmt.Errorf("event writer: RetentionBytes must be positive, not %d", options.RetentionBytes)
	}
	runName := options.Role + "-" + options.Boot
	var pull func(accept func(sok.RelayedEvent), lost func(events, bytes uint64, reason string, channel Channel))
	if options.Pull != nil {
		pull = nativePuller(options.Pull, options.PullLoss)
	}
	return sok.StartEventLog(sok.EventLogOptions{
		Directory: options.Directory, Role: options.Role, Boot: options.Boot, Layer: "host", Clock: monotonicNanos, Spawn: routine.Go,
		QueueEvents: options.QueueEvents, QueueBytes: options.QueueBytes, BatchInterval: options.BatchInterval,
		RotateBytes: options.RotateBytes, PolicyPath: options.PolicyPath, Pull: pull,
		Prune: func() (Level, json.RawMessage, bool) {
			// The pass counts what is on disk; the batch that waits for the interval is not in it, which is at most one batch.
			result, err := pruneRuns(options.Directory, runName, options.RetentionBytes)
			if err != nil {
				fmt.Fprintf(os.Stderr, "event writer: retention: %v\n", err)
			}
			if result.files == 0 && result.remaining <= options.RetentionBytes {
				return LevelInfo, nil, false
			}
			level := LevelInfo
			if result.remaining > options.RetentionBytes {
				level = LevelWarn
			}
			return level, result.fields(options.RetentionBytes), true
		},
	})
}

// The bounds of the writer of a host: events and bytes of serialized fields waiting for the batch interval.
const (
	hostQueueEvents   = 8192
	hostQueueBytes    = 16 << 20
	hostBatchInterval = 100 * time.Millisecond
	hostRotateBytes   = 100 << 20
)

var (
	bootOnce sync.Once
	bootName string
)

// processBoot is the identifier of this run, shared by the files of the run: the start time in seconds and the process
// identifier.
func processBoot() string {
	bootOnce.Do(func() { bootName = fmt.Sprintf("%d-%d", time.Now().Unix(), os.Getpid()) })
	return bootName
}

// StandardErrorPath is the stderr file of this run under the logs folder of config.
func StandardErrorPath(config string) string {
	return filepath.Join(config, "logs", "host-"+processBoot()+".stderr")
}

// StartHostEventLog starts the writer of the host in logs/ of the configuration folder; the boot identifier is the
// start time in seconds and the process identifier.
func StartHostEventLog(config string) (*EventLog, error) {
	system, err := platform.Current()
	if err != nil {
		return nil, err
	}
	// A platform that cannot pull the native ring fails here, at the start, instead of running without native events.
	if _, err := system.PullNativeEvents(make([]byte, 1)); err != nil {
		return nil, err
	}
	if err := system.SetEventBoot(processBoot()); err != nil {
		return nil, err
	}
	if err := system.ObserveActivity(); err != nil {
		return nil, err
	}
	return StartEventLog(EventLogOptions{
		Pull: system.PullNativeEvents,
		PullLoss: func(channel Channel) (uint64, uint64) {
			events, bytes, err := system.TakeNativeEventLoss(uint8(channel))
			if err != nil {
				fmt.Fprintf(os.Stderr, "event writer: the loss of the native ring cannot be read: %v\n", err)
			}
			return events, bytes
		},
		Directory: filepath.Join(config, "logs"), Role: "host", Boot: processBoot(),
		QueueEvents: hostQueueEvents, QueueBytes: hostQueueBytes, BatchInterval: hostBatchInterval,
		RotateBytes: hostRotateBytes, PolicyPath: filepath.Join(config, "log-policy.json"), RetentionBytes: hostRetentionBytes,
	})
}

// nativePuller is the Pull of the writer for a native ring: it moves the records of the ring into a buffer, decodes each into
// an event, and reports a refused record and the loss of the ring.
func nativePuller(pull func(buffer []byte) (int, error), pullLoss func(Channel) (uint64, uint64)) func(accept func(sok.RelayedEvent), lost func(events, bytes uint64, reason string, channel Channel)) {
	var pulled []byte
	return func(accept func(sok.RelayedEvent), lost func(events, bytes uint64, reason string, channel Channel)) {
		if pulled == nil {
			pulled = make([]byte, nativePullBytes)
		}
		var refused, refusedBytes uint64
		for pass := 0; pass < nativePullPasses; pass++ {
			n, err := pull(pulled)
			if err != nil {
				fmt.Fprintf(os.Stderr, "event writer: the pull of the native ring failed: %v\n", err)
				break
			}
			if n == 0 {
				break
			}
			for offset := 0; offset < n; {
				length, event, err := nativeEventOf(pulled[offset:n])
				if err != nil {
					// The rest of the buffer cannot be located after a record whose length is wrong.
					fmt.Fprintf(os.Stderr, "event writer: a native record was refused: %v\n", err)
					refused++
					refusedBytes += uint64(n - offset)
					if length == 0 {
						break
					}
				} else {
					accept(event)
				}
				offset += length
			}
		}
		// A record that cannot be decoded has no level, so its loss is counted in the channel other.
		lost(refused, refusedBytes, "a native record was refused", ChannelOther)
		if pullLoss != nil {
			for channel := ChannelOther; channel < sok.ChannelCount; channel++ {
				events, bytes := pullLoss(channel)
				lost(events, bytes, "the native ring was full", channel)
			}
		}
	}
}

// nativePullBytes is the size of the buffer of one pull; nativePullPasses bounds the passes of one pull, so a flood of
// native events cannot hold the writer; the records left in the ring wait for the next pull.
const (
	nativePullBytes  = 256 << 10
	nativePullPasses = 64
)

// nativeLevels maps the level byte of a native record to the level of the contract.
var nativeLevels = []Level{LevelError, LevelWarn, LevelInfo, LevelDebug, LevelTrace}

// nativeHeaderBytes is the size of the fixed part of a native record (native/darwin/src/event_ring.h).
const nativeHeaderBytes = 21

// nativeEventOf decodes the record at the start of buffer: a 4-byte length, then the wall clock in microseconds (8 bytes),
// the monotonic clock in nanoseconds (8), the level (1 byte), the class (1 byte), the length of the name (1 byte), the length of
// the cids (2 bytes), the name, the cids as a list separated by commas and the fields as JSON text, in the byte order of the host.
// It returns the number of bytes the record takes. When the length itself is wrong it returns 0, so the caller
// abandons the rest of the buffer. The class that the library gave is checked against the catalog: a record of a declared
// event with another class is refused, so a producer that disagrees with the catalog is counted and reported.
func nativeEventOf(buffer []byte) (int, sok.RelayedEvent, error) {
	if len(buffer) < 4 {
		return 0, sok.RelayedEvent{}, fmt.Errorf("%d bytes are left, which is less than a length", len(buffer))
	}
	length := int(binary.NativeEndian.Uint32(buffer))
	if length < nativeHeaderBytes || 4+length > len(buffer) {
		return 0, sok.RelayedEvent{}, fmt.Errorf("the length %d does not fit %d bytes", length, len(buffer)-4)
	}
	total := 4 + length
	body := buffer[4:total]
	level := int(body[16])
	class := int(body[17])
	nameLength := int(body[18])
	cidsLength := int(binary.NativeEndian.Uint16(body[19:]))
	if level >= len(nativeLevels) {
		return total, sok.RelayedEvent{}, fmt.Errorf("the level %d is not defined", level)
	}
	if class >= len(sok.Classes) {
		return total, sok.RelayedEvent{}, fmt.Errorf("the class %d is not defined", class)
	}
	if nativeHeaderBytes+nameLength+cidsLength > len(body) {
		return total, sok.RelayedEvent{}, fmt.Errorf("the name of %d bytes and the cids of %d bytes do not fit the record", nameLength, cidsLength)
	}
	name := string(body[nativeHeaderBytes : nativeHeaderBytes+nameLength])
	if !strings.HasPrefix(name, "native.") {
		return total, sok.RelayedEvent{}, fmt.Errorf("the event %q does not start with its layer \"native\"", name)
	}
	mono := binary.NativeEndian.Uint64(body[8:])
	if mono == 0 {
		return total, sok.RelayedEvent{}, fmt.Errorf("the monotonic clock of %s is 0", name)
	}
	var cids []string
	if cidsLength > 0 {
		cids = strings.Split(string(body[nativeHeaderBytes+nameLength:nativeHeaderBytes+nameLength+cidsLength]), ",")
		if err := sok.CheckCids(cids); err != nil {
			return total, sok.RelayedEvent{}, fmt.Errorf("the cids of %s: %w", name, err)
		}
	}
	if declared, known := sok.EventClassOf(name); known && declared != sok.Classes[class] {
		return total, sok.RelayedEvent{}, fmt.Errorf("the record of %s has the class %s, and the catalog declares %s", name, sok.Classes[class], declared)
	}
	fields := body[nativeHeaderBytes+nameLength+cidsLength:]
	if !json.Valid(fields) || len(fields) == 0 || fields[0] != '{' {
		return total, sok.RelayedEvent{}, fmt.Errorf("the fields of %s are not a JSON object", name)
	}
	return total, sok.RelayedEvent{TsMicros: int64(binary.NativeEndian.Uint64(body)), MonoNs: mono, Cids: cids, Layer: "native", Level: nativeLevels[level],
		Event: name, Fields: append(json.RawMessage(nil), fields...)}, nil
}
