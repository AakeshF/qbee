//go:build !windows

package main

import "os/exec"

// macOS and Linux don't have the Windows console-window problem. No-op.
func hideChildWindow(_ *exec.Cmd) {}
