package ui

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/protocol"
	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/theme"
)

func makeRunningSnap(n int) protocol.Snapshot {
	s := fixtureS0()
	s.Turn = 2
	s.Agents = nil
	for i := range n {
		s.Agents = append(s.Agents, protocol.Agent{
			ID:        fmt.Sprintf("a%d", i+1),
			SpawnTurn: 2,
			Name:      fmt.Sprintf("ag-%02d", i+1),
			Type:      "task",
			Desc:      fmt.Sprintf("Task description %02d", i+1),
			Model:     "claude-opus-5.5",
			Status:    "running",
			StartedAt: "2026-11-23T23:48:30Z",
			Tools:     []protocol.Tool{{Name: "bash", Summary: "go test ./...", Status: "running"}},
		})
	}
	return s
}

func TestHorizontalS2_170x15(t *testing.T) {
	m := testModel(fixtureS2(), 170, 15)
	c, hits := layout(m)
	lines := plainLines(c)
	text := strings.Join(lines, "\n")

	if len(lines) != 15 {
		t.Fatalf("line count = %d, want 15", len(lines))
	}

	// Title and counts on row 0.
	if !strings.Contains(lines[0], "FLEETPANE") || !strings.Contains(lines[0], "2 running") || !strings.Contains(lines[0], "1 done") || !strings.Contains(lines[0], "1 failed") {
		t.Errorf("row 0 = %q, want title and counts", lines[0])
	}

	// Exact column positions (0-based inclusive):
	// main: 1–28, boxes: 33–56 and 58–81, back to main: 85–128, activity: 131–168.
	hMain, ok := findHit(hits, hitItem, mainID)
	if !ok {
		t.Fatal("missing hitItem for main")
	}
	if hMain.rect.Min.X != 1 || hMain.rect.Max.X != 29 || hMain.rect.Min.Y != 3 || hMain.rect.Max.Y != 11 {
		t.Errorf("main rect = %v, want (1,3)-(29,11)", hMain.rect)
	}

	h1, ok1 := findHit(hits, hitItem, "a1")
	h2, ok2 := findHit(hits, hitItem, "a2")
	if !ok1 || !ok2 {
		t.Fatalf("missing running box hits: a1=%v a2=%v", ok1, ok2)
	}
	if h1.rect.Min.X != 33 || h1.rect.Max.X != 57 || h1.rect.Min.Y != 3 || h1.rect.Max.Y != 11 {
		t.Errorf("a1 rect = %v, want (33,3)-(57,11)", h1.rect)
	}
	if h2.rect.Min.X != 58 || h2.rect.Max.X != 82 || h2.rect.Min.Y != 3 || h2.rect.Max.Y != 11 {
		t.Errorf("a2 rect = %v, want (58,3)-(82,11)", h2.rect)
	}

	hBack, ok := findHit(hits, hitBackScroll, "")
	if !ok {
		t.Fatal("missing hitBackScroll")
	}
	if hBack.rect.Min.X != 85 || hBack.rect.Max.X != 129 || hBack.rect.Min.Y != 3 || hBack.rect.Max.Y != 11 {
		t.Errorf("back to main rect = %v, want (85,3)-(129,11)", hBack.rect)
	}

	hLog, ok := findHit(hits, hitLogScroll, "")
	if !ok {
		t.Fatal("missing hitLogScroll")
	}
	if hLog.rect.Min.X != 131 || hLog.rect.Max.X != 169 || hLog.rect.Min.Y != 1 || hLog.rect.Max.Y != 12 {
		t.Errorf("activity rect = %v, want (131,1)-(169,12)", hLog.rect)
	}

	// Tall (h=8) running box content: model on line 2 (row 5), desc on line 3 (row 6).
	if !strings.Contains(lines[4], "explore-auth · expl…") {
		t.Errorf("row 4 = %q, want explore-auth · expl…", lines[4])
	}
	if !strings.Contains(lines[5], "gemini-4-neon") || !strings.Contains(lines[5], "claude-opus-5.5 · bg") {
		t.Errorf("row 5 = %q, want models on line 2 of tall boxes", lines[5])
	}
	if !strings.Contains(lines[6], "Trace how joinSessi…") || !strings.Contains(lines[6], "Run Go tests and su…") {
		t.Errorf("row 6 = %q, want desc on line 3 of tall boxes", lines[6])
	}

	// Connectors: row 1 delegate (live), row 2 arrows into both boxes (live), row 11 report merge ending in ▲ (main).
	if !strings.Contains(lines[1], "delegate") {
		t.Errorf("row 1 = %q, want delegate line", lines[1])
	}
	if c.At(2, 45).Text != ArrowDown || c.At(2, 45).FG != theme.RoleLive.Color() {
		t.Errorf("cell (2,45) = (%q, %v), want live ▼", c.At(2, 45).Text, c.At(2, 45).FG)
	}
	if c.At(2, 70).Text != ArrowDown || c.At(2, 70).FG != theme.RoleLive.Color() {
		t.Errorf("cell (2,70) = (%q, %v), want live ▼", c.At(2, 70).Text, c.At(2, 70).FG)
	}
	if !strings.Contains(lines[11], "report") {
		t.Errorf("row 11 = %q, want report merge line", lines[11])
	}
	backMid := 85 + 44/2 // 107
	if c.At(11, backMid).Text != ArrowUp || c.At(11, backMid).FG != theme.RoleMain.Color() {
		t.Errorf("cell (11,%d) = (%q, %v), want main ▲", backMid, c.At(11, backMid).Text, c.At(11, backMid).FG)
	}

	// Back to main entries and hits; previous-turn agent excluded.
	for _, want := range []string{"docs-outline", "lint-check", "exit 1 · config not found", "2/4"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in horizontal S2 output", want)
		}
	}
	if strings.Contains(text, "prev-turn-audit") {
		t.Error("previous-turn agent prev-turn-audit must not appear")
	}
	hA3, ok3 := findHit(hits, hitItem, "a3")
	hA4, ok4 := findHit(hits, hitItem, "a4")
	if !ok3 || !ok4 || hA3.rect.Dy() != 1 || hA4.rect.Dy() != 2 {
		t.Errorf("back hits: a3=(%v,%v) a4=(%v,%v), want heights 1 and 2", ok3, hA3.rect, ok4, hA4.rect)
	}

	// Narrow activity format (innerW = 34 < 50): MM:SS timestamps, not HH:MM:SS.
	if !strings.Contains(lines[10], "48:44") {
		t.Errorf("activity row 10 = %q, want MM:SS 48:44", lines[10])
	}
	if strings.Contains(lines[10], "23:48:44") {
		t.Errorf("activity row 10 = %q, narrow box should use MM:SS not HH:MM:SS", lines[10])
	}

	// Status bar and hints share row 14 (H-1) and are marked Panel.
	if !strings.Contains(lines[14], "main [working]") || !strings.Contains(lines[14], "sub-agents [2/4]") || !strings.Contains(lines[14], "tools [11]") {
		t.Errorf("status row 14 = %q, want status bar fields", lines[14])
	}
	if !strings.Contains(lines[14], "q close") {
		t.Errorf("status row 14 = %q, want right-aligned key hints", lines[14])
	}
	if !c.At(14, 0).Panel || !c.At(14, 169).Panel {
		t.Error("status bar row 14 must be marked Panel")
	}
}

