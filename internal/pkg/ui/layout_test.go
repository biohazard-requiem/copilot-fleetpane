package ui

import (
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/protocol"
	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/theme"
)

func TestChooseLayout(t *testing.T) {
	tests := []struct {
		w, h int
		want layoutKind
	}{
		// Standard cases
		{57, 45, layoutVertical},
		{170, 45, layoutVertical},
		{170, 15, layoutHorizontal},
		{100, 20, layoutCompact},
		{30, 8, layoutCompact},
		// Boundary cases
		{147, 14, layoutHorizontal},
		{146, 14, layoutCompact},
		{170, 13, layoutCompact},
		{40, 30, layoutVertical},
		{39, 45, layoutCompact},
	}
	for _, tt := range tests {
		if got := chooseLayout(tt.w, tt.h); got != tt.want {
			t.Errorf("chooseLayout(%d, %d) = %v, want %v", tt.w, tt.h, got, tt.want)
		}
	}
}

func TestLayoutSizeMatrix(t *testing.T) {
	widths := []int{24, 40, 57, 80, 120, 147, 170, 195}
	heights := []int{6, 8, 14, 15, 30, 45}
	fixtures := []struct {
		name string
		snap protocol.Snapshot
	}{
		{"S0", fixtureS0()},
		{"S2", fixtureS2()},
		{"S5", fixtureS5()},
		{"SW", fixtureSW()},
	}
	themes := []*theme.Theme{mustTheme(t, "gta6"), mustTheme(t, "auto")}

	for _, f := range fixtures {
		for _, w := range widths {
			for _, h := range heights {
				m := testModel(f.snap, w, h)
				c, _ := layout(m)
				if c.W != w || c.H != h {
					t.Fatalf("%s %dx%d: canvas size = %dx%d, want %dx%d", f.name, w, h, c.W, c.H, w, h)
				}
				mask := theme.PalmMask(w, h)
				for _, th := range themes {
					out := c.Render(th, true, mask)
					lines := strings.Split(ansi.Strip(out), "\n")
					if len(lines) != h {
						t.Fatalf("%s %dx%d: rendered %d lines, want %d", f.name, w, h, len(lines), h)
					}
					for r, line := range lines {
						if lw := ansi.StringWidth(line); lw != w {
							t.Fatalf("%s %dx%d row %d: width = %d, want %d (%q)", f.name, w, h, r, lw, w, line)
						}
					}
				}
			}
		}
	}
}

func TestLayoutPureAndDeterministic(t *testing.T) {
	m := testModel(fixtureS2(), 57, 45)
	before := m
	c1, h1 := layout(m)
	c2, h2 := layout(m)

	if !reflect.DeepEqual(c1, c2) {
		t.Error("two calls to layout(m) produced different canvases")
	}
	if !reflect.DeepEqual(h1, h2) {
		t.Error("two calls to layout(m) produced different hits")
	}
	if !reflect.DeepEqual(m.snap, before.snap) || m.selected != before.selected || m.runOffset != before.runOffset || m.backOffset != before.backOffset {
		t.Error("layout(m) modified Model state")
	}

	// Selectable items and scrollable boxes must be present in hits.
	for _, id := range []string{mainID, "a1", "a2", "a3", "a4"} {
		if _, ok := findHit(h1, hitItem, id); !ok {
			t.Errorf("missing hitItem for %q", id)
		}
	}
	// Failed entry a4 has 2 rows (including its error line).
	hA4, _ := findHit(h1, hitItem, "a4")
	if hA4.rect.Dy() != 2 {
		t.Errorf("failed back-to-main hit height = %d, want 2", hA4.rect.Dy())
	}
	if _, ok := findHit(h1, hitBackScroll, ""); !ok {
		t.Error("missing hitBackScroll")
	}
	if _, ok := findHit(h1, hitLogScroll, ""); !ok {
		t.Error("missing hitLogScroll")
	}
}

func TestVerticalS2_57x45(t *testing.T) {
	m := testModel(fixtureS2(), 57, 45)
	c, hits := layout(m)
	lines := plainLines(c)
	text := strings.Join(lines, "\n")

	if len(lines) != 45 {
		t.Fatalf("line count = %d, want 45", len(lines))
	}

	// Running boxes: explore-auth & review-tests.
	h1, ok1 := findHit(hits, hitItem, "a1")
	h2, ok2 := findHit(hits, hitItem, "a2")
	if !ok1 || !ok2 {
		t.Fatalf("missing running agent hits: a1=%v a2=%v", ok1, ok2)
	}
	if h1.rect.Dx() != 26 || h2.rect.Dx() != 26 || h1.rect.Dy() != 7 || h2.rect.Dy() != 7 {
		t.Errorf("running box rects = %v and %v, want 26x7 each", h1.rect, h2.rect)
	}

	// Back to main: docs-outline & lint-check + error line; prev-turn-audit excluded.
	for _, want := range []string{"explore-auth", "review-tests", "docs-outline", "lint-check", "exit 1 · config not found"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in S2 output", want)
		}
	}
	if strings.Contains(text, "prev-turn-audit") {
		t.Error("previous-turn agent prev-turn-audit must not appear")
	}

	// Activity box must be exactly 15 rows tall (including borders).
	hLog, ok := findHit(hits, hitLogScroll, "")
	if !ok {
		t.Fatal("missing hitLogScroll")
	}
	if hLog.rect.Dy() != 15 {
		t.Errorf("activity box height = %d, want 15", hLog.rect.Dy())
	}

	// Status bar: sub-agents [2/4] and tools [11] from stats.turnTools.
	if !strings.Contains(text, "sub-agents [2/4]") {
		t.Error("status bar missing sub-agents [2/4]")
	}
	if !strings.Contains(text, "tools [11]") {
		t.Error("status bar missing tools [11]")
	}

	// Activity contains recent log entries and kind:agent done/failed.
	if !strings.Contains(text, "done") || !strings.Contains(text, "failed") {
		t.Error("activity missing agent done/failed entries")
	}

	// First two lines of running boxes: name · type (name bold, type dim), model [+ · bg].
	row1 := h1.rect.Min.Y + 1
	row2 := h1.rect.Min.Y + 2
	if !strings.Contains(lines[row1], "explore-auth · explore") {
		t.Errorf("a1 line 1 = %q, want explore-auth · explore", lines[row1])
	}
	if !strings.Contains(lines[row2], "gemini-4-neon") {
		t.Errorf("a1 line 2 = %q, want gemini-4-neon", lines[row2])
	}
	if !strings.Contains(lines[row1], "review-tests · task") {
		t.Errorf("a2 line 1 = %q, want review-tests · task", lines[row1])
	}
	if !strings.Contains(lines[row2], "claude-opus-5.5 · bg") {
		t.Errorf("a2 line 2 = %q, want claude-opus-5.5 · bg", lines[row2])
	}
	// Check cell colors on a1 line 1: name bold + RoleAgent, type RoleDim.
	nameCell := c.At(row1, h1.rect.Min.X+2)
	if !nameCell.Bold || nameCell.FG != theme.RoleAgent.Color() {
		t.Errorf("a1 name cell = %+v, want Bold + RoleAgent", nameCell)
	}
	typeStart := h1.rect.Min.X + 2 + len("explore-auth · ")
	typeCell := c.At(row1, typeStart)
	if typeCell.FG != theme.RoleDim.Color() || typeCell.Bold {
		t.Errorf("a1 type cell = %+v, want RoleDim not Bold", typeCell)
	}
}

func TestAgentBoxFirstTwoLines(t *testing.T) {
	t.Run("long name leaves <4 cells omits type", func(t *testing.T) {
		c := NewCanvas(26, 7) // inner = 22
		a := protocol.Agent{
			ID: "a1", Name: "abcdefghijklmnopq", Type: "explore", Model: "gemini-4-neon", Status: "running",
		} // name width 17; 22 - 17 - 3 = 2 < 4 -> omit type
		drawAgentBox(c, 0, 0, 26, boxFull, a, "", false, false, 0, fixtureNow)
		lines := plainLines(c)
		if strings.Contains(lines[1], Separator) {
			t.Errorf("line 1 = %q, want no type when <4 cells remain", lines[1])
		}
		if !strings.Contains(lines[1], "abcdefghijklmnopq") {
			t.Errorf("line 1 = %q, want full name", lines[1])
		}
	})

	t.Run("remaining >=4 cells truncates type with ellipsis", func(t *testing.T) {
		c := NewCanvas(24, 7) // inner = 20
		a := protocol.Agent{
			ID: "a1", Name: "explore-auth", Type: "explore", Model: "gemini-4-neon", Status: "running",
		} // 20 - 12 - 3 = 5 >= 4 -> "expl…"
		drawAgentBox(c, 0, 0, 24, boxFull, a, "", false, false, 0, fixtureNow)
		lines := plainLines(c)
		if !strings.Contains(lines[1], "explore-auth · expl…") {
			t.Errorf("line 1 = %q, want explore-auth · expl…", lines[1])
		}
	})

	t.Run("width 17 long model and bg drops bg and truncates model", func(t *testing.T) {
		c := NewCanvas(17, 7) // inner = 13
		a := protocol.Agent{
			ID: "a1", Name: "worker", Type: "task", Mode: "background", Model: "claude-opus-5.5-extra", Status: "running",
		}
		drawAgentBox(c, 0, 0, 17, boxFull, a, "", false, false, 0, fixtureNow)
		lines := plainLines(c)
		if strings.Contains(lines[2], "bg") {
			t.Errorf("line 2 = %q, want · bg dropped", lines[2])
		}
		if !strings.Contains(lines[2], Ellipsis) {
			t.Errorf("line 2 = %q, want truncated model with ellipsis", lines[2])
		}
	})

	t.Run("empty model shows name only on line 1 and type + bg on line 2", func(t *testing.T) {
		c := NewCanvas(26, 7)
		a := protocol.Agent{
			ID: "a1", Name: "review-tests", Type: "task", Mode: "background", Model: "", Status: "running",
		}
		drawAgentBox(c, 0, 0, 26, boxFull, a, "", false, false, 0, fixtureNow)
		lines := plainLines(c)
		if strings.Contains(lines[1], Separator) {
			t.Errorf("line 1 = %q, want name only when model is empty", lines[1])
		}
		if !strings.Contains(lines[2], "task · bg") {
			t.Errorf("line 2 = %q, want task · bg", lines[2])
		}
	})

	t.Run("spawned agent with model wide vs narrow", func(t *testing.T) {
		a := protocol.Agent{
			ID: "c1", Name: "child", Type: "explore", Model: "gpt-5", Parent: "p1", Status: "running",
		}
		// Width 31 (inner 27): "↳ parent  gpt-5" fits
		wide := NewCanvas(31, 7)
		drawAgentBox(wide, 0, 0, 31, boxFull, a, "parent", false, false, 0, fixtureNow)
		wl := plainLines(wide)
		if !strings.Contains(wl[2], "↳ parent  gpt-5") {
			t.Errorf("wide line 2 = %q, want %q", wl[2], "↳ parent  gpt-5")
		}

		// Width 17 (inner 13): "↳ parent" (8) + 2 + "gpt-5" (5) = 15 > 13 -> model omitted
		narrow := NewCanvas(17, 7)
		drawAgentBox(narrow, 0, 0, 17, boxFull, a, "parent", false, false, 0, fixtureNow)
		nl := plainLines(narrow)
		if !strings.Contains(nl[2], "↳ parent") {
			t.Errorf("narrow line 2 = %q, want prefix ↳ parent", nl[2])
		}
		if strings.Contains(nl[2], "gpt-5") {
			t.Errorf("narrow line 2 = %q, want model omitted when it doesn't fit", nl[2])
		}
	})

	t.Run("tall box h8 shows model on line 2 and desc on line 3", func(t *testing.T) {
		c := NewCanvas(26, 8)
		a := protocol.Agent{
			ID: "a1", Name: "explore-auth", Type: "explore", Model: "gemini-4-neon", Desc: "Trace joinSession", Status: "running",
		}
		drawAgentBox(c, 0, 0, 26, boxTall, a, "", false, false, 0, fixtureNow)
		lines := plainLines(c)
		if !strings.Contains(lines[2], "gemini-4-neon") {
			t.Errorf("tall line 2 = %q, want model", lines[2])
		}
		if !strings.Contains(lines[3], "Trace joinSession") {
			t.Errorf("tall line 3 = %q, want desc", lines[3])
		}
	})

	t.Run("no model in short box, compact row, or back to main", func(t *testing.T) {
		a := protocol.Agent{
			ID: "a1", Name: "worker", Type: "explore", Model: "secret-model-xyz", Status: "running",
			Tools: []protocol.Tool{{Name: "bash", Summary: "go test", Status: "running"}},
		}
		short := NewCanvas(24, 5)
		drawAgentBox(short, 0, 0, 24, boxShort, a, "", false, false, 0, fixtureNow)
		if strings.Contains(plainText(short), "secret-model") {
			t.Error("short box must not display model")
		}

		comp := NewCanvas(47, 1)
		drawCompactRow(comp, 0, 0, 47, a, "", false, false, 0, fixtureNow)
		if strings.Contains(plainText(comp), "secret-model") {
			t.Error("compact row must not display model")
		}

		done := a
		done.Status = "done"
		done.ReportedTurn = 1
		back := NewCanvas(55, 5)
		drawBackToMain(back, 0, 0, 55, 5, []protocol.Agent{done}, 1, "", 0, 0, fixtureNow)
		if strings.Contains(plainText(back), "secret-model") {
			t.Error("back to main must not display model")
		}
	})
}

