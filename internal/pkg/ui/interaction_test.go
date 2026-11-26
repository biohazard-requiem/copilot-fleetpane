package ui

import (
	"fmt"
	"image/color"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/protocol"
)

var (
	keyTab      = tea.KeyPressMsg{Code: tea.KeyTab}
	keyShiftTab = tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift}
	keyDown     = tea.KeyPressMsg{Code: tea.KeyDown}
	keyUp       = tea.KeyPressMsg{Code: tea.KeyUp}
	keyRight    = tea.KeyPressMsg{Code: tea.KeyRight}
	keyLeft     = tea.KeyPressMsg{Code: tea.KeyLeft}
	keyJ        = tea.KeyPressMsg{Code: 'j', Text: "j"}
	keyK        = tea.KeyPressMsg{Code: 'k', Text: "k"}
	keyL        = tea.KeyPressMsg{Code: 'l', Text: "l"}
	keyH        = tea.KeyPressMsg{Code: 'h', Text: "h"}
	keyEsc      = tea.KeyPressMsg{Code: tea.KeyEsc}
	keyEnter    = tea.KeyPressMsg{Code: tea.KeyEnter}
	keyPgUp     = tea.KeyPressMsg{Code: tea.KeyPgUp}
	keyPgDown   = tea.KeyPressMsg{Code: tea.KeyPgDown}
	keyEnd      = tea.KeyPressMsg{Code: tea.KeyEnd}
)

// readyModel creates a sized, past-inputGuard Model with snap loaded via Update.
func readyModel(t *testing.T, themesDir string, snap protocol.Snapshot, w, h int) Model {
	t.Helper()
	m := New(themesDir, fixtureNow)
	m.clock = func() time.Time { return fixtureNow.Add(time.Second) }
	m.now = fixtureNow
	m = send(t, m, tea.WindowSizeMsg{Width: w, Height: h})
	m = send(t, m, SnapshotMsg{Snapshot: snap})
	return m
}

func send(t *testing.T, m Model, msg tea.Msg) Model {
	t.Helper()
	next, _ := m.Update(msg)
	return next.(Model)
}

func sendCmd(t *testing.T, m Model, msg tea.Msg) (Model, tea.Cmd) {
	t.Helper()
	next, cmd := m.Update(msg)
	return next.(Model), cmd
}

func TestSelectionOrderAndKeys(t *testing.T) {
	s := fixtureS0()
	s.Turn = 2
	s.Agents = []protocol.Agent{
		{ID: "A", SpawnTurn: 2, Name: "alpha", Status: "running", StartedAt: "2026-11-23T23:48:30Z"},
		{ID: "B", SpawnTurn: 2, Name: "beta", Status: "running", StartedAt: "2026-11-23T23:48:31Z"},
		{ID: "C", SpawnTurn: 2, Name: "child", Parent: "A", Status: "running", StartedAt: "2026-11-23T23:48:32Z"},
		{ID: "D", SpawnTurn: 2, ReportedTurn: 2, Name: "done-d", Status: "done", DurationMs: 4000},
		{ID: "E", SpawnTurn: 2, ReportedTurn: 2, Name: "fail-e", Status: "failed", DurationMs: 5000, Error: "boom"},
		{ID: "OLD", SpawnTurn: 1, ReportedTurn: 1, Name: "prev-turn", Status: "done", DurationMs: 3000},
	}

	m := readyModel(t, "", s, 57, 45)
	wantOrder := []string{mainID, "A", "C", "B", "D", "E"}

	var got []string
	for range wantOrder {
		m = send(t, m, keyTab)
		got = append(got, m.selected)
	}
	if !slices.Equal(got, wantOrder) {
		t.Fatalf("tab order = %v, want %v", got, wantOrder)
	}

	// Verify alternative next/prev keys all work and start from main when unselected.
	for _, k := range []tea.KeyPressMsg{keyTab, keyDown, keyJ, keyRight, keyL, keyShiftTab, keyUp, keyK, keyLeft, keyH} {
		m0 := readyModel(t, "", s, 57, 45)
		m0 = send(t, m0, k)
		if m0.selected != mainID {
			t.Errorf("key %q from unselected: selected = %q, want %q", k.String(), m0.selected, mainID)
		}
	}

	// Step forward then backward with each pair.
	for _, pair := range [][2]tea.KeyPressMsg{
		{keyTab, keyShiftTab},
		{keyDown, keyUp},
		{keyJ, keyK},
		{keyRight, keyLeft},
		{keyL, keyH},
	} {
		m0 := readyModel(t, "", s, 57, 45)
		m0 = send(t, m0, pair[0]) // main
		m0 = send(t, m0, pair[0]) // A
		m0 = send(t, m0, pair[0]) // C
		if m0.selected != "C" {
			t.Errorf("after 3x %q: selected = %q, want C", pair[0].String(), m0.selected)
		}
		m0 = send(t, m0, pair[1]) // A
		if m0.selected != "A" {
			t.Errorf("after %q: selected = %q, want A", pair[1].String(), m0.selected)
		}
	}
}

func TestS2EscRestoresAllActivity(t *testing.T) {
	m := readyModel(t, "", fixtureS2(), 57, 45)
	// Select explore-auth (tab -> main, tab -> a1).
	m = send(t, m, keyTab)
	m = send(t, m, keyTab)
	if m.selected != "a1" {
		t.Fatalf("selected = %q, want a1", m.selected)
	}
	cSel, _ := layout(m)
	if strings.Contains(plainText(cSel), "README.md") {
		t.Fatal("while a1 is selected, activity should filter out a3's README.md")
	}

	// Press esc: selection cleared and all activity restored.
	m = send(t, m, keyEsc)
	if m.selected != "" {
		t.Fatalf("after esc: selected = %q, want empty", m.selected)
	}
	cAll, _ := layout(m)
	if !strings.Contains(plainText(cAll), "README.md") {
		t.Error("after esc: activity did not restore all entries (missing README.md)")
	}
}

func TestSelectedIDDisappearsOnSnapshot(t *testing.T) {
	s1 := fixtureS2()
	m := readyModel(t, "", s1, 57, 45)
	m = send(t, m, keyTab) // main
	m = send(t, m, keyTab) // a1
	if m.selected != "a1" {
		t.Fatalf("selected = %q, want a1", m.selected)
	}

	// New snapshot drops a1 (e.g. finished in a previous turn).
	s2 := s1
	s2.Turn = 4
	s2.Agents = []protocol.Agent{s1.Agents[1]} // only a2 remains running
	m = send(t, m, SnapshotMsg{Snapshot: s2})
	if m.selected != "" {
		t.Errorf("selected after a1 vanished = %q, want empty", m.selected)
	}
}

