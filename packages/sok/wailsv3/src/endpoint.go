package sok

// 실행 중인 애플리케이션의 로컬 엔드포인트(docs/spec/endpoint.md)에 연결해 JSON-RPC 요청을 보낸다. 프레임은 4바이트
// 빅엔디언 길이와 UTF-8 JSON 본문이다.

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"

	"github.com/min-median-max/soksak/packages/sok/wailsv3/src/platform"
)

// MaxFrameLength 는 프레임 본문의 최대 길이다.
const MaxFrameLength = 16 * 1024 * 1024

// Endpoint 는 설정 폴더의 endpoint.json 이다.
type Endpoint struct {
	Transport string `json:"transport"`
	Address   string `json:"address"`
	PID       int    `json:"pid"`
}

// EndpointError 는 엔드포인트가 돌려준 JSON-RPC 오류다.
type EndpointError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *EndpointError) Error() string { return fmt.Sprintf("%s (%d)", e.Message, e.Code) }

// ReadEndpoint 는 configDir 의 endpoint.json 을 읽고, 이 플랫폼의 transport 이며 그 프로세스가 실행 중인지 확인한다.
func ReadEndpoint(configDir string) (Endpoint, error) {
	file := filepath.Join(configDir, "endpoint.json")
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return Endpoint{}, fmt.Errorf("%s does not exist; the application is not running", file)
	}
	if err != nil {
		return Endpoint{}, err
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

// Client 는 엔드포인트 연결 하나다. 요청은 차례로 보내고 응답을 기다리며, 그 사이에 온 알림은 Notify 로 넘긴다.
type Client struct {
	conn   net.Conn
	nextID int
	// Notify 는 응답을 기다리는 동안 도착한 알림을 받는다.
	Notify func(method string, params json.RawMessage) error
}

// Dial 은 엔드포인트의 socket 에 연결한다.
func Dial(endpoint Endpoint) (*Client, error) {
	conn, err := net.Dial("unix", endpoint.Address)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to %s: %w", endpoint.Address, err)
	}
	return &Client{conn: conn, nextID: 1}, nil
}

// Close 는 연결을 닫는다.
func (c *Client) Close() error { return c.conn.Close() }

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

// Read 는 다음 메시지 하나를 읽는다. 연결이 닫히면 "endpoint connection closed" 오류다.
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

// Request 는 method 를 보내고 그 결과를 원래 JSON 그대로 돌려준다. 결과가 없으면 null 이다.
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

// Listen 은 연결이 닫힐 때까지 알림을 Notify 로 넘긴다. 반환값은 연결이 끝난 이유다.
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
