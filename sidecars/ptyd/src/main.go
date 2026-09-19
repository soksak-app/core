// PTY 데몬 헬퍼. 데몬은 부모 프로세스와 독립되고 Unix 소켓으로 통신한다.
package main

import (
	"fmt"
	"os"
	"time"

	"github.com/min-median-max/soksak/sidecars/ptyd/src/platform"
	_ "github.com/min-median-max/soksak/sidecars/ptyd/src/platform/darwin"
	"github.com/min-median-max/soksak/sidecars/ptyd/src/ptyd"
)

func main() {
	socketDir := os.Getenv("PTYD_SOCKET_DIR")
	if socketDir == "" {
		fmt.Fprintf(os.Stderr, "ptyd: PTYD_SOCKET_DIR is required\n")
		os.Exit(2)
	}

	protocol := os.Getenv("PTYD_PROTOCOL")
	if protocol == "" {
		fmt.Fprintf(os.Stderr, "ptyd: PTYD_PROTOCOL is required\n")
		os.Exit(2)
	}

	buildKind := os.Getenv("SOKSAK_PROFILE")
	if buildKind == "" {
		fmt.Fprintf(os.Stderr, "ptyd: SOKSAK_PROFILE is required\n")
		os.Exit(2)
	}

	if buildKind != "debug" && buildKind != "release" {
		fmt.Fprintf(os.Stderr, "ptyd: SOKSAK_PROFILE must be 'debug' or 'release', got '%s'\n", buildKind)
		os.Exit(2)
	}

	idleTimeout := 60 * time.Second
	if buildKind == "release" {
		idleTimeout = 5 * time.Minute
	}
	if envTimeout := os.Getenv("PTYD_IDLE_TIMEOUT"); envTimeout != "" {
		if d, err := time.ParseDuration(envTimeout); err != nil {
			fmt.Fprintf(os.Stderr, "ptyd: invalid PTYD_IDLE_TIMEOUT '%s': %v\n", envTimeout, err)
			os.Exit(2)
		} else {
			idleTimeout = d
		}
	}

	identity := ptyd.DaemonIdentity{
		Protocol:  protocol,
		BuildKind: buildKind,
		PID:       os.Getpid(),
	}

	daemon := ptyd.NewDaemon(identity, socketDir, idleTimeout)
	if err := daemon.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "ptyd: %v\n", err)
		os.Exit(2)
	}

	// Write ready signal to stdout (before daemonizing)
	socketPath := daemon.SocketPath()
	fmt.Printf("ready %s\n", socketPath)

	plat, err := platform.Current()
	if err != nil {
		fmt.Fprintf(os.Stderr, "ptyd: %v\n", err)
		os.Exit(2)
	}

	// Setsid first
	if err := plat.Setsid(); err != nil {
		fmt.Fprintf(os.Stderr, "ptyd: setsid failed: %v\n", err)
		os.Exit(2)
	}

	// Then detach from terminal
	if err := plat.Detach(); err != nil {
		fmt.Fprintf(os.Stderr, "ptyd: detach failed: %v\n", err)
		os.Exit(2)
	}

	daemon.Wait()
}