func TestCompactEnterAndEsc(t *testing.T) {
	t.Run("enter with nothing selected selects main without opening log page", func(t *testing.T) {
		m := readyModel(t, "", fixtureS2(), 30, 8)
		m = send(t, m, keyEnter)
		if m.selected != mainID {
			t.Errorf("selected = %q, want %q", m.selected, mainID)
		}
		if m.showLog {
			t.Error("showLog = true, want false when nothing was selected")
		}
		// Second enter opens main's log page.
		m = send(t, m, keyEnter)
		if !m.showLog {
			t.Error("second enter did not open log page")
		}
	})

	t.Run("S2 enter opens selected log page and esc returns", func(t *testing.T) {
		m := readyModel(t, "", fixtureS2(), 30, 8)
		m = send(t, m, keyTab) // main
		m = send(t, m, keyTab) // a1 (explore-auth)
		m = send(t, m, keyEnter)
		if !m.showLog {
			t.Fatal("enter did not switch to log page")
		}
		cLog, _ := layout(m)
		txt := plainText(cLog)
		if !strings.Contains(txt, "explore-auth") || !strings.Contains(txt, "grep") {
			t.Errorf("compact log page did not show explore-auth activity:\n%s", txt)
		}
		if strings.Contains(txt, "docs-outline") {
			t.Errorf("compact log page leaked other agent:\n%s", txt)
		}

		// First esc leaves log page, keeping selection.
		m = send(t, m, keyEsc)
		if m.showLog {
			t.Error("first esc did not leave log page")
		}
		if m.selected != "a1" {
			t.Errorf("first esc changed selection to %q, want a1", m.selected)
		}

		// Second esc clears selection.
		m = send(t, m, keyEsc)
		if m.selected != "" {
			t.Errorf("second esc did not clear selection: %q", m.selected)
		}
	})
}

func TestThemeSwitchingAndErrors(t *testing.T) {
	t.Run("gta6 to auto removes background sequences", func(t *testing.T) {
		s := fixtureS2()
		m := readyModel(t, "", s, 57, 45)
		vGTA6 := m.View()
		if vGTA6.BackgroundColor == nil {
			t.Fatal("gta6 View().BackgroundColor is nil")
		}
		if !strings.Contains(vGTA6.Content, "48;2;") {
			t.Fatal("gta6 rendered output should contain truecolor background sequences")
		}

		sAuto := s
		sAuto.Theme = "auto"
		m = send(t, m, SnapshotMsg{Snapshot: sAuto})
		vAuto := m.View()
		if vAuto.BackgroundColor != nil {
			t.Errorf("auto View().BackgroundColor = %v, want nil", vAuto.BackgroundColor)
		}
		c, _ := layout(m)
		for row, cells := range parseCells(t, c, vAuto.Content) {
			for col, cell := range cells {
				if cell.bg != "" {
					t.Fatalf("auto cell (%d,%d) has background %q, want none", row, col, cell.bg)
				}
			}
		}
	})

	t.Run("nonexistent theme falls back to gta6 and notes error in status bar", func(t *testing.T) {
		s := fixtureS2()
		s.Theme = "nosuch"
		m := readyModel(t, t.TempDir(), s, 57, 45)
		v := m.View()
		if v.BackgroundColor == nil || !strings.Contains(v.Content, "48;2;") {
			t.Error("fallback theme should render with gta6 background")
		}
		lines := strings.Split(ansi.Strip(v.Content), "\n")
		statusArea := lines[len(lines)-2] + "\n" + lines[len(lines)-1]
		if !strings.Contains(statusArea, "nosuch") || !strings.Contains(statusArea, "not found") {
			t.Errorf("status bar missing theme error note:\n%s", statusArea)
		}

		// Also check horizontal layout (single status bar row).
		mH := readyModel(t, t.TempDir(), s, 170, 15)
		hLines := strings.Split(ansi.Strip(mH.View().Content), "\n")
		if !strings.Contains(hLines[len(hLines)-1], "theme nosuch not found") {
			t.Errorf("horizontal status bar = %q, want 'theme nosuch not found'", hLines[len(hLines)-1])
		}

		// Switching back to a valid theme clears the error note.
		sOK := s
		sOK.Theme = "gta6"
		m = send(t, m, SnapshotMsg{Snapshot: sOK})
		if m.themeErr != "" {
			t.Errorf("themeErr after switching back to gta6 = %q, want empty", m.themeErr)
		}
	})

	t.Run("empty theme keeps current theme and failing name is not reloaded", func(t *testing.T) {
		dir := t.TempDir()
		s := fixtureS2()
		s.Theme = "auto"
		m := readyModel(t, dir, s, 57, 45)
		if m.activeTheme().HasBackground() {
			t.Fatal("expected auto theme without background")
		}
		// Empty theme field keeps auto.
		sEmpty := s
		sEmpty.Theme = ""
		m = send(t, m, SnapshotMsg{Snapshot: sEmpty})
		if m.activeTheme().HasBackground() || m.themeName != "auto" {
			t.Errorf("empty theme changed themeName=%q HasBackground=%v", m.themeName, m.activeTheme().HasBackground())
		}

		// Failing theme is remembered so creating the file later doesn't reload on same name.
		sFail := s
		sFail.Theme = "later"
		m = send(t, m, SnapshotMsg{Snapshot: sFail})
		if !strings.Contains(m.themeErr, "theme later not found") {
			t.Fatalf("themeErr = %q, want 'theme later not found'", m.themeErr)
		}
		if err := os.WriteFile(filepath.Join(dir, "later.json"), []byte(`{"colors":{"main":"#ff0000"}}`), 0o600); err != nil {
			t.Fatal(err)
		}
		m = send(t, m, SnapshotMsg{Snapshot: sFail})
		if m.themeErr == "" {
			t.Error("same failing theme name was reloaded on subsequent snapshot")
		}
	})

	t.Run("theme name with ESC and control sequences is cleaned in status bar", func(t *testing.T) {
		s := fixtureS2()
		s.Theme = "\x1b[31mevil\x1b[0m\n\t\x07\u202ename"
		m := readyModel(t, t.TempDir(), s, 100, 45)
		if m.themeErr == "" {
			t.Fatal("expected themeErr to be set")
		}
		for _, r := range m.themeErr {
			if unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) {
				t.Errorf("themeErr %q contains control/bidi rune %U", m.themeErr, r)
			}
		}
		lines := strings.Split(ansi.Strip(m.View().Content), "\n")
		statusArea := lines[len(lines)-2] + "\n" + lines[len(lines)-1]
		if !strings.Contains(statusArea, "evil") {
			t.Errorf("status bar %q should contain cleaned theme name", statusArea)
		}
	})

	t.Run("custom theme from themesDir is loaded cleanly", func(t *testing.T) {
		data, err := os.ReadFile(filepath.Join("..", "..", "..", "extension", "themes", "example.json"))
		if err != nil {
			t.Fatalf("read example.json: %v", err)
		}
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "mine.json"), data, 0o600); err != nil {
			t.Fatal(err)
		}

		s := fixtureS2()
		s.Theme = "mine"
		m := readyModel(t, dir, s, 57, 45)
		if m.themeErr != "" {
			t.Fatalf("unexpected themeErr = %q", m.themeErr)
		}
		v := m.View()
		// example.json starts its background gradient at #0d1117 (13, 17, 23).
		if v.BackgroundColor == nil {
			t.Fatal("mine theme should have a BackgroundColor")
		}
		r, g, b, _ := v.BackgroundColor.RGBA()
		if r>>8 != 0x0d || g>>8 != 0x11 || b>>8 != 0x17 {
			t.Errorf("BackgroundColor = (%x,%x,%x), want (0d,11,17)", r>>8, g>>8, b>>8)
		}
		// example.json has decor: "none", so no palm quadrant block chars appear.
		stripped := ansi.Strip(v.Content)
		for _, r := range stripped {
			if r >= 0x2596 && r <= 0x259f || r == 0x2580 || r == 0x2584 || r == 0x258c || r == 0x2590 {
				t.Errorf("mine theme (decor=none) unexpectedly rendered quadrant char %q", r)
				break
			}
		}
	})
}

