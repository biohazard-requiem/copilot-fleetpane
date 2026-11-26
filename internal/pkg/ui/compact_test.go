package ui

import (
	"fmt"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/protocol"
	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/theme"
)

func TestCompactS2_30x8(t *testing.T) {
	m := testModel(fixtureS2(), 30, 8)
	c, hits := layout(m)
	lines := plainLines(c)

	if len(lines) != 8 {
		t.Fatalf("line count = %d, want 8", len(lines))
	}

	// Items: main, explore-auth, review-tests, docs-outline, lint-check on rows 0..4; prev-turn-audit excluded.
	wantRows := []struct {
		row  int
		id   string
		sub  string
		time string
	}{
		{0, mainID, "main", "0:42"},
		{1, "a1", "explore-auth", "0:40"},
		{2, "a2", "review-tests", "0:38"},
		{3, "a3", "docs-outline", "0:12"},
		{4, "a4", "lint-check", "0:08"},
	}
	for _, w := range wantRows {
		if !strings.Contains(lines[w.row], w.sub) || !strings.Contains(lines[w.row], w.time) {
			t.Errorf("row %d = %q, want %q and %q", w.row, lines[w.row], w.sub, w.time)
		}
		h, ok := findHit(hits, hitItem, w.id)
		if !ok {
			t.Errorf("missing hitItem for %q", w.id)
			continue
		}
		if h.rect.Min.Y != w.row || h.rect.Max.Y != w.row+1 || h.rect.Min.X != 0 || h.rect.Max.X != 30 {
			t.Errorf("hitItem %q rect = %v, want (0,%d)-(30,%d)", w.id, h.rect, w.row, w.row+1)
		}
	}
	if strings.Contains(strings.Join(lines, "\n"), "prev-turn-audit") {
		t.Error("previous-turn agent must not appear in compact list")
	}

	// Scrollable list hit covers rows 0..6 (H-1 rows).
	hl, ok := findHit(hits, hitListScroll, "")
	if !ok || hl.rect.Min.Y != 0 || hl.rect.Max.Y != 7 || hl.rect.Dx() != 30 {
		t.Errorf("hitListScroll = %v (ok=%v), want (0,0)-(30,7)", hl.rect, ok)
	}

	// Last row is key hint and marked Panel.
	if !strings.Contains(lines[7], "tab") || !strings.Contains(lines[7], "q") {
		t.Errorf("row 7 = %q, want key hints", lines[7])
	}
	if !c.At(7, 0).Panel {
		t.Error("compact key hint row 7 must be marked Panel")
	}

	// No boxes or connectors in compact list.
	for r := range 7 {
		if strings.ContainsAny(lines[r], "┌┐└┘│─") {
			t.Errorf("row %d = %q contains box/connector chars", r, lines[r])
		}
	}

	// Selection marker ▸ appears on selected row.
	mSel := m
	mSel.selected = "a1"
	cSel, _ := layout(mSel)
	if cSel.At(1, 0).Text != MarkSelected {
		t.Errorf("selected row 1 col 0 = %q, want %q", cSel.At(1, 0).Text, MarkSelected)
	}
	mSelMain := m
	mSelMain.selected = mainID
	cSelMain, _ := layout(mSelMain)
	if cSelMain.At(0, 0).Text != MarkSelected {
		t.Errorf("selected main row 0 col 0 = %q, want %q", cSelMain.At(0, 0).Text, MarkSelected)
	}
}

