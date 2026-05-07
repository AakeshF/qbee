// QBee launcher. Cross-platform Go binary that:
//   1. Locates the bundled worker + editor relative to its own path
//   2. Picks a free localhost port + a random auth token
//   3. Spawns the worker (bundled Node + bundled SPA dist)
//   4. Waits briefly for the worker's "ready" handshake on stdout
//   5. Execs the editor with QBEE_WORKER_URL + QBEE_WORKER_AUTH set
//   6. Kills the worker when the editor exits
//
// The same source compiles for windows/amd64 and darwin/{amd64,arm64}.
// Linux uses the AppRun shell script — no need to swap that out, AppImage
// expects a script named "AppRun".

package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const readyTimeout = 5 * time.Second

func main() {
	exe, err := os.Executable()
	if err != nil {
		fail("locate self: %v", err)
	}
	exeDir := filepath.Dir(exe)

	layout, err := resolveLayout(exeDir)
	if err != nil {
		fail("resolve layout: %v", err)
	}

	// Free port via OS-assigned ephemeral binding.
	port, err := pickFreePort()
	if err != nil {
		fail("free port: %v", err)
	}

	token, err := randomToken(16)
	if err != nil {
		fail("random token: %v", err)
	}

	env := append(os.Environ(),
		fmt.Sprintf("QBEE_WORKER_PORT=%d", port),
		fmt.Sprintf("QBEE_WORKER_AUTH=%s", token),
		fmt.Sprintf("QBEE_SPA_DIST=%s", layout.spaDir),
		fmt.Sprintf("QBEE_WORKER_URL=http://127.0.0.1:%d", port),
	)

	var workerCmd *exec.Cmd
	if layout.canRunWorker() {
		workerCmd = exec.Command(layout.nodeBin, layout.serverScript)
		workerCmd.Env = env
		workerCmd.Dir = layout.workerDir
		hideChildWindow(workerCmd)
		// Capture stdout so we can wait for the {"type":"ready",...} line. The
		// worker logs structured JSON; we just need to see one line that
		// contains "ready".
		stdoutPipe, _ := workerCmd.StdoutPipe()
		workerCmd.Stderr = os.Stderr
		if err := workerCmd.Start(); err != nil {
			fmt.Fprintf(os.Stderr, "QBee: worker start failed: %v (continuing editor-only)\n", err)
			workerCmd = nil
		} else {
			waitForReady(stdoutPipe, readyTimeout)
		}
	}

	// Forward SIGINT/SIGTERM to the worker so Ctrl-C cleans up.
	if workerCmd != nil {
		sigs := make(chan os.Signal, 1)
		signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
		go func() {
			<-sigs
			killWorker(workerCmd)
			os.Exit(130)
		}()
	}

	editor := exec.Command(layout.editorExe, os.Args[1:]...)
	editor.Env = env
	editor.Stdin = os.Stdin
	editor.Stdout = os.Stdout
	editor.Stderr = os.Stderr
	runErr := editor.Run()

	if workerCmd != nil {
		killWorker(workerCmd)
	}

	if runErr != nil {
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		fail("editor: %v", runErr)
	}
}

type layout struct {
	editorExe    string // absolute path to the editor binary
	workerDir    string // <root>/qbee-worker
	nodeBin      string // <workerDir>/node[.exe]
	serverScript string // <workerDir>/server.cjs
	spaDir       string // <root>/qbee-spa
}

func (l layout) canRunWorker() bool {
	if _, err := os.Stat(l.nodeBin); err != nil {
		return false
	}
	if _, err := os.Stat(l.serverScript); err != nil {
		return false
	}
	return true
}

