package transport

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"spackt/internal/transport/wire"
	"time"
)

func CheckReadiness(ctx context.Context, rawURL string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	client := &http.Client{
		Timeout: 2 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1025))
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("readiness returned %d", resp.StatusCode)
	}
	if len(body) > 1024 {
		return errors.New("readiness body is too large")
	}
	if err := rejectDuplicateReadinessKeys(body); err != nil {
		return err
	}
	decoded, err := wire.Decode("readiness", body)
	if err != nil {
		return err
	}
	if decoded["status"] != "ok" {
		return errors.New("readiness status is not ok")
	}
	return nil
}

func rejectDuplicateReadinessKeys(body []byte) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	token, err := dec.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok || delimiter != '{' {
		return errors.New("readiness body must be an object")
	}
	seen := map[string]bool{}
	for dec.More() {
		token, err := dec.Token()
		if err != nil {
			return err
		}
		key, ok := token.(string)
		if !ok {
			return errors.New("readiness object key is invalid")
		}
		if seen[key] {
			return errors.New("readiness body has duplicate fields")
		}
		seen[key] = true
		var value any
		if err := dec.Decode(&value); err != nil {
			return err
		}
	}
	token, err = dec.Token()
	if err != nil {
		return err
	}
	delimiter, ok = token.(json.Delim)
	if !ok || delimiter != '}' {
		return errors.New("readiness body is invalid")
	}
	if token, err = dec.Token(); err != io.EOF {
		return errors.New("readiness body has trailing data")
	}
	return nil
}
