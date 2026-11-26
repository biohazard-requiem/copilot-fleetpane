package ui

import (
	"fmt"
	"math/bits"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/theme"
)

// styled is a piece of rendered output and the style it is printed in. fg and
// bg are the SGR parameters that select the colors, "" when none was sent.
type styled struct {
	text        string
	fg, bg      string
	bold, faint bool
}

// parseLine splits a rendered line into the runs Render wrote. Colors are
// asserted on the result, never on stripped text.
func parseLine(t *testing.T, line string) []styled {
	t.Helper()
	var runs []styled
	var cur styled
	for line != "" {
		if seq, ok := strings.CutPrefix(line, "\x1b["); ok {
			params, rest, ok := strings.Cut(seq, "m")
			if !ok {
				t.Fatalf("unterminated sequence in %q", line)
			}
			cur = applySGR(t, cur, params)
			line = rest
			continue
		}
		n := strings.IndexByte(line, '\x1b')
		switch n {
		case -1:
			n = len(line)
		case 0:
			t.Fatalf("unexpected escape sequence in %q", line)
		}
		run := cur
		run.text = line[:n]
		runs = append(runs, run)
		line = line[n:]
	}
	return runs
}

// applySGR returns style st after the SGR sequence with the given parameters.
func applySGR(t *testing.T, st styled, params string) styled {
	t.Helper()
	p := strings.Split(params, ";")
	for i := 0; i < len(p); i++ {
		switch code := p[i]; code {
		case "", "0":
			st = styled{}
		case "1":
			st.bold = true
		case "2":
			st.faint = true
		case "38", "48":
			n := 3 // 38;5;N
			if i+1 < len(p) && p[i+1] == "2" {
				n = 5 // 38;2;R;G;B
			}
			if i+n > len(p) {
				t.Fatalf("short color in SGR %q", params)
			}
			color := strings.Join(p[i:i+n], ";")
			i += n - 1
			if code == "38" {
				st.fg = color
			} else {
				st.bg = color
			}
		default:
			n, err := strconv.Atoi(code)
			switch {
			case err != nil:
				t.Fatalf("SGR %q: %v", params, err)
			case n >= 30 && n <= 37, n == 39, n >= 90 && n <= 97:
				st.fg = code
			case n >= 40 && n <= 47, n == 49, n >= 100 && n <= 107:
				st.bg = code
			default:
				t.Fatalf("unexpected parameter %s in SGR %q", code, params)
			}
		}
	}
	return st
}

// parseCells returns the rendered output of c as a grid with one entry per
// cell. The second cell of a wide character has the style of the first and
// no text.
func parseCells(t *testing.T, c *Canvas, out string) [][]styled {
	t.Helper()
	var grid [][]styled
	for line := range strings.SplitSeq(out, "\n") {
		var row []styled
		for _, run := range parseLine(t, line) {
			for text := run.text; text != ""; {
				g, w := ansi.FirstGraphemeCluster(text, ansi.GraphemeWidth)
				text = text[len(g):]
				cell := run
				cell.text = g
				row = append(row, cell)
				for range w - 1 {
					cell.text = ""
					row = append(row, cell)
				}
			}
		}
		if len(row) != c.W {
			t.Fatalf("line %d has %d cells, want %d", len(grid), len(row), c.W)
		}
		grid = append(grid, row)
	}
	if len(grid) != c.H {
		t.Fatalf("%d lines, want %d", len(grid), c.H)
	}
	return grid
}

func fgSeq(c theme.RGB) string { return fmt.Sprintf("38;2;%d;%d;%d", c.R, c.G, c.B) }
func bgSeq(c theme.RGB) string { return fmt.Sprintf("48;2;%d;%d;%d", c.R, c.G, c.B) }

func loadTheme(t *testing.T, name string) *theme.Theme {
	t.Helper()
	th, err := theme.Load(name, "")
	if err != nil {
		t.Fatalf("theme.Load(%q): %v", name, err)
	}
	return th
}

