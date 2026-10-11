// SPDX-License-Identifier: MIT

//go:build linux

package opencodefamily

import (
	"errors"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// removeDeadLaneSockets removes lane tool sockets left by lane workers of this
// family that ended without closing them, such as after SIGKILL. It removes a
// socket of the key shape only when a connection to it is refused; any other
// outcome leaves the entry. It never fails an Open.
//
// This is exact on Linux only: there a connection is refused when no socket is
// bound to the file, or the bound socket does not listen or is shut down, and a
// listener whose queue is full answers EAGAIN instead.
func removeDeadLaneSockets(socket string) {
	directory := filepath.Join(filepath.Dir(socket), "lanes")
	entries, _ := os.ReadDir(directory)
	for _, entry := range entries {
		key, isSocket := strings.CutSuffix(entry.Name(), ".sock")
		if !isSocket || entry.Type()&fs.ModeSocket == 0 || !laneKey(key) {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		connection, err := net.DialTimeout("unix", path, time.Second)
		if err == nil {
			_ = connection.Close()
		} else if errors.Is(err, syscall.ECONNREFUSED) {
			_ = os.Remove(path)
		}
	}
}