// resolveLayout figures out where editor / worker / spa live based on the
// launcher's own location. Two supported package shapes:
//
//   Windows portable zip:
//     <root>/QBee.exe              ← launcher (this binary)
//     <root>/app/QBee.exe          ← editor
//     <root>/qbee-worker/...
//     <root>/qbee-spa/...
//
//   macOS .app bundle:
//     QBee.app/Contents/MacOS/qbee-launcher  ← launcher (this binary)
//     QBee.app/Contents/MacOS/Electron       ← editor
//     QBee.app/Contents/Resources/qbee-worker/...
//     QBee.app/Contents/Resources/qbee-spa/...
func resolveLayout(exeDir string) (layout, error) {
	if runtime.GOOS == "darwin" {
		// macOS: launcher is at .app/Contents/MacOS/qbee-launcher.
		// Editor binary is the actual Electron exe in the same MacOS/.
		// Worker + SPA live under Contents/Resources/.
		contents := filepath.Dir(exeDir) // .app/Contents
		var editor string
		// Try a few common Electron exe names.
		for _, cand := range []string{"Electron", "QBee", "QBee Helper", "Code"} {
			p := filepath.Join(exeDir, cand)
			if _, err := os.Stat(p); err == nil {
				editor = p
				break
			}
		}
		if editor == "" {
			// Last resort: any executable in MacOS/ that isn't us.
			entries, _ := os.ReadDir(exeDir)
			for _, e := range entries {
				if e.IsDir() {
					continue
				}
				p := filepath.Join(exeDir, e.Name())
				if p == os.Args[0] {
					continue
				}
				if isExecutable(p) {
					editor = p
					break
				}
			}
		}
		if editor == "" {
			return layout{}, fmt.Errorf("could not locate editor binary in %s", exeDir)
		}
		workerDir := filepath.Join(contents, "Resources", "qbee-worker")
		return layout{
			editorExe:    editor,
			workerDir:    workerDir,
			nodeBin:      filepath.Join(workerDir, "node"),
			serverScript: filepath.Join(workerDir, "server.cjs"),
			spaDir:       filepath.Join(contents, "Resources", "qbee-spa"),
		}, nil
	}

	// Windows / Linux: launcher at root, editor in app/, worker/spa siblings.
	editor := ""
	exeName := "QBee.exe"
	if runtime.GOOS != "windows" {
		exeName = "QBee"
	}
	// Try app/ subdir first, then editor next to launcher (older layout).
	for _, base := range []string{filepath.Join(exeDir, "app"), exeDir} {
		for _, name := range []string{exeName, strings.ToLower(exeName)} {
			p := filepath.Join(base, name)
			if _, err := os.Stat(p); err == nil {
				editor = p
				break
			}
		}
		if editor != "" {
			break
		}
	}
	if editor == "" {
		return layout{}, fmt.Errorf("could not locate %s in %s/app or %s", exeName, exeDir, exeDir)
	}

	workerDir := filepath.Join(exeDir, "qbee-worker")
	nodeBin := filepath.Join(workerDir, "node")
	if runtime.GOOS == "windows" {
		nodeBin += ".exe"
	}
	return layout{
		editorExe:    editor,
		workerDir:    workerDir,
		nodeBin:      nodeBin,
		serverScript: filepath.Join(workerDir, "server.cjs"),
		spaDir:       filepath.Join(exeDir, "qbee-spa"),
	}, nil
}

func pickFreePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// waitForReady consumes the worker's stdout until it sees a "ready" line or
// timeout elapses. Either way it then drains stdout in a goroutine so the
// worker's pipe buffer doesn't fill and block its writes.
func waitForReady(out io.ReadCloser, timeout time.Duration) {
	if out == nil {
		return
	}
	done := make(chan struct{})
	scanner := bufio.NewScanner(out)
	go func() {
		for scanner.Scan() {
			line := scanner.Text()
			if strings.Contains(line, `"type":"ready"`) {
				close(done)
				break
			}
		}
		// Continue draining after ready so the worker doesn't block on stdout.
		for scanner.Scan() {
			_ = scanner.Text()
		}
	}()
	select {
	case <-done:
	case <-time.After(timeout):
	}
}

func killWorker(c *exec.Cmd) {
	if c == nil || c.Process == nil {
		return
	}
	_ = c.Process.Kill()
	// Give it a moment to exit so we don't orphan it.
	go func() { _, _ = c.Process.Wait() }()
}

func isExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	if info.IsDir() {
		return false
	}
	return info.Mode().Perm()&0o111 != 0
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "QBee launcher: "+format+"\n", args...)
	os.Exit(2)
}
