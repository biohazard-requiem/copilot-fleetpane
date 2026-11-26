package main

import (
	"os"
	"time"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/app/fleetpane"
)

func main() {
	start := time.Now()
	err := fleetpane.NewCommand().Execute()
	time.Sleep(fleetpane.Remaining(start, time.Now()))
	if err != nil {
		os.Exit(1)
	}
}