func TestAutoThemeBackgroundColorMsg(t *testing.T) {
	s := fixtureS2()
	s.Theme = "auto"
	m := readyModel(t, "", s, 57, 45)

	// Dark terminal background -> bright ANSI group (main=95, run=93, agent=96, ok=92, fail=91).
	m = send(t, m, tea.BackgroundColorMsg{Color: color.RGBA{R: 0x10, G: 0x10, B: 0x14, A: 0xff}})
	if !m.dark {
		t.Fatal("dark background should set m.dark = true")
	}
	cDark, _ := layout(m)
	darkGrid := parseCells(t, cDark, m.View().Content)
	// Row 3 is main box top border (RoleMain).
	foundBrightMain := false
	for _, cell := range darkGrid[3] {
		if cell.text == LightBorder.TopLeft && cell.fg == "95" {
			foundBrightMain = true
			break
		}
	}
	if !foundBrightMain {
		t.Error("dark BackgroundColorMsg under auto theme did not emit bright ANSI 95 for main border")
	}

	// Light terminal background -> normal ANSI group (main=35, run=33, agent=36, ok=32, fail=31).
	m = send(t, m, tea.BackgroundColorMsg{Color: color.RGBA{R: 0xf8, G: 0xf8, B: 0xf8, A: 0xff}})
	if m.dark {
		t.Fatal("light background should set m.dark = false")
	}
	cLight, _ := layout(m)
	lightGrid := parseCells(t, cLight, m.View().Content)
	foundNormalMain := false
	for _, cell := range lightGrid[3] {
		if cell.text == LightBorder.TopLeft && cell.fg == "35" {
			foundNormalMain = true
			break
		}
	}
	if !foundNormalMain {
		t.Error("light BackgroundColorMsg under auto theme did not emit normal ANSI 35 for main border")
	}
}

var (
	reScrollUp   = regexp.MustCompile(ArrowUp + ` (\d+)`)
	reScrollDown = regexp.MustCompile(ArrowDown + ` (\d+)`)
)

func parseScrollMark(line string, re *regexp.Regexp) int {
	if m := re.FindStringSubmatch(line); m != nil {
		n, _ := strconv.Atoi(m[1])
		return n
	}
	return 0
}

func makeLogEntries(startSeq, count int64) []protocol.LogEntry {
	out := make([]protocol.LogEntry, 0, count)
	for i := range count {
		seq := startSeq + i
		actor := mainID
		name := mainID
		if seq%3 == 0 {
			actor = "a1"
			name = "explore-auth"
		}
		out = append(out, protocol.LogEntry{
			Seq:     seq,
			T:       "2026-11-23T23:48:00Z",
			Actor:   actor,
			Name:    name,
			Kind:    "tool",
			Tool:    "view",
			Summary: fmt.Sprintf("entry-%03d.go", seq),
			Status:  "done",
		})
	}
	return out
}

func makeReported14Snap() protocol.Snapshot {
	s := makeRunningSnap(2)
	for i := range 14 {
		a := protocol.Agent{
			ID:           fmt.Sprintf("r%d", i+1),
			SpawnTurn:    2,
			ReportedTurn: 2,
			Name:         fmt.Sprintf("rep-%02d", i+1),
			Type:         "task",
			Status:       "done",
			DurationMs:   5000,
			ToolCount:    2,
		}
		if i == 2 || i == 7 || i == 12 {
			a.Status = "failed"
			a.Error = fmt.Sprintf("err-code-%02d", i+1)
		}
		s.Agents = append(s.Agents, a)
	}
	return s
}

func TestTabScrolls60Running(t *testing.T) {
	m := readyModel(t, "", makeRunningSnap(60), 57, 45)

	// First tab selects main.
	m = send(t, m, keyTab)
	if m.selected != mainID {
		t.Fatalf("first tab selected = %q, want %q", m.selected, mainID)
	}

	for i := 1; i <= 60; i++ {
		m = send(t, m, keyTab)
		wantID := fmt.Sprintf("a%d", i)
		if m.selected != wantID {
			t.Fatalf("step %d: selected = %q, want %q", i, m.selected, wantID)
		}
		c, hits := layout(m)
		if _, ok := findHit(hits, hitItem, wantID); !ok {
			t.Fatalf("step %d: selected %q is not in viewport (runOffset=%d)", i, wantID, m.runOffset)
		}
		hr, ok := findHit(hits, hitRunScroll, "")
		if !ok {
			t.Fatalf("step %d: missing hitRunScroll", i)
		}
		lines := plainLines(c)
		above := parseScrollMark(lines[hr.rect.Min.Y], reScrollUp)
		below := parseScrollMark(lines[hr.rect.Max.Y-1], reScrollDown)
		vis := 0
		for _, h := range hits {
			if h.kind == hitItem && strings.HasPrefix(h.id, "a") {
				vis++
			}
		}
		if above+vis+below != 60 {
			t.Fatalf("step %d: ▲ %d + vis %d + ▼ %d = %d, want 60", i, above, vis, below, above+vis+below)
		}
	}
}

func TestTabScrolls14ReportedWithFailed(t *testing.T) {
	s := makeReported14Snap()
	failedIDs := map[string]string{"r3": "err-code-03", "r8": "err-code-08", "r13": "err-code-13"}

	m := readyModel(t, "", s, 57, 45)
	// Skip main + 2 running.
	for range 3 {
		m = send(t, m, keyTab)
	}

	for i := 1; i <= 14; i++ {
		m = send(t, m, keyTab)
		wantID := fmt.Sprintf("r%d", i)
		if m.selected != wantID {
			t.Fatalf("step %d: selected = %q, want %q", i, m.selected, wantID)
		}
		c, hits := layout(m)
		if _, ok := findHit(hits, hitItem, wantID); !ok {
			t.Fatalf("step %d: selected %q not in viewport (backOffset=%d)", i, wantID, m.backOffset)
		}
		hb, ok := findHit(hits, hitBackScroll, "")
		if !ok {
			t.Fatalf("step %d: missing hitBackScroll", i)
		}
		lines := plainLines(c)
		above := parseScrollMark(lines[hb.rect.Min.Y], reScrollUp)
		below := parseScrollMark(lines[hb.rect.Max.Y-1], reScrollDown)
		vis := 0
		for _, h := range hits {
			if h.kind == hitItem && strings.HasPrefix(h.id, "r") {
				vis++
				if errText, isFailed := failedIDs[h.id]; isFailed {
					if h.rect.Dy() != 2 {
						t.Fatalf("step %d: visible failed entry %q has height %d, want 2", i, h.id, h.rect.Dy())
					}
					if !strings.Contains(lines[h.rect.Min.Y+1], errText) {
						t.Fatalf("step %d: failed entry %q missing error line %q in %q", i, h.id, errText, lines[h.rect.Min.Y+1])
					}
				}
			}
		}
		if above+vis+below != 14 {
			t.Fatalf("step %d: ▲ %d + vis %d + ▼ %d = %d, want 14", i, above, vis, below, above+vis+below)
		}
	}
}

