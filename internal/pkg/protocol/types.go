// Package protocol defines the snapshots the FleetPane extension streams to
// the pane and decodes them from NDJSON.
package protocol

// Snapshot is one complete state of a Copilot CLI session. Timestamps are
// ISO 8601 strings, empty when unset. The protocol version ("v") is not
// decoded: the pane never checks it.
type Snapshot struct {
	Seq       int64      `json:"seq"`
	Session   string     `json:"session"`
	Theme     string     `json:"theme"`
	Turn      int        `json:"turn"`
	Stats     Stats      `json:"stats"`
	Main      Main       `json:"main"`
	Agents    []Agent    `json:"agents"`
	Log       []LogEntry `json:"log"`
	Truncated bool       `json:"truncated"`
}

// Stats holds per-turn counters.
type Stats struct {
	TurnTools int `json:"turnTools"`
}

// Main is the state of the main agent.
type Main struct {
	Status string `json:"status"`
	Since  string `json:"since"`
	Intent string `json:"intent"`
	Error  string `json:"error"`
	Model  string `json:"model"`
	Wait   string `json:"wait"`
	Tools  []Tool `json:"tools"`
}

// Agent is the state of one sub-agent.
type Agent struct {
	ID           string `json:"id"`
	Call         string `json:"call"`
	SpawnTurn    int    `json:"spawnTurn"`
	ReportedTurn int    `json:"reportedTurn"`
	Name         string `json:"name"`
	Type         string `json:"type"`
	Desc         string `json:"desc"`
	Mode         string `json:"mode"`
	Model        string `json:"model"`
	Wait         string `json:"wait"`
	Status       string `json:"status"`
	StartedAt    string `json:"startedAt"`
	EndedAt      string `json:"endedAt"`
	DurationMs   int64  `json:"durationMs"`
	Error        string `json:"error"`
	Depth        int    `json:"depth"`
	Parent       string `json:"parent"`
	ToolCount    int    `json:"toolCount"`
	Tools        []Tool `json:"tools"`
}

// Tool is one tool call of the main agent or of a sub-agent.
type Tool struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Summary   string `json:"summary"`
	Status    string `json:"status"`
	StartedAt string `json:"startedAt"`
	EndedAt   string `json:"endedAt"`
	Error     string `json:"error"`
}

// LogEntry is one line of the activity log.
type LogEntry struct {
	Seq     int64  `json:"seq"`
	T       string `json:"t"`
	Actor   string `json:"actor"`
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Tool    string `json:"tool"`
	Summary string `json:"summary"`
	Status  string `json:"status"`
	ID      string `json:"id"`
}
