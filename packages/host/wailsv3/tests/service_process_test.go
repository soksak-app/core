package host_test

import (
	"os/exec"
	"testing"
	"time"

	platform "github.com/min-median-max/soksak/packages/host/wailsv3/src/platform"
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
	if current.ServiceProcessExists(sleep.Process.Pid) {
		t.Fatal("a zombie service process must not exist")
	}
	if err := sleep.Wait(); err == nil {
		t.Fatal("the killed sleep exited successfully")
	}
}
