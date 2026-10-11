package sok

// The record of a run of the tool (docs/spec/cli.md#event-log): the event file in the configuration directory that the
// command targets holds the command with its result, and a panic with its stack.

import (
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Command is one run of the tool: it takes the arguments and the streams and returns the exit status. Run is the command
// of the executable.
type Command func(args []string, stdout, stderr io.Writer, options Options) int

// eventFlushDeadline is how long a run waits for the writer to put its last events on disk.
const eventFlushDeadline = 2 * time.Second

// callTextBytes is the bound of the arguments and of the error text of a command event (docs/spec/logging.md#bounds).
const callTextBytes = 1024

// targetConfigDir is the configuration directory that the arguments target: the value of --config-dir before any `--`, or
// the default directory of this application.
func targetConfigDir(args []string, options Options) (string, error) {
	values := map[string]string{}
	for i := 0; i < len(args) && args[i] != "--"; i++ {
		if value, ok := strings.CutPrefix(args[i], "--config-dir="); ok {
			values["config-dir"] = value
			break
		}
		if args[i] == "--config-dir" && i+1 < len(args) {
			values["config-dir"] = args[i+1]
			break
		}
	}
	return configDirOf(values, options)
}

// firstLine passes everything to its stream and keeps the first line of what was written, up to callTextBytes.
type firstLine struct {
	stream io.Writer
	text   []byte
	ended  bool
}

func (f *firstLine) Write(data []byte) (int, error) {
	if !f.ended {
		line, _, found := strings.Cut(string(data), "\n")
		f.text = append(f.text, line...)
		f.ended = found
	}
	return f.stream.Write(data)
}

// runLog is the event file of the run that Logged started; a command stores its own events in it. It is nil in a run without an
// event file (Logged could not start it and reported that), where the failure that an event describes is also the error of the
// command.
var runLog atomic.Pointer[EventLog]

// Logged runs command and records it: it starts the event file of the targeted configuration directory, runs the command,
// stores a panic of the command with its stack as the exit status PanicStatus, stores the command with its result, and
// flushes the file. An event file that cannot be started is reported on the standard error and the command runs without it.
func Logged(args []string, stdout, stderr io.Writer, options Options, command Command) int {
	started := time.Now()
	config, err := targetConfigDir(args, options)
	var log *EventLog
	if err == nil {
		log, err = StartEventLog(config)
	}
	if err != nil {
		// When the report cannot be written to the standard error, there is no place to report it, so it is reported with
		// exit status 3 (docs/spec/cli.md).
		if _, writeErr := fmt.Fprintf(stderr, "sok: event log: %v\n", err); writeErr != nil {
			return 3
		}
		return command(args, stdout, stderr, options)
	}
	runLog.Store(log)
	defer runLog.Store(nil)
	captured := &firstLine{stream: stderr}
	var recorded sync.Once
	// finish stores the command with its result once, whichever entrance ends the run.
	finish := func(status int, errorText string) {
		recorded.Do(func() {
			text, cut := cutText(strings.Join(args, " "), callTextBytes)
			fields := map[string]any{"name": commandWord(args), "args": text, "micros": time.Since(started).Microseconds(), "ok": status == 0, "status": status}
			level := LevelDebug
			if status != 0 {
				level = LevelWarn
				var errorCut bool
				fields["error"], errorCut = cutText(errorText, callTextBytes)
				cut = cut || errorCut
			}
			if cut {
				fields["truncated"] = true
			}
			log.Emit(level, "sok.command", fields)
		})
	}
	record := func(p Panic) {
		log.Emit(LevelError, "sok.panic", map[string]any{"name": p.Name, "text": p.Text, "stack": p.Stack})
		finish(PanicStatus, "sok: panic: "+p.Text)
		if err := log.Flush(eventFlushDeadline); err != nil {
			fmt.Fprintf(stderr, "sok: event log: %v\n", err)
		}
	}
	panicRecorder.Store(&record)
	status, panicked := Guard(func() int { return command(args, stdout, captured, options) })
	panicRecorder.Store(nil)
	if panicked != nil {
		if _, writeErr := fmt.Fprintf(captured, "sok: panic: %s\n%s", panicked.Text, panicked.Stack); writeErr != nil {
			status = 3
		} else {
			status = PanicStatus
		}
		log.Emit(LevelError, "sok.panic", map[string]any{"name": panicked.Name, "text": panicked.Text, "stack": panicked.Stack})
	}
	finish(status, string(captured.text))
	if err := log.Flush(eventFlushDeadline); err != nil {
		if _, writeErr := fmt.Fprintf(stderr, "sok: event log: %v\n", err); writeErr != nil {
			status = 3
		}
	}
	log.Close()
	return status
}

// Main runs Run with the record of the tool.
func Main(args []string, stdout, stderr io.Writer, options Options) int {
	return Logged(args, stdout, stderr, options, Run)
}