func TestHorizontalCompressionLevels_170x15(t *testing.T) {
	// W=170 -> Wr=51: 2 -> boxes; 3, 6 -> compact rows (no scroll); 7 -> compact rows with scroll.
	cases := []struct {
		n          int
		wantBox    bool
		wantScroll bool
		wantActW   int
	}{
		{2, true, false, 38},
		{3, false, false, 36},
		{6, false, false, 36},
		{7, false, true, 36},
	}

	for _, tc := range cases {
		t.Run(fmt.Sprintf("n=%d", tc.n), func(t *testing.T) {
			m := testModel(makeRunningSnap(tc.n), 170, 15)
			c, hits := layout(m)
			lines := plainLines(c)

			hLog, ok := findHit(hits, hitLogScroll, "")
			if !ok {
				t.Fatal("missing activity hitLogScroll")
			}
			if hLog.rect.Dx() != tc.wantActW {
				t.Errorf("n=%d activity width = %d, want %d", tc.n, hLog.rect.Dx(), tc.wantActW)
			}

			hr, hasRunScroll := findHit(hits, hitRunScroll, "")
			if tc.wantBox {
				if hasRunScroll {
					t.Errorf("n=%d should use boxes, got compact frame", tc.n)
				}
				h1, ok1 := findHit(hits, hitItem, "a1")
				if !ok1 || h1.rect.Dx() != 24 || h1.rect.Dy() != 8 {
					t.Errorf("n=%d a1 box = %v (ok=%v), want 24x8", tc.n, h1.rect, ok1)
				}
				return
			}

			if !hasRunScroll {
				t.Fatalf("n=%d should use compact frame (missing hitRunScroll)", tc.n)
			}
			if hr.rect.Min.X != 33 || hr.rect.Dx() != 51 || hr.rect.Min.Y != 3 || hr.rect.Dy() != 8 {
				t.Errorf("n=%d compact frame rect = %v, want (33,3) 51x8", tc.n, hr.rect)
			}

			// Single arrow into middle of frame top; merge line leaves middle of frame bottom.
			frameMid := 33 + 51/2
			if c.At(2, frameMid).Text != ArrowDown || c.At(2, frameMid).FG != theme.RoleLive.Color() {
				t.Errorf("n=%d top arrow at (2,%d) = (%q,%v), want live ▼", tc.n, frameMid, c.At(2, frameMid).Text, c.At(2, frameMid).FG)
			}
			if c.At(11, frameMid).Text != LightBorder.BottomLeft || c.At(11, frameMid).FG != theme.RoleMain.Color() {
				t.Errorf("n=%d bottom merge start at (11,%d) = (%q,%v), want main └", tc.n, frameMid, c.At(11, frameMid).Text, c.At(11, frameMid).FG)
			}

			botBorder := lines[hr.rect.Max.Y-1]
			hasDown := strings.Contains(botBorder, ArrowDown+" ")
			if hasDown != tc.wantScroll {
				t.Errorf("n=%d compact bottom border %q: hasDown=%v, want %v", tc.n, botBorder, hasDown, tc.wantScroll)
			}
			if tc.wantScroll && !strings.Contains(botBorder, ArrowDown+" 1") {
				t.Errorf("n=%d compact bottom border %q, want ▼ 1", tc.n, botBorder)
			}
		})
	}
}

