// 애플리케이션 로그 테스트(docs/spec/hosts.md#application-log). 표준 오류 교체는 프로세스 전체에 영향을
// 주므로 자식 프로세스에서 확인한다.
package host_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	host "github.com/min-median-max/soksak/packages/host/wailsv3/src"
)

// applicationLogChild 는 자식 프로세스에 설정 디렉터리를 알리는 환경 변수다.
const applicationLogChild = "SOKSAK_APPLICATION_LOG_CHILD"

// contract: log.open.rotates-at-10mb
func TestOpenLogMovesAFileOfTenMegabytesToTheEarlierGeneration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "logs", "application.log")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	full := strings.Repeat("x", 10*1024*1024)
	if err := os.WriteFile(path, []byte(full), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path+".1", []byte("older\n"), 0o600); err != nil {
		t.Fatal(err)
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
	start := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z application log: com\.soksak\.test pid \d+$`)
	if len(lines) < 3 || !start.MatchString(lines[0]) || lines[1] != "host line" || lines[2] != "child line" {
		t.Fatalf("application log %q", lines)
	}
}