func TestCompactTabScrolls60Running(t *testing.T) {
	m := readyModel(t, "", makeRunningSnap(60), 30, 8)
	totalItems := 61 // main + 60 running
	visRows := compactListVisRows(8)

	for step := range totalItems {
		m = send(t, m, keyTab)
		wantID := mainID
		if step > 0 {
			wantID = fmt.Sprintf("a%d", step)
		}
		if m.selected != wantID {
			t.Fatalf("step %d: selected = %q, want %q", step, m.selected, wantID)
		}
		c, hits := layout(m)
		if _, ok := findHit(hits, hitItem, wantID); !ok {
			t.Fatalf("step %d: %q not in compact viewport (listOffset=%d)", step, wantID, m.listOffset)
		}
		lines := plainLines(c)
		above := parseScrollMark(lines[0], reScrollUp)
		below := parseScrollMark(lines[visRows-1], reScrollDown)
		vis := 0
		for _, h := range hits {
			if h.kind == hitItem {
				vis++
			}
		}
		if above+vis+below != totalItems {
			t.Fatalf("step %d: ▲ %d + vis %d + ▼ %d = %d, want %d", step, above, vis, below, above+vis+below, totalItems)
		}
	}
}

func TestActivityScrollPgUpEvictionEndAndSelection(t *testing.T) {
	s := fixtureS2()
	s.Log = makeLogEntries(1, 200)
	m := readyModel(t, "", s, 57, 45)

	activityFirstAndBelow := func(m Model) (firstLine string, above, below int) {
		c, hits := layout(m)
		hl, ok := findHit(hits, hitLogScroll, "")
		if !ok {
			t.Fatal("missing hitLogScroll")
		}
		lines := plainLines(c)
		above = parseScrollMark(lines[hl.rect.Min.Y], reScrollUp)
		below = parseScrollMark(lines[hl.rect.Max.Y-1], reScrollDown)
		firstLine = lines[hl.rect.Min.Y+1]
		return firstLine, above, below
	}

	// Initially following at bottom: no ▼, latest entry-200 visible.
	c0, _ := layout(m)
	if !strings.Contains(plainText(c0), "entry-200.go") {
		t.Fatal("initial activity should show latest entry-200.go")
	}
	_, _, below0 := activityFirstAndBelow(m)
	if below0 != 0 {
		t.Fatalf("initial below = %d, want 0", below0)
	}

	// Press pgup twice.
	m = send(t, m, keyPgUp)
	m = send(t, m, keyPgUp)
	if m.logFollow {
		t.Fatal("after 2x pgup: logFollow should be false")
	}
	firstAfterPgUp, _, belowAfterPgUp := activityFirstAndBelow(m)
	if belowAfterPgUp == 0 {
		t.Fatal("after 2x pgup: expected ▼ > 0")
	}

	// New snapshot arrives with 10 newer entries (sliding 200-entry window: seqs 11..210).
	s2 := s
	s2.Seq++
	s2.Log = makeLogEntries(11, 200)
	m = send(t, m, SnapshotMsg{Snapshot: s2})
	firstAfterSnap, _, belowAfterSnap := activityFirstAndBelow(m)
	if firstAfterSnap != firstAfterPgUp {
		t.Errorf("first visible log line changed on new snapshot:\ngot:  %q\nwant: %q", firstAfterSnap, firstAfterPgUp)
	}
	if belowAfterSnap != belowAfterPgUp+10 {
		t.Errorf("below = %d, want %d (+10)", belowAfterSnap, belowAfterPgUp+10)
	}

	// Evict logTop completely (window advances to seqs 250..449).
	s3 := s2
	s3.Seq++
	s3.Log = makeLogEntries(250, 200)
	m = send(t, m, SnapshotMsg{Snapshot: s3})
	firstAfterEvict, aboveAfterEvict, _ := activityFirstAndBelow(m)
	if aboveAfterEvict != 0 {
		t.Errorf("after eviction: ▲ = %d, want 0", aboveAfterEvict)
	}
	if !strings.Contains(firstAfterEvict, "entry-250.go") {
		t.Errorf("after eviction: first line = %q, want earliest surviving entry-250.go", firstAfterEvict)
	}

	// Press end: return to bottom and restore follow.
	m = send(t, m, keyEnd)
	if !m.logFollow {
		t.Fatal("after end: logFollow should be true")
	}
	_, _, belowAfterEnd := activityFirstAndBelow(m)
	if belowAfterEnd != 0 {
		t.Errorf("after end: ▼ = %d, want 0", belowAfterEnd)
	}
	s4 := s3
	s4.Seq++
	s4.Log = makeLogEntries(255, 200) // latest is 454
	m = send(t, m, SnapshotMsg{Snapshot: s4})
	c4, _ := layout(m)
	if !strings.Contains(plainText(c4), "entry-454.go") {
		t.Error("after end: new snapshot did not follow to entry-454.go")
	}

	// Scroll up again, then select an item -> resets to bottom and restores follow.
	m = send(t, m, keyPgUp)
	if m.logFollow {
		t.Fatal("after pgup: logFollow should be false")
	}
	m = send(t, m, keyTab) // select main
	if !m.logFollow {
		t.Error("selecting an item while scrolled up did not restore logFollow")
	}
	_, _, belowAfterSel := activityFirstAndBelow(m)
	if belowAfterSel != 0 {
		t.Errorf("after selecting while scrolled up: ▼ = %d, want 0", belowAfterSel)
	}

	// Scroll up with pgup then back down to bottom with pgdown restores logFollow.
	m = send(t, m, keyPgUp)
	if m.logFollow {
		t.Fatal("expected logFollow=false after pgup")
	}
	m = send(t, m, keyPgDown)
	if !m.logFollow {
		t.Error("pgdown reaching bottom did not restore logFollow")
	}
}