func TestHorizontalWidths_195_and_147(t *testing.T) {
	t.Run("195x15 with 3 running uses 3 boxes and shows activity", func(t *testing.T) {
		m := testModel(makeRunningSnap(3), 195, 15)
		_, hits := layout(m)
		if _, hasScroll := findHit(hits, hitRunScroll, ""); hasScroll {
			t.Fatal("195x15 n=3 should use boxes, not compact frame")
		}
		for i, wantX := range []int{33, 58, 83} {
			h, ok := findHit(hits, hitItem, fmt.Sprintf("a%d", i+1))
			if !ok || h.rect.Min.X != wantX || h.rect.Dx() != 24 || h.rect.Dy() != 8 {
				t.Errorf("a%d rect = %v (ok=%v), want Min.X=%d 24x8", i+1, h.rect, ok, wantX)
			}
		}
		hLog, ok := findHit(hits, hitLogScroll, "")
		if !ok || hLog.rect.Dx() < 36 {
			t.Errorf("activity rect = %v (ok=%v), want width >= 36", hLog.rect, ok)
		}
	})

	t.Run("195x15 with 12 and 13 running uses 2-column compact frame", func(t *testing.T) {
		c12, h12 := layout(testModel(makeRunningSnap(12), 195, 15))
		hr12, ok := findHit(h12, hitRunScroll, "")
		if !ok || hr12.rect.Dx() != 76 {
			t.Fatalf("195x15 n=12 compact frame = %v (ok=%v), want width 76", hr12.rect, ok)
		}
		if strings.Contains(plainLines(c12)[hr12.rect.Max.Y-1], ArrowDown) {
			t.Error("195x15 n=12 should fit all 12 without ▼")
		}
		ha1, _ := findHit(h12, hitItem, "a1")
		ha2, _ := findHit(h12, hitItem, "a2")
		if ha1.rect.Min.Y != ha2.rect.Min.Y || ha2.rect.Min.X <= ha1.rect.Min.X {
			t.Errorf("195x15 n=12 should be 2 columns: a1=%v a2=%v", ha1.rect, ha2.rect)
		}

		c13, h13 := layout(testModel(makeRunningSnap(13), 195, 15))
		hr13, _ := findHit(h13, hitRunScroll, "")
		if !strings.Contains(plainLines(c13)[hr13.rect.Max.Y-1], ArrowDown+" 1") {
			t.Errorf("195x15 n=13 bottom border = %q, want ▼ 1", plainLines(c13)[hr13.rect.Max.Y-1])
		}
	})

	t.Run("147x14 with 1 running: merge line row 11, status bar row 13", func(t *testing.T) {
		m := testModel(makeRunningSnap(1), 147, 14)
		c, hits := layout(m)
		lines := plainLines(c)
		if len(lines) != 14 {
			t.Fatalf("line count = %d, want 14", len(lines))
		}
		h1, ok := findHit(hits, hitItem, "a1")
		if !ok || h1.rect.Min.X != 33 || h1.rect.Dx() != 24 || h1.rect.Dy() != 8 {
			t.Errorf("a1 rect = %v (ok=%v), want (33,3) 24x8", h1.rect, ok)
		}
		if !strings.Contains(lines[11], "report") || !strings.Contains(lines[11], ArrowUp) {
			t.Errorf("row 11 = %q, want report merge line with ▲", lines[11])
		}
		if strings.Contains(lines[11], "main [") {
			t.Errorf("row 11 = %q, status bar must not overlap merge line", lines[11])
		}
		if !strings.Contains(lines[13], "main [working]") {
			t.Errorf("row 13 = %q, want status bar", lines[13])
		}
	})
}