// rowColor returns the base background of a row.
func rowColor(t *testing.T, th *theme.Theme, c *Canvas, row int) theme.RGB {
	t.Helper()
	base, ok := th.Background(row, 0, c.W, c.H)
	rgb, isRGB := base.RGB()
	if !ok || !isRGB {
		t.Fatalf("theme has no background color for row %d", row)
	}
	return rgb
}

// drawSample draws a bit of everything: boxes, panel rows, text in several
// styles, and wide characters at the edges and cut in half.
func drawSample(c *Canvas) {
	c.Box(1, 1, c.W-2, 4, Style{FG: theme.RoleEdge.Color()}, false)
	c.Box(c.H/2, c.W/3, 12, 3, Style{FG: theme.RoleAgent.Color()}, true)
	c.MarkPanel(c.H-2, 0, c.W, 2)
	c.Put(0, c.W/2-4, "FLEETPANE", Style{FG: theme.RoleTitle.Color(), Bold: true})
	c.Put(2, 3, "explore-auth · 读取文件 🚀 grep", mainBold)
	c.Put(2, 19, "x", Style{FG: theme.RoleFail.Color()})
	c.Put(c.H/2+1, c.W/3+2, "■ ■ ◐", Style{FG: theme.RoleOK.Color()})
	c.Put(c.H-1, 1, "main [working]   sub-agents [2/4]", dimFaint)
	for row := range c.H {
		c.Put(row, c.W-2-row%2, "中", Style{FG: theme.RoleTool.Color()})
		c.Put(row, -1, "文a", Style{})
	}
}

func TestRenderSize(t *testing.T) {
	sizes := [][2]int{{1, 1}, {2, 1}, {1, 3}, {7, 3}, {24, 6}, {30, 8}, {57, 45}, {170, 15}, {0, 3}}
	for _, name := range []string{"auto", "gta6"} {
		th := loadTheme(t, name)
		for _, size := range sizes {
			w, h := size[0], size[1]
			c := NewCanvas(w, h)
			drawSample(c)

			lines := strings.Split(c.Render(th, true, theme.PalmMask(w, h)), "\n")
			if len(lines) != h {
				t.Errorf("%s %d×%d: %d lines, want %d", name, w, h, len(lines), h)
			}
			for row, line := range lines {
				if got := ansi.StringWidth(line); got != w {
					t.Errorf("%s %d×%d: line %d is %d cells wide: %q", name, w, h, row, got, ansi.Strip(line))
				}
			}
		}

		if got := NewCanvas(5, 0).Render(th, true, theme.Mask{}); got != "" {
			t.Errorf("%s: a canvas without rows renders as %q, want nothing", name, got)
		}
	}
}

func TestRenderText(t *testing.T) {
	c := NewCanvas(9, 3)
	c.Put(0, 0, "a中b", mainBold)
	c.Put(1, 0, "✓ ok", Style{FG: theme.RoleOK.Color()})
	c.Box(0, 5, 4, 3, Style{}, false)
	c.Put(1, 6, "🚀", dimFaint)

	want := "a中b ┌──┐\n✓ ok │🚀│\n     └──┘"
	for _, name := range []string{"auto", "gta6"} {
		if got := ansi.Strip(c.Render(loadTheme(t, name), true, theme.Mask{})); got != want {
			t.Errorf("%s: text is\n%s\nwant\n%s", name, got, want)
		}
	}
}

func TestRenderAutoHasNoBackground(t *testing.T) {
	th := loadTheme(t, "auto")
	c := NewCanvas(57, 45)
	drawSample(c)

	for _, dark := range []bool{true, false} {
		// The mask is there to be ignored: auto has no silhouette.
		out := c.Render(th, dark, theme.PalmMask(c.W, c.H))
		for row, cells := range parseCells(t, c, out) {
			for col, cell := range cells {
				if cell.bg != "" {
					t.Fatalf("dark=%v: cell %d,%d has the background %q", dark, row, col, cell.bg)
				}
				if got, want := cell.text, c.At(row, col).Text; got != want && (got != " " || want != "") {
					t.Fatalf("dark=%v: cell %d,%d shows %q, want %q", dark, row, col, got, want)
				}
			}
		}
	}
}