func TestMouseWheelTargets(t *testing.T) {
	// Build snapshot with 60 running, 14 reported, and 200 log entries so all 3 frames scroll.
	s := makeRunningSnap(60)
	for i := range 14 {
		s.Agents = append(s.Agents, protocol.Agent{
			ID: fmt.Sprintf("r%d", i+1), SpawnTurn: 2, ReportedTurn: 2,
			Name: fmt.Sprintf("rep-%02d", i+1), Type: "task", Status: "done", DurationMs: 5000,
		})
	}
	s.Log = makeLogEntries(1, 200)

	m := readyModel(t, "", s, 57, 45)
	m = send(t, m, keyTab) // select main
	_, hits := layout(m)

	hRun, okRun := findHit(hits, hitRunScroll, "")
	hBack, okBack := findHit(hits, hitBackScroll, "")
	hLog, okLog := findHit(hits, hitLogScroll, "")
	if !okRun || !okBack || !okLog {
		t.Fatalf("missing scroll hits: run=%v back=%v log=%v", okRun, okBack, okLog)
	}

	center := func(h hit) (int, int) {
		return (h.rect.Min.X + h.rect.Max.X) / 2, (h.rect.Min.Y + h.rect.Max.Y) / 2
	}

	// 1. Wheel up inside activity: only activity scrolls.
	lx, ly := center(hLog)
	m = send(t, m, tea.MouseWheelMsg{X: lx, Y: ly, Button: tea.MouseWheelUp})
	if m.logFollow || m.runOffset != 0 || m.backOffset != 0 || m.selected != mainID {
		t.Errorf("wheel in activity: follow=%v run=%d back=%d sel=%q", m.logFollow, m.runOffset, m.backOffset, m.selected)
	}
	savedLogTop := m.logTop

	// 2. Wheel down inside back to main: only backOffset increments.
	bx, by := center(hBack)
	m = send(t, m, tea.MouseWheelMsg{X: bx, Y: by, Button: tea.MouseWheelDown})
	if m.backOffset != 1 || m.runOffset != 0 || m.logTop != savedLogTop || m.selected != mainID {
		t.Errorf("wheel in back: back=%d run=%d logTop=%d sel=%q", m.backOffset, m.runOffset, m.logTop, m.selected)
	}

	// 3. Wheel down inside run area compact-rows frame: only runOffset increments.
	rx, ry := center(hRun)
	m = send(t, m, tea.MouseWheelMsg{X: rx, Y: ry, Button: tea.MouseWheelDown})
	if m.runOffset != 1 || m.backOffset != 1 || m.logTop != savedLogTop || m.selected != mainID {
		t.Errorf("wheel in run: run=%d back=%d logTop=%d sel=%q", m.runOffset, m.backOffset, m.logTop, m.selected)
	}

	// 4. Wheel outside any scrollable frame (row 0 title): nothing changes.
	m = send(t, m, tea.MouseWheelMsg{X: 0, Y: 0, Button: tea.MouseWheelDown})
	if m.runOffset != 1 || m.backOffset != 1 || m.logTop != savedLogTop || m.selected != mainID {
		t.Errorf("wheel outside changed state: run=%d back=%d logTop=%d sel=%q", m.runOffset, m.backOffset, m.logTop, m.selected)
	}

	// 5. Compact layout list wheel and compact log page wheel/pgup/end.
	mc := readyModel(t, "", makeRunningSnap(60), 30, 8)
	mc = send(t, mc, tea.MouseWheelMsg{X: 5, Y: 2, Button: tea.MouseWheelDown})
	if mc.listOffset != 1 || mc.selected != "" {
		t.Errorf("compact list wheel: listOffset=%d sel=%q, want 1 and empty", mc.listOffset, mc.selected)
	}
	mcLogSnap := fixtureS0()
	mcLogSnap.Log = makeLogEntries(1, 50)
	mcLog := readyModel(t, "", mcLogSnap, 30, 8)
	mcLog = send(t, mcLog, keyEnter) // selects main
	mcLog = send(t, mcLog, keyEnter) // opens main log page
	mcLog = send(t, mcLog, tea.MouseWheelMsg{X: 5, Y: 2, Button: tea.MouseWheelUp})
	if mcLog.logFollow {
		t.Error("wheel up on compact log page should leave logFollow")
	}
	mcLog = send(t, mcLog, keyPgUp)
	mcLog = send(t, mcLog, keyEnd)
	if !mcLog.logFollow {
		t.Error("end on compact log page should restore logFollow")
	}

	// 6. Horizontal layout wheel on compact running frame and back to main.
	mh := readyModel(t, "", s, 170, 15)
	_, hHits := layout(mh)
	hhRun, okHRun := findHit(hHits, hitRunScroll, "")
	hhBack, okHBack := findHit(hHits, hitBackScroll, "")
	if !okHRun || !okHBack {
		t.Fatalf("horizontal missing scroll hits: run=%v back=%v", okHRun, okHBack)
	}
	mh = send(t, mh, tea.MouseWheelMsg{X: hhRun.rect.Min.X + 2, Y: hhRun.rect.Min.Y + 1, Button: tea.MouseWheelDown})
	mh = send(t, mh, tea.MouseWheelMsg{X: hhBack.rect.Min.X + 2, Y: hhBack.rect.Min.Y + 1, Button: tea.MouseWheelDown})
	if mh.runOffset != 1 || mh.backOffset != 1 {
		t.Errorf("horizontal wheel: runOffset=%d backOffset=%d, want 1 and 1", mh.runOffset, mh.backOffset)
	}
}

func TestWheelScrollOutOfViewNotPulledBackUntilTab(t *testing.T) {
	s := makeRunningSnap(60)
	m := readyModel(t, "", s, 57, 45)
	// Select a1 (tab -> main, tab -> a1).
	m = send(t, m, keyTab)
	m = send(t, m, keyTab)
	if m.selected != "a1" {
		t.Fatalf("selected = %q, want a1", m.selected)
	}

	_, hits := layout(m)
	hRun, ok := findHit(hits, hitRunScroll, "")
	if !ok {
		t.Fatal("missing hitRunScroll")
	}
	rx := (hRun.rect.Min.X + hRun.rect.Max.X) / 2
	ry := (hRun.rect.Min.Y + hRun.rect.Max.Y) / 2

	// Wheel down 3 times so a1 (row 0) is scrolled out of the viewport.
	for range 3 {
		m = send(t, m, tea.MouseWheelMsg{X: rx, Y: ry, Button: tea.MouseWheelDown})
	}
	if m.runOffset != 3 {
		t.Fatalf("runOffset = %d, want 3", m.runOffset)
	}
	_, hitsScrolled := layout(m)
	if _, visible := findHit(hitsScrolled, hitItem, "a1"); visible {
		t.Fatal("a1 should have been scrolled out of viewport")
	}

	// Identical snapshot arrives: viewport must NOT pull back to a1.
	m = send(t, m, SnapshotMsg{Snapshot: s})
	if m.runOffset != 3 {
		t.Errorf("snapshot pulled runOffset to %d, want 3", m.runOffset)
	}

	// Now press tab: selects a2, and a2 must be brought into the viewport.
	m = send(t, m, keyTab)
	if m.selected != "a2" {
		t.Fatalf("after tab: selected = %q, want a2", m.selected)
	}
	_, hitsAfterTab := layout(m)
	if _, visible := findHit(hitsAfterTab, hitItem, "a2"); !visible {
		t.Errorf("after tab: a2 is not in viewport (runOffset=%d)", m.runOffset)
	}
}

