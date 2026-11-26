package ui

import (
	"testing"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/theme"
)

var (
	mainBold = Style{FG: theme.RoleMain.Color(), Bold: true}
	dimFaint = Style{FG: theme.RoleDim.Color(), Faint: true}
)

// rowText returns the text of a canvas row, with "·" for a blank cell and
// "<" for the second cell of a wide character.
func rowText(c *Canvas, row int) string {
	var s string
	for col := range c.W {
		switch cell := c.At(row, col); {
		case cell.Cont:
			s += "<"
		case cell.Text == "":
			s += "·"
		default:
			s += cell.Text
		}
	}
	return s
}

func TestNewCanvas(t *testing.T) {
	c := NewCanvas(4, 2)
	if c.W != 4 || c.H != 2 {
		t.Fatalf("size = %d×%d, want 4×2", c.W, c.H)
	}
	for row := range 2 {
		for col := range 4 {
			if got := c.At(row, col); got != (Cell{}) {
				t.Errorf("At(%d, %d) = %+v, want a blank cell", row, col, got)
			}
		}
	}

	if c := NewCanvas(-1, -5); c.W != 0 || c.H != 0 {
		t.Errorf("NewCanvas(-1, -5) is %d×%d, want 0×0", c.W, c.H)
	}
}

func TestAtOutOfRange(t *testing.T) {
	c := NewCanvas(2, 1)
	c.Put(0, 0, "ab", mainBold)
	for _, p := range [][2]int{{-1, 0}, {1, 0}, {0, -1}, {0, 2}} {
		if got := c.At(p[0], p[1]); got != (Cell{}) {
			t.Errorf("At(%d, %d) = %+v, want a blank cell", p[0], p[1], got)
		}
	}
}

func TestPut(t *testing.T) {
	c := NewCanvas(5, 2)
	if n := c.Put(1, 1, "ab", mainBold); n != 2 {
		t.Errorf("Put returned %d, want 2", n)
	}
	if n := c.Put(1, 3, "c", dimFaint); n != 1 {
		t.Errorf("Put returned %d, want 1", n)
	}

	if got, want := rowText(c, 0)+"|"+rowText(c, 1), "·····|·abc·"; got != want {
		t.Errorf("canvas = %s, want %s", got, want)
	}
	if got, want := c.At(1, 1), (Cell{Text: "a", FG: theme.RoleMain.Color(), Bold: true}); got != want {
		t.Errorf("At(1, 1) = %+v, want %+v", got, want)
	}
	if got, want := c.At(1, 3), (Cell{Text: "c", FG: theme.RoleDim.Color(), Faint: true}); got != want {
		t.Errorf("At(1, 3) = %+v, want %+v", got, want)
	}
}

func TestPutWideCharacters(t *testing.T) {
	c := NewCanvas(8, 1)
	if n := c.Put(0, 0, "中🚀a", mainBold); n != 5 {
		t.Errorf("Put returned %d, want 5", n)
	}

	if got, want := rowText(c, 0), "中<🚀<a···"; got != want {
		t.Errorf("row = %s, want %s", got, want)
	}
	lead := Cell{Text: "中", FG: theme.RoleMain.Color(), Bold: true}
	cont := Cell{FG: theme.RoleMain.Color(), Bold: true, Cont: true}
	if got := c.At(0, 0); got != lead {
		t.Errorf("first cell of 中 = %+v, want %+v", got, lead)
	}
	if got := c.At(0, 1); got != cont {
		t.Errorf("second cell of 中 = %+v, want %+v", got, cont)
	}

	// A cluster of several code points is one grapheme of two cells.
	c = NewCanvas(4, 1)
	if n := c.Put(0, 0, "👨\u200d👩\u200d👧é", Style{}); n != 3 {
		t.Errorf("Put returned %d, want 3", n)
	}
	if got, want := rowText(c, 0), "👨\u200d👩\u200d👧<é·"; got != want {
		t.Errorf("row = %s, want %s", got, want)
	}
}

func TestPutWideCharacterInTheLastCell(t *testing.T) {
	tests := []struct {
		name     string
		col      int
		text     string
		wantUsed int
		wantRow  string
	}{
		{"exactly two cells left", 2, "中", 2, "··中<"},
		{"one cell left", 3, "中", 0, "····"},
		{"one cell left after other text", 1, "ab中", 2, "·ab·"},
		{"what follows it is beyond the edge", 2, "a中b", 1, "··a·"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := NewCanvas(4, 1)
			if n := c.Put(0, tt.col, tt.text, Style{}); n != tt.wantUsed {
				t.Errorf("Put returned %d, want %d", n, tt.wantUsed)
			}
			if got := rowText(c, 0); got != tt.wantRow {
				t.Errorf("row = %s, want %s", got, tt.wantRow)
			}
		})
	}
}

func TestPutOutOfRange(t *testing.T) {
	tests := []struct {
		name     string
		row, col int
		text     string
		wantUsed int
		wantRow  string // row 0
	}{
		{"past the right edge", 0, 2, "abcdef", 2, "··ab"},
		{"before the left edge", 0, -2, "abcd", 2, "cd··"},
		{"wide character across the left edge", 0, -1, "中a", 1, "·a··"},
		{"column past the canvas", 0, 4, "ab", 0, "····"},
		{"row above", -1, 0, "ab", 0, "····"},
		{"row below", 2, 0, "ab", 0, "····"},
		{"empty text", 0, 1, "", 0, "····"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := NewCanvas(4, 2)
			if n := c.Put(tt.row, tt.col, tt.text, Style{}); n != tt.wantUsed {
				t.Errorf("Put returned %d, want %d", n, tt.wantUsed)
			}
			if got := rowText(c, 0); got != tt.wantRow {
				t.Errorf("row 0 = %s, want %s", got, tt.wantRow)
			}
			if got := rowText(c, 1); got != "····" {
				t.Errorf("row 1 = %s, want it untouched", got)
			}
		})
	}
}

