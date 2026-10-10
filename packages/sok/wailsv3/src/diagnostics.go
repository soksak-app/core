//go:build diagnostics

package sok

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
)

// Commands of the diagnostic build (docs/spec/cli.md). The sok of a regular build has no diagnostic methods.

func init() {
	captureRequest = func(window string) (request, error) {
		return request{method: "diagnostics.capture.still", params: compact("window", window)}, nil
	}
}

// UseRegistryAuthorities makes the registry download trust only the certificate authorities that the PEM file at path
// holds. The host of a diagnostic build calls it registry-ca (docs/spec/hosts.md#application-arguments).
func UseRegistryAuthorities(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fileError(path, err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(data) {
		return fmt.Errorf("%s: the file holds no certificate", path)
	}
	DefaultFetcher.TLS = &tls.Config{RootCAs: pool}
	return nil
}
