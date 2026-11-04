// Package benchmark holds the benchmark of an empty mygo window: a window of the framework without the mygo framework adapter, which
// draws no workbench, so its readings are the floor of the framework (docs/operations/examples.md#empty-window-benchmark).
package benchmark

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"time"
)

const (
	// Width and Height are the size of the window in points, the window of the three-host benchmark.
	Width  = 1200
	Height = 760
	// DefaultSeconds is the time over which the benchmark reads the CPU.
	DefaultSeconds = 240
	// resizeSteps is the number of sizes of a resize, and resizePoints the width that it takes from the window at its middle.
	resizeSteps  = 60
	resizePoints = 300
	// resizeFrame is the time between two sizes of a resize.
	resizeFrame = 16 * time.Millisecond
	// settle is the time after a resize at which the benchmark reads the footprint.
	settle = 3 * time.Second
)

// Options are the arguments of the benchmark.
type Options struct {
	Seconds int
}

// ParseArguments reads `[--seconds N]`. An undeclared argument and a value that is not a positive whole number are errors.
func ParseArguments(args []string) (Options, error) {
	options := Options{Seconds: DefaultSeconds}
	for index := 0; index < len(args); index += 2 {
		if args[index] != "--seconds" {
			return Options{}, fmt.Errorf("unknown argument %s", args[index])
		}
		if index+1 == len(args) {
			return Options{}, errors.New("--seconds needs a value")
		}
		seconds, err := strconv.Atoi(args[index+1])
		if err != nil || seconds <= 0 {
			return Options{}, fmt.Errorf("--seconds must be a positive whole number, not %s", args[index+1])
		}
		options.Seconds = seconds
	}
	return options, nil
}

// Window is the window that the benchmark measures.
type Window interface {
	// Resize sets the size of the window in points.
	Resize(width, height int)
}

// Process reads the process that shows the window.
type Process interface {
	// Footprint returns the physical footprint of the process in bytes.
	Footprint() (int64, error)
	// CPU returns the CPU time that the process has used.
	CPU() (time.Duration, error)
}

// Report is the output of the benchmark.
type Report struct {
	Width           int     `json:"width"`
	Height          int     `json:"height"`
	Footprint       int64   `json:"footprintBytes"`
	Seconds         int     `json:"seconds"`
	CPU             float64 `json:"cpuSeconds"`
	ResizeFootprint int64   `json:"resizeFootprintBytes"`
	AfterResize     int64   `json:"afterResizeFootprintBytes"`
}

// Measure reads the footprint of the idle window, the CPU over the time of options, the footprint in the middle of a resize and the
// footprint 3 s after the resize. sleep waits for a time.
func Measure(window Window, process Process, options Options, sleep func(time.Duration)) (Report, error) {
	report := Report{Width: Width, Height: Height, Seconds: options.Seconds}
	var err error
	if report.Footprint, err = process.Footprint(); err != nil {
		return Report{}, err
	}
	before, err := process.CPU()
	if err != nil {
		return Report{}, err
	}
	sleep(time.Duration(options.Seconds) * time.Second)
	after, err := process.CPU()
	if err != nil {
		return Report{}, err
	}
	report.CPU = (after - before).Seconds()
	for step := 1; step <= resizeSteps; step++ {
		window.Resize(resizedWidth(step), Height)
		sleep(resizeFrame)
		if step == resizeSteps/2 {
			if report.ResizeFootprint, err = process.Footprint(); err != nil {
				return Report{}, err
			}
		}
	}
	sleep(settle)
	if report.AfterResize, err = process.Footprint(); err != nil {
		return Report{}, err
	}
	return report, nil
}

// resizedWidth returns the width of a step of a resize: the window narrows by resizePoints to the middle of the resize and returns.
func resizedWidth(step int) int {
	half := resizeSteps / 2
	distance := step
	if step > half {
		distance = resizeSteps - step
	}
	return Width - resizePoints*distance/half
}

// Write writes the report as one line of JSON.
func Write(output io.Writer, report Report) error {
	return json.NewEncoder(output).Encode(report)
}

var footprintLine = regexp.MustCompile(`(?m)^\s*phys_footprint: (\d+) B$`)

// ParseFootprint reads the footprint in bytes from the output of `footprint -p PID -f bytes`.
func ParseFootprint(text string) (int64, error) {
	match := footprintLine.FindStringSubmatch(text)
	if match == nil {
		return 0, errors.New("footprint output has no phys_footprint line")
	}
	return strconv.ParseInt(match[1], 10, 64)
}
