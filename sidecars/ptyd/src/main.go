// PTY 데몬 헬퍼. 데몬은 부모 프로세스와 독립되고 Unix 소켓으로 통신한다.
package main

import (
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/min-median-max/soksak/sidecars/ptyd/src/platform"
	"github.com/min-median-max/soksak/sidecars/ptyd/src/ptyd"
	_ "github.com/min-median-max/soksak/sidecars/ptyd/src/platform/darwin"
)

func main() {
	log.SetFlags(0)

	socketDir := os.Getenv("PTYD_SOCKET_DIR")
	if socketDir == "" {
		tmpDir := os.Getenv("TMPDIR")
		if tmpDir == "" {
			tmpDir = "/tmp"
		}
		socketDir = filepath.Join(tmpDir, "soksak")
	}

	protocol := os.Getenv("PTYD_PROTOCOL")
	if protocol == "" {
		protocol = "ptyd"
	}

	buildKind := os.Getenv("SOKSAK_PROFILE")
	if buildKind == "" {
		buildKind = "debug"
	}

	idleTimeout := 60 * time.Second
	if buildKind == "release" {
		idleTimeout = 5 * time.Minute
	}
	if envTimeout := os.Getenv("PTYD_IDLE_TIMEOUT"); envTimeout != "" {
		if d, err := time.ParseDuration(envTimeout); err == nil {
			idleTimeout = d
		}
	}

	identity := ptyd.DaemonIdentity{
		Protocol:  protocol,
		BuildKind: buildKind,
		PID:       os.Getpid(),
	}

	plat, err := platform.Current()
	if err != nil {
		log.Fatalf("ptyd: %v", err)
	}
	if err := plat.Daemonize(); err != nil {
		log.Fatalf("ptyd: daemonize failed: %v", err)
	}

	daemon := ptyd.NewDaemon(identity, socketDir, idleTimeout)
	if err := daemon.Start(); err != nil {
		log.Fatalf("ptyd: %v", err)
	}

	daemon.Wait()
}
