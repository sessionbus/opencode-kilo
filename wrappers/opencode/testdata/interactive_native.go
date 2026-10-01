// SPDX-License-Identifier: MIT

//go:build ignore

package main

import (
	"encoding/json"
	"net"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	conn, err := net.Dial("unix", os.Getenv("OC_TEST_SOCKET"))
	if err != nil {
		panic(err)
	}
	defer conn.Close()
	cwd, _ := os.Getwd()
	var launch any
	if err := json.Unmarshal([]byte(os.Getenv("SESSIONBUS_OPENCODE_LAUNCH")), &launch); err != nil {
		panic(err)
	}
	encode := json.NewEncoder(conn)
	if err := encode.Encode(map[string]any{"pid": os.Getpid(), "ppid": os.Getppid(), "cwd": cwd, "args": os.Args[1:], "launch": launch, "old_id": os.Getenv("SESSIONBUS_SESSION_ID")}); err != nil {
		panic(err)
	}
	switch os.Getenv("OC_TEST_MODE") {
	case "exit":
		return
	case "error":
		os.Exit(23)
	}
	for sig := range signals {
		if sig == syscall.SIGTERM {
			return
		}
		if err := encode.Encode(map[string]string{"event": "interrupt"}); err != nil {
			panic(err)
		}
	}
}
