//go:build darwin

// Memory pressure tests (docs/spec/hosts.md#memory-pressure). The native source starts and receives levels only on the main
// thread, so each test runs its scenario in a child process of this test binary. TestMain runs the scenario on the main
// goroutine, which stays on the main thread.
package system_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/go/src"
	"github.com/soksak-app/core/packages/host/go/src/platform"
)

// memoryPressureChild is the environment variable that names the scenario that a child process runs.
const memoryPressureChild = "SOKSAK_MEMORY_PRESSURE_SCENARIO"

// memoryPressureLimit is the time limit of one child process of a memory pressure scenario.
const memoryPressureLimit = 30 * time.Second

// memoryPressureRefused is the prefix of the line that a child writes for a start that the native owner refuses.
const memoryPressureRefused = "refused: "

// emitted is one call of the emit function of the host.
type emitted struct {
	name    string
	payload any
}

// memoryPressureLine is one line that a child writes for one emit call.
type memoryPressureLine struct {
	Name    string                `json:"name"`
	Payload memoryPressurePayload `json:"payload"`
}

// memoryPressurePayload is the payload of the page event memory-pressure.
type memoryPressurePayload struct {
	Level string `json:"level"`
	Seq   uint64 `json:"seq"`
}

// runMemoryPressureChild runs the scenario of a child process on the main goroutine and writes its lines to standard output.
func runMemoryPressureChild(scenario string) error {
	switch scenario {
	case "relay":
		return relayScenario()
	case "seq-order":
		return seqOrderScenario()
	}
	return fmt.Errorf("unknown memory pressure scenario %q", scenario)
}

// relayScenario starts the real source, injects two levels, writes the relayed reports and then starts the source again.
func relayScenario() error {
	system, err := platform.Current()
	if err != nil {
		return err
	}
	sent := make(chan emitted, 4)
	emit := func(name string, payload any) { sent <- emitted{name, payload} }
	if err := host.StartMemoryPressure(system, emit); err != nil {
		return err
	}
	if err := system.InjectMemoryPressure("warn"); err != nil {
		return err
	}
	if err := system.InjectMemoryPressure("normal"); err != nil {
		return err
	}
	for range 2 {
		if err := writeEmitted(<-sent); err != nil {
			return err
		}
	}
	// The native owner keeps one source per process, so the second start is refused.
	err = host.StartMemoryPressure(system, emit)
	if err == nil {
		return errors.New("a second start of the memory pressure source was accepted")
	}
	_, err = fmt.Println(memoryPressureRefused + err.Error())
	return err
}

// seqOrderScenario holds the emit of the first report, injects two levels and then releases the emit. The injections return
// without waiting for the held emit, so the child reaches the release.
func seqOrderScenario() error {
	system, err := platform.Current()
	if err != nil {
		return err
	}
	release := make(chan struct{})
	sent := make(chan emitted, 4)
	if err := host.StartMemoryPressure(system, func(name string, payload any) {
		level := payload.(map[string]any)["level"].(string)
		if level == "critical" {
			<-release
		}
		sent <- emitted{name, payload}
	}); err != nil {
		return err
	}
	if err := system.InjectMemoryPressure("critical"); err != nil {
		return err
	}
	if err := system.InjectMemoryPressure("normal"); err != nil {
		return err
	}
	close(release)
	for range 2 {
		if err := writeEmitted(<-sent); err != nil {
			return err
		}
	}
	return nil
}

// writeEmitted writes one emit call to standard output as a JSON line.
func writeEmitted(e emitted) error {
	line, err := json.Marshal(map[string]any{"name": e.name, "payload": e.payload})
	if err != nil {
		return err
	}
	_, err = fmt.Println(string(line))
	return err
}

// memoryPressureLines runs the scenario in a child process of this test binary and returns its output lines.
func memoryPressureLines(t *testing.T, scenario string) []string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), memoryPressureLimit)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0])
	command.Env = append(os.Environ(), memoryPressureChild+"="+scenario)
	output, err := command.Output()
	if err != nil {
		t.Fatalf("child %s ended with %v, output %q", scenario, err, output)
	}
	return strings.Split(strings.TrimRight(string(output), "\n"), "\n")
}

// decodeMemoryPressureLine reads one JSON line of a child.
func decodeMemoryPressureLine(t *testing.T, line string) memoryPressureLine {
	t.Helper()
	var got memoryPressureLine
	if err := json.Unmarshal([]byte(line), &got); err != nil {
		t.Fatalf("line %q: %v", line, err)
	}
	return got
}

// contract: host.memory-pressure.relays-level-and-seq
func TestMemoryPressureRelaysLevelAndSeq(t *testing.T) {
	lines := memoryPressureLines(t, "relay")
	want := []memoryPressureLine{
		{"memory-pressure", memoryPressurePayload{"warn", 1}},
		{"memory-pressure", memoryPressurePayload{"normal", 2}},
	}
	if len(lines) != len(want)+1 {
		t.Fatalf("the child wrote %d lines, want %d reports and the refusal: %q", len(lines), len(want), lines)
	}
	for i, w := range want {
		if got := decodeMemoryPressureLine(t, lines[i]); got != w {
			t.Fatalf("sent %#v, want %#v", got, w)
		}
	}
	refusal, found := strings.CutPrefix(lines[len(want)], memoryPressureRefused)
	if !found || refusal != "failed to start the memory pressure source" {
		t.Fatalf("a refused source returned %q", lines[len(want)])
	}
}

// contract: host.memory-pressure.relays-level-and-seq
func TestMemoryPressureReportsArriveInSeqOrderWithoutWaiting(t *testing.T) {
	lines := memoryPressureLines(t, "seq-order")
	want := []string{"critical", "normal"}
	if len(lines) != len(want) {
		t.Fatalf("the child wrote %d lines, want %d: %q", len(lines), len(want), lines)
	}
	for i, line := range lines {
		if got := decodeMemoryPressureLine(t, line); got.Payload.Level != want[i] {
			t.Fatalf("emitted %q, want %q in seq order", got.Payload.Level, want[i])
		}
	}
}
