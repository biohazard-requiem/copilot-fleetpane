//go:build unix

package theme

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestLoadRejectsAFIFOWithoutBlocking(t *testing.T) {
	dir := t.TempDir()
	fifo := filepath.Join(dir, "pipe.json")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := Load("pipe", dir)
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Error("Load succeeded, want an error")
		} else if !strings.Contains(err.Error(), "regular file") {
			t.Errorf("error = %q, want it to say the file is not a regular file", err)
		}
	case <-time.After(2 * time.Second):
		// Opening a FIFO for reading waits for a writer: provide one so
		// the goroutine does not outlive the test.
		if w, err := os.OpenFile(fifo, os.O_WRONLY|syscall.O_NONBLOCK, 0); err == nil {
			w.Close()
		}
		t.Fatal("Load blocks on a FIFO")
	}
}
