package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var serverBinary struct {
	path string
	err  error
}

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "spackt-server-test-*")
	if err != nil {
		serverBinary.err = err
		os.Exit(m.Run())
	}
	serverBinary.path = filepath.Join(dir, "spackt-server")
	build := exec.Command("go", "build", "-o", serverBinary.path, "./cmd/server")
	build.Dir = "../.."
	if output, err := build.CombinedOutput(); err != nil {
		serverBinary.err = fmt.Errorf("build server: %w\n%s", err, output)
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func TestMainUsesPortEnvironmentAsDefaultAddress(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	addr := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	cmd, cancel, markWaited := startServerProcess(t, []string{"PORT=" + portFromAddress(t, addr)})
	defer cancel()

	waitForHTTPStatus(t, "http://"+addr+"/healthz", http.StatusOK)
	if err := cmd.Process.Signal(os.Interrupt); err != nil {
		t.Fatalf("signal server: %v", err)
	}
	err = cmd.Wait()
	markWaited()
	if err != nil {
		t.Fatalf("server exit after interrupt: %v", err)
	}
}

func TestMainRejectsInvalidEnvironmentBeforeListening(t *testing.T) {
	addr := freeAddress(t)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, builtServerBinary(t), "-addr", addr)
	cmd.Env = testEnv("SPACKT_HISTORY_MINUTES=bad")
	output, err := cmd.CombinedOutput()

	if ctx.Err() == context.DeadlineExceeded {
		t.Fatalf("server did not exit promptly for invalid environment; output:\n%s", output)
	}
	if err == nil {
		t.Fatalf("server exited successfully for invalid environment; output:\n%s", output)
	}
	if isServing("http://" + addr + "/healthz") {
		t.Fatalf("server accepted traffic after invalid environment")
	}
}

func TestHealthcheckUsesReadyzFromPortEnvironment(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/readyz" {
			t.Fatalf("path = %q, want /readyz", r.URL.Path)
		}
		io.WriteString(w, `{"status":"ok"}`)
	}))
	defer target.Close()

	cmd := healthcheckCommand(t)
	cmd.Env = testEnv("PORT=" + portFromURL(t, target.URL))
	output, err := cmd.CombinedOutput()

	if err != nil {
		t.Fatalf("healthcheck failed; output:\n%s", output)
	}
}

func TestHealthcheckUsesExplicitTargetURL(t *testing.T) {
	target := healthcheckTarget(t, http.StatusOK, `{"status":"ok"}`)

	cmd := healthcheckCommand(t, "-healthcheck-url", target.URL+"/readyz")
	output, err := cmd.CombinedOutput()

	if err != nil {
		t.Fatalf("healthcheck failed; output:\n%s", output)
	}
}

func TestHealthcheckAcceptsFormattedReadinessJSON(t *testing.T) {
	target := healthcheckTarget(t, http.StatusOK, "{\n  \"status\": \"ok\"\n}")

	cmd := healthcheckCommand(t, "-healthcheck-url", target.URL+"/readyz")
	output, err := cmd.CombinedOutput()

	if err != nil {
		t.Fatalf("healthcheck failed for formatted readiness JSON; output:\n%s", output)
	}
}

func TestHealthcheckAcceptsEscapedReadinessJSON(t *testing.T) {
	target := healthcheckTarget(t, http.StatusOK, `{"st\u0061tus":"\u006fk"}`)

	cmd := healthcheckCommand(t, "-healthcheck-url", target.URL+"/readyz")
	output, err := cmd.CombinedOutput()

	if err != nil {
		t.Fatalf("healthcheck failed for escaped readiness JSON; output:\n%s", output)
	}
}

func TestHealthcheckIgnoresMarketEnvironmentSettings(t *testing.T) {
	target := healthcheckTarget(t, http.StatusOK, `{"status":"ok"}`)

	cmd := healthcheckCommand(t, "-healthcheck-url", target.URL+"/readyz")
	cmd.Env = testEnv("SPACKT_HISTORY_MINUTES=bad")
	output, err := cmd.CombinedOutput()

	if err != nil {
		t.Fatalf("healthcheck failed with invalid market env; output:\n%s", output)
	}
}

