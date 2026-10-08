package tests

// 위치를 읽는 규칙(docs/spec/installation.md#fetching)을 검사 소유의 TLS server 로 검사한다. 외부 network 는 쓰지 않는다.

import (
	"crypto/tls"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/soksak-app/core/packages/sok/wailsv3/src"
)

// tlsFetcher 는 server 의 인증서를 신뢰하고 작은 한도를 쓰는 Fetcher 다.
func tlsFetcher(server *httptest.Server) sok.Fetcher {
	transport := server.Client().Transport.(*http.Transport)
	return sok.Fetcher{
		TLS:     &tls.Config{RootCAs: transport.TLSClientConfig.RootCAs},
		Index:   sok.Limit{Bytes: 16, Timeout: time.Second},
		Release: sok.Limit{Bytes: 16, Timeout: time.Second},
	}
}

// contract: fetch.https.reads-a-tls-response
func TestAnHTTPSLocationIsReadOverTLS(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"format":1}`)
	}))
	defer server.Close()
	fetcher := tlsFetcher(server)
	data, err := fetcher.Read(server.URL+"/index.json", fetcher.Index)
	if err != nil || string(data) != `{"format":1}` {
		t.Fatalf("data %q err %v", data, err)
	}
	// 신뢰하지 않는 인증서는 연결하지 못한다.
	_, err = sok.DefaultFetcher.Read(server.URL+"/index.json", fetcher.Index)
	if err == nil || !strings.HasPrefix(err.Error(), server.URL+"/index.json: cannot connect: ") {
		t.Fatalf("untrusted err %v", err)
	}
}

// contract: fetch.https.redirects-only-to-https
func TestRedirectsAreFollowedOnlyToHTTPS(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var hops int
		if _, err := fmt.Sscanf(r.URL.Path, "/hop/%d", &hops); err == nil && hops > 0 {
			http.Redirect(w, r, fmt.Sprintf("/hop/%d", hops-1), http.StatusFound)
			return
		}
		if r.URL.Path == "/plain" {
			http.Redirect(w, r, "http://example.invalid/index.json", http.StatusFound)
			return
		}
		fmt.Fprint(w, "end")
	}))
	defer server.Close()
	fetcher := tlsFetcher(server)
	if data, err := fetcher.Read(server.URL+"/hop/5", fetcher.Index); err != nil || string(data) != "end" {
		t.Fatalf("five redirects: %q %v", data, err)
	}
	if _, err := fetcher.Read(server.URL+"/hop/6", fetcher.Index); err == nil || err.Error() != server.URL+"/hop/6: more than 5 redirects" {
		t.Fatalf("six redirects: %v", err)
	}
	if _, err := fetcher.Read(server.URL+"/plain", fetcher.Index); err == nil || err.Error() != server.URL+"/plain: redirect to http://example.invalid/index.json is not https" {
		t.Fatalf("plain redirect: %v", err)
	}
}

// contract: fetch.https.reports-status-size-and-timeout
func TestStatusSizeAndTimeoutFailWithTheirTexts(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/missing":
			http.NotFound(w, r)
		case "/large":
			fmt.Fprint(w, strings.Repeat("x", 17))
		case "/slow":
			time.Sleep(1500 * time.Millisecond)
			fmt.Fprint(w, "late")
		default:
			fmt.Fprint(w, strings.Repeat("x", 16))
		}
	}))
	defer server.Close()
	fetcher := tlsFetcher(server)
	cases := map[string]string{
		"/missing": "HTTP 404",
		"/large":   "larger than 16 bytes",
		"/slow":    "timed out after 1 s",
	}
	for path, want := range cases {
		if _, err := fetcher.Read(server.URL+path, fetcher.Release); err == nil || err.Error() != server.URL+path+": "+want {
			t.Fatalf("%s: %v", path, err)
		}
	}
	if data, err := fetcher.Read(server.URL+"/limit", fetcher.Release); err != nil || len(data) != 16 {
		t.Fatalf("limit: %d %v", len(data), err)
	}
}

// contract: fetch.url.rejects-other-schemes
func TestOtherSchemesAreRejected(t *testing.T) {
	for _, location := range []string{"http://example.invalid/index.json", "ftp://example.invalid/index.json", "index.json", "https:index.json"} {
		_, err := sok.DefaultFetcher.Read(location, sok.DefaultFetcher.Index)
		if err == nil || err.Error() != location+": the URL must be https: or an absolute file: URL" {
			t.Fatalf("%s: %v", location, err)
		}
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "index.json")
	if err := os.WriteFile(file, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if data, err := sok.DefaultFetcher.Read("file://"+file, sok.DefaultFetcher.Index); err != nil || string(data) != "{}" {
		t.Fatalf("file: %q %v", data, err)
	}
}

// contract: fetch.https.reads-a-tls-response
func TestRegistryUseRecordsAnHTTPSIndex(t *testing.T) {
	index := `{"format":1,"plugins":[],"sidecars":[],"packs":[],"revoked":{"plugins":[],"sidecars":[]}}`
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, index)
	}))
	defer server.Close()
	fetcher := tlsFetcher(server)
	fetcher.Index.Bytes = 1 << 20
	config := t.TempDir()
	url, err := sok.UseRegistry(config, server.URL+"/index.json", fetcher)
	if err != nil || url != server.URL+"/index.json" {
		t.Fatalf("url %q err %v", url, err)
	}
	if text := readText(t, filepath.Join(config, "plugins/registry.json")); text != `{"format":1,"index":"`+server.URL+`/index.json"}`+"\n" {
		t.Fatalf("registry.json %q", text)
	}
}
