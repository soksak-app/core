//go:build darwin

// Command darwin runs the benchmark of an empty mygo window on a display (make benchmark-empty-window): it opens a window of the framework
// without the mygo framework adapter and writes one line of JSON to the standard output.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/soksak-app/core/packages/host/mygo/benchmark"
)

// frameworkWindow resizes the window on the main thread and waits until the window has painted at the new size.
type frameworkWindow struct {
	window  *mygo.Window
	painted <-chan [2]int
	closed  <-chan struct{}
}

func (w frameworkWindow) Resize(width, height int) error {
	mygo.RunOnMain(func() { w.window.SetSize(width, height) })
	want := [2]int{width, height}
	for {
		select {
		case size := <-w.painted:
			if size == want {
				return nil
			}
		case <-w.closed:
			return errors.New("the window closed before it painted at the new size")
		}
	}
}

// reportPaint sends the size of each paint to painted. A paint replaces an unread one, so the newest size always waits there.
func reportPaint(painted chan [2]int) func(_ *ui.Painter, r ui.Rect) {
	return func(_ *ui.Painter, r ui.Rect) {
		select {
		case <-painted:
		default:
		}
		painted <- [2]int{int(r.W), int(r.H)}
	}
}

// ownProcess reads this process.
type ownProcess struct{}

func (ownProcess) Footprint() (int64, error) {
	output, err := exec.Command("/usr/bin/footprint", "-p", strconv.Itoa(os.Getpid()), "-f", "bytes").Output()
	if err != nil {
		return 0, fmt.Errorf("footprint: %w", err)
	}
	return benchmark.ParseFootprint(string(output))
}

func (ownProcess) CPU() (time.Duration, error) {
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		return 0, fmt.Errorf("rusage: %w", err)
	}
	return time.Duration(usage.Utime.Nano() + usage.Stime.Nano()), nil
}

func main() {
	options, err := benchmark.ParseArguments(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyProhibited)
	mygo.App.OnWindowAllClosed(func() {})
	var failure error
	mygo.App.WhenReady(func() {
		painted := make(chan [2]int, 1)
		closed := make(chan struct{})
		window := mygo.NewWindow(mygo.WindowOptions{
			Title: "empty", Width: benchmark.Width, Height: benchmark.Height,
			Content: ui.View(func(c *ui.Context) {
				ui.Box(c).Grow(1).Draw(reportPaint(painted))
			}),
		})
		window.OnClosed(func() { close(closed) })
		go func() {
			defer mygo.App.Quit()
			report, err := benchmark.Measure(frameworkWindow{window: window, painted: painted, closed: closed}, ownProcess{}, options, time.Sleep)
			if err != nil {
				failure = err
				return
			}
			failure = benchmark.Write(os.Stdout, report)
		}()
	})
	if err := mygo.App.Run(); err != nil {
		failure = err
	}
	if failure != nil {
		fmt.Fprintln(os.Stderr, failure)
		os.Exit(1)
	}
}