func TestCompactLogPage_30x8(t *testing.T) {
	m := testModel(fixtureS2(), 30, 8)
	m.selected = "a1" // explore-auth
	m.showLog = true

	c, hits := layout(m)
	lines := plainLines(c)
	text := strings.Join(lines, "\n")

	if len(lines) != 8 {
		t.Fatalf("line count = %d, want 8", len(lines))
	}
	// Header on row 0 shows selected item.
	if !strings.Contains(lines[0], "explore-auth") {
		t.Errorf("log page row 0 = %q, want explore-auth header", lines[0])
	}
	// Contains explore-auth's log entries (view, grep) and excludes other actors' entries.
	if !strings.Contains(text, "view") || !strings.Contains(text, "grep") {
		t.Errorf("log page missing explore-auth tool entries:\n%s", text)
	}
	for _, other := range []string{"docs-outline", "lint-check", "golangci", "README"} {
		if strings.Contains(text, other) {
			t.Errorf("log page leaked other actor %q:\n%s", other, text)
		}
	}
	// Last row is key hints with esc back.
	if !strings.Contains(lines[7], "esc") {
		t.Errorf("log page hint row 7 = %q, want esc hint", lines[7])
	}
	// Hits should have hitLogScroll covering rows 0..6 and no hitListScroll.
	hl, ok := findHit(hits, hitLogScroll, "")
	if !ok || hl.rect.Min.Y != 0 || hl.rect.Max.Y != 7 {
		t.Errorf("log page hitLogScroll = %v (ok=%v), want Y=[0,7)", hl.rect, ok)
	}
	if _, hasList := findHit(hits, hitListScroll, ""); hasList {
		t.Error("log page must not emit hitListScroll")
	}

	// Scrolling in compact log page with many entries: ▲ N and ▼ N markers.
	sMany := fixtureS0()
	sMany.Log = nil
	for i := range 20 {
		sMany.Log = append(sMany.Log, protocol.LogEntry{
			Seq: int64(i + 1), T: "2026-11-23T23:48:00Z", Actor: mainID, Name: mainID,
			Kind: "tool", Tool: "view", Summary: fmt.Sprintf("f%02d.go", i+1), Status: "done",
		})
	}
	mScroll := testModel(sMany, 30, 8)
	mScroll.selected = mainID
	mScroll.showLog = true
	mScroll.logFollow = false
	mScroll.logTop = 5 // 4 above (seqs 1..4), 6 visible (seqs 5..10), 10 below (seqs 11..20)
	cs, _ := layout(mScroll)
	ls := plainLines(cs)
	if !strings.Contains(ls[0], ArrowUp+" 4") {
		t.Errorf("scrolled log page row 0 = %q, want ▲ 4", ls[0])
	}
	if !strings.Contains(ls[6], ArrowDown+" 10") {
		t.Errorf("scrolled log page row 6 = %q, want ▼ 10", ls[6])
	}
}

func TestCompactScroll_30x8_60Running(t *testing.T) {
	s := makeRunningSnap(60)
	totalItems := 61 // main + 60 running
	visRows := 7     // 8 - 1 hint row

	upRe := regexp.MustCompile(ArrowUp + ` (\d+)`)
	downRe := regexp.MustCompile(ArrowDown + ` (\d+)`)

	for _, off := range []int{0, 1, 10, 30, 54, 100, -5} {
		t.Run(fmt.Sprintf("offset=%d", off), func(t *testing.T) {
			m := testModel(s, 30, 8)
			m.listOffset = off
			c, hits := layout(m)
			lines := plainLines(c)

			clamped := min(max(off, 0), totalItems-visRows)
			wantAbove := clamped
			wantBelow := totalItems - (clamped + visRows)

			gotAbove := 0
			if match := upRe.FindStringSubmatch(lines[0]); match != nil {
				gotAbove, _ = strconv.Atoi(match[1])
			}
			gotBelow := 0
			if match := downRe.FindStringSubmatch(lines[visRows-1]); match != nil {
				gotBelow, _ = strconv.Atoi(match[1])
			}

			if gotAbove != wantAbove {
				t.Errorf("offset %d: row 0 = %q, ▲ = %d, want %d", off, lines[0], gotAbove, wantAbove)
			}
			if gotBelow != wantBelow {
				t.Errorf("offset %d: row %d = %q, ▼ = %d, want %d", off, visRows-1, lines[visRows-1], gotBelow, wantBelow)
			}

			// Count visible item hits and verify invariant: above + visible + below == totalItems.
			visHits := 0
			for _, h := range hits {
				if h.kind == hitItem {
					visHits++
				}
			}
			if visHits != visRows {
				t.Errorf("offset %d: visible hitItems = %d, want %d", off, visHits, visRows)
			}
			if gotAbove+visHits+gotBelow != totalItems {
				t.Errorf("offset %d: %d + %d + %d != %d", off, gotAbove, visHits, gotBelow, totalItems)
			}

			// At offset=0: first row is main, last row ends with ▼ 54.
			if off == 0 {
				if !strings.Contains(lines[0], "main") {
					t.Errorf("offset 0 row 0 = %q, want main", lines[0])
				}
				if !strings.HasSuffix(lines[visRows-1], ArrowDown+" 54") {
					t.Errorf("offset 0 last list row = %q, want suffix %q", lines[visRows-1], ArrowDown+" 54")
				}
			}
		})
	}
}