func TestToolTrail(t *testing.T) {
	tools := []protocol.Tool{
		{Status: "done"},
		{Status: "done"},
		{Status: "done"},
		{Status: "failed"},
		{Status: "running"},
	}
	c := NewCanvas(20, 1)
	drawToolTrail(c, 0, 0, 20, tools, false, 0)

	wantText := []string{MarkTool, MarkTool, MarkTool, MarkTool, Spinner[0]}
	wantRole := []theme.Role{theme.RoleOK, theme.RoleOK, theme.RoleOK, theme.RoleFail, theme.RoleRun}
	for i := range wantText {
		cell := c.At(0, i*2)
		if cell.Text != wantText[i] || cell.FG != wantRole[i].Color() {
			t.Errorf("trail[%d] = (%q, %v), want (%q, %v)", i, cell.Text, cell.FG, wantText[i], wantRole[i])
		}
	}

	// Narrow width keeps only the most recent items.
	narrow := NewCanvas(5, 1) // fits (5+1)/2 = 3 items -> last 3: ok, fail, running
	drawToolTrail(narrow, 0, 0, 5, tools, false, 0)
	if narrow.At(0, 0).FG != theme.RoleOK.Color() || narrow.At(0, 2).FG != theme.RoleFail.Color() || narrow.At(0, 4).Text != Spinner[0] {
		t.Errorf("narrow trail = (%q %v, %q %v, %q %v), want last 3 (ok, fail, run)",
			narrow.At(0, 0).Text, narrow.At(0, 0).FG,
			narrow.At(0, 2).Text, narrow.At(0, 2).FG,
			narrow.At(0, 4).Text, narrow.At(0, 4).FG)
	}
}

func TestSelectionAndActivityFilter(t *testing.T) {
	m := testModel(fixtureS2(), 57, 45)
	m.selected = "a1" // explore-auth
	c, hits := layout(m)
	lines := plainLines(c)

	// Selected box has heavy border.
	h1, _ := findHit(hits, hitItem, "a1")
	if got := c.At(h1.rect.Min.Y, h1.rect.Min.X).Text; got != HeavyBorder.TopLeft {
		t.Errorf("selected box top-left = %q, want heavy %q", got, HeavyBorder.TopLeft)
	}
	// Unselected box has light border.
	h2, _ := findHit(hits, hitItem, "a2")
	if got := c.At(h2.rect.Min.Y, h2.rect.Min.X).Text; got != LightBorder.TopLeft {
		t.Errorf("unselected box top-left = %q, want light %q", got, LightBorder.TopLeft)
	}

	// Activity title shows selected name and only its entries.
	hLog, _ := findHit(hits, hitLogScroll, "")
	if !strings.Contains(lines[hLog.rect.Min.Y], "activity · explore-auth") {
		t.Errorf("activity header = %q, want activity · explore-auth", lines[hLog.rect.Min.Y])
	}
	for r := hLog.rect.Min.Y + 1; r < hLog.rect.Max.Y-1; r++ {
		if strings.Contains(lines[r], "review-tests") || strings.Contains(lines[r], "docs-outline") || strings.Contains(lines[r], "lint-check") {
			t.Errorf("filtered activity row %d leaked other actor: %q", r, lines[r])
		}
	}
}

func TestVerticalArrangementsAndGrid(t *testing.T) {
	makeSnap := func(n int) protocol.Snapshot {
		s := fixtureS0()
		s.Agents = nil
		for i := range n {
			s.Agents = append(s.Agents, protocol.Agent{
				ID:        fmt.Sprintf("a%d", i+1),
				SpawnTurn: 1,
				Name:      fmt.Sprintf("agent-%d", i+1),
				Type:      "task",
				Status:    "running",
				StartedAt: "2026-11-23T23:48:30Z",
			})
		}
		return s
	}

	// 1, 2, 3 running at 57x45 -> single row, widths 31, 26, 17.
	for _, tc := range []struct {
		n     int
		wantW int
	}{
		{1, 31},
		{2, 26},
		{3, 17},
	} {
		m := testModel(makeSnap(tc.n), 57, 45)
		_, hits := layout(m)
		var y0 int
		for i := range tc.n {
			h, ok := findHit(hits, hitItem, fmt.Sprintf("a%d", i+1))
			if !ok {
				t.Fatalf("n=%d missing hit a%d", tc.n, i+1)
			}
			if h.rect.Dx() != tc.wantW {
				t.Errorf("n=%d a%d width = %d, want %d", tc.n, i+1, h.rect.Dx(), tc.wantW)
			}
			if i == 0 {
				y0 = h.rect.Min.Y
			} else if h.rect.Min.Y != y0 {
				t.Errorf("n=%d a%d row = %d, want same row %d", tc.n, i+1, h.rect.Min.Y, y0)
			}
		}
	}

	// 3 running at width 50 -> (50-6)/3 = 14 < 16 -> two-column grid!
	m50 := testModel(makeSnap(3), 50, 45)
	_, hits50 := layout(m50)
	ha1, _ := findHit(hits50, hitItem, "a1")
	ha3, _ := findHit(hits50, hitItem, "a3")
	if ha3.rect.Min.Y <= ha1.rect.Min.Y {
		t.Errorf("3 running at W=50: a3 row %d should be below a1 row %d (2-col grid)", ha3.rect.Min.Y, ha1.rect.Min.Y)
	}

	// S5 at 57x45 -> 2-column grid with trunk and left/right branches.
	m5 := testModel(fixtureS5(), 57, 45)
	c5, hits5 := layout(m5)
	text5 := plainText(c5)
	if !strings.Contains(text5, ArrowLeft) || !strings.Contains(text5, ArrowRight) {
		t.Error("S5 two-column grid missing left/right branch arrows")
	}
	// Ensure ESC sequence from S5 fixture was cleaned.
	for r := range c5.H {
		for col := range c5.W {
			if strings.ContainsRune(c5.At(r, col).Text, '\x1b') {
				t.Fatalf("ESC sequence leaked into canvas at (%d,%d)", r, col)
			}
		}
	}
	for i := 1; i <= 5; i++ {
		if _, ok := findHit(hits5, hitItem, fmt.Sprintf("a%d", i)); !ok {
			t.Errorf("S5 missing running hit a%d", i)
		}
	}
}