func TestHorizontalTallerHeight_170x20(t *testing.T) {
	m := testModel(fixtureS2(), 170, 20)
	c, hits := layout(m)
	lines := plainLines(c)

	hLog, ok := findHit(hits, hitLogScroll, "")
	if !ok {
		t.Fatal("missing hitLogScroll")
	}
	// Activity occupies rows 1..16 inclusive -> Min.Y=1, Max.Y=17 (height 16).
	if hLog.rect.Min.Y != 1 || hLog.rect.Max.Y != 17 {
		t.Errorf("activity Y range = [%d, %d), want [1, 17) (rows 1..16)", hLog.rect.Min.Y, hLog.rect.Max.Y)
	}

	// Main, running boxes, back to main remain at rows 3..10; merge line stays at row 11.
	hMain, _ := findHit(hits, hitItem, mainID)
	hA1, _ := findHit(hits, hitItem, "a1")
	hBack, _ := findHit(hits, hitBackScroll, "")
	if hMain.rect.Min.Y != 3 || hMain.rect.Max.Y != 11 {
		t.Errorf("main Y = [%d,%d), want [3,11)", hMain.rect.Min.Y, hMain.rect.Max.Y)
	}
	if hA1.rect.Min.Y != 3 || hA1.rect.Max.Y != 11 {
		t.Errorf("a1 Y = [%d,%d), want [3,11)", hA1.rect.Min.Y, hA1.rect.Max.Y)
	}
	if hBack.rect.Min.Y != 3 || hBack.rect.Max.Y != 11 {
		t.Errorf("back Y = [%d,%d), want [3,11)", hBack.rect.Min.Y, hBack.rect.Max.Y)
	}
	if !strings.Contains(lines[11], "report") {
		t.Errorf("row 11 = %q, want merge line unchanged at row 11", lines[11])
	}
	if !strings.Contains(lines[19], "main [working]") {
		t.Errorf("row 19 = %q, want status bar at H-1", lines[19])
	}
}