// Text is cleaned before it is drawn, but a stray control character must
// still not end up in a cell: it would break the width of the line.
func TestPutDropsZeroWidthCharacters(t *testing.T) {
	c := NewCanvas(5, 1)
	if n := c.Put(0, 0, "a\tb\x1b\nc\u200b", Style{}); n != 3 {
		t.Errorf("Put returned %d, want 3", n)
	}
	if got, want := rowText(c, 0), "abc··"; got != want {
		t.Errorf("row = %s, want %s", got, want)
	}
}

func TestPutOverHalfAWideCharacter(t *testing.T) {
	tests := []struct {
		name    string
		col     int
		text    string
		wantRow string
	}{
		{"over the second cell", 1, "x", "·x文<·"},
		{"over the first cell", 0, "x", "x·文<·"},
		{"over the halves of two characters", 1, "xy", "·xy··"},
		{"wide over the halves of two characters", 1, "字", "·字<··"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := NewCanvas(5, 1)
			c.Put(0, 0, "中文", Style{})
			c.Put(0, tt.col, tt.text, Style{})
			if got := rowText(c, 0); got != tt.wantRow {
				t.Errorf("row = %s, want %s", got, tt.wantRow)
			}
		})
	}
}

func TestMarkPanel(t *testing.T) {
	c := NewCanvas(4, 3)
	c.Put(1, 1, "a", mainBold)
	c.MarkPanel(1, 1, 2, 5)   // runs past the bottom
	c.MarkPanel(-1, -1, 2, 2) // only its last cell is on the canvas

	for row := range 3 {
		for col := range 4 {
			want := row >= 1 && (col == 1 || col == 2) || row == 0 && col == 0
			if got := c.At(row, col).Panel; got != want {
				t.Errorf("At(%d, %d).Panel = %v, want %v", row, col, got, want)
			}
		}
	}
	if got, want := c.At(1, 1), (Cell{Text: "a", FG: theme.RoleMain.Color(), Bold: true, Panel: true}); got != want {
		t.Errorf("At(1, 1) = %+v, want %+v", got, want)
	}

	// Put keeps the mark.
	c.Put(2, 1, "中", Style{})
	if !c.At(2, 1).Panel || !c.At(2, 2).Panel {
		t.Error("Put cleared the panel mark")
	}
}

func TestBox(t *testing.T) {
	tests := []struct {
		name  string
		heavy bool
		want  []string
	}{
		{"light", false, []string{"·······", "·┌───┐·", "·│·x·│·", "·│···│·", "·└───┘·", "·······"}},
		{"heavy", true, []string{"·······", "·┏━━━┓·", "·┃·x·┃·", "·┃···┃·", "·┗━━━┛·", "·······"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := NewCanvas(7, 6)
			c.Put(2, 3, "x", Style{})
			c.Box(1, 1, 5, 4, mainBold, tt.heavy)

			for row, want := range tt.want {
				if got := rowText(c, row); got != want {
					t.Errorf("row %d = %s, want %s", row, got, want)
				}
			}
			for row := range c.H {
				for col := range c.W {
					cell := c.At(row, col)
					inside := row >= 1 && row <= 4 && col >= 1 && col <= 5
					if cell.Panel != inside {
						t.Errorf("At(%d, %d).Panel = %v, want %v", row, col, cell.Panel, inside)
					}
					border := inside && (row == 1 || row == 4 || col == 1 || col == 5)
					if border && (cell.FG != theme.RoleMain.Color() || !cell.Bold) {
						t.Errorf("border cell At(%d, %d) = %+v, want the style of the box", row, col, cell)
					}
				}
			}
			if got, want := c.At(2, 3), (Cell{Text: "x", Panel: true}); got != want {
				t.Errorf("content inside the box = %+v, want %+v", got, want)
			}
		})
	}
}

func TestBoxClippedAndDegenerate(t *testing.T) {
	c := NewCanvas(4, 3)
	c.Box(1, 2, 4, 4, Style{}, false)
	for row, want := range []string{"····", "··┌─", "··│·"} {
		if got := rowText(c, row); got != want {
			t.Errorf("clipped box, row %d = %s, want %s", row, got, want)
		}
	}

	// The smallest box is all border.
	c = NewCanvas(4, 3)
	c.Box(0, 0, 2, 2, Style{}, false)
	for row, want := range []string{"┌┐··", "└┘··", "····"} {
		if got := rowText(c, row); got != want {
			t.Errorf("2×2 box, row %d = %s, want %s", row, got, want)
		}
	}

	// Anything smaller has no room for a border and is not drawn.
	c = NewCanvas(4, 3)
	c.Box(0, 0, 1, 3, Style{}, false)
	c.Box(0, 0, 4, 1, Style{}, false)
	c.Box(0, 0, 0, 0, Style{}, false)
	for row := range c.H {
		for col := range c.W {
			if got := c.At(row, col); got != (Cell{}) {
				t.Errorf("At(%d, %d) = %+v after boxes without room, want a blank cell", row, col, got)
			}
		}
	}
}
