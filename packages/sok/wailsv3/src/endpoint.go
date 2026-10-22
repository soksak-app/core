package sok

// Connects to the local endpoint of a running application (docs/spec/endpoint.md) and sends JSON-RPC requests. A frame
// is a 4-byte big-endian length followed by a UTF-8 JSON body.

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"

	"github.com/soksak-app/core/packages/sok/wailsv3/src/platform"
)

// MaxFrameLength is the maximum length of a frame body.
const MaxFrameLength = 16 * 1024 * 1024

// Endpoint is the endpoint.json of the configuration directory.
type Endpoint struct {
	Transport string `json:"transport"`
	Address   string `json:"address"`
	PID       int    `json:"pid"`
}

// EndpointError is a JSON-RPC error that the endpoint returned.
type EndpointError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *EndpointError) Error() string { return fmt.Sprintf("%s (%d)", e.Message, e.Code) }

// UnmarshalJSON reads an error member, which names its code and its message. A member without either is refused, so no empty
// message or code stands for it.
func (e *EndpointError) UnmarshalJSON(data []byte) error {
	var raw struct {
		Code    *int    `json:"code"`
		Message *string `json:"message"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if raw.Code == nil {
		return errors.New("invalid frame from endpoint: error has no code")
	}
	if raw.Message == nil {
		return errors.New("invalid frame from endpoint: error has no message")
	}
	e.Code, e.Message = *raw.Code, *raw.Message
	return nil
}

// ReadEndpoint reads endpoint.json of configDir and checks that its transport belongs to this platform and that its
// process is running.
func ReadEndpoint(configDir string) (Endpoint, error) {
	file := filepath.Join(configDir, "endpoint.json")
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return Endpoint{}, fmt.Errorf("%s does not exist; the application is not running", file)
	}
	if err != nil {
		return Endpoint{}, fileError(file, err)
	}
	var endpoint Endpoint
	if err := json.Unmarshal(data, &endpoint); err != nil {
		return Endpoint{}, fmt.Errorf("%s is not valid JSON: %w", file, err)
	}
	if endpoint.Address == "" || endpoint.PID <= 0 {
		return Endpoint{}, fmt.Errorf("%s has no address or pid", file)
	}
	if endpoint.Transport != "unix" {
		return Endpoint{}, fmt.Errorf("%s has transport %s; this command line connects to unix sockets", file, endpoint.Transport)
	}
	current, err := platform.Current()
	if err != nil {
		return Endpoint{}, err
	}
	if err := current.ProcessRunning(endpoint.PID); err != nil {
		return Endpoint{}, fmt.Errorf("%s names process %d, which is not running", file, endpoint.PID)
	}
	return endpoint, nil
}

// Client is one endpoint connection. It sends requests one after another and waits for each response; notifications
// that arrive in between go to Notify.
type Client struct {
	conn      net.Conn
	nextID    int
	closeOnce sync.Once
	closeErr  error
	// Notify receives the notifications that arrive while a response is awaited.
	Notify func(method string, params json.RawMessage) error
}

// Dial connects to the socket of the endpoint.
func Dial(endpoint Endpoint) (*Client, error) {
	conn, err := net.Dial("unix", endpoint.Address)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to %s: %w", endpoint.Address, err)
	}
	return &Client{conn: conn, nextID: 1}, nil
}

// Close closes the connection.
// Close closes the connection and returns its result. From the second call on, it returns the result of the first
// close.
func (c *Client) Close() error {
	c.closeOnce.Do(func() {
		if err := c.conn.Close(); err != nil {
			c.closeErr = fmt.Errorf("endpoint connection: %s", osReason(err))
		}
	})
	return c.closeErr
}

func (c *Client) write(message any) error {
	body, err := json.Marshal(message)
	if err != nil {
		return err
	}
	if len(body) > MaxFrameLength {
		return fmt.Errorf("frame length %d exceeds limit %d", len(body), MaxFrameLength)
	}
	frame := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(frame, uint32(len(body)))
	copy(frame[4:], body)
	_, err = c.conn.Write(frame)
	return err
}

type message struct {
	ID     *int            `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  *EndpointError  `json:"error"`
}

// Read reads the next message. When the connection is closed, it returns the error "endpoint connection closed".
func (c *Client) read() (message, error) {
	var header [4]byte
	if _, err := io.ReadFull(c.conn, header[:]); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return message{}, errors.New("endpoint connection closed")
		}
		return message{}, fmt.Errorf("endpoint connection failed: %w", err)
	}
	length := binary.BigEndian.Uint32(header[:])
	if length > MaxFrameLength {
		return message{}, fmt.Errorf("invalid frame from endpoint: frame length %d exceeds limit %d", length, MaxFrameLength)
	}
	body := make([]byte, length)
	if _, err := io.ReadFull(c.conn, body); err != nil {
		return message{}, errors.New("endpoint connection closed")
	}
	var m message
	if err := json.Unmarshal(body, &m); err != nil {
		return message{}, fmt.Errorf("invalid frame from endpoint: %w", err)
	}
	return m, nil
}

// Request sends the method and returns its result as the original JSON. Without a result, it returns null.
func (c *Client) Request(method string, params any) (json.RawMessage, error) {
	id := c.nextID
	c.nextID++
	request := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		request["params"] = params
	}
	if err := c.write(request); err != nil {
		return nil, err
	}
	for {
		m, err := c.read()
		if err != nil {
			return nil, err
		}
		if m.ID == nil {
			if c.Notify != nil {
				if err := c.Notify(m.Method, m.Params); err != nil {
					return nil, err
				}
			}
			continue
		}
		if *m.ID != id {
			return nil, fmt.Errorf("endpoint answered request %d while %d was pending", *m.ID, id)
		}
		if m.Error != nil {
			return nil, m.Error
		}
		if len(m.Result) == 0 {
			return json.RawMessage("null"), nil
		}
		return m.Result, nil
	}
}

// Listen passes notifications to Notify until the connection closes. The return value is the reason the connection
// ended.
func (c *Client) Listen() error {
	for {
		m, err := c.read()
		if err != nil {
			return err
		}
		if m.ID != nil {
			return fmt.Errorf("endpoint sent an answer to request %d that is not pending", *m.ID)
		}
		if c.Notify != nil {
			if err := c.Notify(m.Method, m.Params); err != nil {
				return err
			}
		}
	}
}