func TestCompactS2_24x6(t *testing.T) {
	m := testModel(fixtureS2(), 24, 6)
	c, hits := layout(m)
	lines := plainLines(c)

	if len(lines) != 6 {
		t.Fatalf("line count = %d, want 6", len(lines))
	}
	// Exactly 5 items fit on rows 0..4, no scroll markers, row 5 is key hint.
	for r, want := range []string{"main", "explore", "review", "docs", "lint"} {
		if !strings.Contains(lines[r], want) {
			t.Errorf("row %d = %q, want %q", r, lines[r], want)
		}
		if strings.Contains(lines[r], ArrowUp) || strings.Contains(lines[r], ArrowDown) {
			t.Errorf("row %d = %q, unexpected scroll mark when all 5 fit", r, lines[r])
		}
	}
	if !strings.Contains(lines[5], "tab") {
		t.Errorf("row 5 = %q, want key hints", lines[5])
	}
	for _, id := range []string{mainID, "a1", "a2", "a3", "a4"} {
		if _, ok := findHit(hits, hitItem, id); !ok {
			t.Errorf("24x6 missing hitItem for %q", id)
		}
	}
}

func TestCompactNestedParentAndPurity(t *testing.T) {
	s := fixtureS0()
	s.Agents = []protocol.Agent{
		{ID: "A", SpawnTurn: 1, Name: "alpha", Type: "explore", Status: "running", StartedAt: "2026-11-23T23:48:30Z"},
		{ID: "B", SpawnTurn: 1, Name: "beta", Type: "task", Status: "running", StartedAt: "2026-11-23T23:48:32Z"},
		{ID: "C", SpawnTurn: 1, Name: "child", Type: "explore", Parent: "A", Status: "running", StartedAt: "2026-11-23T23:48:34Z"},
	}

	m := testModel(s, 30, 8)
	m.selected = "C"
	before := m
	c1, h1 := layout(m)
	c2, h2 := layout(m)

	if !reflect.DeepEqual(c1, c2) || !reflect.DeepEqual(h1, h2) {
		t.Error("compact layout(m) is not deterministic")
	}
	if !reflect.DeepEqual(m.snap, before.snap) || m.selected != before.selected {
		t.Error("compact layout(m) mutated Model")
	}

	lines := plainLines(c1)
	// Order: main (row 0), A (row 1), C (row 2), B (row 3).
	if !strings.Contains(lines[1], "alpha") || !strings.Contains(lines[2], MarkChild+" child") || !strings.Contains(lines[3], "beta") {
		t.Errorf("nested compact order mismatch:\n%s", strings.Join(lines, "\n"))
	}
	// Parent A gets ◆ marker in RoleMain when C is selected.
	if c1.At(1, 0).Text != MarkParent || c1.At(1, 0).FG != theme.RoleMain.Color() {
		t.Errorf("parent row 1 col 0 = (%q,%v), want RoleMain ◆", c1.At(1, 0).Text, c1.At(1, 0).FG)
	}
}

func TestCompactLogPageSizes(t *testing.T) {
	sizes := [][2]int{{24, 6}, {30, 8}, {100, 20}, {146, 14}}
	for _, sz := range sizes {
		for _, sel := range []string{"", mainID, "a1"} {
			m := testModel(fixtureS2(), sz[0], sz[1])
			m.selected = sel
			m.showLog = true
			c, hits := layout(m)
			lines := plainLines(c)
			if len(lines) != sz[1] {
				t.Fatalf("%dx%d sel=%q: got %d lines, want %d", sz[0], sz[1], sel, len(lines), sz[1])
			}
			for r, line := range lines {
				if Width(line) != sz[0] {
					t.Fatalf("%dx%d sel=%q row %d: width %d != %d", sz[0], sz[1], sel, r, Width(line), sz[0])
				}
			}
			if _, ok := findHit(hits, hitLogScroll, ""); !ok {
				t.Errorf("%dx%d sel=%q: missing hitLogScroll", sz[0], sz[1], sel)
			}
			if sz[0] >= activityFullTimeMinW && sel == "a1" && !strings.Contains(strings.Join(lines, "\n"), "23:48:44") {
				t.Errorf("%dx%d wide compact log page should use HH:MM:SS timestamps", sz[0], sz[1])
			}
		}
	}
}