func TestHealthcheckRejectsNonOKStatus(t *testing.T) {
	target := healthcheckTarget(t, http.StatusServiceUnavailable, `{"status":"not_ready"}`)

	err := runHealthcheckExpectFailure(t, target.URL+"/readyz")

	if err == nil {
		t.Fatalf("healthcheck succeeded for 503 target, want non-zero exit")
	}
	target.assertHit(t)
}

func TestHealthcheckRejectsRedirects(t *testing.T) {
	hit := make(chan struct{}, 1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		markHit(hit)
		http.Redirect(w, r, "/readyz", http.StatusFound)
	}))
	defer target.Close()

	err := runHealthcheckExpectFailure(t, target.URL+"/redirect")

	if err == nil {
		t.Fatalf("healthcheck succeeded for redirect target, want non-zero exit")
	}
	assertHit(t, hit)
}

func TestHealthcheckRejectsMalformedReadinessBody(t *testing.T) {
	target := healthcheckTarget(t, http.StatusOK, `{"status":"ready"}`)

	err := runHealthcheckExpectFailure(t, target.URL+"/readyz")

	if err == nil {
		t.Fatalf("healthcheck succeeded for malformed readiness body, want non-zero exit")
	}
	target.assertHit(t)
}

func TestHealthcheckRejectsDuplicateStatusKeys(t *testing.T) {
	target := healthcheckTarget(t, http.StatusOK, `{"status":"bad","status":"ok"}`)

	err := runHealthcheckExpectFailure(t, target.URL+"/readyz")

	if err == nil {
		t.Fatalf("healthcheck succeeded for duplicate status keys, want non-zero exit")
	}
	target.assertHit(t)
}

func TestHealthcheckRejectsExtraReadinessJSON(t *testing.T) {
	target := healthcheckTarget(t, http.StatusOK, `{"status":"ok"} {}`)

	err := runHealthcheckExpectFailure(t, target.URL+"/readyz")

	if err == nil {
		t.Fatalf("healthcheck succeeded for extra readiness JSON, want non-zero exit")
	}
	target.assertHit(t)
}

func TestHealthcheckRejectsUnknownReadinessFields(t *testing.T) {
	target := healthcheckTarget(t, http.StatusOK, `{"status":"ok","extra":true}`)

	err := runHealthcheckExpectFailure(t, target.URL+"/readyz")

	if err == nil {
		t.Fatalf("healthcheck succeeded for unknown readiness fields, want non-zero exit")
	}
	target.assertHit(t)
}

func TestHealthcheckRejectsOversizedReadinessBody(t *testing.T) {
	target := healthcheckTarget(t, http.StatusOK, strings.Repeat("x", 1025))

	err := runHealthcheckExpectFailure(t, target.URL+"/readyz")

	if err == nil {
		t.Fatalf("healthcheck succeeded for oversized readiness body, want non-zero exit")
	}
	target.assertHit(t)
}

func TestHealthcheckRejectsRefusedConnections(t *testing.T) {
	addr := freeAddress(t)

	err := runHealthcheckExpectFailure(t, "http://"+addr+"/readyz")

	if err == nil {
		t.Fatalf("healthcheck succeeded for refused connection, want non-zero exit")
	}
}

func builtServerBinary(t *testing.T) string {
	t.Helper()
	if serverBinary.err != nil {
		t.Fatal(serverBinary.err)
	}
	return serverBinary.path
}

func healthcheckCommand(t *testing.T, args ...string) *exec.Cmd {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	t.Cleanup(cancel)
	cmdArgs := append([]string{"-healthcheck"}, args...)
	return exec.CommandContext(ctx, builtServerBinary(t), cmdArgs...)
}

func runHealthcheckExpectFailure(t *testing.T, target string) error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, builtServerBinary(t), "-healthcheck", "-healthcheck-url", target)
	output, err := cmd.CombinedOutput()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		t.Fatalf("healthcheck timed out; output:\n%s", output)
	}
	if strings.Contains(string(output), "flag provided but not defined") {
		t.Fatalf("healthcheck flag is not implemented; output:\n%s", output)
	}
	return err
}

type healthTarget struct {
	*httptest.Server
	hit chan struct{}
}

func (h *healthTarget) assertHit(t *testing.T) {
	t.Helper()
	assertHit(t, h.hit)
}

