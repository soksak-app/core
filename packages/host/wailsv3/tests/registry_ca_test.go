//go:build diagnostics

package host_test

// 진단 build 의 --registry-ca(docs/spec/hosts.md#application-arguments)를 검사 소유 TLS server 로 검사한다.

import (
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	host "github.com/soksak-app/core/packages/host/wailsv3/src"
	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// contract: host.arguments.registry-ca-in-diagnostic-builds
func TestADiagnosticBuildTrustsTheRegistryAuthority(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "index")
	}))
	defer server.Close()
	folder := t.TempDir()
	authority := filepath.Join(folder, "ca.pem")
	if err := os.WriteFile(authority, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0o644); err != nil {
		t.Fatal(err)
	}
	empty := filepath.Join(folder, "empty.pem")
	if err := os.WriteFile(empty, []byte("no certificate\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	options, err := host.ParseArguments([]string{"--registry-ca", empty})
	if err != nil || options.RegistryCA != empty {
		t.Fatalf("parse %+v %v", options, err)
	}
	if err := host.ApplyArguments(options); err == nil || err.Error() != "--registry-ca "+empty+": the file holds no certificate" {
		t.Fatalf("empty file: %v", err)
	}
	options, err = host.ParseArguments([]string{"--registry-ca=" + authority})
	if err != nil {
		t.Fatal(err)
	}
	if err := host.ApplyArguments(options); err != nil {
		t.Fatal(err)
	}
	data, err := sok.DefaultFetcher.Read(server.URL+"/index.json", sok.DefaultFetcher.Index)
	if err != nil || string(data) != "index" {
		t.Fatalf("read %q %v", data, err)
	}
}
