package host_test

import (
	"os/exec"
	"testing"
	"time"

	platform "github.com/soksak-app/core/packages/host/wailsv3/src/platform"
)

// contract: sidecars-transport.endpoint.zombie-service-does-not-exist
func TestAZombieServiceProcessDoesNotExist(t *testing.T) {
	// 기다리지 않은 스폰은 좀비로 남는다. kill(pid, 0) 은 좀비를 통과시키므로(V5-106)
	// 좀비는 존재하지 않는 것이다 — 낡은 endpoint 를 버리고 재스폰하는 판정이 좀비에
	// 막혀서는 안 된다.
	sleep := exec.Command("sleep", "30")
	if err := sleep.Start(); err != nil {
		t.Fatalf("start sleep failed: %v", err)
	}
	if err := sleep.Process.Kill(); err != nil {
		t.Fatalf("kill sleep failed: %v", err)
	}
	// 좀비가 되기를 기다린다 — 부모가 기다리지 않았으므로 죽은 뒤에도 표에 남는다.
	time.Sleep(100 * time.Millisecond)
	current, err := platform.Current()
	if err != nil {
		t.Fatalf("platform failed: %v", err)
	}
	exists, err := current.ServiceProcessExists(sleep.Process.Pid)
	if err != nil {
		t.Fatalf("inspect the zombie: %v", err)
	}
	if exists {
		t.Fatal("a zombie service process must not exist")
	}
	if err := sleep.Wait(); err == nil {
		t.Fatal("the killed sleep exited successfully")
	}
}

// 다른 사용자의 프로세스에는 신호 확인이 거부된다. 거부(EPERM)는 그 번호의 프로세스가 있다는 뜻이므로 그 service
// 프로세스는 존재한다.
// contract: sidecars-transport.endpoint.foreign-service-process-exists
func TestAServiceProcessOfAnotherUserExists(t *testing.T) {
	current, err := platform.Current()
	if err != nil {
		t.Fatalf("platform failed: %v", err)
	}
	// 1 은 root 가 실행하는 launchd 다.
	exists, err := current.ServiceProcessExists(1)
	if err != nil {
		t.Fatalf("inspect process 1: %v", err)
	}
	if !exists {
		t.Fatal("process 1 of another user must exist")
	}
}

// contract: sidecars-transport.endpoint.waits-for-the-end-of-a-service-process
func TestTheWaitForTheEndOfAServiceProcess(t *testing.T) {
	current, err := platform.Current()
	if err != nil {
		t.Fatalf("platform failed: %v", err)
	}
	ending := exec.Command("sleep", "30")
	if err := ending.Start(); err != nil {
		t.Fatalf("start sleep failed: %v", err)
	}
	time.AfterFunc(150*time.Millisecond, func() { ending.Process.Kill() })
	started := time.Now()
	ended, err := current.WaitServiceProcessEnd(ending.Process.Pid, 10*time.Second)
	if err != nil || !ended || time.Since(started) > 5*time.Second {
		t.Fatalf("a process that ends within the timeout: ended %v after %v, %v", ended, time.Since(started), err)
	}
	ending.Wait()
	running := exec.Command("sleep", "30")
	if err := running.Start(); err != nil {
		t.Fatalf("start sleep failed: %v", err)
	}
	defer func() { running.Process.Kill(); running.Wait() }()
	if ended, err := current.WaitServiceProcessEnd(running.Process.Pid, 200*time.Millisecond); err != nil || ended {
		t.Fatalf("a process that keeps running: ended %v, %v", ended, err)
	}
	if ended, err := current.WaitServiceProcessEnd(ending.Process.Pid, time.Second); err != nil || !ended {
		t.Fatalf("a process that does not exist: ended %v, %v", ended, err)
	}
}