func TestEmptyAndTurnStates(t *testing.T) {
	t.Run("S0 no sub-agents this turn", func(t *testing.T) {
		m := testModel(fixtureS0(), 57, 45)
		c, hits := layout(m)
		text := plainText(c)
		if !strings.Contains(text, "no sub-agents this turn") {
			t.Error("S0 missing 'no sub-agents this turn'")
		}
		if strings.Contains(text, "back to main") {
			t.Error("S0 must not show back to main")
		}
		if !strings.Contains(text, "sub-agents [0/0]") {
			t.Error("S0 status bar missing sub-agents [0/0]")
		}
		if _, ok := findHit(hits, hitBackScroll, ""); ok {
			t.Error("S0 must not have hitBackScroll")
		}
		hLog, ok := findHit(hits, hitLogScroll, "")
		if !ok || hLog.rect.Dy() != 45-12 {
			t.Errorf("S0 activity height = %d (ok=%v), want %d", hLog.rect.Dy(), ok, 45-12)
		}
	})

	t.Run("S0 main idle", func(t *testing.T) {
		s := fixtureS0()
		s.Main.Status = "idle"
		m := testModel(s, 57, 45)
		c, _ := layout(m)
		if !strings.Contains(plainText(c), IconIdle+" idle") {
			t.Error("idle main missing '○ idle'")
		}
	})

	t.Run("running with 0 reported shows back to main 0/N", func(t *testing.T) {
		s := fixtureS0()
		s.Agents = []protocol.Agent{
			{ID: "a1", SpawnTurn: 1, Name: "w1", Type: "task", Status: "running"},
			{ID: "a2", SpawnTurn: 1, Name: "w2", Type: "task", Status: "running"},
		}
		m := testModel(s, 57, 45)
		c, hits := layout(m)
		text := plainText(c)
		if !strings.Contains(text, "back to main") || !strings.Contains(text, "0/2") {
			t.Error("running with 0 reported should show back to main 0/2")
		}
		hb, _ := findHit(hits, hitBackScroll, "")
		if hb.rect.Dy() != 3 {
			t.Errorf("empty back to main height = %d, want 3", hb.rect.Dy())
		}
	})

	t.Run("previous-turn background agent still running then finishes", func(t *testing.T) {
		s := fixtureS0()
		s.Turn = 5
		s.Agents = []protocol.Agent{
			{ID: "bg1", SpawnTurn: 4, ReportedTurn: 0, Name: "old-bg", Type: "task", Mode: "background", Status: "running"},
		}
		m := testModel(s, 57, 45)
		c, _ := layout(m)
		text := plainText(c)
		if strings.Contains(text, "no sub-agents this turn") {
			t.Error("previous-turn running agent must not show 'no sub-agents this turn'")
		}
		for _, want := range []string{"1 running", "0/1", "sub-agents [1/1]"} {
			if !strings.Contains(text, want) {
				t.Errorf("missing %q", want)
			}
		}

		// Now it finishes in turn 5.
		s.Agents[0].Status = "done"
		s.Agents[0].ReportedTurn = 5
		m2 := testModel(s, 57, 45)
		c2, _ := layout(m2)
		text2 := plainText(c2)
		if !strings.Contains(text2, "1/1") || !strings.Contains(text2, "old-bg") {
			t.Error("finished previous-turn agent should appear in back to main with 1/1")
		}
	})

	t.Run("turn 0 with running agent reportedTurn 0", func(t *testing.T) {
		s := fixtureS0()
		s.Turn = 0
		s.Agents = []protocol.Agent{
			{ID: "a1", SpawnTurn: 0, ReportedTurn: 0, Name: "early", Type: "task", Status: "running"},
		}
		m := testModel(s, 57, 45)
		c, hits := layout(m)
		text := plainText(c)
		if !strings.Contains(text, "0/1") {
			t.Error("turn=0 running agent must show 0/1 in back to main")
		}
		hb, _ := findHit(hits, hitBackScroll, "")
		if hb.rect.Dy() != 3 {
			t.Errorf("turn=0 running agent leaked into back to main (height=%d, want 3)", hb.rect.Dy())
		}
	})

	t.Run("only finished agents: direct main-colored arrow, no live cells", func(t *testing.T) {
		s := fixtureS0()
		s.Turn = 2
		s.Agents = []protocol.Agent{
			{ID: "a1", SpawnTurn: 2, ReportedTurn: 2, Name: "done-one", Type: "task", Status: "done", DurationMs: 5000},
		}
		m := testModel(s, 57, 45)
		c, _ := layout(m)
		foundArrow := false
		for r := range c.H {
			for col := range c.W {
				cell := c.At(r, col)
				if cell.FG == theme.RoleLive.Color() {
					t.Errorf("found RoleLive cell at (%d,%d) %q when no agents running", r, col, cell.Text)
				}
				if cell.Text == ArrowDown && cell.FG == theme.RoleMain.Color() {
					foundArrow = true
				}
			}
		}
		if !foundArrow {
			t.Error("missing main-colored downward arrow into back to main")
		}

		// No sub-agent is counted as running: the icon of the count line is still.
		m.frame = 1
		c1, _ := layout(m)
		if got, want := plainLines(c1)[1], Spinner[0]+" 0 running"; !strings.Contains(got, want) {
			t.Errorf("count line on frame 1 = %q, want %q", got, want)
		}
	})

	t.Run("cancelled agent in count line and activity, absent when none", func(t *testing.T) {
		s := fixtureS0()
		s.Turn = 2
		s.Agents = []protocol.Agent{
			{ID: "a1", SpawnTurn: 2, ReportedTurn: 2, Name: "stopped", Type: "task", Status: "cancelled", DurationMs: 3000},
		}
		s.Log = append(s.Log, protocol.LogEntry{
			Seq: 99, T: "2026-11-23T23:48:42Z", Actor: "a1", Name: "stopped", Kind: "agent", Summary: "0:03", Status: "cancelled",
		})
		m := testModel(s, 57, 45)
		c, _ := layout(m)
		text := plainText(c)
		if !strings.Contains(text, IconCancelled+" 1 cancelled") {
			t.Errorf("missing %q in count line", IconCancelled+" 1 cancelled")
		}
		if !strings.Contains(text, "cancelled") {
			t.Error("missing cancelled in activity")
		}

		// Without cancelled agents: no ⊘ in count line.
		c2, _ := layout(testModel(fixtureS2(), 57, 45))
		if strings.Contains(plainLines(c2)[1], IconCancelled) {
			t.Error("count line should not show ⊘ when no agents cancelled")
		}
	})

	t.Run("turn increment clears back to main while keeping activity", func(t *testing.T) {
		s := fixtureS2()
		s.Turn = 4                                            // previous turn was 3
		s.Agents = []protocol.Agent{s.Agents[2], s.Agents[3]} // only finished from turn 3
		m := testModel(s, 57, 45)
		c, _ := layout(m)
		text := plainText(c)
		if !strings.Contains(text, "no sub-agents this turn") {
			t.Error("after turn increment with no new agents, should show no sub-agents this turn")
		}
		if strings.Contains(text, "back to main") {
			t.Error("back to main must be cleared after turn increment")
		}
		if !strings.Contains(text, "docs-outline") {
			t.Error("activity must still retain old log entries after turn increment")
		}
	})
}

func TestCompressionLevelsAndBoundaries(t *testing.T) {
	makeRunning := func(n int) protocol.Snapshot {
		s := fixtureS0()
		s.Agents = nil
		for i := range n {
			s.Agents = append(s.Agents, protocol.Agent{
				ID:        fmt.Sprintf("a%d", i+1),
				SpawnTurn: 1,
				Name:      fmt.Sprintf("ag-%02d", i+1),
				Type:      "task",
				Status:    "running",
				StartedAt: "2026-11-23T23:48:30Z",
				Tools:     []protocol.Tool{{Name: "bash", Summary: "run", Status: "running"}},
			})
		}
		return s
	}

	// Boundaries at 57x45 with 0 reported: 6 (full), 7 (short), 8 (short), 9 (compact), 12 (compact), 40 (compact), 41 (scroll), 60 (scroll).
	cases := []struct {
		n          int
		wantLevel  int
		wantBoxH   int
		wantScroll bool
		allVisible bool
	}{
		{6, 1, 7, false, true},
		{7, 2, 5, false, true},
		{8, 2, 5, false, true},
		{9, 3, 0, false, true},
		{12, 3, 0, false, true},
		{40, 3, 0, false, true},
		{41, 4, 0, true, false},
		{60, 4, 0, true, false},
	}

	for _, tc := range cases {
		t.Run(fmt.Sprintf("n=%d", tc.n), func(t *testing.T) {
			m := testModel(makeRunning(tc.n), 57, 45)
			c, hits := layout(m)
			text := plainText(c)

			if tc.wantLevel <= 2 {
				if _, ok := findHit(hits, hitRunScroll, ""); ok {
					t.Errorf("n=%d should be boxes (level %d), got compact frame", tc.n, tc.wantLevel)
				}
				h1, ok := findHit(hits, hitItem, "a1")
				if !ok || h1.rect.Dy() != tc.wantBoxH {
					t.Errorf("n=%d box height = %d (ok=%v), want %d", tc.n, h1.rect.Dy(), ok, tc.wantBoxH)
				}
			} else {
				hr, ok := findHit(hits, hitRunScroll, "")
				if !ok {
					t.Errorf("n=%d should be compact frame (level %d)", tc.n, tc.wantLevel)
				}
				if !strings.Contains(text, fmt.Sprintf("running · %d", tc.n)) {
					t.Errorf("n=%d missing running · %d title", tc.n, tc.n)
				}
				botBorder := plainLines(c)[hr.rect.Max.Y-1]
				hasDown := strings.Contains(botBorder, ArrowDown+" ")
				if hasDown != tc.wantScroll {
					t.Errorf("n=%d compact bottom border %q: hasDown = %v, want %v", tc.n, botBorder, hasDown, tc.wantScroll)
				}
			}
			if tc.allVisible {
				for i := 1; i <= tc.n; i++ {
					name := fmt.Sprintf("ag-%02d", i)
					if !strings.Contains(text, name) {
						t.Errorf("n=%d missing %q on screen", tc.n, name)
					}
				}
			}
		})
	}

	// Short box 2-col grid (n=8): branch connects at row 3 (0-based +2) of each box.
	m8 := testModel(makeRunning(8), 57, 45)
	c8, hits8 := layout(m8)
	h1, _ := findHit(hits8, hitItem, "a1")
	branchRow := h1.rect.Min.Y + 2
	if got := c8.At(branchRow, h1.rect.Max.X).Text; got != ArrowLeft {
		t.Errorf("short box grid branch at box row 3 (y=%d, x=%d) = %q, want %q", branchRow, h1.rect.Max.X, got, ArrowLeft)
	}

	// W=44, H=45, n=12 -> compact rows 1 column, height 14.
	m44 := testModel(makeRunning(12), 44, 45)
	_, hits44 := layout(m44)
	hr44, ok := findHit(hits44, hitRunScroll, "")
	if !ok || hr44.rect.Dy() != 14 {
		t.Errorf("W=44 n=12 compact frame height = %d (ok=%v), want 14", hr44.rect.Dy(), ok)
	}

	// 60 running, no selection: starts at first, ▼ N equals hidden count, no ▲.
	m60 := testModel(makeRunning(60), 57, 45)
	c60, hits60 := layout(m60)
	hr60, _ := findHit(hits60, hitRunScroll, "")
	lines60 := plainLines(c60)
	if strings.Contains(lines60[hr60.rect.Min.Y], ArrowUp) {
		t.Errorf("60 running top border = %q, want no ▲", lines60[hr60.rect.Min.Y])
	}
	visItems := (hr60.rect.Dy() - 2) * 2
	wantBelow := fmt.Sprintf("%s %d", ArrowDown, 60-visItems)
	if !strings.Contains(lines60[hr60.rect.Max.Y-1], wantBelow) {
		t.Errorf("60 running bottom border = %q, want %q", lines60[hr60.rect.Max.Y-1], wantBelow)
	}
}

func TestWorkedExampleBudget(t *testing.T) {
	// 7.11 worked example: W=57, 4 running, 5 finished (none failed), H=45, 41, 40, 38.
	s := fixtureS0()
	s.Agents = nil
	for i := range 4 {
		s.Agents = append(s.Agents, protocol.Agent{
			ID: fmt.Sprintf("r%d", i+1), SpawnTurn: 1, Name: fmt.Sprintf("run-%d", i+1), Type: "task", Status: "running",
		})
	}
	for i := range 5 {
		s.Agents = append(s.Agents, protocol.Agent{
			ID: fmt.Sprintf("d%d", i+1), SpawnTurn: 1, ReportedTurn: 1, Name: fmt.Sprintf("done-%d", i+1), Type: "task", Status: "done", DurationMs: 5000,
		})
	}

	tests := []struct {
		h            int
		wantBoxH     int
		wantActH     int
		wantBackDown string
	}{
		{45, 7, 9, ""},
		{41, 7, 5, ""},
		{40, 7, 6, ArrowDown + " 2"},
		{38, 5, 8, ArrowDown + " 2"},
	}

	for _, tt := range tests {
		t.Run(fmt.Sprintf("H=%d", tt.h), func(t *testing.T) {
			m := testModel(s, 57, tt.h)
			c, hits := layout(m)
			hr, _ := findHit(hits, hitItem, "r1")
			ha, _ := findHit(hits, hitLogScroll, "")
			hb, _ := findHit(hits, hitBackScroll, "")

			if hr.rect.Dy() != tt.wantBoxH {
				t.Errorf("H=%d run box height = %d, want %d", tt.h, hr.rect.Dy(), tt.wantBoxH)
			}
			if ha.rect.Dy() != tt.wantActH {
				t.Errorf("H=%d activity height = %d, want %d", tt.h, ha.rect.Dy(), tt.wantActH)
			}
			bottomLine := plainLines(c)[hb.rect.Max.Y-1]
			if tt.wantBackDown != "" && !strings.Contains(bottomLine, tt.wantBackDown) {
				t.Errorf("H=%d back bottom border = %q, want %q", tt.h, bottomLine, tt.wantBackDown)
			}
			if tt.wantBackDown == "" && strings.Contains(bottomLine, ArrowDown) {
				t.Errorf("H=%d back bottom border = %q, want no ▼", tt.h, bottomLine)
			}
		})
	}
}