func TestHorizontalAllFinished_170x15(t *testing.T) {
	s := fixtureS2()
	// Keep only the two finished-this-turn agents (a3, a4) and previous-turn a0.
	s.Agents = []protocol.Agent{s.Agents[2], s.Agents[3], s.Agents[4]}

	m := testModel(s, 170, 15)
	c, hits := layout(m)
	lines := plainLines(c)

	hMain, ok := findHit(hits, hitItem, mainID)
	if !ok || hMain.rect.Min.X != 1 || hMain.rect.Max.X != 29 {
		t.Errorf("main rect = %v (ok=%v), want X=[1,29)", hMain.rect, ok)
	}
	hBack, ok := findHit(hits, hitBackScroll, "")
	if !ok || hBack.rect.Min.X != 35 || hBack.rect.Max.X != 79 || hBack.rect.Min.Y != 3 || hBack.rect.Max.Y != 11 {
		t.Errorf("back rect = %v (ok=%v), want (35,3)-(79,11)", hBack.rect, ok)
	}
	hLog, ok := findHit(hits, hitLogScroll, "")
	if !ok || hLog.rect.Min.X != 81 || hLog.rect.Max.X != 169 || hLog.rect.Min.Y != 1 || hLog.rect.Max.Y != 12 {
		t.Errorf("activity rect = %v (ok=%v), want (81,1)-(169,12)", hLog.rect, ok)
	}
	if _, hasRun := findHit(hits, hitRunScroll, ""); hasRun {
		t.Error("all-finished horizontal should not have hitRunScroll")
	}

	// Gap cols 29..34: row 4 "report", row 5 arrowed line in RoleMain.
	var gapLabel strings.Builder
	for col := 29; col < 35; col++ {
		gapLabel.WriteString(c.At(4, col).Text)
	}
	if got := gapLabel.String(); got != "report" {
		t.Errorf("row 4 cols 29..34 = %q, want %q", got, "report")
	}
	if c.At(5, 34).Text != ArrowRight || c.At(5, 34).FG != theme.RoleMain.Color() {
		t.Errorf("cell (5,34) = (%q,%v), want main ▶", c.At(5, 34).Text, c.At(5, 34).FG)
	}
	if c.At(5, 29).Text != LightBorder.Horizontal || c.At(5, 29).FG != theme.RoleMain.Color() {
		t.Errorf("cell (5,29) = (%q,%v), want main ─", c.At(5, 29).Text, c.At(5, 29).FG)
	}

	// No connectors on rows 1, 2, 11 and no RoleLive cells anywhere.
	if strings.Contains(lines[1], "delegate") || strings.Contains(lines[11], "report") {
		t.Errorf("rows 1/11 must not have delegate/report connectors: r1=%q r11=%q", lines[1], lines[11])
	}
	for r := range c.H {
		for col := range c.W {
			if c.At(r, col).FG == theme.RoleLive.Color() {
				t.Fatalf("unexpected RoleLive cell at (%d,%d) %q when all agents finished", r, col, c.At(r, col).Text)
			}
		}
	}

	// Wide activity (width 88, inner 84 >= 50) uses HH:MM:SS timestamps.
	if !strings.Contains(lines[10], "23:48:44") {
		t.Errorf("wide activity row 10 = %q, want HH:MM:SS 23:48:44", lines[10])
	}
}

func TestHorizontalNoSubAgents_170x15(t *testing.T) {
	m := testModel(fixtureS0(), 170, 15)
	c, hits := layout(m)
	lines := plainLines(c)
	text := strings.Join(lines, "\n")

	if !strings.Contains(lines[0], "no sub-agents this turn") {
		t.Errorf("row 0 = %q, want 'no sub-agents this turn'", lines[0])
	}
	if strings.Contains(text, "back to main") {
		t.Error("no-sub-agents horizontal must not draw back to main")
	}
	if _, hasBack := findHit(hits, hitBackScroll, ""); hasBack {
		t.Error("no-sub-agents horizontal must not have hitBackScroll")
	}

	hMain, ok := findHit(hits, hitItem, mainID)
	if !ok || hMain.rect.Min.X != 1 || hMain.rect.Max.X != 29 || hMain.rect.Min.Y != 3 || hMain.rect.Max.Y != 11 {
		t.Errorf("main rect = %v (ok=%v), want (1,3)-(29,11)", hMain.rect, ok)
	}
	hLog, ok := findHit(hits, hitLogScroll, "")
	if !ok || hLog.rect.Min.X != 33 || hLog.rect.Max.X != 169 || hLog.rect.Min.Y != 1 || hLog.rect.Max.Y != 12 {
		t.Errorf("activity rect = %v (ok=%v), want (33,1)-(169,12)", hLog.rect, ok)
	}
	if !strings.Contains(lines[14], "sub-agents [0/0]") {
		t.Errorf("status row 14 = %q, want sub-agents [0/0]", lines[14])
	}
}