func TestRenderAutoStyles(t *testing.T) {
	th := loadTheme(t, "auto")
	c := NewCanvas(18, 1)
	c.Put(0, 1, "ab", Style{FG: theme.RoleMain.Color()})
	c.Put(0, 3, "cd", Style{FG: theme.RoleMain.Color()})
	c.Put(0, 5, "e", mainBold)
	c.Put(0, 6, "f", Style{FG: theme.RoleMain.Color(), Faint: true})
	c.Put(0, 7, "g", Style{FG: theme.RoleDim.Color()})
	c.Put(0, 8, "h", Style{FG: theme.RoleDim.Color(), Bold: true})
	c.Put(0, 10, "i j", Style{})
	c.Put(0, 13, "k", Style{FG: theme.RGB{R: 1, G: 2, B: 3}.Color()})
	c.MarkPanel(0, 14, 2, 1)

	tests := []struct {
		dark bool
		main string
	}{
		{true, "95"},
		{false, "35"},
	}
	for _, tt := range tests {
		want := []styled{
			{text: " "},
			{text: "abcd", fg: tt.main},
			{text: "e", fg: tt.main, bold: true},
			{text: "f", fg: tt.main, faint: true},
			{text: "g", faint: true},
			{text: "h", bold: true, faint: true},
			{text: " i j"},
			{text: "k", fg: "38;2;1;2;3"},
			{text: "    "},
		}
		got := parseLine(t, c.Render(th, tt.dark, theme.Mask{}))
		if !slices.Equal(got, want) {
			t.Errorf("dark=%v: runs are\n%+v\nwant\n%+v", tt.dark, got, want)
		}
	}
}

// gta6Sample is a 57×45 canvas with boxes and status rows, some of them over
// the palms, and the theme and mask to render it with.
func gta6Sample(t *testing.T) (*Canvas, *theme.Theme, theme.Mask) {
	t.Helper()
	c := NewCanvas(57, 45)
	c.Box(1, 2, 20, 4, Style{FG: theme.RoleEdge.Color()}, false)
	c.Box(22, 13, 31, 5, Style{FG: theme.RoleMain.Color()}, true)
	c.Put(23, 15, "main · 模型", mainBold)
	c.MarkPanel(0, 30, 3, 1)
	c.MarkPanel(43, 0, 57, 2)
	c.Put(43, 1, "main [working]", Style{})
	c.Put(20, 5, "delegate · 2 running", dimFaint)
	return c, loadTheme(t, "gta6"), theme.PalmMask(57, 45)
}

func TestRenderGTA6EveryCellHasABackground(t *testing.T) {
	c, th, mask := gta6Sample(t)
	for row, cells := range parseCells(t, c, c.Render(th, true, mask)) {
		for col, cell := range cells {
			if !strings.HasPrefix(cell.bg, "48;2;") {
				t.Fatalf("cell %d,%d has the background %q, want a true color", row, col, cell.bg)
			}
		}
	}
}

func TestRenderGTA6RowBackground(t *testing.T) {
	c, th, mask := gta6Sample(t)
	grid := parseCells(t, c, c.Render(th, true, mask))

	var prev string
	for row, cells := range grid {
		want := bgSeq(rowColor(t, th, c, row))
		plain := 0
		for col, cell := range cells {
			if c.At(row, col).Panel || mask.Bits(row, col) != 0 {
				continue
			}
			plain++
			if cell.bg != want {
				t.Fatalf("cell %d,%d outside panels and palms has the background %q, want the row's %q", row, col, cell.bg, want)
			}
		}
		// The last two rows are the status rows: panel cells all the way.
		if plain == 0 && row < 43 {
			t.Fatalf("row %d has no cell outside panels and palms", row)
		}
		if want == prev {
			t.Errorf("rows %d and %d have the same background %q", row-1, row, want)
		}
		prev = want
	}

	// The gradient of 45 rows starts at #2d1e5f, just below the first stop.
	if got, want := grid[0][56].bg, "48;2;45;30;95"; got != want {
		t.Errorf("top row background = %q, want %q", got, want)
	}
}

