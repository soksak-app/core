package sok

// Reads registry indexes and releases from a location (docs/spec/installation.md#fetching). A location is an https: URL
// or an absolute file: URL. https: uses TLS with the certificate authorities that the operating system trusts, follows
// redirects only to https: and at most 5 times, and rejects a response other than 200, a body larger than the limit and
// a request slower than the limit with the specified sentence. Nothing is stored.

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Limit is the limit of the body size and the time of one request.
type Limit struct {
	Bytes   int64
	Timeout time.Duration
}

// Fetcher reads a location. When TLS is nil, it uses the certificate authorities that the operating system trusts. A
// check gives it its own certificate authority and small limits.
type Fetcher struct {
	TLS     *tls.Config
	Index   Limit
	Release Limit
}

// maxRedirects is the maximum number of redirects that are followed.
const maxRedirects = 5

// DefaultFetcher is the Fetcher that uses the limits of the specification.
var DefaultFetcher = Fetcher{
	Index:   Limit{Bytes: 8 << 20, Timeout: 60 * time.Second},
	Release: Limit{Bytes: 256 << 20, Timeout: 600 * time.Second},
}

// errRedirect is a redirect that cannot be followed. Its sentence becomes the error unchanged.
type errRedirect struct{ text string }

func (e errRedirect) Error() string { return e.text }

// CheckLocation checks that the location is an https: URL or an absolute file: URL.
func CheckLocation(location string) error {
	if strings.HasPrefix(location, "https:") {
		parsed, err := url.Parse(location)
		if err != nil || parsed.Host == "" || parsed.Scheme != "https" {
			return fmt.Errorf("%s: the URL must be https: or an absolute file: URL", location)
		}
		return nil
	}
	if strings.HasPrefix(location, "file:") {
		if _, err := FilePath(location); err != nil {
			return fmt.Errorf("%s: %w", location, err)
		}
		return nil
	}
	return fmt.Errorf("%s: the URL must be https: or an absolute file: URL", location)
}

// Read reads the body of the location within limit.
func (f Fetcher) Read(location string, limit Limit) ([]byte, error) {
	if err := CheckLocation(location); err != nil {
		return nil, err
	}
	if strings.HasPrefix(location, "file:") {
		path, err := FilePath(location)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", location, err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fileError(path, err)
		}
		return data, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), limit.Timeout)
	defer cancel()
	client := &http.Client{
		Transport: &http.Transport{TLSClientConfig: f.TLS, Proxy: http.ProxyFromEnvironment},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if req.URL.Scheme != "https" {
				return errRedirect{fmt.Sprintf("%s: redirect to %s is not https", location, req.URL)}
			}
			if len(via) > maxRedirects {
				return errRedirect{fmt.Sprintf("%s: more than %d redirects", location, maxRedirects)}
			}
			return nil
		},
	}
	defer client.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, location, nil)
	if err != nil {
		return nil, fmt.Errorf("%s: the URL must be https: or an absolute file: URL", location)
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, f.failure(location, limit, ctx, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %d", location, response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit.Bytes+1))
	if err != nil {
		return nil, f.failure(location, limit, ctx, err)
	}
	if int64(len(data)) > limit.Bytes {
		return nil, fmt.Errorf("%s: larger than %d bytes", location, limit.Bytes)
	}
	return data, nil
}

// failure turns a request error into the sentence of the specification.
func (f Fetcher) failure(location string, limit Limit, ctx context.Context, err error) error {
	var redirect errRedirect
	if errors.As(err, &redirect) {
		return redirect
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("%s: timed out after %d s", location, int(limit.Timeout/time.Second))
	}
	var urlError *url.Error
	if errors.As(err, &urlError) {
		err = urlError.Err
	}
	return fmt.Errorf("%s: cannot connect: %v", location, err)
}
