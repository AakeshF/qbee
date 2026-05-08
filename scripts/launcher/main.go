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
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	readyTimeout         = 5 * time.Second
	restartWindow        = 30 * time.Second
	restartMaxInWindow   = 5
	restartBackoffStart  = 500 * time.Millisecond
	restartBackoffMaxMs  = 8000
)

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

	supervisor := &workerSupervisor{layout: layout, env: env}
	if layout.canRunWorker() {
		supervisor.start()
	}

	// Forward SIGINT/SIGTERM to the worker so Ctrl-C cleans up.
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigs
		supervisor.stop()
		os.Exit(130)
	}()

	editor := exec.Command(layout.editorExe, os.Args[1:]...)
	editor.Env = env
	editor.Stdin = os.Stdin
	editor.Stdout = os.Stdout
	editor.Stderr = os.Stderr
	runErr := editor.Run()

	supervisor.stop()

	if runErr != nil {
		if exitErr, ok := runErr.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		fail("editor: %v", runErr)
	}
}

// workerSupervisor spawns the worker and respawns it if it exits unexpectedly,
// up to restartMaxInWindow restarts in any restartWindow. The port and auth
// token in `env` are fixed at construction so the editor's QBEE_WORKER_URL
// stays valid across restarts.
type workerSupervisor struct {
	layout layout
	env    []string

	mu        sync.Mutex
	current   *exec.Cmd
	stopping  atomic.Bool
	wg        sync.WaitGroup
	readyOnce sync.Once
	readyCh   chan struct{}
}

func (s *workerSupervisor) start() {
	s.readyCh = make(chan struct{})
	s.wg.Add(1)
	go s.loop()

	// Block briefly for the FIRST ready handshake so the editor doesn't open
	// before the worker is reachable. After that, restarts run silently.
	select {
	case <-s.readyCh:
	case <-time.After(readyTimeout):
	}
}

func (s *workerSupervisor) stop() {
	if !s.stopping.CompareAndSwap(false, true) {
		return
	}
	s.mu.Lock()
	cmd := s.current
	s.mu.Unlock()
	if cmd != nil {
		killWorker(cmd)
	}
	s.wg.Wait()
}

func (s *workerSupervisor) loop() {
	defer s.wg.Done()
	var restarts []time.Time
	backoff := restartBackoffStart

	for !s.stopping.Load() {
		cmd := exec.Command(s.layout.nodeBin, s.layout.serverScript)
		cmd.Env = s.env
		cmd.Dir = s.layout.workerDir
		hideChildWindow(cmd)
		stdoutPipe, _ := cmd.StdoutPipe()
		cmd.Stderr = os.Stderr

		if err := cmd.Start(); err != nil {
			fmt.Fprintf(os.Stderr, "QBee: worker start failed: %v\n", err)
			s.mu.Lock()
			s.current = nil
			s.mu.Unlock()
			if !s.shouldRestart(&restarts) {
				return
			}
			s.sleepBackoff(&backoff)
			continue
		}

		s.mu.Lock()
		s.current = cmd
		s.mu.Unlock()

		// Drain stdout looking for ready, then keep draining until exit.
		go waitForReady(stdoutPipe, readyTimeout, func() {
			s.readyOnce.Do(func() { close(s.readyCh) })
		})

		err := cmd.Wait()
		if s.stopping.Load() {
			return
		}
		// Worker died on us. Decide whether to retry.
		if err != nil {
			fmt.Fprintf(os.Stderr, "QBee: worker exited: %v\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "QBee: worker exited cleanly; restarting\n")
		}
		if !s.shouldRestart(&restarts) {
			fmt.Fprintf(os.Stderr, "QBee: worker restart budget exhausted; giving up\n")
			return
		}
		s.sleepBackoff(&backoff)
	}
}

// shouldRestart drops timestamps older than restartWindow, then returns true
// iff appending a new one would stay within restartMaxInWindow.
func (s *workerSupervisor) shouldRestart(restarts *[]time.Time) bool {
	cutoff := time.Now().Add(-restartWindow)
	kept := (*restarts)[:0]
	for _, t := range *restarts {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	*restarts = kept
	if len(*restarts) >= restartMaxInWindow {
		return false
	}
	*restarts = append(*restarts, time.Now())
	return true
}

func (s *workerSupervisor) sleepBackoff(backoff *time.Duration) {
	// Don't sleep if we've been told to stop.
	select {
	case <-time.After(*backoff):
	case <-s.stopChan():
		return
	}
	next := *backoff * 2
	if next > time.Duration(restartBackoffMaxMs)*time.Millisecond {
		next = time.Duration(restartBackoffMaxMs) * time.Millisecond
	}
	*backoff = next
}

func (s *workerSupervisor) stopChan() <-chan struct{} {
	// Cheap check via a polled atomic: if stopping is set, return a closed chan.
	if s.stopping.Load() {
		c := make(chan struct{})
		close(c)
		return c
	}
	// Otherwise return a never-firing channel — sleep runs to completion.
	return make(chan struct{})
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
// timeout elapses. Either way it then drains stdout so the worker's pipe
// buffer doesn't fill and block its writes. onReady is called once when ready
// is observed (or never, on timeout).
func waitForReady(out io.ReadCloser, timeout time.Duration, onReady func()) {
	if out == nil {
		return
	}
	done := make(chan struct{})
	scanner := bufio.NewScanner(out)
	go func() {
		for scanner.Scan() {
			line := scanner.Text()
			if strings.Contains(line, `"type":"ready"`) {
				if onReady != nil {
					onReady()
				}
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