func TestBackToMainScrollingAndFailedEntries(t *testing.T) {
	// 14 finished (3 failed), 2 running, 57x45.
	s := fixtureS0()
	s.Agents = []protocol.Agent{
		{ID: "r1", SpawnTurn: 1, Name: "run-1", Type: "task", Status: "running"},
		{ID: "r2", SpawnTurn: 1, Name: "run-2", Type: "task", Status: "running"},
	}
	for i := range 14 {
		a := protocol.Agent{
			ID: fmt.Sprintf("f%d", i+1), SpawnTurn: 1, ReportedTurn: 1,
			Name: fmt.Sprintf("fin-%02d", i+1), Type: "task", Status: "done", DurationMs: 5000, ToolCount: 2,
		}
		if i == 1 || i == 6 || i == 10 {
			a.Status = "failed"
			a.Error = fmt.Sprintf("err on fin-%02d", i+1)
		}
		s.Agents = append(s.Agents, a)
	}

	m := testModel(s, 57, 45)
	c, hits := layout(m)
	hb, _ := findHit(hits, hitBackScroll, "")
	if hb.rect.Dy() > 3+8 {
		t.Errorf("back to main height = %d, want <= 11 (3 + 8 entry rows)", hb.rect.Dy())
	}
	text := plainText(c)
	if strings.Contains(text, "more") {
		t.Error("back to main must not show '+N more'")
	}

	// Count visible back entries via hits and verify above + vis + below == 14, and no failed entry is 1 row.
	for off := 0; off < 14; off++ {
		mo := m
		mo.backOffset = off
		co, hitso := layout(mo)
		hbo, _ := findHit(hitso, hitBackScroll, "")
		vis := 0
		for _, h := range hitso {
			if h.kind == hitItem && strings.HasPrefix(h.id, "f") {
				vis++
				if (h.id == "f2" || h.id == "f7" || h.id == "f11") && h.rect.Dy() != 2 {
					t.Errorf("offset %d: failed entry %s rendered with height %d, want 2", off, h.id, h.rect.Dy())
				}
			}
		}
		lineso := plainLines(co)
		topBorder := lineso[hbo.rect.Min.Y]
		botBorder := lineso[hbo.rect.Max.Y-1]
		above := off
		below := 14 - off - vis
		if above > 0 && !strings.Contains(topBorder, fmt.Sprintf("%s %d", ArrowUp, above)) {
			t.Errorf("offset %d: top border %q missing ▲ %d", off, topBorder, above)
		}
		if below > 0 && !strings.Contains(botBorder, fmt.Sprintf("%s %d", ArrowDown, below)) {
			t.Errorf("offset %d: bot border %q missing ▼ %d", off, botBorder, below)
		}
	}
}

func TestNestedSubAgents(t *testing.T) {
	// Running A, B, and C spawned by A -> display order A, C, B.
	s := fixtureS0()
	s.Agents = []protocol.Agent{
		{ID: "A", SpawnTurn: 1, Name: "alpha", Type: "explore", Model: "gemini-4-neon", Status: "running", Tools: []protocol.Tool{{Name: "grep", Status: "running"}}},
		{ID: "B", SpawnTurn: 1, Name: "beta", Type: "task", Model: "claude-opus-5.5", Status: "running", Tools: []protocol.Tool{{Name: "bash", Status: "running"}}},
		{ID: "C", SpawnTurn: 1, Name: "child", Type: "explore", Model: "gemini-4-neon", Parent: "A", Status: "running", Tools: []protocol.Tool{{Name: "view", Summary: "x.go", Status: "running"}}},
	}

	m := testModel(s, 57, 45)
	m.selected = "C"
	c, hits := layout(m)
	lines := plainLines(c)

	hA, _ := findHit(hits, hitItem, "A")
	hC, _ := findHit(hits, hitItem, "C")
	hB, _ := findHit(hits, hitItem, "B")
	if !(hA.rect.Min.X < hC.rect.Min.X && hC.rect.Min.X < hB.rect.Min.X) {
		t.Errorf("expected order A (%d) < C (%d) < B (%d)", hA.rect.Min.X, hC.rect.Min.X, hB.rect.Min.X)
	}
	// Parent A's border is RoleMain when child C is selected.
	if got := c.At(hA.rect.Min.Y, hA.rect.Min.X).FG; got != theme.RoleMain.Color() {
		t.Errorf("parent A border FG = %v, want RoleMain", got)
	}
	// Activity header shows "activity · child ‹ alpha".
	hLog, _ := findHit(hits, hitLogScroll, "")
	if !strings.Contains(lines[hLog.rect.Min.Y], "activity · child ‹ alpha") {
		t.Errorf("activity header = %q, want activity · child ‹ alpha", lines[hLog.rect.Min.Y])
	}

	// Short box for C: "child ‹ alpha".
	shortC := NewCanvas(24, 5)
	drawAgentBox(shortC, 0, 0, 24, boxShort, s.Agents[2], "alpha", false, false, 0, fixtureNow)
	if !strings.Contains(plainLines(shortC)[1], "child ‹ alpha") {
		t.Errorf("short box line 1 = %q, want 'child ‹ alpha'", plainLines(shortC)[1])
	}

	// Compact row for C at colW=26 and colW=47.
	comp26 := NewCanvas(26, 1)
	drawCompactRow(comp26, 0, 0, 26, s.Agents[2], "alpha", false, false, 0, fixtureNow)
	s26 := plainText(comp26)
	if !strings.Contains(s26, "↳ child") || strings.Contains(s26, "‹ alpha") {
		t.Errorf("compact colW=26 = %q, want '↳ child' without '‹ alpha'", s26)
	}

	comp47 := NewCanvas(47, 1)
	drawCompactRow(comp47, 0, 0, 47, s.Agents[2], "alpha", false, false, 0, fixtureNow)
	s47 := plainText(comp47)
	if !strings.Contains(s47, "↳ child") || !strings.Contains(s47, "‹ alpha") {
		t.Errorf("compact colW=47 = %q, want '↳ child' and '‹ alpha'", s47)
	}

	// Compact row for parent A when C is selected: leading ◆ and RoleMain name.
	compParent := NewCanvas(26, 1)
	drawCompactRow(compParent, 0, 0, 26, s.Agents[0], "", false, true, 0, fixtureNow)
	if compParent.At(0, 0).Text != MarkParent {
		t.Errorf("parent compact row col 0 = %q, want %q", compParent.At(0, 0).Text, MarkParent)
	}
	if compParent.At(0, 3).FG != theme.RoleMain.Color() {
		t.Errorf("parent compact row name FG = %v, want RoleMain", compParent.At(0, 3).FG)
	}

	// Parent finished (in back to main) or missing -> no ↳ and no parent name.
	sFin := fixtureS0()
	sFin.Agents = []protocol.Agent{
		{ID: "C", SpawnTurn: 1, Name: "orphan-1", Type: "explore", Parent: "A", Status: "running"},
		{ID: "D", SpawnTurn: 1, Name: "orphan-2", Type: "explore", Parent: "missing", Status: "running"},
		{ID: "A", SpawnTurn: 1, ReportedTurn: 1, Name: "alpha", Type: "explore", Status: "done", DurationMs: 5000},
	}
	cFin, _ := layout(testModel(sFin, 57, 45))
	if strings.Contains(plainText(cFin), MarkChild) {
		t.Error("agent whose parent is finished or missing must not show ↳")
	}
}

func TestActivityScrolling(t *testing.T) {
	makeLogSnap := func(firstSeq, count int) protocol.Snapshot {
		s := fixtureS0()
		s.Log = nil
		for i := range count {
			seq := int64(firstSeq + i)
			s.Log = append(s.Log, protocol.LogEntry{
				Seq: seq, T: "2026-11-23T23:48:00Z", Actor: "main", Name: "main",
				Kind: "tool", Tool: "view", Summary: fmt.Sprintf("entry-%03d", seq), Status: "done",
			})
		}
		return s
	}

	// Following at bottom: shows newest, no ▼.
	m := testModel(makeLogSnap(1, 200), 57, 45)
	m.logFollow = true
	c, hits := layout(m)
	hLog, _ := findHit(hits, hitLogScroll, "")
	lines := plainLines(c)
	if !strings.Contains(lines[hLog.rect.Max.Y-2], "entry-200") {
		t.Errorf("last activity row = %q, want entry-200", lines[hLog.rect.Max.Y-2])
	}
	if strings.Contains(lines[hLog.rect.Max.Y-1], ArrowDown) {
		t.Errorf("following bottom border = %q, want no ▼", lines[hLog.rect.Max.Y-1])
	}

	// Scrolled up (!logFollow) with logTop=100: stays at 100 when new entries arrive and ▼ grows.
	mUp := m
	mUp.logFollow = false
	mUp.logTop = 100
	c1, hits1 := layout(mUp)
	hLog1, _ := findHit(hits1, hitLogScroll, "")
	lines1 := plainLines(c1)
	if !strings.Contains(lines1[hLog1.rect.Min.Y+1], "entry-100") {
		t.Errorf("first visible row = %q, want entry-100", lines1[hLog1.rect.Min.Y+1])
	}

	// 10 more entries arrive (oldest 10 evicted: seqs 11..210).
	mUp.snap = makeLogSnap(11, 200)
	c2, hits2 := layout(mUp)
	hLog2, _ := findHit(hits2, hitLogScroll, "")
	lines2 := plainLines(c2)
	if !strings.Contains(lines2[hLog2.rect.Min.Y+1], "entry-100") {
		t.Errorf("after new entries first visible row = %q, want still entry-100", lines2[hLog2.rect.Min.Y+1])
	}
	visRows := hLog2.rect.Dy() - 2
	wantBelow := fmt.Sprintf("%s %d", ArrowDown, 210-(100+visRows-1))
	if !strings.Contains(lines2[hLog2.rect.Max.Y-1], wantBelow) {
		t.Errorf("after new entries bottom border = %q, want %q", lines2[hLog2.rect.Max.Y-1], wantBelow)
	}

	// logTop evicted (seqs 150..349): stops at oldest existing (entry-150), no panic.
	mUp.snap = makeLogSnap(150, 200)
	c3, hits3 := layout(mUp)
	hLog3, _ := findHit(hits3, hitLogScroll, "")
	lines3 := plainLines(c3)
	if !strings.Contains(lines3[hLog3.rect.Min.Y+1], "entry-150") {
		t.Errorf("after eviction first visible row = %q, want entry-150", lines3[hLog3.rect.Min.Y+1])
	}
}

