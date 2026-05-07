//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// On Windows, hide the worker's console window. Without this flag, double-clicking
// QBee.exe would briefly flash a black cmd.exe window for the worker process.
// CREATE_NO_WINDOW is the standard flag.
const createNoWindow = 0x08000000

func hideChildWindow(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
}