func TestHorizontalNestedCompactAndBackScroll(t *testing.T) {
	t.Run("compact rows colW=47 show parent name and highlight parent on child selection", func(t *testing.T) {
		s := makeRunningSnap(4)
		s.Agents[0].Name = "explore-auth"
		s.Agents[1].Name = "grep-hooks"
		s.Agents[1].Parent = "a1"
		s.Agents[1].Tools = []protocol.Tool{{Name: "grep", Summary: "onUserPromptSubmitted", Status: "running"}}

		m := testModel(s, 170, 15)
		m.selected = "a2"
		c, hits := layout(m)
		lines := plainLines(c)

		hA1, _ := findHit(hits, hitItem, "a1")
		hA2, _ := findHit(hits, hitItem, "a2")
		if c.At(hA1.rect.Min.Y, hA1.rect.Min.X).Text != MarkParent {
			t.Errorf("parent row start = %q, want %q", c.At(hA1.rect.Min.Y, hA1.rect.Min.X).Text, MarkParent)
		}
		childLine := lines[hA2.rect.Min.Y]
		if !strings.Contains(childLine, "↳ grep-hooks") || !strings.Contains(childLine, "‹ explore") {
			t.Errorf("child compact row = %q, want '↳ grep-hooks' and '‹ explore…'", childLine)
		}
		hLog, _ := findHit(hits, hitLogScroll, "")
		if !strings.Contains(lines[hLog.rect.Min.Y], "activity · grep-hooks ‹") {
			t.Errorf("activity title = %q, want parent relation", lines[hLog.rect.Min.Y])
		}
	})

	t.Run("back to main height 8 shows at most 5 entry rows and scrolls", func(t *testing.T) {
		s := makeRunningSnap(1)
		for i := range 8 {
			s.Agents = append(s.Agents, protocol.Agent{
				ID: fmt.Sprintf("f%d", i+1), SpawnTurn: 2, ReportedTurn: 2,
				Name: fmt.Sprintf("fin-%02d", i+1), Type: "task", Status: "done", DurationMs: 5000, ToolCount: 2,
			})
		}
		m := testModel(s, 170, 15)
		c, hits := layout(m)
		hb, _ := findHit(hits, hitBackScroll, "")
		if hb.rect.Dy() != 8 {
			t.Fatalf("back height = %d, want 8", hb.rect.Dy())
		}
		vis := 0
		for _, h := range hits {
			if h.kind == hitItem && strings.HasPrefix(h.id, "f") {
				vis++
			}
		}
		if vis != 5 {
			t.Errorf("visible back entries = %d, want 5", vis)
		}
		bot := plainLines(c)[hb.rect.Max.Y-1]
		if !strings.Contains(bot, ArrowDown+" 3") {
			t.Errorf("back bottom border = %q, want ▼ 3", bot)
		}
	})

	t.Run("level 1 boxes show nested parent and highlight parent border", func(t *testing.T) {
		s := makeRunningSnap(2)
		s.Agents[0].Name = "explore-auth"
		s.Agents[1].Name = "grep-hooks"
		s.Agents[1].Parent = "a1"

		m := testModel(s, 170, 15)
		m.selected = "a2"
		c, hits := layout(m)
		lines := plainLines(c)

		hA1, _ := findHit(hits, hitItem, "a1")
		hA2, _ := findHit(hits, hitItem, "a2")
		if c.At(hA1.rect.Min.Y, hA1.rect.Min.X).FG != theme.RoleMain.Color() {
			t.Errorf("parent box border FG = %v, want RoleMain", c.At(hA1.rect.Min.Y, hA1.rect.Min.X).FG)
		}
		if c.At(hA2.rect.Min.Y, hA2.rect.Min.X).Text != HeavyBorder.TopLeft {
			t.Errorf("selected child top-left = %q, want heavy %q", c.At(hA2.rect.Min.Y, hA2.rect.Min.X).Text, HeavyBorder.TopLeft)
		}
		if !strings.Contains(lines[hA2.rect.Min.Y+2], MarkChild+" explore-auth") {
			t.Errorf("child box line 2 = %q, want ↳ explore-auth", lines[hA2.rect.Min.Y+2])
		}
	})

	t.Run("delegate line has animated live dot that advances with frame", func(t *testing.T) {
		m0 := testModel(fixtureS2(), 170, 15)
		m1 := m0
		m1.frame = 1
		c0, _ := layout(m0)
		c1, _ := layout(m1)
		findDot := func(c *Canvas) int {
			for col := range c.W {
				if c.At(horizDelegateRow, col).Text == Dot && c.At(horizDelegateRow, col).FG == theme.RoleLive.Color() {
					return col
				}
			}
			return -1
		}
		d0, d1 := findDot(c0), findDot(c1)
		if d0 < 0 || d1 < 0 || d0 == d1 {
			t.Errorf("live dot cols for frame 0 and 1 = (%d, %d), want two distinct valid cols", d0, d1)
		}
	})

	t.Run("layout purity and determinism for horizontal", func(t *testing.T) {
		m := testModel(fixtureS2(), 170, 15)
		before := m
		c1, h1 := layout(m)
		c2, h2 := layout(m)
		if !reflect.DeepEqual(c1, c2) || !reflect.DeepEqual(h1, h2) {
			t.Error("horizontal layout(m) is not deterministic")
		}
		if !reflect.DeepEqual(m.snap, before.snap) || m.selected != before.selected {
			t.Error("horizontal layout(m) mutated Model")
		}
	})
}