// A long title does not take the place of the ▲ N mark on the top border: it
// is cut short in front of it.
func TestActivityScrollMarkWithALongTitle(t *testing.T) {
	const name = "very-long-subagent-name-for-truncation-checks"
	logSnap := func(records int) protocol.Snapshot {
		s := makeRunningSnap(1)
		s.Agents[0].Name = name
		s.Log = nil
		for i := range records {
			s.Log = append(s.Log, protocol.LogEntry{
				Seq: int64(i + 1), T: "2026-11-23T23:48:00Z", Actor: "a1", Name: name,
				Kind: "tool", Tool: "view", Summary: fmt.Sprintf("f%02d.go", i+1), Status: "done",
			})
		}
		return s
	}
	tests := []struct {
		name    string
		records int // the box shows 16 of them
		want    string
	}{
		{"records above", 40, "┌─ activity · very-long-subagent-name-for-trun… ▲ 24 ─┐"},
		{"nothing above", 16, "┌─ activity · very-long-subagent-name-for-truncation…─┐"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := testModel(logSnap(tt.records), 57, 45)
			m.selected = "a1"
			c, hits := layout(m)
			h, ok := findHit(hits, hitLogScroll, "")
			if !ok || h.rect.Dy() != 18 {
				t.Fatalf("activity box rect = %v (ok=%v), want it 18 rows tall", h.rect, ok)
			}
			if got := strings.TrimSpace(plainLines(c)[h.rect.Min.Y]); got != tt.want {
				t.Errorf("top border = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestActivityToolNameWithoutSummary(t *testing.T) {
	const (
		plan = "exit_plan_mode"
		long = "github-mcp-server-get_file_contents"
	)
	record := protocol.LogEntry{Seq: 1, T: "2026-11-23T23:48:41Z", Actor: mainID, Name: mainID, Kind: "tool", Status: "running"}
	tool := func(name, summary string) protocol.LogEntry {
		e := record
		e.Tool, e.Summary = name, summary
		return e
	}
	// The pane does not know this status: nothing else is longer than the slot.
	agent := record
	agent.Kind, agent.Status = "agent", "timed_out_waiting"

	tests := []struct {
		name     string
		w, h     int
		selected string // not empty: the activity page of the compact layout
		entry    protocol.LogEntry
		want     string // the row of the record
	}{
		{"activity box", 57, 45, "", tool(plan, ""), "23:48:41 main         ◐ exit_plan_mode"},
		{"activity box, name longer than the row", 57, 45, "", tool(long, ""), "23:48:41 main         ◐ github-mcp-server-get_file…"},
		{"activity box, with a summary", 57, 45, "", tool(plan, "plan.md"), "23:48:41 main         ◐ exit_plan… plan.md"},
		{"activity box, agent record", 57, 45, "", agent, "23:48:41 main         ? timed_out…"},
		{"narrow activity box", 40, 30, "", tool(plan, ""), "48:41 main       ◐ exit_plan_mode"},
		{"compact layout, 100 wide", 100, 20, mainID, tool(plan, ""), "23:48:41 main         ◐ exit_plan_mode"},
		{"compact layout", 30, 8, mainID, tool(plan, ""), "48:41 ◐ exit_plan_mode"},
		{"compact layout, name longer than the row", 20, 8, mainID, tool(plan, ""), "48:41 ◐ exit_plan_m…"},
		{"compact layout, with a summary", 30, 8, mainID, tool(plan, "plan.md"), "48:41 ◐ exit_plan… plan.md"},
		{"compact layout, agent record", 30, 8, mainID, agent, "48:41 ? timed_out…"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := fixtureS0()
			s.Log = []protocol.LogEntry{tt.entry}
			m := testModel(s, tt.w, tt.h)
			m.selected, m.showLog = tt.selected, tt.selected != ""
			c, hits := layout(m)
			h, ok := findHit(hits, hitLogScroll, "")
			if !ok {
				t.Fatal("missing hitLogScroll")
			}
			// The record is below the top border of the box, or the title of the page.
			got := strings.Trim(plainLines(c)[h.rect.Min.Y+1], " "+LightBorder.Vertical)
			if got != tt.want {
				t.Errorf("record row = %q, want %q", got, tt.want)
			}
		})
	}
}

// The records carry UTC times, and the pane shows them in the zone of the
// model: the hour is another one, and in a half-hour zone the minute too.
func TestActivityTimesInTheZoneOfTheModel(t *testing.T) {
	record := protocol.LogEntry{Seq: 1, T: "2026-11-23T23:48:41Z", Actor: mainID, Name: mainID, Kind: "tool", Tool: "view", Status: "done"}
	zones := []struct {
		name        string
		loc         *time.Location
		full, short string // HH:MM:SS and MM:SS
	}{
		{"UTC", time.UTC, "23:48:41", "48:41"},
		{"east of UTC, the next day", time.FixedZone("", 8*60*60), "07:48:41", "48:41"},
		{"west of UTC", time.FixedZone("", -8*60*60), "15:48:41", "48:41"},
		{"half-hour zone", time.FixedZone("", 5*60*60+30*60), "05:18:41", "18:41"},
	}
	pages := []struct {
		name     string
		w, h     int
		selected string // not empty: the activity page of the compact layout
		full     bool
	}{
		{"activity box", 57, 45, "", true},
		{"narrow activity box", 40, 30, "", false},
		{"compact layout, 100 wide", 100, 20, mainID, true},
		{"compact layout", 30, 8, mainID, false},
	}
	for _, z := range zones {
		for _, p := range pages {
			t.Run(z.name+", "+p.name, func(t *testing.T) {
				s := fixtureS0()
				s.Log = []protocol.LogEntry{record}
				m := testModel(s, p.w, p.h)
				m.loc = z.loc
				m.selected, m.showLog = p.selected, p.selected != ""
				c, hits := layout(m)
				h, ok := findHit(hits, hitLogScroll, "")
				if !ok {
					t.Fatal("missing hitLogScroll")
				}
				want := z.short + " "
				if p.full {
					want = z.full + " "
				}
				got := strings.Trim(plainLines(c)[h.rect.Min.Y+1], " "+LightBorder.Vertical)
				if !strings.HasPrefix(got, want) {
					t.Errorf("record row = %q, want it to start with %q", got, want)
				}
			})
		}
	}
}

// A new model shows the times in the local zone.
func TestActivityTimesAreLocalByDefault(t *testing.T) {
	local := time.Local
	t.Cleanup(func() { time.Local = local })
	time.Local = time.FixedZone("", 5*60*60+30*60)

	m := New("", fixtureNow)
	m.snap, m.connected, m.width, m.height = fixtureS0(), true, 57, 45
	c, hits := layout(m)
	h, ok := findHit(hits, hitLogScroll, "")
	if !ok {
		t.Fatal("missing hitLogScroll")
	}
	// The first record of fixtureS0 is of 23:48:32 UTC.
	got := strings.Trim(plainLines(c)[h.rect.Min.Y+1], " "+LightBorder.Vertical)
	if want := "05:18:32 main"; !strings.HasPrefix(got, want) {
		t.Errorf("record row = %q, want it to start with %q", got, want)
	}
}

// In a narrow pane the status bar takes a narrower form rather than be cut.
func TestStatusBarNarrowForms(t *testing.T) {
	tests := []struct {
		w                     int // of the pane: the bar is two cells narrower
		running, total, tools int
		want                  string
	}{
		{57, 2, 4, 11, "main [working]  sub-agents [2/4]  tools [11]"},
		{46, 2, 4, 11, "main [working]  sub-agents [2/4]  tools [11]"},
		{45, 2, 4, 11, "main [working] sub-agents [2/4] tools [11]"},
		{44, 2, 4, 11, "main [working] sub-agents [2/4] tools [11]"},
		{43, 2, 4, 11, "main [working] agents [2/4] tools [11]"},
		{40, 2, 4, 11, "main [working] agents [2/4] tools [11]"},
		{49, 10, 60, 240, "main [working]  sub-agents [10/60]  tools [240]"},
		{48, 10, 60, 240, "main [working] sub-agents [10/60] tools [240]"},
		{46, 10, 60, 240, "main [working] agents [10/60] tools [240]"},
		{43, 10, 60, 240, "main [working] agents [10/60] tools [240]"},
		{42, 10, 60, 240, "main [working] [10/60] [240]"},
		{40, 10, 60, 240, "main [working] [10/60] [240]"},
		// Narrower than the vertical layout gets: the last counts go, whole.
		{29, 10, 60, 240, "main [working] [10/60]"},
		{23, 10, 60, 240, "main [working]"},
	}
	for _, tt := range tests {
		m := testModel(fixtureS2(), tt.w, 2)
		m.snap.Stats.TurnTools = tt.tools
		c := NewCanvas(tt.w, 2)
		drawStatusAndHints(c, 0, 0, tt.w, m, tt.running, tt.total, true)
		if got := strings.TrimSpace(plainLines(c)[0]); got != tt.want {
			t.Errorf("%d wide, [%d/%d] and [%d]: status bar = %q, want %q", tt.w, tt.running, tt.total, tt.tools, got, tt.want)
		}
	}

	// The same in the layout: 11 tool calls do not read as 1.
	c, _ := layout(testModel(fixtureS2(), 44, 45))
	if got, want := strings.TrimSpace(plainLines(c)[43]), "main [working] sub-agents [2/4] tools [11]"; got != want {
		t.Errorf("status bar of a pane 44 wide = %q, want %q", got, want)
	}
}

// In a narrow pane the count line takes a narrower form rather than be cut.
func TestCountLineNarrowForms(t *testing.T) {
	// One sub-agent of each kind: running, waiting, done, failed, cancelled.
	s := fixtureSW()
	s.Agents = append(s.Agents, protocol.Agent{
		ID: "a5", SpawnTurn: 3, ReportedTurn: 3, Name: "stopped", Type: "task", Status: "cancelled", DurationMs: 3000,
	})
	var (
		full   = Spinner[0] + " 1 running  ! 1 waiting  ✓ 1 done  ✗ 1 failed  ⊘ 1 cancelled"
		single = Spinner[0] + " 1 running ! 1 waiting ✓ 1 done ✗ 1 failed ⊘ 1 cancelled"
		short  = Spinner[0] + "1 !1 ✓1 ✗1 ⊘1"
	)
	tests := []struct {
		w    int
		want string
	}{
		{62, full},
		{61, full},
		{60, single},
		{57, single},
		{56, short},
		{40, short},
	}
	for _, tt := range tests {
		c, _ := layout(testModel(s, tt.w, 45))
		line := plainLines(c)[1]
		if got := strings.TrimSpace(line); got != tt.want {
			t.Errorf("%d wide: count line = %q, want %q", tt.w, got, tt.want)
			continue
		}
		// Whatever the form, it is centered and its waiting mark is bold.
		if got, want := colOf(line, tt.want), (tt.w-Width(tt.want))/2; got != want {
			t.Errorf("%d wide: count line starts at column %d, want %d", tt.w, got, want)
		}
		checkMark(t, c, 1, colOf(line, IconWaiting))
	}
}

// In a narrow pane the label of the delegate stem loses the word "running"
// rather than be cut.
func TestDelegateLabelNarrowForms(t *testing.T) {
	tests := []struct {
		w, n int // the width of the pane, the running sub-agents
		want string
	}{
		{57, 2, "│ delegate · 2 running"},
		{42, 2, "│ delegate · 2 running"},
		{41, 2, "│ delegate · 2"},
		{40, 2, "│ delegate · 2"},
		{44, 12, "│ delegate · 12 running"},
		{43, 12, "│ delegate · 12"},
		{40, 12, "│ delegate · 12"},
	}
	for _, tt := range tests {
		c, _ := layout(testModel(makeRunningSnap(tt.n), tt.w, 45))
		if got := strings.TrimSpace(plainLines(c)[8]); got != tt.want {
			t.Errorf("%d wide, %d running: row 8 = %q, want %q", tt.w, tt.n, got, tt.want)
		}
	}

	// Nothing at all where even the short label has no room.
	if got := delegateLabel(2, 12); got != "" {
		t.Errorf("delegateLabel(2, 12) = %q, want nothing", got)
	}
}

func TestConnectingAndViewMetadata(t *testing.T) {
	m := New("", fixtureNow)
	um, _ := m.Update(tea.WindowSizeMsg{Width: 57, Height: 45})
	m = um.(Model)

	c, hits := layout(m)
	if len(hits) != 0 {
		t.Errorf("before snapshot hits = %d, want 0", len(hits))
	}
	lines := plainLines(c)
	if !strings.Contains(lines[45/2], "Connecting…") {
		t.Errorf("middle row before snapshot = %q, want Connecting…", lines[45/2])
	}

	v := m.View()
	if !v.AltScreen {
		t.Error("View.AltScreen = false, want true")
	}
	if v.WindowTitle != "FleetPane" {
		t.Errorf("View.WindowTitle = %q, want FleetPane", v.WindowTitle)
	}
	if v.MouseMode != tea.MouseModeCellMotion {
		t.Errorf("View.MouseMode = %v, want MouseModeCellMotion", v.MouseMode)
	}
	if v.BackgroundColor == nil {
		t.Error("View.BackgroundColor = nil for gta6 theme, want first stop")
	}
}

func TestVerticalDetailsAndEdgeCases(t *testing.T) {
	t.Run("turnTools overrides len(main.tools) and status rows are panel-marked", func(t *testing.T) {
		s := fixtureS2()
		s.Stats.TurnTools = 77
		s.Main.Tools = make([]protocol.Tool, 20)
		for i := range s.Main.Tools {
			s.Main.Tools[i] = protocol.Tool{Name: "view", Summary: "f.go", Status: "done"}
		}
		m := testModel(s, 57, 45)
		c, hits := layout(m)
		text := plainText(c)
		if !strings.Contains(text, "tools [77]") {
			t.Errorf("status bar missing tools [77] from stats.turnTools")
		}
		// Status bar & key hints rows must be marked Panel=true.
		for _, r := range []int{43, 44} {
			if !c.At(r, 1).Panel {
				t.Errorf("row %d col 1 Panel = false, want true", r)
			}
		}
		// kind:agent "done"/"failed" in activity must be bold.
		hLog, _ := findHit(hits, hitLogScroll, "")
		foundBoldAgent := false
		for r := hLog.rect.Min.Y + 1; r < hLog.rect.Max.Y-1; r++ {
			line := plainLines(c)[r]
			if idx := strings.Index(line, "failed"); idx >= 0 {
				if c.At(r, idx).Bold {
					foundBoldAgent = true
				}
			}
		}
		if !foundBoldAgent {
			t.Error("expected kind:agent 'failed' in activity to be Bold")
		}
	})

	t.Run("wide vertical 170x45 caps content width to 100 and centers it", func(t *testing.T) {
		m := testModel(fixtureS2(), 170, 45)
		_, hits := layout(m)
		hLog, ok := findHit(hits, hitLogScroll, "")
		if !ok {
			t.Fatal("missing hitLogScroll")
		}
		// W=100, x0=(170-100)/2=35, activity box starts at x0+1=36 with width W-2=98.
		if hLog.rect.Min.X != 36 || hLog.rect.Dx() != 98 {
			t.Errorf("wide activity rect = %v, want Min.X=36 Dx=98", hLog.rect)
		}
	})

	t.Run("narrow activity uses MM:SS and 10-cell name", func(t *testing.T) {
		m := testModel(fixtureS2(), 40, 45) // activity innerW = 38 - 4 = 34 < 50
		c, hits := layout(m)
		hLog, _ := findHit(hits, hitLogScroll, "")
		lines := plainLines(c)
		rowText := lines[hLog.rect.Max.Y-2] // newest entry: 23:48:44 explore-auth
		if strings.Contains(rowText, "23:48:44") {
			t.Errorf("narrow activity row %q should use MM:SS, not HH:MM:SS", rowText)
		}
		if !strings.Contains(rowText, "48:44") {
			t.Errorf("narrow activity row %q missing MM:SS '48:44'", rowText)
		}
		if !strings.Contains(rowText, "explore-a…") {
			t.Errorf("narrow activity row %q should truncate actor name to 10 cells ('explore-a…')", rowText)
		}
	})

	t.Run("status icons and frame animation", func(t *testing.T) {
		m0 := testModel(fixtureS2(), 57, 45)
		m0.frame = 0
		m1 := m0
		m1.frame = 1
		c0, _ := layout(m0)
		c1, _ := layout(m1)
		if !strings.Contains(plainText(c0), Spinner[0]) || !strings.Contains(plainText(c1), Spinner[1]) {
			t.Error("animation frame did not advance spinner icon")
		}
		for _, tc := range []struct {
			status string
			want   string
		}{
			{"running", Spinner[0]},
			{"working", Spinner[0]},
			{"done", IconOK},
			{"failed", IconFail},
			{"cancelled", IconCancelled},
			{"idle", IconIdle},
			{"mystery", IconUnknown},
		} {
			if got, _ := statusIcon(tc.status, 0); got != tc.want {
				t.Errorf("statusIcon(%q) = %q, want %q", tc.status, got, tc.want)
			}
		}
	})
}

func TestWaitingSW_57x45(t *testing.T) {
	m := testModel(fixtureSW(), 57, 45)
	c, hits := layout(m)
	lines := plainLines(c)
	run := theme.RoleRun.Color()

	hMain, _ := findHit(hits, hitItem, mainID)
	h1, _ := findHit(hits, hitItem, "a1")
	h2, ok := findHit(hits, hitItem, "a2")
	if !ok || h2.rect.Dx() != 26 || h2.rect.Dy() != 7 {
		t.Fatalf("waiting box rect = %v (ok=%v), want a 26x7 box in the run area", h2.rect, ok)
	}
	cx := hMain.rect.Min.X + hMain.rect.Dx()/2
	bc1 := h1.rect.Min.X + h1.rect.Dx()/2
	bc2 := h2.rect.Min.X + h2.rect.Dx()/2
	fanRow, arrowRow := h2.rect.Min.Y-2, h2.rect.Min.Y-1

	t.Run("count line and status bar", func(t *testing.T) {
		want := Spinner[0] + " 1 running  ! 1 waiting  ✓ 1 done  ✗ 1 failed"
		if got := strings.TrimSpace(lines[1]); got != want {
			t.Errorf("count line = %q, want %q", got, want)
		}
		checkMark(t, c, 1, colOf(lines[1], IconWaiting))
		if want := "main [waiting]  sub-agents [2/4]"; !strings.Contains(lines[43], want) {
			t.Errorf("status bar = %q, want %q", lines[43], want)
		}
	})

	t.Run("main box", func(t *testing.T) {
		row := hMain.rect.Min.Y + 2
		if want := "│ ! needs answer         0:42 │"; !strings.Contains(lines[row], want) {
			t.Errorf("main box line 2 = %q, want %q", lines[row], want)
		}
		checkMark(t, c, row, hMain.rect.Min.X+2)
	})

	t.Run("waiting box", func(t *testing.T) {
		row := h2.rect.Max.Y - 2
		if want := "│ ! needs approval  0:38 │"; !strings.Contains(lines[row], want) {
			t.Errorf("status line = %q, want %q", lines[row], want)
		}
		checkMark(t, c, row, h2.rect.Min.X+2)
		for x := h2.rect.Min.X; x < h2.rect.Max.X; x++ {
			for _, y := range []int{h2.rect.Min.Y, h2.rect.Max.Y - 1} {
				if got := c.At(y, x).FG; got != run {
					t.Errorf("border cell (%d,%d) is drawn in %v, want %v", y, x, got, theme.RoleRun)
				}
			}
		}
		for y := h2.rect.Min.Y; y < h2.rect.Max.Y; y++ {
			for _, x := range []int{h2.rect.Min.X, h2.rect.Max.X - 1} {
				if got := c.At(y, x).FG; got != run {
					t.Errorf("border cell (%d,%d) is drawn in %v, want %v", y, x, got, theme.RoleRun)
				}
			}
		}

		// The running call of the tool trail is the mark, on every frame.
		checkMark(t, c, h2.rect.Min.Y+3, h2.rect.Min.X+2)
		for frame := range len(Spinner) {
			mf := m
			mf.frame = frame
			cf, _ := layout(mf)
			for y := h2.rect.Min.Y; y < h2.rect.Max.Y; y++ {
				for x := h2.rect.Min.X; x < h2.rect.Max.X; x++ {
					if got := cf.At(y, x).Text; slices.Contains(Spinner[:], got) {
						t.Errorf("frame %d: cell (%d,%d) = %q, want no spinner in the waiting box", frame, y, x, got)
					}
				}
			}
		}
	})

	t.Run("branches", func(t *testing.T) {
		for frame := range 30 {
			mf := m
			mf.frame = frame
			cf, _ := layout(mf)

			// Into the waiting box: static.
			checkSegment(t, cf, fanRow, cx+1, bc2+1, theme.RoleEdge, 0)
			checkSegment(t, cf, arrowRow, bc2, bc2+1, theme.RoleEdge, 0)
			if got := cf.At(arrowRow, bc2).Text; got != ArrowDown {
				t.Errorf("frame %d: cell (%d,%d) = %q, want the arrow %q", frame, arrowRow, bc2, got, ArrowDown)
			}

			// Into the running box, the stem included: as in S2.
			checkSegment(t, cf, fanRow, bc1, cx+1, theme.RoleLive, 1)
			checkSegment(t, cf, arrowRow, bc1, bc1+1, theme.RoleLive, 0)
			checkSegment(t, cf, fanRow-1, cx, cx+1, theme.RoleLive, 0)
		}
	})

	t.Run("the other box and its branch are those of S2", func(t *testing.T) {
		c2, _ := layout(testModel(fixtureS2(), 57, 45))
		same := func(y, x int) {
			if got, want := c.At(y, x), c2.At(y, x); got != want {
				t.Errorf("cell (%d,%d) = %+v, want %+v as in S2", y, x, got, want)
			}
		}
		for y := h1.rect.Min.Y; y < h1.rect.Max.Y; y++ {
			for x := h1.rect.Min.X; x < h1.rect.Max.X; x++ {
				same(y, x)
			}
		}
		for x := bc1; x <= cx; x++ {
			same(fanRow, x)
		}
		same(arrowRow, bc1)
	})

	t.Run("activity", func(t *testing.T) {
		hLog, _ := findHit(hits, hitLogScroll, "")
		for r := hLog.rect.Min.Y + 1; r < hLog.rect.Max.Y-1; r++ {
			if !strings.Contains(lines[r], "23:48:28") {
				continue
			}
			if want := "review-tests ! bash"; !strings.Contains(lines[r], want) {
				t.Errorf("waiting record = %q, want %q", lines[r], want)
			}
			checkMark(t, c, r, colOf(lines[r], "! bash"))
			return
		}
		t.Error("activity does not show the record of 23:48:28")
	})
}

func TestNothingWaiting(t *testing.T) {
	tests := []struct {
		w, h                int
		countRow, statusRow int
	}{
		{57, 45, 1, 43},
		{170, 15, 0, 14},
	}
	for _, tt := range tests {
		c, _ := layout(testModel(fixtureS2(), tt.w, tt.h))
		lines := plainLines(c)
		if strings.Contains(lines[tt.countRow], "waiting") || strings.Contains(lines[tt.countRow], IconWaiting) {
			t.Errorf("%dx%d count line = %q, want no waiting part", tt.w, tt.h, lines[tt.countRow])
		}
		if !strings.Contains(lines[tt.statusRow], "main [working]") {
			t.Errorf("%dx%d status bar = %q, want main [working]", tt.w, tt.h, lines[tt.statusRow])
		}
	}
}

func TestWaitingStatusLine(t *testing.T) {
	const (
		ago40s = "2026-11-23T23:48:04Z" // 0:40 before fixtureNow
		ago1h  = "2026-11-23T22:46:41Z" // 1:02:03 before fixtureNow
	)
	tests := []struct {
		name      string
		boxW      int // the inner width is 4 less
		variant   boxVariant
		wait      string
		startedAt string
		text      string
		elapsed   string
	}{
		{"inner 22", 26, boxFull, "approval", ago40s, "! needs approval", "0:40"},
		{"inner 21 is the least for needs approval", 25, boxFull, "approval", ago40s, "! needs approval", "0:40"},
		{"inner 20, as in the two-column grid", 24, boxFull, "approval", ago40s, "! approval", "0:40"},
		{"inner 15 is the least for approval", 19, boxFull, "approval", ago40s, "! approval", "0:40"},
		{"inner 14", 18, boxFull, "approval", ago40s, "!", "0:40"},
		{"inner 13, as three in a row", 17, boxFull, "approval", ago40s, "!", "0:40"},
		{"inner 24 past one hour is the least for needs approval", 28, boxFull, "approval", ago1h, "! needs approval", "1:02:03"},
		{"inner 22 past one hour", 26, boxFull, "approval", ago1h, "! approval", "1:02:03"},
		{"inner 18 past one hour is the least for approval", 22, boxFull, "approval", ago1h, "! approval", "1:02:03"},
		{"inner 17 past one hour", 21, boxFull, "approval", ago1h, "!", "1:02:03"},
		{"answer, inner 22", 26, boxFull, "answer", ago40s, "! needs answer", "0:40"},
		{"answer, inner 19 is the least for needs answer", 23, boxFull, "answer", ago40s, "! needs answer", "0:40"},
		{"answer, inner 18", 22, boxFull, "answer", ago40s, "! answer", "0:40"},
		{"answer, inner 14", 18, boxFull, "answer", ago40s, "!", "0:40"},
		{"short box, inner 22", 26, boxShort, "approval", ago40s, "! needs approval", "0:40"},
		{"short box, inner 20", 24, boxShort, "approval", ago40s, "! approval", "0:40"},
		{"short box, inner 13", 17, boxShort, "approval", ago40s, "!", "0:40"},
		{"tall box, inner 20", 24, boxTall, "approval", ago40s, "! approval", "0:40"},
		{"a wait the pane does not know", 26, boxFull, "review", ago40s, "! needs review", "0:40"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := protocol.Agent{
				ID: "a1", Name: "worker", Type: "task", Status: "running", Wait: tt.wait, StartedAt: tt.startedAt,
				Tools: []protocol.Tool{{Name: "bash", Summary: "go test", Status: "running"}},
			}
			boxH := map[boxVariant]int{boxFull: fullBoxH, boxTall: tallBoxH, boxShort: shortBoxH}[tt.variant]
			c := NewCanvas(tt.boxW, boxH)
			drawAgentBox(c, 0, 0, tt.boxW, tt.variant, a, "", false, false, 0, fixtureNow)

			gap := tt.boxW - 4 - Width(tt.text) - Width(tt.elapsed)
			if gap < 1 {
				t.Fatalf("%q and %q leave a gap of %d in the box, want one cell at least", tt.text, tt.elapsed, gap)
			}
			want := "│ " + tt.text + strings.Repeat(" ", gap) + tt.elapsed + " │"
			row := boxH - 2
			if got := plainLines(c)[row]; got != want {
				t.Errorf("status line = %q, want %q", got, want)
			}
			checkMark(t, c, row, 2)
			if text := c.At(row, 4); tt.text != IconWaiting && (!text.Bold || text.FG != theme.RoleRun.Color()) {
				t.Errorf("status text cell = %+v, want bold in %v", text, theme.RoleRun)
			}
			if got := c.At(0, 0).FG; got != theme.RoleRun.Color() {
				t.Errorf("border is drawn in %v, want %v", got, theme.RoleRun)
			}
		})
	}
}

func TestWaitingMainBox(t *testing.T) {
	tests := []struct {
		name  string
		w, h  int
		wait  string
		since string
		want  string
	}{
		{"vertical, inner 27", 31, mainBoxH, "answer", "2026-11-23T23:48:02Z", "│ ! needs answer         0:42 │"},
		{"horizontal, inner 24", horizMainW, horizBoxH, "approval", "2026-11-23T23:48:02Z", "│ ! needs approval    0:42 │"},
		{"horizontal, inner 24, past ten hours", horizMainW, horizBoxH, "approval", "2026-11-23T13:48:02Z", "│ ! approval      10:00:42 │"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := fixtureS0()
			s.Main.Wait, s.Main.Since = tt.wait, tt.since
			c := NewCanvas(tt.w, tt.h)
			drawMainBox(c, 0, 0, tt.w, tt.h, testModel(s, 57, 45))
			if got := plainLines(c)[2]; got != tt.want {
				t.Errorf("line 2 = %q, want %q", got, tt.want)
			}
			checkMark(t, c, 2, 2)
			if text := c.At(2, 4); !text.Bold || text.FG != theme.RoleRun.Color() {
				t.Errorf("status text cell = %+v, want bold in %v", text, theme.RoleRun)
			}
			if got := c.At(0, 0).FG; got != theme.RoleMain.Color() {
				t.Errorf("border is drawn in %v, want %v", got, theme.RoleMain)
			}
		})
	}
}

func TestWaitingBoxBorderAndToolTrail(t *testing.T) {
	a := protocol.Agent{
		ID: "a1", Name: "worker", Type: "task", Status: "running", Wait: "answer",
		Tools: []protocol.Tool{
			{Name: "view", Status: "ok"},
			{Name: "bash", Status: "running"},
			{Name: "ask_user", Status: "running"},
		},
	}
	tests := []struct {
		name                         string
		selected, isParentOfSelected bool
		wantCorner                   string
		wantRole                     theme.Role
	}{
		{"waiting", false, false, LightBorder.TopLeft, theme.RoleRun},
		{"waiting and selected", true, false, HeavyBorder.TopLeft, theme.RoleRun},
		{"waiting parent of the selected item", false, true, LightBorder.TopLeft, theme.RoleMain},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := NewCanvas(26, fullBoxH)
			drawAgentBox(c, 0, 0, 26, boxFull, a, "", tt.selected, tt.isParentOfSelected, 1, fixtureNow)
			if got := c.At(0, 0); got.Text != tt.wantCorner || got.FG != tt.wantRole.Color() {
				t.Errorf("corner = %q in %v, want %q in %v", got.Text, got.FG, tt.wantCorner, tt.wantRole)
			}
			// Every call still running is the mark: nothing in the box spins.
			if got := c.At(3, 2); got.Text != MarkTool || got.FG != theme.RoleOK.Color() {
				t.Errorf("trail[0] = %q in %v, want %q in %v", got.Text, got.FG, MarkTool, theme.RoleOK)
			}
			checkMark(t, c, 3, 4)
			checkMark(t, c, 3, 6)
		})
	}
}

