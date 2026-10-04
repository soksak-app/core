package tests

// 이전 설정 폴더를 옮기는 규칙(docs/spec/projects.md#persistence)을 검사한다.

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// contract: cli.identity.moves-only-the-former-directory
func TestTheFormerDirectoryMovesOnce(t *testing.T) {
	base := t.TempDir()
	former, current := filepath.Join(base, "com.soksak.former"), filepath.Join(base, "app.soksak.current")
	if err := os.Mkdir(former, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(former, "projects.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	moved, err := sok.MoveFormerConfigDir(base, "com.soksak.former", "app.soksak.current")
	if err != nil || moved != former {
		t.Fatalf("moved %q err %v", moved, err)
	}
	if data, err := os.ReadFile(filepath.Join(current, "projects.json")); err != nil || string(data) != "{}" {
		t.Fatalf("current projects.json %q err %v", data, err)
	}
	if _, err := os.Lstat(former); !os.IsNotExist(err) {
		t.Fatalf("the former directory remains: %v", err)
	}
	// 두 번째 시작은 옮길 것이 없다.
	moved, err = sok.MoveFormerConfigDir(base, "com.soksak.former", "app.soksak.current")
	if err != nil || moved != "" {
		t.Fatalf("second start moved %q err %v", moved, err)
	}
	// 이전 식별자가 없는 build 는 아무것도 옮기지 않는다.
	if err := os.Mkdir(former, 0o700); err != nil {
		t.Fatal(err)
	}
	moved, err = sok.MoveFormerConfigDir(base, "", "app.soksak.current")
	if err != nil || moved != "" {
		t.Fatalf("a build without a former identifier moved %q err %v", moved, err)
	}
}

// contract: cli.identity.refuses-both-directories
func TestBothDirectoriesAreRefused(t *testing.T) {
	base := t.TempDir()
	former, current := filepath.Join(base, "com.soksak.former"), filepath.Join(base, "app.soksak.current")
	for _, dir := range []string{former, current} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	moved, err := sok.MoveFormerConfigDir(base, "com.soksak.former", "app.soksak.current")
	want := former + " and " + current + " both exist; move or remove " + former
	if moved != "" || err == nil || err.Error() != want {
		t.Fatalf("moved %q err %v want %q", moved, err, want)
	}
	for _, dir := range []string{former, current} {
		if _, err := os.Lstat(dir); err != nil {
			t.Fatalf("%s: %v", dir, err)
		}
	}
}

// contract: cli.config-dir.refuses-an-unmoved-former-directory
func TestSokRefusesAnUnmovedFormerDirectory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", "")
	base, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	former, current := filepath.Join(base, "com.soksak.former"), filepath.Join(base, "app.soksak.current")
	if err := os.MkdirAll(former, 0o700); err != nil {
		t.Fatal(err)
	}
	runFormer := func(args ...string) (int, string) {
		var stdout, stderr bytes.Buffer
		code := sok.Run(args, &stdout, &stderr, sok.Options{Identifier: "app.soksak.current", Former: "com.soksak.former", PathsDir: t.TempDir(), CoreVersion: "0.0.2"})
		return code, stderr.String()
	}
	want := "sok: " + former + " has not been moved; start the application once to move it to " + current + "\n"
	for _, args := range [][]string{{"windows"}, {"plugin", "list"}, {"core.page.audit"}} {
		code, stderr := runFormer(args...)
		if code != 1 || stderr != want {
			t.Fatalf("%v: code %d stderr %q want %q", args, code, stderr, want)
		}
	}
	if _, err := os.Lstat(current); !os.IsNotExist(err) {
		t.Fatalf("sok created the current directory: %v", err)
	}
	if err := os.Mkdir(current, 0o700); err != nil {
		t.Fatal(err)
	}
	code, stderr := runFormer("windows")
	if code != 1 || !strings.HasPrefix(stderr, "sok: "+former+" and "+current+" both exist; move or remove "+former+"\n") {
		t.Fatalf("both: code %d stderr %q", code, stderr)
	}
}

// contract: cli.identity.refuses-a-former-directory-in-use
func TestAFormerDirectoryInUseIsRefused(t *testing.T) {
	base := t.TempDir()
	former, current := filepath.Join(base, "com.soksak.former"), filepath.Join(base, "app.soksak.current")
	if err := os.Mkdir(former, 0o700); err != nil {
		t.Fatal(err)
	}
	// 이 테스트 프로세스는 실행 중이다.
	lock := filepath.Join(former, "process.lock")
	if err := os.WriteFile(lock, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		t.Fatal(err)
	}
	moved, err := sok.MoveFormerConfigDir(base, "com.soksak.former", "app.soksak.current")
	want := fmt.Sprintf("%s is in use by process %d; quit that application first", former, os.Getpid())
	if moved != "" || err == nil || err.Error() != want {
		t.Fatalf("moved %q err %v want %q", moved, err, want)
	}
	if _, err := os.Lstat(current); !os.IsNotExist(err) {
		t.Fatalf("the current directory exists: %v", err)
	}
	// 끝난 프로세스의 lock 은 폴더와 함께 옮겨진다.
	ended := exec.Command("true")
	if err := ended.Run(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lock, []byte(strconv.Itoa(ended.Process.Pid)), 0o600); err != nil {
		t.Fatal(err)
	}
	moved, err = sok.MoveFormerConfigDir(base, "com.soksak.former", "app.soksak.current")
	if err != nil || moved != former {
		t.Fatalf("moved %q err %v", moved, err)
	}
	if _, err := os.Lstat(filepath.Join(current, "process.lock")); err != nil {
		t.Fatalf("the ended lock did not move: %v", err)
	}
}