func TestMouseLeftClickTargets(t *testing.T) {
	// Case A: S2 with running boxes, main box, back to main with failed error line, and empty space.
	m := readyModel(t, "", fixtureS2(), 57, 45)
	_, hits := layout(m)

	click := func(m Model, x, y int, btn tea.MouseButton) Model {
		return send(t, m, tea.MouseClickMsg{X: x, Y: y, Button: btn})
	}

	// Sub-agent box (a1)
	hA1, _ := findHit(hits, hitItem, "a1")
	m = click(m, hA1.rect.Min.X+1, hA1.rect.Min.Y+1, tea.MouseLeft)
	if m.selected != "a1" {
		t.Errorf("click a1 box: selected = %q, want a1", m.selected)
	}

	// Back to main normal entry (a3)
	hA3, _ := findHit(hits, hitItem, "a3")
	m = click(m, hA3.rect.Min.X+2, hA3.rect.Min.Y, tea.MouseLeft)
	if m.selected != "a3" {
		t.Errorf("click a3 back entry: selected = %q, want a3", m.selected)
	}

	// Failed entry's error row (second row of a4)
	hA4, _ := findHit(hits, hitItem, "a4")
	if hA4.rect.Dy() != 2 {
		t.Fatalf("a4 hit height = %d, want 2", hA4.rect.Dy())
	}
	m = click(m, hA4.rect.Min.X+3, hA4.rect.Min.Y+1, tea.MouseLeft)
	if m.selected != "a4" {
		t.Errorf("click a4 error row: selected = %q, want a4", m.selected)
	}

	// Main box
	hMain, _ := findHit(hits, hitItem, mainID)
	m = click(m, hMain.rect.Min.X+2, hMain.rect.Min.Y+2, tea.MouseLeft)
	if m.selected != mainID {
		t.Errorf("click main box: selected = %q, want main", m.selected)
	}

	// Empty space (top-left corner row 0, col 0): selection unchanged.
	m = click(m, 0, 0, tea.MouseLeft)
	if m.selected != mainID {
		t.Errorf("click empty space changed selection to %q, want main", m.selected)
	}

	// Right click on a1: ignored.
	m = click(m, hA1.rect.Min.X+1, hA1.rect.Min.Y+1, tea.MouseRight)
	if m.selected != mainID {
		t.Errorf("right click changed selection to %q, want main", m.selected)
	}

	// Case B: Compact row in running area (12 running at 57x45).
	mc := readyModel(t, "", makeRunningSnap(12), 57, 45)
	_, cHits := layout(mc)
	hA5, ok := findHit(cHits, hitItem, "a5")
	if !ok {
		t.Fatal("missing compact row hit for a5")
	}
	mc = click(mc, hA5.rect.Min.X+2, hA5.rect.Min.Y, tea.MouseLeft)
	if mc.selected != "a5" {
		t.Errorf("click compact row a5: selected = %q, want a5", mc.selected)
	}
}

func TestOffsetClampingOnShrinkTurnChangeAndResize(t *testing.T) {
	t.Run("run area scrolled to middle then shrunk to fit one screen", func(t *testing.T) {
		m := readyModel(t, "", makeRunningSnap(60), 57, 45)
		m.runOffset = 8

		m = send(t, m, SnapshotMsg{Snapshot: makeRunningSnap(10)})
		if m.runOffset != 0 {
			t.Errorf("runOffset after shrink to 10 = %d, want 0", m.runOffset)
		}
		_, hits := layout(m)
		if _, ok := findHit(hits, hitItem, "a1"); !ok {
			t.Error("viewport blank or missing a1 after shrink")
		}
	})

	t.Run("back to main scrolled to middle then turn changes", func(t *testing.T) {
		s := makeReported14Snap()
		m := readyModel(t, "", s, 57, 45)
		m.backOffset = 5

		nextTurn := s
		nextTurn.Turn++
		m = send(t, m, SnapshotMsg{Snapshot: nextTurn})
		if m.backOffset != 0 {
			t.Errorf("backOffset after turn change = %d, want 0", m.backOffset)
		}
		// Must render cleanly without panic.
		_ = m.View()
	})

	t.Run("resize clamps listOffset", func(t *testing.T) {
		m := readyModel(t, "", makeRunningSnap(10), 30, 8)
		m.listOffset = 4
		// Grow tall enough that all 11 items fit in compact list (100x20 -> 19 visRows).
		m = send(t, m, tea.WindowSizeMsg{Width: 100, Height: 20})
		if m.listOffset != 0 {
			t.Errorf("listOffset after growing compact pane = %d, want 0", m.listOffset)
		}
	})
}

func TestMouseIgnoredDuringInputGuard(t *testing.T) {
	for _, elapsed := range []time.Duration{0, 499 * time.Millisecond} {
		m := New("", fixtureNow)
		m.clock = func() time.Time { return fixtureNow.Add(elapsed) }
		m.now = fixtureNow
		m = send(t, m, tea.WindowSizeMsg{Width: 57, Height: 45})
		m = send(t, m, SnapshotMsg{Snapshot: makeRunningSnap(60)})

		_, hits := layout(m)
		hA1, _ := findHit(hits, hitItem, "a1")
		hRun, _ := findHit(hits, hitRunScroll, "")

		m = send(t, m, tea.MouseClickMsg{X: hA1.rect.Min.X + 1, Y: hA1.rect.Min.Y, Button: tea.MouseLeft})
		if m.selected != "" {
			t.Errorf("elapsed %v: click selected %q, want ignored", elapsed, m.selected)
		}
		m = send(t, m, tea.MouseWheelMsg{X: hRun.rect.Min.X + 2, Y: hRun.rect.Min.Y + 1, Button: tea.MouseWheelDown})
		if m.runOffset != 0 {
			t.Errorf("elapsed %v: wheel set runOffset=%d, want ignored", elapsed, m.runOffset)
		}
	}

	// At 500ms, both click and wheel take effect.
	m := New("", fixtureNow)
	m.clock = func() time.Time { return fixtureNow.Add(500 * time.Millisecond) }
	m.now = fixtureNow
	m = send(t, m, tea.WindowSizeMsg{Width: 57, Height: 45})
	m = send(t, m, SnapshotMsg{Snapshot: makeRunningSnap(60)})
	_, hits := layout(m)
	hA1, _ := findHit(hits, hitItem, "a1")
	hRun, _ := findHit(hits, hitRunScroll, "")
	m = send(t, m, tea.MouseClickMsg{X: hA1.rect.Min.X + 1, Y: hA1.rect.Min.Y, Button: tea.MouseLeft})
	if m.selected != "a1" {
		t.Errorf("at 500ms: click selected %q, want a1", m.selected)
	}
	m = send(t, m, tea.MouseWheelMsg{X: hRun.rect.Min.X + 2, Y: hRun.rect.Min.Y + 1, Button: tea.MouseWheelDown})
	if m.runOffset != 1 {
		t.Errorf("at 500ms: wheel runOffset = %d, want 1", m.runOffset)
	}
}

type scheduledTick struct {
	d  time.Duration
	fn func(time.Time) tea.Msg
}

func fakeTick(d time.Duration, fn func(time.Time) tea.Msg) tea.Cmd {
	return func() tea.Msg {
		return scheduledTick{d: d, fn: fn}
	}
}

func collectMsgs(cmd tea.Cmd) []tea.Msg {
	if cmd == nil {
		return nil
	}
	msg := cmd()
	if msg == nil {
		return nil
	}
	if batch, ok := msg.(tea.BatchMsg); ok {
		var out []tea.Msg
		for _, c := range batch {
			out = append(out, collectMsgs(c)...)
		}
		return out
	}
	return []tea.Msg{msg}
}

func findTick(msgs []tea.Msg, d time.Duration) (scheduledTick, bool) {
	for _, msg := range msgs {
		if st, ok := msg.(scheduledTick); ok && st.d == d {
			return st, true
		}
	}
	return scheduledTick{}, false
}

func hasRequestBG(msgs []tea.Msg) bool {
	want := tea.RequestBackgroundColor()
	for _, msg := range msgs {
		if msg == want {
			return true
		}
	}
	return false
}