func TestWaitingCompactRow(t *testing.T) {
	bash := protocol.Tool{Name: "bash", Summary: "go test ./internal/...", Status: "running"}
	tests := []struct {
		name   string
		colW   int
		wait   string
		tool   protocol.Tool
		parent string
		want   string
	}{
		{"column of 47", 47, "approval", bash, "", " ! review-tests   bash needs approval      0:38"},
		{"column of 47, answer", 47, "answer", bash, "", " ! review-tests   bash needs answer        0:38"},
		{"column of 36 has room for approval only", 36, "approval", bash, "", " ! review-tests   bash approval 0:38"},
		{"column of 30 has no room for it", 30, "approval", bash, "", " ! review-tests   bash    0:38"},
		{"column of 26 has no summary", 26, "approval", bash, "", " ! review-tests bash  0:38"},
		{
			"a long parent name leaves room for it", 54, "approval",
			protocol.Tool{Name: "exit_plan_mode", Status: "running"}, "a-very-long-parent-name",
			" ! ↳ review-tests exit_pl… ‹ a-very-l… approval   0:38",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := protocol.Agent{
				ID: "a2", Name: "review-tests", Status: "running", Wait: tt.wait, StartedAt: "2026-11-23T23:48:06Z",
				Tools: []protocol.Tool{tt.tool},
			}
			c := NewCanvas(tt.colW, 1)
			drawCompactRow(c, 0, 0, tt.colW, a, tt.parent, false, false, 1, fixtureNow)
			line := plainText(c)
			if line != tt.want {
				t.Errorf("row = %q, want %q", line, tt.want)
			}
			checkMark(t, c, 0, 1)
			if name := c.At(0, 3); !name.Bold || name.FG != theme.RoleFG.Color() {
				t.Errorf("name cell = %+v, want bold in %v", name, theme.RoleFG)
			}
			if col := colOf(line, tt.wait); col >= 0 {
				if text := c.At(0, col); !text.Bold || text.FG != theme.RoleRun.Color() {
					t.Errorf("cell (0,%d) of the waiting text = %+v, want bold in %v", col, text, theme.RoleRun)
				}
			}
		})
	}
}