func TestRenderGTA6Panel(t *testing.T) {
	c, th, mask := gta6Sample(t)
	grid := parseCells(t, c, c.Render(th, true, mask))
	glass := th.Glass()

	panels, overPalms := 0, 0
	for row, cells := range grid {
		want := bgSeq(theme.Mix(rowColor(t, th, c, row), glass.Color, glass.Alpha))
		for col, cell := range cells {
			src := c.At(row, col)
			if !src.Panel {
				continue
			}
			panels++
			if mask.Bits(row, col) != 0 {
				overPalms++
			}
			if cell.bg != want {
				t.Fatalf("panel cell %d,%d has the background %q, want the glass mix %q", row, col, cell.bg, want)
			}
			if cell.text != src.Text && (cell.text != " " || src.Text != "") {
				t.Fatalf("panel cell %d,%d shows %q, want %q", row, col, cell.text, src.Text)
			}
		}
	}
	if want := 20*4 + 31*5 + 3 + 57*2; panels != want {
		t.Errorf("%d panel cells, want %d", panels, want)
	}
	if overPalms == 0 {
		t.Error("no panel cell lies over the palms; the sample does not cover that case")
	}

	// mix(#2d1e5f, #170a30, 0.60), worked out by hand.
	if got, want := grid[0][30].bg, "48;2;32;18;67"; got != want {
		t.Errorf("panel cell in the top row has the background %q, want %q", got, want)
	}
}

func TestRenderGTA6Silhouette(t *testing.T) {
	c, th, mask := gta6Sample(t)
	decor := th.Decor()
	textStyle := Style{FG: theme.RoleOK.Color(), Bold: true}

	// Put a letter on one fully covered cell and on one cell for each number
	// of covered sub-blocks.
	lettered := map[int]bool{}
	for row := range c.H {
		for col := range c.W {
			n := bits.OnesCount(uint(mask.Bits(row, col)))
			if n == 0 || lettered[n] || c.At(row, col).Panel {
				continue
			}
			lettered[n] = true
			c.Put(row, col, "x", textStyle)
		}
	}
	if len(lettered) != 4 {
		t.Fatalf("lettered cells with %v covered sub-blocks, want 1 to 4", lettered)
	}

	grid := parseCells(t, c, c.Render(th, true, mask))
	seen := map[string]int{}
	for row, cells := range grid {
		base := rowColor(t, th, c, row)
		dark := theme.Mix(base, decor.Color, decor.Alpha)
		for col, cell := range cells {
			src := c.At(row, col)
			covered := mask.Bits(row, col)
			if src.Panel || covered == 0 {
				continue
			}
			at := fmt.Sprintf("cell %d,%d with sub-blocks %04b", row, col, covered)
			var want styled
			switch {
			case covered == 15 && src.Text == "":
				seen["full"]++
				want = styled{text: " ", fg: cell.fg, bg: bgSeq(dark)}
			case covered == 15:
				seen["full with text"]++
				want = styled{text: "x", fg: fgSeq(theme.RGB{R: 0x8d, G: 0xff, B: 0xbe}), bg: bgSeq(dark), bold: true}
			case src.Text == "":
				seen["partial"]++
				want = styled{text: theme.QuadrantChar(covered), fg: fgSeq(dark), bg: bgSeq(base)}
			default:
				seen["partial with text"]++
				k := float64(bits.OnesCount(uint(covered))) / 4
				want = styled{text: "x", fg: fgSeq(theme.RGB{R: 0x8d, G: 0xff, B: 0xbe}), bg: bgSeq(theme.Mix(base, dark, k)), bold: true}
			}
			if cell != want {
				t.Fatalf("%s is %+v, want %+v", at, cell, want)
			}
		}
	}
	if seen["full"] == 0 || seen["full with text"] != 1 || seen["partial"] == 0 || seen["partial with text"] != 3 {
		t.Errorf("cells checked: %v; the sample does not cover every case", seen)
	}

	// mix(#2d1e5f, #190b38, 0.30), worked out by hand. Cell 0,1 is fully covered.
	if got, want := grid[0][1].bg, "48;2;39;24;83"; got != want {
		t.Errorf("fully covered cell in the top row has the background %q, want %q", got, want)
	}
}

