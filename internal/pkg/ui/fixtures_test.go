package ui

import (
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/protocol"
	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/theme"
)

var fixtureNow = time.Date(2026, 11, 23, 23, 48, 44, 0, time.UTC)

func mustTheme(t *testing.T, name string) *theme.Theme {
	t.Helper()
	th, err := theme.Load(name, "")
	if err != nil {
		t.Fatalf("theme.Load(%q): %v", name, err)
	}
	return th
}

// fixtureS0 is a snapshot with a working main agent and no sub-agents this turn.
func fixtureS0() protocol.Snapshot {
	return protocol.Snapshot{
		Seq:     10,
		Session: "sess-s0",
		Theme:   "gta6",
		Turn:    1,
		Stats:   protocol.Stats{TurnTools: 6},
		Main: protocol.Main{
			Status: "working",
			Since:  "2026-11-23T23:48:31Z",
			Model:  "claude-fable-5.2",
			Intent: "Running unit tests",
			Tools: []protocol.Tool{
				{ID: "t1", Name: "view", Summary: "internal/pkg/ui/view.go", Status: "done"},
				{ID: "t2", Name: "bash", Summary: "go test ./internal/...", Status: "running"},
			},
		},
		Log: []protocol.LogEntry{
			{Seq: 1, T: "2026-11-23T23:48:32Z", Actor: "main", Name: "main", Kind: "tool", Tool: "view", Summary: "internal/pkg/ui/view.go", Status: "done", ID: "t1"},
			{Seq: 2, T: "2026-11-23T23:48:40Z", Actor: "main", Name: "main", Kind: "tool", Tool: "bash", Summary: "go test ./internal/...", Status: "running", ID: "t2"},
		},
	}
}

// fixtureS2 matches the Appendix C vertical mock-up: 2 running sub-agents with
// models (one background), 1 done and 1 failed this turn, and 1 finished in a
// previous turn.
func fixtureS2() protocol.Snapshot {
	return protocol.Snapshot{
		Seq:     42,
		Session: "sess-s2",
		Theme:   "gta6",
		Turn:    3,
		Stats:   protocol.Stats{TurnTools: 11},
		Main: protocol.Main{
			Status: "working",
			Since:  "2026-11-23T23:48:02Z",
			Model:  "claude-fable-5.2",
			Intent: "Auditing the codebase",
			Tools: []protocol.Tool{
				{ID: "mt1", Name: "task", Summary: "lint-check", Status: "done"},
			},
		},
		Agents: []protocol.Agent{
			{
				ID:        "a1",
				SpawnTurn: 3,
				Name:      "explore-auth",
				Type:      "explore",
				Desc:      "Trace how joinSession wires hooks",
				Model:     "gemini-4-neon",
				Status:    "running",
				StartedAt: "2026-11-23T23:48:04Z",
				ToolCount: 3,
				Tools: []protocol.Tool{
					{ID: "t11", Name: "view", Summary: "extension/extension.mjs", Status: "done"},
					{ID: "t12", Name: "grep", Summary: `"hooks" extension/`, Status: "done"},
					{ID: "t13", Name: "grep", Summary: `"joinSession" extension/`, Status: "running"},
				},
			},
			{
				ID:        "a2",
				SpawnTurn: 3,
				Name:      "review-tests",
				Type:      "task",
				Desc:      "Run Go tests and summarize failures",
				Mode:      "background",
				Model:     "claude-opus-5.5",
				Status:    "running",
				StartedAt: "2026-11-23T23:48:06Z",
				ToolCount: 1,
				Tools: []protocol.Tool{
					{ID: "t21", Name: "bash", Summary: "go test ./internal/...", Status: "running"},
				},
			},
			{
				ID:           "a3",
				SpawnTurn:    3,
				ReportedTurn: 3,
				Name:         "docs-outline",
				Type:         "general",
				Status:       "done",
				StartedAt:    "2026-11-23T23:48:03Z",
				EndedAt:      "2026-11-23T23:48:15Z",
				DurationMs:   12000,
				ToolCount:    2,
			},
			{
				ID:           "a4",
				SpawnTurn:    3,
				ReportedTurn: 3,
				Name:         "lint-check",
				Type:         "task",
				Mode:         "background",
				Status:       "failed",
				StartedAt:    "2026-11-23T23:48:03Z",
				EndedAt:      "2026-11-23T23:48:11Z",
				DurationMs:   8000,
				Error:        "exit 1 · config not found",
				ToolCount:    1,
			},
			{
				ID:           "a0",
				SpawnTurn:    2,
				ReportedTurn: 2,
				Name:         "prev-turn-audit",
				Type:         "explore",
				Status:       "done",
				StartedAt:    "2026-11-23T23:45:00Z",
				EndedAt:      "2026-11-23T23:45:15Z",
				DurationMs:   15000,
				ToolCount:    4,
			},
		},
		Log: []protocol.LogEntry{
			{Seq: 101, T: "2026-11-23T23:48:02Z", Actor: "main", Name: "main", Kind: "tool", Tool: "task", Summary: "explore-auth", Status: "done"},
			{Seq: 102, T: "2026-11-23T23:48:02Z", Actor: "main", Name: "main", Kind: "tool", Tool: "task", Summary: "review-tests", Status: "done"},
			{Seq: 103, T: "2026-11-23T23:48:03Z", Actor: "main", Name: "main", Kind: "tool", Tool: "task", Summary: "docs-outline", Status: "done"},
			{Seq: 104, T: "2026-11-23T23:48:03Z", Actor: "main", Name: "main", Kind: "tool", Tool: "task", Summary: "lint-check", Status: "done"},
			{Seq: 105, T: "2026-11-23T23:48:05Z", Actor: "a1", Name: "explore-auth", Kind: "tool", Tool: "view", Summary: "extension/extension.mjs", Status: "done"},
			{Seq: 106, T: "2026-11-23T23:48:08Z", Actor: "a3", Name: "docs-outline", Kind: "tool", Tool: "view", Summary: "README.md", Status: "done"},
			{Seq: 107, T: "2026-11-23T23:48:11Z", Actor: "a4", Name: "lint-check", Kind: "tool", Tool: "bash", Summary: "golangci-lint run", Status: "failed"},
			{Seq: 108, T: "2026-11-23T23:48:11Z", Actor: "a4", Name: "lint-check", Kind: "agent", Summary: "0:08 · exit 1 · config not found", Status: "failed"},
			{Seq: 109, T: "2026-11-23T23:48:13Z", Actor: "a1", Name: "explore-auth", Kind: "tool", Tool: "grep", Summary: `"hooks" extension/`, Status: "done"},
			{Seq: 110, T: "2026-11-23T23:48:15Z", Actor: "a3", Name: "docs-outline", Kind: "tool", Tool: "create", Summary: "docs/outline.md", Status: "done"},
			{Seq: 111, T: "2026-11-23T23:48:15Z", Actor: "a3", Name: "docs-outline", Kind: "agent", Summary: "0:12 · 2 tools", Status: "done"},
			{Seq: 112, T: "2026-11-23T23:48:28Z", Actor: "a2", Name: "review-tests", Kind: "tool", Tool: "bash", Summary: "go test ./internal/...", Status: "running"},
			{Seq: 113, T: "2026-11-23T23:48:44Z", Actor: "a1", Name: "explore-auth", Kind: "tool", Tool: "grep", Summary: `"joinSession" extension/`, Status: "running"},
		},
	}
}

