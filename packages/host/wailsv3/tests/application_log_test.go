// 애플리케이션 로그 테스트(docs/spec/hosts.md#application-log). 표준 오류 교체는 프로세스 전체에 영향을
// 주므로 자식 프로세스에서 확인한다.
package host_test

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/soksak-app/core/packages/host/wailsv3/tests/support"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// standardErrorChild 는 자식 프로세스에 설정 디렉터리를 알리는 환경 변수다.
const standardErrorChild = "SOKSAK_APPLICATION_LOG_CHILD"

// contract: log.open.rotates-at-100mb
func TestOpenLogMovesAFileOfOneHundredMegabytesToTheEarlierGeneration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "logs", "application.log")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	full := strings.Repeat("x", 100*1024*1024)
	if err := os.WriteFile(path, []byte(full), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path+".1", []byte("older\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for generation := 2; generation <= 5; generation++ {
		if err := os.WriteFile(fmt.Sprintf("%s.%d", path, generation), []byte(fmt.Sprintf("generation %d\n", generation)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	file, err := host.OpenLog(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("new\n"); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	earlier, err := os.ReadFile(path + ".1")
	if err != nil {
		t.Fatal(err)
	}
	current, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(earlier) != len(full) || string(current) != "new\n" {
		t.Fatalf("earlier generation %d bytes, current %q", len(earlier), current)
	}
	// The earlier generations move up by one and the fifth one is dropped.
	for generation, want := range map[int]string{2: "older\n", 3: "generation 2\n", 4: "generation 3\n", 5: "generation 4\n"} {
		data, err := os.ReadFile(fmt.Sprintf("%s.%d", path, generation))
		if err != nil || string(data) != want {
			t.Fatalf("generation %d is %q (%v), want %q", generation, data, err, want)
		}
	}
	if _, err := os.Stat(path + ".6"); !os.IsNotExist(err) {
		t.Fatalf("a sixth earlier generation was kept: %v", err)
	}
}

// contract: log.open.appends-below-bound
func TestOpenLogAppendsToASmallerFileAndCreatesAPrivateFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "logs", "application.log")
	for _, line := range []string{"first\n", "second\n"} {
		file, err := host.OpenLog(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.WriteString(line); err != nil {
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "first\nsecond\n" || info.Mode().Perm() != 0o600 {
		t.Fatalf("log %q with mode %v", data, info.Mode().Perm())
	}
	if _, err := os.Stat(path + ".1"); !os.IsNotExist(err) {
		t.Fatalf("a file below the bound was rotated: %v", err)
	}
}

// contract: log.application.start-replaces-standard-error
func TestStartStandardErrorWritesTheRunRecordAsAnEventAndTakesTheStandardErrorOfTheProcessAndItsChildren(t *testing.T) {
	if config := os.Getenv(standardErrorChild); config != "" {
		log, err := host.StartHostEventLog(config)
		if err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		host.UseHostEventLog(log)
		if err := host.StartStandardError(config, "com.soksak.test"); err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		os.Stderr.WriteString("host line\n")
		child := exec.Command("/bin/sh", "-c", "echo child line >&2")
		child.Stderr = os.Stderr
		if err := child.Run(); err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		if err := log.Flush(5 * time.Second); err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		return
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestStartStandardErrorWritesTheRunRecordAsAnEventAndTakesTheStandardErrorOfTheProcessAndItsChildren$")
	command.Env = append(os.Environ(), standardErrorChild+"="+config)
	if output, err := command.Output(); err != nil {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	// The raw standard error of the process and its children is in the stderr file of the run, beside the event log.
	stderr, err := filepath.Glob(filepath.Join(config, "logs", "host-*.stderr"))
	if err != nil || len(stderr) != 1 {
		t.Fatalf("stderr files %v, %v", stderr, err)
	}
	data, err := os.ReadFile(stderr[0])
	if err != nil {
		t.Fatal(err)
	}
	if got := string(data); got != "host line\nchild line\n" {
		t.Fatalf("stderr file %q", got)
	}
	// The run record is an event of the event log, not a line of the stderr file.
	events := readHostEventLog(t, config)
	run := events[len(events)-1]
	fields, _ := run["fields"].(map[string]any)
	if run["event"] != "host.record.info" || fields["where"] != "run" || !regexp.MustCompile(`^com\.soksak\.test pid \d+$`).MatchString(fields["text"].(string)) {
		t.Fatalf("event log %v", events)
	}
}

// contract: log.error.line-form
func TestLogErrorWritesAnErrorEventToTheEventLog(t *testing.T) {
	if config := os.Getenv(standardErrorChild); config != "" {
		log, err := host.StartHostEventLog(config)
		if err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		host.UseHostEventLog(log)
		host.LogError("surface input", errors.New("the window has no content view"))
		if err := log.Flush(5 * time.Second); err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		return
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestLogErrorWritesAnErrorEventToTheEventLog$")
	command.Env = append(os.Environ(), standardErrorChild+"="+config)
	if output, err := command.Output(); err != nil {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	events := readHostEventLog(t, config)
	if len(events) != 2 || events[1]["event"] != "host.record.error" || events[1]["level"] != "error" ||
		events[1]["fields"].(map[string]any)["where"] != "surface input" ||
		events[1]["fields"].(map[string]any)["text"] != "the window has no content view" {
		t.Fatalf("event log %v", events)
	}
}

// page 가 받는 binding 실패는 page 가 한 번 기록한다. host 가 쓰는 Wails transport 가 그 실패를 다시 기록하면
// 실패 하나가 두 줄로 남는다(docs/spec/hosts.md#application-log).
// contract: log.binding-failure.returned-not-logged
func TestTheTransportReturnsAFailedCallWithoutLoggingIt(t *testing.T) {
	var logged strings.Builder
	transport := application.NewHTTPTransport(application.HTTPTransportWithLogger(slog.New(slog.NewTextHandler(&logged, nil))))
	handler := transport.Handler()(http.NotFoundHandler())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/wails/runtime", strings.NewReader("{}")))
	if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), "missing object value") {
		t.Fatalf("response = %d %q", response.Code, response.Body.String())
	}
	if logged.Len() != 0 {
		t.Fatalf("the transport logged the failure it returned: %q", logged.String())
	}
}

// A record is one line: a line feed in its text is written as the two characters `\n`.
// contract: log.record.one-line
func TestARecordIsOneLineAndEscapesALineFeed(t *testing.T) {
	line := host.Entry{Level: "error", Layer: "page", Where: "start", Text: "first\nsecond"}.Line()
	if want := `error page start: first\nsecond`; line != want {
		t.Fatalf("line %q, want %q", line, want)
	}
	if strings.Contains(host.Entry{Level: "info", Layer: "host", Where: "w", Text: "a\nb"}.Line(), "\n") {
		t.Fatal("a record holds a line feed")
	}
}

// A host observation is a record of level info through LogInfo.
// contract: log.info.record-form
func TestLogInfoWritesAnInfoEventToTheEventLog(t *testing.T) {
	if config := os.Getenv(standardErrorChild); config != "" {
		log, err := host.StartHostEventLog(config)
		if err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		host.UseHostEventLog(log)
		host.LogInfo("webkit children", "pid 7: gone")
		if err := log.Flush(5 * time.Second); err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		return
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestLogInfoWritesAnInfoEventToTheEventLog$")
	command.Env = append(os.Environ(), standardErrorChild+"="+config)
	if output, err := command.Output(); err != nil {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	events := readHostEventLog(t, config)
	if len(events) != 2 || events[1]["event"] != "host.record.info" || events[1]["level"] != "info" ||
		events[1]["fields"].(map[string]any)["where"] != "webkit children" ||
		events[1]["fields"].(map[string]any)["text"] != "pid 7: gone" {
		t.Fatalf("event log %v", events)
	}
}

// readHostEventLog returns the events of the only host event log under the logs folder of a configuration folder.
func readHostEventLog(t *testing.T, config string) []map[string]any {
	t.Helper()
	return support.ReadEvents(t, support.EventLogPath(t, config))
}

// A line of the diagnostic transcript of a window, and an error that the transcript carries, also reach the application log.
// contract: log.transcript.line-reaches-the-application-log
func TestTranscriptLinesReachTheApplicationLog(t *testing.T) {
	if got, want := host.TranscriptEntry("main", "diagnostics: modal rendered m1").Line(),
		"info host transcript main: diagnostics: modal rendered m1"; got != want {
		t.Fatalf("transcript line = %q, want %q", got, want)
	}
	if got, want := host.TranscriptFailure("main", "rewatch core.layout", errors.New("page timed out")).Line(),
		"error host rewatch core.layout main: page timed out"; got != want {
		t.Fatalf("transcript failure = %q, want %q", got, want)
	}
}