func TestRenderGTA6Foreground(t *testing.T) {
	// Render must write true colors whatever the environment says about the
	// terminal: Bubble Tea adapts them to the real one.
	t.Setenv("NO_COLOR", "1")
	t.Setenv("TERM", "dumb")

	th := loadTheme(t, "gta6")
	title := th.Title(1, 3, true)
	titleRGB, ok := title.RGB()
	if !ok {
		t.Fatalf("gta6 title color %v is not a true color", title)
	}
	c := NewCanvas(12, 2)
	c.Put(0, 0, "a", Style{FG: theme.RoleMain.Color()})
	c.Put(0, 1, "b", Style{FG: theme.RoleMain.Color()})
	c.Put(0, 2, "c", mainBold)
	c.Put(0, 3, "d", dimFaint)
	c.Put(0, 4, "e", Style{FG: title})
	c.Put(0, 5, "中", Style{FG: theme.RoleFail.Color()})
	c.MarkPanel(0, 6, 1, 1) // the second cell of 中

	base := bgSeq(rowColor(t, th, c, 0))
	want := []styled{
		{text: "ab", fg: "38;2;255;196;107", bg: base},
		{text: "c", fg: "38;2;255;196;107", bg: base, bold: true},
		{text: "d", fg: "38;2;227;205;243", bg: base, faint: true},
		{text: "e", fg: fgSeq(titleRGB), bg: base},
		// A wide character is printed in one piece, on the background of its first cell.
		{text: "中", fg: "38;2;255;111;134", bg: base},
		{text: "     ", fg: "38;2;255;255;255", bg: base},
	}
	lines := strings.Split(c.Render(th, true, theme.Mask{}), "\n")
	if len(lines) != 2 {
		t.Fatalf("%d lines, want 2", len(lines))
	}
	if got := parseLine(t, lines[0]); !slices.Equal(got, want) {
		t.Errorf("runs are\n%+v\nwant\n%+v", got, want)
	}
	// A blank row is a single run.
	if got := parseLine(t, lines[1]); len(got) != 1 || got[0].text != strings.Repeat(" ", 12) {
		t.Errorf("blank row is rendered as %+v, want one run of 12 spaces", got)
	}
}

func TestRenderIgnoresMaskWithoutDecor(t *testing.T) {
	dir := t.TempDir()
	file := `{"colors": {"fg": "#ffffff"}, "background": {"stops": ["#102030", "#405060"]}}`
	if err := os.WriteFile(filepath.Join(dir, "plain.json"), []byte(file), 0o600); err != nil {
		t.Fatal(err)
	}
	th, err := theme.Load("plain", dir)
	if err != nil {
		t.Fatal(err)
	}

	c := NewCanvas(57, 45)
	for row, cells := range parseCells(t, c, c.Render(th, true, theme.PalmMask(c.W, c.H))) {
		want := styled{text: " ", fg: "38;2;255;255;255", bg: bgSeq(rowColor(t, th, c, row))}
		for col, cell := range cells {
			if cell != want {
				t.Fatalf("cell %d,%d is %+v, want %+v", row, col, cell, want)
			}
		}
	}
}