// fixtureS5 has 5 running sub-agents and 1 done this turn, including a very
// long name, a CJK name, and a summary containing an ANSI escape sequence.
func fixtureS5() protocol.Snapshot {
	return protocol.Snapshot{
		Seq:     55,
		Session: "sess-s5",
		Theme:   "gta6",
		Turn:    4,
		Stats:   protocol.Stats{TurnTools: 15},
		Main: protocol.Main{
			Status: "working",
			Since:  "2026-11-23T23:48:02Z",
			Model:  "claude-fable-5.2",
			Tools: []protocol.Tool{
				{ID: "mt1", Name: "task", Summary: "×6 sub-agents", Status: "running"},
			},
		},
		Agents: []protocol.Agent{
			{
				ID:        "a1",
				SpawnTurn: 4,
				Name:      "explore-auth",
				Type:      "explore",
				Model:     "gemini-4-neon",
				Status:    "running",
				StartedAt: "2026-11-23T23:48:04Z",
				Tools: []protocol.Tool{
					{ID: "t1", Name: "grep", Summary: "\x1b[31m\"joinSession\"\x1b[0m extension/", Status: "running"},
				},
			},
			{
				ID:        "a2",
				SpawnTurn: 4,
				Name:      "review-tests",
				Type:      "task",
				Mode:      "background",
				Model:     "claude-opus-5.5",
				Status:    "running",
				StartedAt: "2026-11-23T23:48:06Z",
				Tools: []protocol.Tool{
					{ID: "t2", Name: "bash", Summary: "go test ./internal/...", Status: "running"},
				},
			},
			{
				ID:        "a3",
				SpawnTurn: 4,
				Name:      "检查中文接口",
				Type:      "explore",
				Model:     "gemini-4-neon",
				Status:    "running",
				StartedAt: "2026-11-23T23:48:08Z",
				Tools: []protocol.Tool{
					{ID: "t3", Name: "view", Summary: "session-events.md", Status: "running"},
				},
			},
			{
				ID:        "a4",
				SpawnTurn: 4,
				Name:      "very-long-subagent-name-for-truncation-checks",
				Type:      "task",
				Mode:      "background",
				Model:     "claude-opus-5.5",
				Status:    "running",
				StartedAt: "2026-11-23T23:48:23Z",
				Tools: []protocol.Tool{
					{ID: "t4", Name: "bash", Summary: "go test -bench=.", Status: "running"},
				},
			},
			{
				ID:        "a5",
				SpawnTurn: 4,
				Name:      "types-check",
				Type:      "task",
				Model:     "claude-opus-5.5",
				Status:    "running",
				StartedAt: "2026-11-23T23:48:35Z",
				Tools: []protocol.Tool{
					{ID: "t5", Name: "bash", Summary: "node --check extension/", Status: "running"},
				},
			},
			{
				ID:           "a6",
				SpawnTurn:    4,
				ReportedTurn: 4,
				Name:         "docs-outline",
				Type:         "general",
				Status:       "done",
				DurationMs:   12000,
				ToolCount:    3,
			},
		},
		Log: []protocol.LogEntry{
			{Seq: 201, T: "2026-11-23T23:48:17Z", Actor: "a6", Name: "docs-outline", Kind: "agent", Summary: "0:12 · 3 tools", Status: "done"},
			{Seq: 202, T: "2026-11-23T23:48:28Z", Actor: "a2", Name: "review-tests", Kind: "tool", Tool: "bash", Summary: "go test ./internal/...", Status: "running"},
			{Seq: 203, T: "2026-11-23T23:48:44Z", Actor: "a1", Name: "explore-auth", Kind: "tool", Tool: "grep", Summary: "\x1b[31m\"joinSession\"\x1b[0m extension/", Status: "running"},
		},
	}
}