func TestWaitingGridBranches(t *testing.T) {
	tests := []struct {
		name    string
		waiting []int // indexes of the waiting sub-agents; the last row is 2 and 3
	}{
		{"the right box of the last row waits", []int{3}},
		{"the last row waits", []int{2, 3}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := makeRunningSnap(4)
			for _, i := range tt.waiting {
				s.Agents[i].Wait = "approval"
			}
			m := testModel(s, 57, 45)
			_, hits := layout(m)
			h1, _ := findHit(hits, hitItem, "a1")
			h3, _ := findHit(hits, hitItem, "a3")
			if h1.rect.Dx() != 24 || h1.rect.Dy() != fullBoxH || h3.rect.Min.Y != h1.rect.Max.Y {
				t.Fatalf("boxes a1 = %v, a3 = %v, want a two-column grid of full boxes", h1.rect, h3.rect)
			}
			trunk := h1.rect.Max.X + 3
			first, last := h1.rect.Min.Y+3, h3.rect.Min.Y+3
			leftWaits := slices.Contains(tt.waiting, 2)

			for frame := range len(Spinner) {
				mf := m
				mf.frame = frame
				c, _ := layout(mf)

				// First row: both branches are live.
				checkSegment(t, c, first, trunk-3, trunk, theme.RoleLive, 1)
				checkSegment(t, c, first, trunk, trunk+1, theme.RoleLive, 0)
				checkSegment(t, c, first, trunk+1, trunk+4, theme.RoleLive, 1)

				// Last row: the branch into a waiting box is static and keeps its arrow.
				checkSegment(t, c, last, trunk+1, trunk+4, theme.RoleEdge, 0)
				if got := c.At(last, trunk+3).Text; got != ArrowRight {
					t.Errorf("frame %d: cell (%d,%d) = %q, want the arrow %q", frame, last, trunk+3, got, ArrowRight)
				}
				if leftWaits {
					checkSegment(t, c, last, trunk-3, trunk, theme.RoleEdge, 0)
					if got := c.At(last, trunk-3).Text; got != ArrowLeft {
						t.Errorf("frame %d: cell (%d,%d) = %q, want the arrow %q", frame, last, trunk-3, got, ArrowLeft)
					}
				} else {
					checkSegment(t, c, last, trunk-3, trunk, theme.RoleLive, 1)
				}

				// The trunk is live as far as the last live branch, and static from there on.
				for row := h1.rect.Min.Y - 1; row <= last; row++ {
					role := theme.RoleLive
					if leftWaits && row > first {
						role = theme.RoleEdge
					}
					checkSegment(t, c, row, trunk, trunk+1, role, 0)
				}
			}
		})
	}
}

