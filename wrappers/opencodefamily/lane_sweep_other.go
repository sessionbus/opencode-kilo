// SPDX-License-Identifier: MIT

//go:build !linux

package opencodefamily

// removeDeadLaneSockets does nothing outside Linux. On macOS a live listener
// whose accept queue is full also refuses a connection, so a refused socket
// does not prove that its worker is gone; a killed worker's socket stays until
// the daemon next starts.
func removeDeadLaneSockets(string) {}