func healthcheckTarget(t *testing.T, status int, body string) *healthTarget {
	t.Helper()
	hit := make(chan struct{}, 1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		markHit(hit)
		if r.URL.Path != "/readyz" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(status)
		io.WriteString(w, body)
	}))
	t.Cleanup(target.Close)
	return &healthTarget{Server: target, hit: hit}
}

func startServerProcess(t *testing.T, env []string) (*exec.Cmd, context.CancelFunc, func()) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	cmd := exec.CommandContext(ctx, builtServerBinary(t))
	cmd.Env = testEnv(env...)
	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatalf("start server: %v", err)
	}
	waited := false
	t.Cleanup(func() {
		if waited {
			return
		}
		cancel()
		if err := cmd.Wait(); err != nil && ctx.Err() == nil {
			t.Errorf("reap server process: %v", err)
		}
	})
	return cmd, cancel, func() { waited = true }
}

func testEnv(values ...string) []string {
	env := make([]string, 0, len(os.Environ())+len(configEnvDefaults())+1)
	for _, entry := range os.Environ() {
		key := envKey(entry)
		if key == "PORT" || strings.HasPrefix(key, "SPACKT_") || key == "GOCACHE" {
			continue
		}
		env = append(env, entry)
	}
	merged := configEnvDefaults()
	for _, entry := range values {
		key := envKey(entry)
		merged[key] = strings.TrimPrefix(entry, key+"=")
	}
	for _, key := range configEnvKeys() {
		env = append(env, key+"="+merged[key])
	}
	env = append(env, "GOCACHE=/tmp/spackt-go-cache")
	return env
}

func configEnvDefaults() map[string]string {
	return map[string]string{
		"PORT":                             "8080",
		"SPACKT_SEED":                      "7",
		"SPACKT_EPOCH_MS":                  "0",
		"SPACKT_HISTORY_MINUTES":           "1",
		"SPACKT_ALLOWED_ORIGINS":           "http://localhost:3000,http://127.0.0.1:3000",
		"SPACKT_DEBUG_CONTROLS":            "true",
		"SPACKT_MAX_CONNECTIONS":           "100",
		"SPACKT_MARKET_FRAME_BUDGET_BYTES": "1048576",
		"SPACKT_BOOK_CHANGES":              "4096",
	}
}

func configEnvKeys() []string {
	return []string{
		"PORT",
		"SPACKT_SEED",
		"SPACKT_EPOCH_MS",
		"SPACKT_HISTORY_MINUTES",
		"SPACKT_ALLOWED_ORIGINS",
		"SPACKT_DEBUG_CONTROLS",
		"SPACKT_MAX_CONNECTIONS",
		"SPACKT_MARKET_FRAME_BUDGET_BYTES",
		"SPACKT_BOOK_CHANGES",
	}
}

func envKey(entry string) string {
	key, _, _ := strings.Cut(entry, "=")
	return key
}

func freeAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	addr := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	return addr
}

func portFromAddress(t *testing.T, addr string) string {
	t.Helper()
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("SplitHostPort(%q): %v", addr, err)
	}
	return port
}

func portFromURL(t *testing.T, raw string) string {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("Parse(%q): %v", raw, err)
	}
	return portFromAddress(t, parsed.Host)
}

func waitForHTTPStatus(t *testing.T, raw string, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	client := &http.Client{Timeout: 100 * time.Millisecond}
	var lastErr error
	for time.Now().Before(deadline) {
		resp, err := client.Get(raw)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == want {
				return
			}
			lastErr = fmt.Errorf("status %d", resp.StatusCode)
		} else {
			lastErr = err
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("GET %s did not return %d: %v", raw, want, lastErr)
}

func isServing(raw string) bool {
	client := &http.Client{Timeout: 100 * time.Millisecond}
	resp, err := client.Get(raw)
	if err != nil {
		return false
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
	return true
}

func markHit(hit chan struct{}) {
	select {
	case hit <- struct{}{}:
	default:
	}
}

func assertHit(t *testing.T, hit chan struct{}) {
	t.Helper()
	select {
	case <-hit:
	default:
		t.Fatalf("healthcheck did not contact the target")
	}
}
