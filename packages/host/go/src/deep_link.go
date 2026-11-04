package host

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"unicode/utf8"
)

// deepLinkScheme is the URL scheme of deep links (docs/spec/native-host.md#deep-links).
const deepLinkScheme = "soksak"

// deepLinkMaxLength is the maximum number of characters of a deep link URL.
const deepLinkMaxLength = 8192

// errInvalidPercent is the refusal of a query that holds an invalid percent-encoding.
var errInvalidPercent = errors.New("invalid percent-encoding")

// DeepLink is a parsed deep link: the declared command <owner>.<command> and its string parameters.
type DeepLink struct {
	Owner   string
	Command string
	Params  map[string]string
}

// Name is the declared command name of the link.
func (l DeepLink) Name() string { return l.Owner + "." + l.Command }

// ParseDeepLink parses the URL value of a deep link. An error text is the reason of the refusal.
func ParseDeepLink(value string) (DeepLink, error) {
	if utf8.RuneCountInString(value) > deepLinkMaxLength {
		return DeepLink{}, fmt.Errorf("URL is longer than %d characters", deepLinkMaxLength)
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return DeepLink{}, errors.New("URL does not parse")
	}
	if parsed.Scheme != deepLinkScheme {
		return DeepLink{}, fmt.Errorf("scheme %q is not soksak", parsed.Scheme)
	}
	if parsed.Host == "" {
		return DeepLink{}, errors.New("owner is missing")
	}
	command := strings.TrimPrefix(parsed.EscapedPath(), "/")
	if command == "" {
		return DeepLink{}, errors.New("command is missing")
	}
	if strings.Contains(command, "/") {
		return DeepLink{}, errors.New("command has more than one segment")
	}
	params, err := deepLinkParams(parsed.RawQuery)
	if err != nil {
		return DeepLink{}, err
	}
	return DeepLink{Owner: parsed.Host, Command: command, Params: params}, nil
}

// deepLinkParams splits the raw query into its parameters. An empty segment is skipped. A name that is empty or repeats is refused.
func deepLinkParams(raw string) (map[string]string, error) {
	params := map[string]string{}
	for _, segment := range strings.Split(raw, "&") {
		if segment == "" {
			continue
		}
		// default: a segment without `=` is a name with an empty value, as in the query of a form.
		rawName, rawValue, _ := strings.Cut(segment, "=")
		name, err := decodeComponent(rawName)
		if err != nil {
			return nil, err
		}
		if name == "" {
			return nil, errors.New("parameter name is empty")
		}
		if _, repeated := params[name]; repeated {
			return nil, fmt.Errorf("parameter %s is repeated", name)
		}
		value, err := decodeComponent(rawValue)
		if err != nil {
			return nil, err
		}
		params[name] = value
	}
	return params, nil
}

// decodeComponent decodes a query name or value: `+` is a space and each percent sign is followed by two hexadecimal digits.
// The decoded text must be valid UTF-8.
func decodeComponent(raw string) (string, error) {
	decoded := make([]byte, 0, len(raw))
	for i := 0; i < len(raw); i++ {
		switch raw[i] {
		case '+':
			decoded = append(decoded, ' ')
		case '%':
			if i+2 >= len(raw) || !isHexDigit(raw[i+1]) || !isHexDigit(raw[i+2]) {
				return "", errInvalidPercent
			}
			decoded = append(decoded, unhex(raw[i+1])<<4|unhex(raw[i+2]))
			i += 2
		default:
			decoded = append(decoded, raw[i])
		}
	}
	if !utf8.Valid(decoded) {
		return "", errInvalidPercent
	}
	return string(decoded), nil
}

func isHexDigit(c byte) bool {
	return ('0' <= c && c <= '9') || ('a' <= c && c <= 'f') || ('A' <= c && c <= 'F')
}

func unhex(c byte) byte {
	switch {
	case '0' <= c && c <= '9':
		return c - '0'
	case 'a' <= c && c <= 'f':
		return c - 'a' + 10
	default:
		return c - 'A' + 10
	}
}

// DeepLinkQueue holds the deep links that arrive before the first window is ready and runs them in arrival order.
// The zero value holds no link and is not ready. A link that arrives after the first window is ready runs at once.
type DeepLinkQueue struct {
	mu       sync.Mutex
	pending  []string
	draining bool
	ready    bool
}

// Keep runs the value with run at once when the first window is ready. Before that it holds the value.
func (q *DeepLinkQueue) Keep(value string, run func(string)) {
	q.mu.Lock()
	if q.ready {
		q.mu.Unlock()
		run(value)
		return
	}
	q.pending = append(q.pending, value)
	q.mu.Unlock()
}

// Ready runs the held links in arrival order and marks the queue ready. A link that arrives while the held links run
// is held too, so it runs after them. A call after the first one does nothing.
func (q *DeepLinkQueue) Ready(run func(string)) {
	q.mu.Lock()
	if q.ready || q.draining {
		q.mu.Unlock()
		return
	}
	q.draining = true
	for len(q.pending) > 0 {
		value := q.pending[0]
		q.pending = q.pending[1:]
		q.mu.Unlock()
		run(value)
		q.mu.Lock()
	}
	q.ready = true
	q.draining = false
	q.mu.Unlock()
}

// openDeepLink runs the deep link value once the first window is ready (docs/spec/native-host.md#deep-links). It is not
// exported: an exported method of Host is a call of the entrance, and this value is not a call argument.
func (h *Host) openDeepLink(value string) {
	h.deepLinks.Keep(value, h.runDeepLink)
}

// runDeepLink runs the deep link value as the declared command of the key window, or of the first window when none is key.
// A refusal is written once as the error host deep link (docs/spec/native-host.md#deep-links).
func (h *Host) runDeepLink(value string) {
	link, err := ParseDeepLink(value)
	if err != nil {
		LogError("deep link", fmt.Sprintf("%s: %s", value, err))
		return
	}
	windows := hostBackend{h}.Windows()
	if len(windows) == 0 {
		LogError("deep link", fmt.Sprintf("%s: no window is open", value))
		return
	}
	window := windows[0].Window
	for _, entry := range windows {
		if entry.Key {
			window = entry.Window
			break
		}
	}
	params, err := json.Marshal(map[string]any{"window": window, "name": link.Name(), "params": link.Params})
	if err != nil {
		LogError("deep link", fmt.Sprintf("%s: %s", value, err))
		return
	}
	if _, err := commandRun(h.endpoint, nil, params); err != nil {
		LogError("deep link", fmt.Sprintf("%s: %s", value, err))
	}
}