func TestInitAndClockTick(t *testing.T) {
	now := fixtureNow
	m := New("", fixtureNow)
	m.clock = func() time.Time { return now }
	m.tick = fakeTick
	m.now = now

	initMsgs := collectMsgs(m.Init())
	tk, ok := findTick(initMsgs, time.Second)
	if !ok {
		t.Fatalf("Init() msgs = %#v, want a 1s clock tick", initMsgs)
	}
	if hasRequestBG(initMsgs) {
		t.Error("Init() under gta6 must not request terminal background color")
	}

	m = send(t, m, tea.WindowSizeMsg{Width: 57, Height: 45})
	m, _ = sendCmd(t, m, SnapshotMsg{Snapshot: fixtureS0()})

	// Advance clock by 5 seconds and deliver the clock tick.
	now = fixtureNow.Add(5 * time.Second)
	var cmd tea.Cmd
	m, cmd = sendCmd(t, m, tk.fn(now))
	if !m.now.Equal(now) {
		t.Errorf("m.now = %v, want %v", m.now, now)
	}
	// fixtureS0 Main.Since is 23:48:31Z; fixtureNow+5s is 23:48:49Z -> 0:18.
	c, _ := layout(m)
	if !strings.Contains(plainText(c), "0:18") {
		t.Errorf("elapsed time did not update to 0:18 after clock tick:\n%s", plainText(c))
	}
	if _, rearmed := findTick(collectMsgs(cmd), time.Second); !rearmed {
		t.Error("clock tick did not re-arm the 1s tick")
	}
}

func TestAnimationTickLifecycle(t *testing.T) {
	t.Run("S0 main idle returns no animation tick", func(t *testing.T) {
		s := fixtureS0()
		s.Main.Status = "idle"
		m := New("", fixtureNow)
		m.clock = func() time.Time { return fixtureNow.Add(time.Second) }
		m.tick = fakeTick
		m.now = fixtureNow
		m = send(t, m, tea.WindowSizeMsg{Width: 57, Height: 45})

		var cmd tea.Cmd
		m, cmd = sendCmd(t, m, SnapshotMsg{Snapshot: s})
		c, _ := layout(m)
		lines := plainLines(c)
		if !strings.Contains(lines[5], IconIdle+" idle") {
			t.Errorf("main box line 2 = %q, want %q", lines[5], IconIdle+" idle")
		}
		if _, hasAnim := findTick(collectMsgs(cmd), 140*time.Millisecond); hasAnim {
			t.Error("idle S0 should not start an animation tick")
		}
		if m.animating {
			t.Error("m.animating = true for idle S0, want false")
		}
	})

	t.Run("main idle with running sub-agent animates and advances spinner frame", func(t *testing.T) {
		s := makeRunningSnap(1)
		s.Main.Status = "idle"
		m := New("", fixtureNow)
		m.clock = func() time.Time { return fixtureNow.Add(time.Second) }
		m.tick = fakeTick
		m.now = fixtureNow
		m = send(t, m, tea.WindowSizeMsg{Width: 57, Height: 45})

		var cmd tea.Cmd
		m, cmd = sendCmd(t, m, SnapshotMsg{Snapshot: s})
		c0, _ := layout(m)
		lines0 := plainLines(c0)
		if !strings.Contains(lines0[5], IconIdle+" idle") {
			t.Errorf("main box line 2 = %q, want %q", lines0[5], IconIdle+" idle")
		}
		tk, ok := findTick(collectMsgs(cmd), 140*time.Millisecond)
		if !ok {
			t.Fatal("SnapshotMsg with running sub-agent did not start 140ms animation tick")
		}
		if !strings.Contains(plainText(c0), Spinner[0]) {
			t.Fatalf("frame 0 missing initial spinner %q", Spinner[0])
		}

		// Deliver the animation tick: frame increments, spinner changes, next tick scheduled.
		m, cmd = sendCmd(t, m, tk.fn(fixtureNow.Add(140*time.Millisecond)))
		if m.frame != 1 {
			t.Errorf("frame = %d, want 1", m.frame)
		}
		tk2, ok2 := findTick(collectMsgs(cmd), 140*time.Millisecond)
		if !ok2 {
			t.Fatal("animation tick with running sub-agent did not schedule next 140ms tick")
		}
		c1, _ := layout(m)
		if !strings.Contains(plainText(c1), Spinner[1]) {
			t.Errorf("frame 1 missing next spinner %q", Spinner[1])
		}

		// Another snapshot while already animating does NOT spawn a second chain.
		m, cmd = sendCmd(t, m, SnapshotMsg{Snapshot: s})
		if _, dup := findTick(collectMsgs(cmd), 140*time.Millisecond); dup {
			t.Error("SnapshotMsg spawned duplicate animation tick chain while already animating")
		}

		// Sub-agent finishes and main is idle: next in-flight tick stops the chain.
		sDone := s
		sDone.Agents[0].Status = "done"
		sDone.Agents[0].ReportedTurn = sDone.Turn
		m, _ = sendCmd(t, m, SnapshotMsg{Snapshot: sDone})
		m, cmd = sendCmd(t, m, tk2.fn(fixtureNow.Add(280*time.Millisecond)))
		if m.animating {
			t.Error("m.animating should be false once idle with no running sub-agents")
		}
		if _, stillTicking := findTick(collectMsgs(cmd), 140*time.Millisecond); stillTicking {
			t.Error("animation tick must stop when main is idle and no sub-agents are running")
		}
	})

	t.Run("anim tick and snapshot do not pull back wheel-scrolled viewport", func(t *testing.T) {
		s := makeRunningSnap(60)
		m := New("", fixtureNow)
		m.clock = func() time.Time { return fixtureNow.Add(time.Second) }
		m.tick = fakeTick
		m.now = fixtureNow
		m = send(t, m, tea.WindowSizeMsg{Width: 57, Height: 45})
		var cmd tea.Cmd
		m, cmd = sendCmd(t, m, SnapshotMsg{Snapshot: s})
		tk, ok := findTick(collectMsgs(cmd), 140*time.Millisecond)
		if !ok {
			t.Fatal("missing initial animation tick")
		}

		// Select a1 and scroll it out of view with the mouse wheel.
		m = send(t, m, keyTab) // main
		m = send(t, m, keyTab) // a1
		_, hits := layout(m)
		hRun, _ := findHit(hits, hitRunScroll, "")
		for range 4 {
			m = send(t, m, tea.MouseWheelMsg{X: hRun.rect.Min.X + 2, Y: hRun.rect.Min.Y + 1, Button: tea.MouseWheelDown})
		}
		if m.runOffset != 4 {
			t.Fatalf("runOffset = %d, want 4", m.runOffset)
		}

		// Animation tick + identical snapshot must not pull viewport back.
		m, _ = sendCmd(t, m, tk.fn(fixtureNow.Add(140*time.Millisecond)))
		m, _ = sendCmd(t, m, SnapshotMsg{Snapshot: s})
		if m.runOffset != 4 {
			t.Errorf("runOffset = %d after anim tick + snapshot, want 4", m.runOffset)
		}

		// Tab moves to a2 and brings a2 into view.
		m = send(t, m, keyTab)
		if m.selected != "a2" {
			t.Fatalf("selected = %q, want a2", m.selected)
		}
		_, hitsAfter := layout(m)
		if _, visible := findHit(hitsAfter, hitItem, "a2"); !visible {
			t.Errorf("a2 not visible after tab (runOffset=%d)", m.runOffset)
		}
	})
}

