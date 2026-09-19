package main

import (
	"context"
	"errors"
	"net"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestMainExitsNonZeroWhenAddressAlreadyInUse(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen occupied address: %v", err)
	}
	defer listener.Close()

	bin := filepath.Join(t.TempDir(), "spackt-server")
	build := exec.Command("go", "build", "-o", bin, "./cmd/server")
	build.Dir = "../.."
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build server: %v\n%s", err, output)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "-addr", listener.Addr().String())
	output, err := cmd.CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		t.Fatalf("server did not exit promptly when address was occupied; output:\n%s", output)
	}
	if err == nil {
		t.Fatalf("server exited successfully on occupied address, want non-zero exit; output:\n%s", output)
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("server launch failed with %T %v, want process exit error; output:\n%s", err, err, output)
	}
	if exitErr.ExitCode() == 0 {
		t.Fatalf("server exit code = 0, want non-zero; output:\n%s", output)
	}
}