func TestCompactLogPageRowsShareTheirColumns(t *testing.T) {
	const (
		h        = 20 // the title, 18 records, the key hints
		lastRow  = h - 2
		fullCols = "23:48:00 main         ✓ view   "
	)
	tests := []struct {
		name     string
		w        int
		records  int
		selected string
		cols     string // what every row starts with: all it has before the summary
		rest     string // the last row after cols: the summary gives way to the mark
	}{
		{"50 wide", 50, 30, mainID, fullCols, "internal/pkg/… ▼ 12"},
		{"54 wide", 54, 30, mainID, fullCols, "internal/pkg/ui/f… ▼ 12"},
		{"56 wide, a thousand below", 56, 1018, mainID, fullCols, "internal/pkg/ui/f… ▼ 1000"},
		{"54 wide, nothing selected", 54, 30, "", fullCols, "internal/pkg/ui/f… ▼ 12"},
		{"49 wide", 49, 30, mainID, "48:00 ✓ view   ", "internal/pkg/ui/f18.go        ▼ 12"},
		{"49 wide, nothing selected", 49, 30, "", "48:00 main       ✓ view   ", "internal/pkg/ui/f… ▼ 12"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// The records differ in their summary only.
			s := fixtureS0()
			s.Log = nil
			for i := range tt.records {
				s.Log = append(s.Log, protocol.LogEntry{
					Seq: int64(i + 1), T: "2026-11-23T23:48:00Z", Actor: mainID, Name: mainID,
					Kind: "tool", Tool: "view", Summary: fmt.Sprintf("internal/pkg/ui/f%02d.go", i+1), Status: "done",
				})
			}
			m := testModel(s, tt.w, h)
			m.selected, m.showLog = tt.selected, true
			m.logFollow, m.logTop = false, 1
			c, _ := layout(m)
			lines := plainLines(c)

			for row := 1; row <= lastRow; row++ {
				if !strings.HasPrefix(lines[row], tt.cols) {
					t.Errorf("row %d = %q, want it to start with %q", row, lines[row], tt.cols)
				}
			}
			if want := tt.cols + tt.rest; lines[lastRow] != want {
				t.Errorf("last row = %q, want %q", lines[lastRow], want)
			}
		})
	}
}

func TestCompactWaiting_30x8(t *testing.T) {
	s := fixtureSW()
	// A sub-agent that has finished is not waiting, whatever the snapshot says.
	s.Agents[2].Wait = "approval"
	m := testModel(s, 30, 8)

	for frame := range len(Spinner) {
		m.frame = frame
		c, _ := layout(m)
		lines := plainLines(c)

		// Rows: main, explore-auth, review-tests, docs-outline, lint-check.
		checkMark(t, c, 0, 0)
		if want := "! main waiting"; !strings.HasPrefix(lines[0], want) {
			t.Errorf("frame %d: row 0 = %q, want it to start with %q", frame, lines[0], want)
		}
		checkMark(t, c, 2, 2)
		if got := c.At(1, 2).Text; got != Spinner[frame] {
			t.Errorf("frame %d: running row icon = %q, want %q", frame, got, Spinner[frame])
		}
		if got := c.At(3, 2).Text; got != IconOK {
			t.Errorf("frame %d: finished row icon = %q, want %q", frame, got, IconOK)
		}
	}

	// The activity page of review-tests: its one record is the waiting call.
	m.selected, m.showLog = "a2", true
	c, _ := layout(m)
	if line, want := plainLines(c)[1], "48:28 ! bash"; !strings.HasPrefix(line, want) {
		t.Errorf("log row = %q, want it to start with %q", line, want)
	}
	checkMark(t, c, 1, 6)
}

func TestCompactWaitingEmphasis(t *testing.T) {
	sw := fixtureSW()
	// A sub-agent that has finished is not waiting, whatever the snapshot says.
	sw.Agents[2].Wait = "approval"
	idle := fixtureS0()
	idle.Main.Status = "idle"

	// Rows: main, explore-auth, review-tests, docs-outline, lint-check.
	tests := []struct {
		name     string
		snap     protocol.Snapshot
		selected string
		row, col int
		text     string // what the row has from that cell on
		role     theme.Role
		bold     bool
	}{
		{"waiting main", sw, "", 0, 7, "waiting", theme.RoleRun, true},
		{"waiting main, selected", sw, mainID, 0, 9, "waiting", theme.RoleRun, true},
		{"working main", fixtureS2(), "", 0, 7, "working", theme.RoleFG, false},
		{"idle main", idle, "", 0, 7, "idle", theme.RoleDim, false},
		{"waiting sub-agent", sw, "", 2, 4, "review-tests", theme.RoleFG, true},
		{"waiting sub-agent, selected", sw, "a2", 2, 4, "review-tests", theme.RoleAgent, true},
		{"the same sub-agent, running", fixtureS2(), "", 2, 4, "review-tests", theme.RoleFG, false},
		{"running sub-agent next to a waiting one", sw, "", 1, 4, "explore-auth", theme.RoleFG, false},
		{"finished sub-agent with a wait", sw, "", 3, 4, "docs-outline", theme.RoleFG, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := testModel(tt.snap, 30, 8)
			m.selected = tt.selected
			c, _ := layout(m)
			for i, r := range tt.text {
				if got := c.At(tt.row, tt.col+i); got.Text != string(r) || got.FG != tt.role.Color() || got.Bold != tt.bold {
					t.Errorf("cell (%d,%d) = %q in %v (bold %v), want %q in %v (bold %v)",
						tt.row, tt.col+i, got.Text, got.FG, got.Bold, string(r), tt.role, tt.bold)
				}
			}
		})
	}
}