func TestEveryRunningSubAgentWaits(t *testing.T) {
	tests := []struct {
		name                string
		w, h, n             int
		countRow, statusRow int
	}{
		{"one box", 57, 45, 1, 1, 43},
		{"a row of boxes", 57, 45, 3, 1, 43},
		{"two-column grid", 57, 45, 5, 1, 43},
		{"compact rows", 57, 45, 12, 1, 43},
		{"horizontal boxes", 170, 15, 2, 0, 14},
		{"horizontal compact rows", 170, 15, 4, 0, 14},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := makeRunningSnap(tt.n)
			for i := range s.Agents {
				s.Agents[i].Wait = "approval"
			}
			for frame := range len(Spinner) {
				m := testModel(s, tt.w, tt.h)
				m.frame = frame
				c, _ := layout(m)
				lines := plainLines(c)

				want := fmt.Sprintf("%s 0 running  ! %d waiting  ✓ 0 done  ✗ 0 failed", Spinner[0], tt.n)
				if !strings.Contains(lines[tt.countRow], want) {
					t.Errorf("frame %d: count line = %q, want %q", frame, lines[tt.countRow], want)
				}
				if want := fmt.Sprintf("sub-agents [%d/%d]", tt.n, tt.n); !strings.Contains(lines[tt.statusRow], want) {
					t.Errorf("frame %d: status bar = %q, want %q", frame, lines[tt.statusRow], want)
				}

				arrows := 0
				for row := range c.H {
					for col := range c.W {
						cell := c.At(row, col)
						if cell.FG == theme.RoleLive.Color() || cell.Text == Dot {
							t.Errorf("frame %d: cell (%d,%d) = %q in %v, want no live connector", frame, row, col, cell.Text, cell.FG)
						}
						if cell.FG == theme.RoleEdge.Color() && slices.Contains([]string{ArrowDown, ArrowLeft, ArrowRight}, cell.Text) {
							arrows++
						}
					}
				}
				if arrows == 0 {
					t.Errorf("frame %d: no static arrow into the run area", frame)
				}
			}
		})
	}
}

// A cancelled tool call never completed: its agent ended or was interrupted
// first. It is drawn dim and it does not spin.
func TestCancelledTool(t *testing.T) {
	cancelled := protocol.Tool{Name: "bash", Summary: "go test ./...", Status: "cancelled"}
	agent := protocol.Agent{
		ID: "a1", Name: "review-tests", Type: "task", Status: "running", StartedAt: "2026-11-23T23:48:06Z",
		Tools: []protocol.Tool{{Name: "view", Summary: "go.mod", Status: "ok"}, cancelled},
	}
	record := protocol.LogEntry{
		Seq: 7, T: "2026-11-23T23:48:28Z", Actor: "a1", Name: "review-tests",
		Kind: "tool", Tool: "bash", Summary: "go test ./...", Status: "cancelled",
	}
	main := fixtureS0()
	main.Main.Tools = []protocol.Tool{cancelled}

	type cell struct {
		row, col int
		text     string
		role     theme.Role
	}
	tests := []struct {
		name string
		w, h int
		draw func(c *Canvas, frame int)
		want []cell
	}{
		{
			name: "tool trail",
			w:    20, h: 1,
			draw: func(c *Canvas, frame int) { drawToolTrail(c, 0, 0, 20, agent.Tools, false, frame) },
			want: []cell{{0, 0, MarkTool, theme.RoleOK}, {0, 2, IconCancelled, theme.RoleDim}},
		},
		{
			name: "tool trail of a waiting sub-agent",
			w:    20, h: 1,
			draw: func(c *Canvas, frame int) { drawToolTrail(c, 0, 0, 20, agent.Tools, true, frame) },
			want: []cell{{0, 0, MarkTool, theme.RoleOK}, {0, 2, IconCancelled, theme.RoleDim}},
		},
		{
			name: "full box: trail and tool line",
			w:    26, h: fullBoxH,
			draw: func(c *Canvas, frame int) {
				drawAgentBox(c, 0, 0, 26, boxFull, agent, "", false, false, frame, fixtureNow)
			},
			want: []cell{{3, 4, IconCancelled, theme.RoleDim}, {4, 2, "b", theme.RoleDim}, {4, 7, "g", theme.RoleDim}},
		},
		{
			name: "short box: tool line",
			w:    26, h: shortBoxH,
			draw: func(c *Canvas, frame int) {
				drawAgentBox(c, 0, 0, 26, boxShort, agent, "", false, false, frame, fixtureNow)
			},
			want: []cell{{2, 2, "b", theme.RoleDim}, {2, 7, "g", theme.RoleDim}},
		},
		{
			name: "main box of a working main agent: tool line",
			w:    31, h: mainBoxH,
			draw: func(c *Canvas, frame int) {
				m := testModel(main, 57, 45)
				m.frame = frame
				drawMainBox(c, 0, 0, 31, mainBoxH, m)
			},
			want: []cell{{3, 2, "b", theme.RoleDim}, {3, 7, "g", theme.RoleDim}},
		},
		{
			name: "compact row: tool name",
			w:    47, h: 1,
			draw: func(c *Canvas, frame int) { drawCompactRow(c, 0, 0, 47, agent, "", false, false, frame, fixtureNow) },
			want: []cell{{0, 18, "b", theme.RoleDim}, {0, 23, "g", theme.RoleDim}},
		},
		{
			name: "activity row",
			w:    60, h: 1,
			draw: func(c *Canvas, frame int) { drawActivityRow(c, 0, 0, 60, true, record, frame, time.UTC) },
			want: []cell{{0, 22, IconCancelled, theme.RoleDim}, {0, 24, "b", theme.RoleTool}},
		},
		{
			name: "row of the compact activity page",
			w:    30, h: 1,
			draw: func(c *Canvas, frame int) { drawCompactLogRow(c, 0, 0, 30, record, frame, time.UTC) },
			want: []cell{{0, 6, IconCancelled, theme.RoleDim}, {0, 8, "b", theme.RoleTool}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// The same on every frame: a cancelled call does not spin.
			for frame := range len(Spinner) {
				c := NewCanvas(tt.w, tt.h)
				tt.draw(c, frame)
				for _, w := range tt.want {
					if got := c.At(w.row, w.col); got.Text != w.text || got.FG != w.role.Color() || got.Bold {
						t.Errorf("frame %d: cell (%d,%d) = %q in %v (bold %v), want %q in %v", frame, w.row, w.col, got.Text, got.FG, got.Bold, w.text, w.role)
					}
				}
			}
		})
	}
}

func TestWaitingBoxInTheRunArea(t *testing.T) {
	tests := []struct {
		name       string
		n          int // running sub-agents; the second one waits
		boxW, boxH int
		want       string
	}{
		{"a row of two, inner 22", 2, 26, fullBoxH, "│ ! needs approval  0:14 │"},
		{"a row of three, inner 13", 3, 17, fullBoxH, "│ !        0:14 │"},
		{"two-column grid, inner 20", 4, 24, fullBoxH, "│ ! approval      0:14 │"},
		{"two-column grid of short boxes, inner 20", 7, 24, shortBoxH, "│ ! approval      0:14 │"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := makeRunningSnap(tt.n)
			s.Agents[1].Wait = "approval"
			c, hits := layout(testModel(s, 57, 45))
			h, ok := findHit(hits, hitItem, "a2")
			if !ok || h.rect.Dx() != tt.boxW || h.rect.Dy() != tt.boxH {
				t.Fatalf("waiting box rect = %v (ok=%v), want %dx%d", h.rect, ok, tt.boxW, tt.boxH)
			}
			row := h.rect.Max.Y - 2
			if got := plainLines(c)[row]; !strings.Contains(got, tt.want) {
				t.Errorf("status line = %q, want %q", got, tt.want)
			}
			checkMark(t, c, row, h.rect.Min.X+2)
			if got := c.At(h.rect.Min.Y, h.rect.Min.X).FG; got != theme.RoleRun.Color() {
				t.Errorf("border is drawn in %v, want %v", got, theme.RoleRun)
			}
		})
	}
}
