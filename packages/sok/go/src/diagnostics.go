//go:build diagnostics

package sok

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
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
	// x509.CertPool.AppendCertsFromPEM skips a block that does not parse without its reason, so each block is parsed here.
	pool := x509.NewCertPool()
	count := 0
	for block, rest := pem.Decode(data); block != nil; block, rest = pem.Decode(rest) {
		if block.Type != "CERTIFICATE" {
			continue
		}
		count++
		certificate, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return fmt.Errorf("%s: certificate %d does not parse: %w", path, count, err)
		}
		pool.AddCert(certificate)
	}
	if count == 0 {
		return fmt.Errorf("%s: the file holds no certificate", path)
	}
	DefaultFetcher.TLS = &tls.Config{RootCAs: pool}
	return nil
}
