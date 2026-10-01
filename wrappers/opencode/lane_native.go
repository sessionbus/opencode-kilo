// SPDX-License-Identifier: MIT

package opencode

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// nativeClient speaks the public OpenCode v2 HTTP API of one native server.
type nativeClient struct {
	base string
	auth string
	http *http.Client
}

// nativeStatus is a native answer that is not success.
type nativeStatus struct {
	code int
	tag  string
	body string
}

// refused reports a declared native error raised before native admits the
// input: unauthorized, unknown session, invalid request or an ID conflict.
// Any other failure can follow admission (native wakes the session after
// admitting), so its outcome stays unknown.
func (e *nativeStatus) refused() bool {
	switch {
	case e.code == 401 && e.tag == "UnauthorizedError",
		e.code == 404 && e.tag == "SessionNotFoundError",
		e.code == 400 && e.tag == "InvalidRequestError",
		e.code == 409 && e.tag == "ConflictError":
		return true
	}
	return false
}

func (e *nativeStatus) Error() string {
	return fmt.Sprintf("OpenCode answered %d: %s", e.code, e.body)
}

// call sends one JSON request. A non-2xx answer is a *nativeStatus; any other
// error leaves the native outcome unknown.
func (c *nativeClient) call(ctx context.Context, method, path string, body, out any) error {
	var payload io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = bytes.NewReader(b)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.base+path, payload)
	if err != nil {
		return err
	}
	request.Header.Set("authorization", c.auth)
	if body != nil {
		request.Header.Set("content-type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	b, err := io.ReadAll(io.LimitReader(response.Body, maxNativeResponse+1))
	if err != nil {
		return err
	}
	if len(b) > maxNativeResponse {
		return errors.New("OpenCode response exceeds limit")
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		var declared struct {
			Tag string `json:"_tag"`
		}
		_ = json.Unmarshal(b, &declared)
		return &nativeStatus{code: response.StatusCode, tag: declared.Tag, body: strings.TrimSpace(string(b[:min(len(b), 512)]))}
	}
	if out == nil || len(b) == 0 {
		return nil
	}
	return json.Unmarshal(b, out)
}

type nativeEvent struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

// events reads the native event stream until it ends or ctx ends. The stream
// is lossy for slow readers, so handle must not block.
func (c *nativeClient) events(ctx context.Context, handle func(nativeEvent)) error {
	request, err := http.NewRequestWithContext(ctx, "GET", c.base+"/api/event", nil)
	if err != nil {
		return err
	}
	request.Header.Set("authorization", c.auth)
	stream := *c.http
	stream.Timeout = 0
	response, err := stream.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return &nativeStatus{code: response.StatusCode, body: "event stream refused"}
	}
	scan := bufio.NewScanner(response.Body)
	scan.Buffer(make([]byte, 64<<10), maxNativeResponse)
	for scan.Scan() {
		line, ok := strings.CutPrefix(scan.Text(), "data: ")
		if !ok {
			continue
		}
		var event nativeEvent
		if json.Unmarshal([]byte(line), &event) != nil || event.Type == "" {
			return errors.New("malformed OpenCode event")
		}
		handle(event)
	}
	if err := scan.Err(); err != nil {
		return err
	}
	return errors.New("OpenCode event stream ended")
}

const (
	maxNativeResponse = 16 << 20
	maxNativeInput    = 2 << 20
	idAlphabet        = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
)

// messageIDs mints native message IDs in native's own ascending format:
// "msg_", 12 hex digits of millisecond*4096+counter, 14 random base62.
type messageIDs struct {
	mu      sync.Mutex
	last    int64
	counter int64
}

func (m *messageIDs) next() (string, error) {
	m.mu.Lock()
	now := time.Now().UnixMilli()
	if now != m.last {
		m.last, m.counter = now, 0
	}
	m.counter++
	value := now*0x1000 + m.counter
	m.mu.Unlock()
	random := make([]byte, 14)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	for i, b := range random {
		random[i] = idAlphabet[int(b)%len(idAlphabet)]
	}
	return fmt.Sprintf("msg_%012x%s", value&0xffffffffffff, random), nil
}
