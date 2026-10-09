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

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// applicationLogChild 는 자식 프로세스에 설정 디렉터리를 알리는 환경 변수다.
const applicationLogChild = "SOKSAK_APPLICATION_LOG_CHILD"

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
func TestStartApplicationLogWritesTheStartLineAndTakesTheStandardErrorOfTheProcessAndItsChildren(t *testing.T) {
	if config := os.Getenv(applicationLogChild); config != "" {
		if err := host.StartApplicationLog(config, "com.soksak.test"); err != nil {
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
		return
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestStartApplicationLogWritesTheStartLineAndTakesTheStandardErrorOfTheProcessAndItsChildren$")
	command.Env = append(os.Environ(), applicationLogChild+"="+config)
	if output, err := command.Output(); err != nil {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	data, err := os.ReadFile(host.ApplicationLogPath(config))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	start := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z info host run: com\.soksak\.test pid \d+$`)
	if len(lines) < 3 || !start.MatchString(lines[0]) || lines[1] != "host line" || lines[2] != "child line" {
		t.Fatalf("application log %q", lines)
	}
}

// contract: log.error.line-form
func TestLogErrorWritesAnErrorLineToTheApplicationLog(t *testing.T) {
	if config := os.Getenv(applicationLogChild); config != "" {
		if err := host.StartApplicationLog(config, "com.soksak.test"); err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		host.LogError("surface input", errors.New("the window has no content view"))
		return
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestLogErrorWritesAnErrorLineToTheApplicationLog$")
	command.Env = append(os.Environ(), applicationLogChild+"="+config)
	if output, err := command.Output(); err != nil {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	data, err := os.ReadFile(host.ApplicationLogPath(config))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	recordLine := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (error|info) (page|host|native|sidecar) .+: .*$`)
	if len(lines) != 2 || !recordLine.MatchString(lines[1]) || !strings.HasSuffix(lines[1], " error host surface input: the window has no content view") {
		t.Fatalf("application log %q", lines)
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
	if strings.Contains(host.RecordLine(host.Entry{Level: "info", Layer: "host", Where: "w", Text: "a\nb"}), "\n") {
		t.Fatal("a record holds a line feed")
	}
}

// A host observation is a record of level info through LogInfo.
// contract: log.info.record-form
func TestLogInfoWritesAnInfoRecordToTheApplicationLog(t *testing.T) {
	if config := os.Getenv(applicationLogChild); config != "" {
		if err := host.StartApplicationLog(config, "com.soksak.test"); err != nil {
			os.Stdout.WriteString(err.Error() + "\n")
			os.Exit(2)
		}
		host.LogInfo("webkit children", "pid 7: gone")
		return
	}
	config := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=^TestLogInfoWritesAnInfoRecordToTheApplicationLog$")
	command.Env = append(os.Environ(), applicationLogChild+"="+config)
	if output, err := command.Output(); err != nil {
		t.Fatalf("child ended with %v, output %q", err, output)
	}
	data, err := os.ReadFile(host.ApplicationLogPath(config))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	record := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z info host webkit children: pid 7: gone$`)
	if len(lines) != 2 || !record.MatchString(lines[1]) {
		t.Fatalf("application log %q", lines)
	}
}