func TestBackgroundColorQueryLifecycle(t *testing.T) {
	s := fixtureS0()
	s.Main.Status = "idle"

	m := New("", fixtureNow)
	m.clock = func() time.Time { return fixtureNow.Add(time.Second) }
	m.tick = fakeTick
	m.now = fixtureNow
	m = send(t, m, tea.WindowSizeMsg{Width: 57, Height: 45})

	// Initial gta6 snapshot: no background query.
	var cmd tea.Cmd
	m, cmd = sendCmd(t, m, SnapshotMsg{Snapshot: s})
	msgs := collectMsgs(cmd)
	if hasRequestBG(msgs) || len(msgs) != 0 {
		t.Fatalf("gta6 snapshot returned unexpected cmds: %#v", msgs)
	}

	// Switch from gta6 -> auto: NO immediate RequestBackgroundColor; schedules 100ms tick.
	sAuto := s
	sAuto.Theme = "auto"
	m, cmd = sendCmd(t, m, SnapshotMsg{Snapshot: sAuto})
	msgs = collectMsgs(cmd)
	if hasRequestBG(msgs) {
		t.Fatal("switching gta6 -> auto must NOT query background immediately")
	}
	tk100, ok := findTick(msgs, 100*time.Millisecond)
	if !ok {
		t.Fatalf("switching gta6 -> auto msgs = %#v, want 100ms delay tick", msgs)
	}

	// 100ms later: emits RequestBackgroundColor and schedules 2s tick.
	m, cmd = sendCmd(t, m, tk100.fn(fixtureNow.Add(100*time.Millisecond)))
	msgs = collectMsgs(cmd)
	if !hasRequestBG(msgs) {
		t.Fatal("100ms tick did not emit tea.RequestBackgroundColor")
	}
	tk2s, ok := findTick(msgs, 2*time.Second)
	if !ok {
		t.Fatalf("100ms tick did not schedule 2s follow-up tick: %#v", msgs)
	}

	// 2s later: emits RequestBackgroundColor and re-arms 2s tick.
	m, cmd = sendCmd(t, m, tk2s.fn(fixtureNow.Add(2100*time.Millisecond)))
	msgs = collectMsgs(cmd)
	if !hasRequestBG(msgs) {
		t.Fatal("2s tick did not emit tea.RequestBackgroundColor")
	}
	tk2sNext, ok := findTick(msgs, 2*time.Second)
	if !ok {
		t.Fatal("2s tick did not re-arm 2s tick")
	}

	// Switch back to gta6: no query now, and stale 2s tick produces nothing.
	sGTA6 := s
	sGTA6.Theme = "gta6"
	m, cmd = sendCmd(t, m, SnapshotMsg{Snapshot: sGTA6})
	msgs = collectMsgs(cmd)
	if hasRequestBG(msgs) || len(msgs) != 0 {
		t.Fatalf("switching back to gta6 returned unexpected cmds: %#v", msgs)
	}
	m, cmd = sendCmd(t, m, tk2sNext.fn(fixtureNow.Add(4100*time.Millisecond)))
	if got := collectMsgs(cmd); len(got) != 0 {
		t.Errorf("stale 2s tick after switching to gta6 returned %#v, want none", got)
	}

	// Custom theme without background also queries (100ms then 2s).
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "nobg.json"), []byte(`{"colors":{"main":"#ff0000"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	m2 := New(dir, fixtureNow)
	m2.clock = func() time.Time { return fixtureNow.Add(time.Second) }
	m2.tick = fakeTick
	m2.now = fixtureNow
	m2 = send(t, m2, tea.WindowSizeMsg{Width: 57, Height: 45})
	sNoBG := s
	sNoBG.Theme = "nobg"
	m2, cmd = sendCmd(t, m2, SnapshotMsg{Snapshot: sNoBG})
	msgs = collectMsgs(cmd)
	if hasRequestBG(msgs) {
		t.Fatal("switching gta6 -> custom no-bg theme must wait ~100ms")
	}
	tkCustom, ok := findTick(msgs, 100*time.Millisecond)
	if !ok {
		t.Fatalf("switching gta6 -> custom no-bg theme msgs = %#v, want 100ms tick", msgs)
	}
	m2, cmd = sendCmd(t, m2, tkCustom.fn(fixtureNow.Add(100*time.Millisecond)))
	msgs = collectMsgs(cmd)
	if !hasRequestBG(msgs) {
		t.Fatal("custom no-bg theme 100ms tick did not emit RequestBackgroundColor")
	}
	if _, ok := findTick(msgs, 2*time.Second); !ok {
		t.Fatal("custom no-bg theme did not schedule 2s tick")
	}
}

func TestAnimationWhileWaiting(t *testing.T) {
	mainOnly := func(wait string) protocol.Snapshot {
		s := fixtureS0()
		s.Main.Wait = wait
		return s
	}
	// agents has one running sub-agent for each wait.
	agents := func(mainStatus, mainWait string, waits ...string) protocol.Snapshot {
		s := makeRunningSnap(len(waits))
		s.Main.Status, s.Main.Wait = mainStatus, mainWait
		for i, wait := range waits {
			s.Agents[i].Wait = wait
		}
		return s
	}
	tests := []struct {
		name     string
		snap     protocol.Snapshot
		wantTick bool
	}{
		{"main idle, the only running sub-agent waits", agents("idle", "", "approval"), false},
		{"main waits, no sub-agents", mainOnly("answer"), false},
		{"main waits, the only running sub-agent waits", agents("working", "approval", "answer"), false},
		{"main waits, a sub-agent runs", agents("working", "answer", ""), true},
		{"main idle, one sub-agent waits and one runs", agents("idle", "", "approval", ""), true},
		{"main works, the only running sub-agent waits", agents("working", "", "approval"), true},
	}
	const animTick = 140 * time.Millisecond
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := New("", fixtureNow)
			m.clock = func() time.Time { return fixtureNow.Add(time.Second) }
			m.tick = fakeTick
			m.now = fixtureNow
			m = send(t, m, tea.WindowSizeMsg{Width: 57, Height: 45})

			// Something spins: the tick chain starts.
			m, cmd := sendCmd(t, m, SnapshotMsg{Snapshot: makeRunningSnap(1)})
			tk, ok := findTick(collectMsgs(cmd), animTick)
			if !ok {
				t.Fatal("a running sub-agent did not start the animation tick")
			}

			// The next snapshot is the case; the tick in flight decides.
			m = send(t, m, SnapshotMsg{Snapshot: tt.snap})
			m, cmd = sendCmd(t, m, tk.fn(fixtureNow.Add(animTick)))
			if _, got := findTick(collectMsgs(cmd), animTick); got != tt.wantTick {
				t.Errorf("next animation tick scheduled = %v, want %v", got, tt.wantTick)
			}
			if m.animating != tt.wantTick {
				t.Errorf("animating = %v, want %v", m.animating, tt.wantTick)
			}
			if wantFrame := map[bool]int{false: 0, true: 1}[tt.wantTick]; m.frame != wantFrame {
				t.Errorf("frame = %d, want %d", m.frame, wantFrame)
			}

			// A stopped chain stays stopped while nothing spins.
			_, cmd = sendCmd(t, m, SnapshotMsg{Snapshot: tt.snap})
			if _, got := findTick(collectMsgs(cmd), animTick); got {
				t.Errorf("the same snapshot scheduled an animation tick, want none: animating was %v", m.animating)
			}
		})
	}
}
