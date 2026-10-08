//go:build diagnostics

package sok

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
)

// 진단 build 의 명령(docs/spec/cli.md). 일반 build 의 sok 에는 진단 method 가 없다.

func init() {
	captureRequest = func(window string) (request, error) {
		return request{method: "diagnostics.capture.still", params: compact("window", window)}, nil
	}
}

// UseRegistryAuthorities 는 path 의 PEM 파일이 담은 인증 기관만 registry 받기가 신뢰하게 한다. 진단 build 의 host 가
// --registry-ca 로 부른다(docs/spec/hosts.md#application-arguments).
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