func TestHorizontalWaitingSW_170x15(t *testing.T) {
	m := testModel(fixtureSW(), 170, 15)
	c, hits := layout(m)
	lines := plainLines(c)

	if want := Spinner[0] + " 1 running  ! 1 waiting  ✓ 1 done  ✗ 1 failed"; !strings.Contains(lines[0], want) {
		t.Errorf("row 0 = %q, want %q", lines[0], want)
	}
	if want := "main [waiting]  sub-agents [2/4]"; !strings.Contains(lines[14], want) {
		t.Errorf("status bar = %q, want %q", lines[14], want)
	}

	// Main box (inner 24) and the waiting tall box (inner 20).
	if want := "│ ! needs answer      0:42 │"; !strings.Contains(lines[5], want) {
		t.Errorf("main box line 2 = %q, want %q", lines[5], want)
	}
	checkMark(t, c, 5, 3)
	h2, _ := findHit(hits, hitItem, "a2")
	if want := "│ ! approval      0:38 │"; !strings.Contains(lines[9], want) {
		t.Errorf("waiting box status line = %q, want %q", lines[9], want)
	}
	checkMark(t, c, 9, h2.rect.Min.X+2)
	checkMark(t, c, 7, h2.rect.Min.X+2)
	for _, x := range []int{h2.rect.Min.X, 70, h2.rect.Max.X - 1} {
		if got := c.At(10, x).FG; got != theme.RoleRun.Color() {
			t.Errorf("bottom border cell (10,%d) is drawn in %v, want %v", x, got, theme.RoleRun)
		}
	}

	// The delegate line is live as far as the running box at column 45, and
	// static from there to the waiting box at column 70.
	for frame := range 40 {
		mf := m
		mf.frame = frame
		cf, _ := layout(mf)
		checkSegment(t, cf, 2, 15, 16, theme.RoleLive, 0)
		checkSegment(t, cf, 1, 27, 46, theme.RoleLive, 1)
		checkSegment(t, cf, 2, 45, 46, theme.RoleLive, 0)
		checkSegment(t, cf, 1, 46, 71, theme.RoleEdge, 0)
		checkSegment(t, cf, 2, 70, 71, theme.RoleEdge, 0)
		if got := cf.At(2, 70).Text; got != ArrowDown {
			t.Errorf("frame %d: cell (2,70) = %q, want the arrow %q", frame, got, ArrowDown)
		}
	}
}
