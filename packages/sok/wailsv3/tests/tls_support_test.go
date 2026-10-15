package tests

// The Fetcher that trusts the TLS server of a check, shared by the checks that read https locations. It uses no external
// network.

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"time"

	sok "github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// tlsFetcher is a Fetcher that trusts the certificate of the server and uses small limits.
func tlsFetcher(server *httptest.Server) sok.Fetcher {
	transport := server.Client().Transport.(*http.Transport)
	return sok.Fetcher{
		TLS:     &tls.Config{RootCAs: transport.TLSClientConfig.RootCAs},
		Index:   sok.Limit{Bytes: 16, Timeout: time.Second},
		Release: sok.Limit{Bytes: 16, Timeout: time.Second},
	}
}
