package benchmark_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/host/mygo/benchmark"
)

// fixtureWindow records the sizes that the benchmark sets.
type fixtureWindow struct{ sizes [][2]int }

func (w *fixtureWindow) Resize(width, height int) { w.sizes = append(w.sizes, [2]int{width, height}) }

// fixtureProcess answers from fixed lists and records when the benchmark read the footprint.
type fixtureProcess struct {
	window     *fixtureWindow
	footprints []int64
	cpu        []time.Duration
	readAt     []int
	failure    error
}

func (p *fixtureProcess) Footprint() (int64, error) {
	if p.failure != nil {
		return 0, p.failure
	}
	p.readAt = append(p.readAt, len(p.window.sizes))
	footprint := p.footprints[0]
	p.footprints = p.footprints[1:]
	return footprint, nil
}

func (p *fixtureProcess) CPU() (time.Duration, error) {
	used := p.cpu[0]
	p.cpu = p.cpu[1:]
	return used, nil
}

// contract: mygo.benchmark.empty-window-reads-the-window
func TestTheBenchmarkReadsTheWindowOfTheThreeHostBenchmark(t *testing.T) {
	window := &fixtureWindow{}
	process := &fixtureProcess{window: window, footprints: []int64{10, 20, 30}, cpu: []time.Duration{time.Second, 3500 * time.Millisecond}}
	var slept []time.Duration
	report, err := benchmark.Measure(window, process, benchmark.Options{Seconds: 240}, func(d time.Duration) { slept = append(slept, d) })
	if err != nil {
		t.Fatal(err)
	}
	want := benchmark.Report{Width: 1200, Height: 760, Footprint: 10, Seconds: 240, CPU: 2.5, ResizeFootprint: 20, AfterResize: 30}
	if report != want {
		t.Fatalf("the report is %+v, want %+v", report, want)
	}
	if slept[0] != 240*time.Second {
		t.Fatalf("the CPU is read over %v, want 240 s", slept[0])
	}
	if last := slept[len(slept)-1]; last != 3*time.Second {
		t.Fatalf("the footprint after the resize is read after %v, want 3 s", last)
	}
	// The resize reads its footprint in its middle, at the narrowest size, and the window ends at its size.
	if !slices.Equal(process.readAt, []int{0, 30, 60}) {
		t.Fatalf("the footprints are read after %v sizes", process.readAt)
	}
	if got := window.sizes[29]; got != [2]int{900, 760} {
		t.Fatalf("the middle of the resize is %v", got)
	}
	if got := window.sizes[len(window.sizes)-1]; got != [2]int{1200, 760} {
		t.Fatalf("the resize ends at %v", got)
	}
}

// contract: mygo.benchmark.empty-window-reads-the-window
func TestAFailedReadingEndsTheBenchmark(t *testing.T) {
	failure := errors.New("no footprint")
	_, err := benchmark.Measure(&fixtureWindow{}, &fixtureProcess{failure: failure}, benchmark.Options{Seconds: 1}, func(time.Duration) {})
	if !errors.Is(err, failure) {
		t.Fatalf("the benchmark returned %v", err)
	}
}

// contract: mygo.benchmark.empty-window-reads-the-window
func TestTheArgumentsOfTheBenchmark(t *testing.T) {
	options, err := benchmark.ParseArguments(nil)
	if err != nil || options.Seconds != 240 {
		t.Fatalf("the default is %+v, %v", options, err)
	}
	options, err = benchmark.ParseArguments([]string{"--seconds", "5"})
	if err != nil || options.Seconds != 5 {
		t.Fatalf("--seconds 5 is %+v, %v", options, err)
	}
	for args, want := range map[string]string{"--seconds": "needs a value", "--seconds 0": "positive", "--seconds x": "positive", "--minutes 5": "unknown argument"} {
		if _, err := benchmark.ParseArguments(strings.Fields(args)); err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("%s returned %v, want %q", args, err, want)
		}
	}
}

// contract: mygo.benchmark.empty-window-reads-the-window
func TestTheReportIsOneLineOfJSON(t *testing.T) {
	var output bytes.Buffer
	if err := benchmark.Write(&output, benchmark.Report{Width: 1200, Height: 760, Footprint: 10, Seconds: 240, CPU: 2.5, ResizeFootprint: 20, AfterResize: 30}); err != nil {
		t.Fatal(err)
	}
	var read map[string]any
	if err := json.Unmarshal(output.Bytes(), &read); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"width": 1200.0, "height": 760.0, "footprintBytes": 10.0, "seconds": 240.0, "cpuSeconds": 2.5, "resizeFootprintBytes": 20.0, "afterResizeFootprintBytes": 30.0}
	if len(read) != len(want) {
		t.Fatalf("the report holds %v", read)
	}
	for key, value := range want {
		if read[key] != value {
			t.Fatalf("%s is %v, want %v", key, read[key], value)
		}
	}
	if strings.Count(output.String(), "\n") != 1 {
		t.Fatalf("the report is %q", output.String())
	}
}

// contract: mygo.benchmark.empty-window-reads-the-window
func TestTheFootprintIsReadFromTheOutputOfFootprint(t *testing.T) {
	footprint, err := benchmark.ParseFootprint("mygo [1]: 64-bit\n  phys_footprint: 52428800 B\n  phys_footprint_peak: 62428800 B\n")
	if err != nil || footprint != 52428800 {
		t.Fatalf("the footprint is %d, %v", footprint, err)
	}
	if _, err := benchmark.ParseFootprint("no such process"); err == nil {
		t.Fatal("an output without the line is read")
	}
}
