package sok

// registry index 와 release 를 위치에서 읽는다(docs/spec/installation.md#fetching). 위치는 https: URL 이나 절대
// file: URL 이다. https: 는 운영체제가 신뢰하는 인증 기관으로 TLS 를 쓰고, https: 로의 redirect 만 5 번까지 따라가며,
// 200 이 아닌 응답, 한도보다 큰 본문, 한도보다 느린 요청을 정한 문장으로 거부한다. 아무것도 저장해 두지 않는다.

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

// Limit 은 한 요청의 본문 크기와 시간의 한도다.
type Limit struct {
	Bytes   int64
	Timeout time.Duration
}

// Fetcher 는 위치를 읽는다. TLS 가 nil 이면 운영체제가 신뢰하는 인증 기관을 쓴다. 검사는 자기 인증 기관과 작은
// 한도를 준다.
type Fetcher struct {
	TLS     *tls.Config
	Index   Limit
	Release Limit
}

// maxRedirects 는 따라가는 redirect 의 최대 수다.
const maxRedirects = 5

// DefaultFetcher 는 명세의 한도를 쓰는 Fetcher 다.
var DefaultFetcher = Fetcher{
	Index:   Limit{Bytes: 8 << 20, Timeout: 60 * time.Second},
	Release: Limit{Bytes: 256 << 20, Timeout: 600 * time.Second},
}

// errRedirect 는 따를 수 없는 redirect 다. 문장은 그대로 오류가 된다.
type errRedirect struct{ text string }

func (e errRedirect) Error() string { return e.text }

// CheckLocation 은 위치가 https: URL 이나 절대 file: URL 인지 검사한다.
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

// Read 는 위치의 본문을 limit 안에서 읽는다.
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

// failure 는 요청 오류를 명세의 문장으로 바꾼다.
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
