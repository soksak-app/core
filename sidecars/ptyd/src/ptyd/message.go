package ptyd

import (
	"encoding/json"
	"fmt"
)

// Request는 클라이언트가 보내는 JSON 요청이다.
type Request struct {
	Command   string            `json:"command"`
	Hint      string            `json:"hint,omitempty"`
	Program   string            `json:"program,omitempty"`
	Args      []string          `json:"args,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	Cwd       string            `json:"cwd,omitempty"`
	Cols      int               `json:"cols,omitempty"`
	Rows      int               `json:"rows,omitempty"`
	SessionID string            `json:"sessionId,omitempty"`
	Data      string            `json:"data,omitempty"`
	Name      string            `json:"name,omitempty"`
	From      int64             `json:"from,omitempty"`
}

// Response는 데몬이 보내는 JSON 응답이다 (요청-응답용).
type Response struct {
	Command     string        `json:"command,omitempty"`
	SessionID   string        `json:"sessionId,omitempty"`
	DefaultCols int           `json:"defaultCols,omitempty"`
	DefaultRows int           `json:"defaultRows,omitempty"`
	Sessions    []SessionInfo `json:"sessions,omitempty"`
	Error       string        `json:"error,omitempty"`
}

// OutputMessage는 링의 output 항목을 소비자에게 보내는 메시지다.
type OutputMessage struct {
	Command   string `json:"command"`
	SessionID string `json:"sessionId"`
	Sequence  int64  `json:"sequence"`
	Output    string `json:"output"`
	Truncated bool   `json:"truncated"`
}

// ResizeMessage는 링의 resize 항목을 소비자에게 보내는 메시지다.
type ResizeMessage struct {
	Command   string `json:"command"`
	SessionID string `json:"sessionId"`
	Sequence  int64  `json:"sequence"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
	Truncated bool   `json:"truncated"`
}

// ExitMessage는 세션 종료를 소비자에게 보내는 메시지다.
type ExitMessage struct {
	Command   string `json:"command"`
	SessionID string `json:"sessionId"`
	Code      int    `json:"code"`
}

// SessionInfo는 list 응답에서 세션 정보.
type SessionInfo struct {
	SessionID string `json:"sessionId"`
	Consumers int    `json:"consumers"`
	Closed    bool   `json:"closed"`
}

// ParseRequest는 JSON 라인을 파싱한다.
func ParseRequest(line []byte) (Request, error) {
	var req Request
	if err := json.Unmarshal(line, &req); err != nil {
		return req, fmt.Errorf("invalid JSON: %w", err)
	}
	if req.Command == "" {
		return req, fmt.Errorf("missing command")
	}
	return req, nil
}

// EncodeResponse는 Response를 JSON으로 인코딩한다.
func EncodeResponse(resp Response) ([]byte, error) {
	return json.Marshal(resp)
}