// fixtureSW is fixtureS2 with review-tests waiting for the approval of its
// plan, the tool call it is running marked as waiting in the log, and the
// main agent waiting for an answer.
func fixtureSW() protocol.Snapshot {
	s := fixtureS2()
	s.Main.Wait = "answer"
	s.Agents[1].Wait = "approval"
	s.Log[11].Status = "waiting"
	return s
}

func testModel(snap protocol.Snapshot, w, h int) Model {
	m := New("", fixtureNow)
	// The tests expect the times as the fixtures have them, in UTC.
	m.loc = time.UTC
	m.snap = snap
	m.connected = true
	m.width = w
	m.height = h
	m.now = fixtureNow
	return m
}

// plainLines returns the H rows of c as plain unstyled strings.
func plainLines(c *Canvas) []string {
	auto, _ := theme.Load("auto", "")
	out := ansi.Strip(c.Render(auto, true, theme.Mask{}))
	return strings.Split(out, "\n")
}

func plainText(c *Canvas) string {
	return strings.Join(plainLines(c), "\n")
}

func findHit(hits []hit, kind hitKind, id string) (hit, bool) {
	for _, h := range hits {
		if h.kind == kind && h.id == id {
			return h, true
		}
	}
	return hit{}, false
}

// checkSegment checks the cells [from, to) of a connector row: each of them is
// drawn in role, and dots of them hold the moving dot.
func checkSegment(t *testing.T, c *Canvas, row, from, to int, role theme.Role, dots int) {
	t.Helper()
	got := 0
	for col := from; col < to; col++ {
		cell := c.At(row, col)
		if cell.FG != role.Color() {
			t.Errorf("cell (%d,%d) = %q in %v, want %v", row, col, cell.Text, cell.FG, role)
		}
		if cell.Text == Dot {
			got++
		}
	}
	if got != dots {
		t.Errorf("row %d cols [%d,%d): %d moving dots, want %d", row, from, to, got, dots)
	}
}

// checkMark checks that the cell at row, col is the bold mark of an item
// waiting for the user.
func checkMark(t *testing.T, c *Canvas, row, col int) {
	t.Helper()
	if cell := c.At(row, col); cell.Text != IconWaiting || !cell.Bold || cell.FG != theme.RoleRun.Color() {
		t.Errorf("cell (%d,%d) = %+v, want a bold %q in %v", row, col, cell, IconWaiting, theme.RoleRun)
	}
}

// colOf returns the column at which sub starts in a plain line, -1 without it.
func colOf(line, sub string) int {
	i := strings.Index(line, sub)
	if i < 0 {
		return -1
	}
	return Width(line[:i])
}
