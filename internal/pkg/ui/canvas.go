package ui

import (
	"github.com/charmbracelet/x/ansi"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/theme"
)

// Cell is one character cell of a Canvas. The zero Cell is blank.
type Cell struct {
	Text  string      // one grapheme; empty in a blank cell and in the second cell of a wide character
	FG    theme.Color // the color of a role, or a concrete color
	Bold  bool
	Faint bool
	Panel bool // inside a box or on a status row: the background is tinted with the theme's glass
	Cont  bool // the second cell of a wide character
}

// Style is how Put and Box draw their text. The zero Style is plain body text.
type Style struct {
	FG    theme.Color
	Bold  bool
	Faint bool
}

// Canvas is a grid of W × H character cells. The interface is drawn onto a
// canvas and encoded as styled text in one go by Render, because a theme with
// a background has to work out a color for every single cell.
type Canvas struct {
	W, H  int
	cells []Cell // row by row
}

// NewCanvas returns a blank canvas of w × h cells.
func NewCanvas(w, h int) *Canvas {
	w, h = max(w, 0), max(h, 0)
	return &Canvas{W: w, H: h, cells: make([]Cell, w*h)}
}

// At returns the cell at row, col. Off the canvas it is a blank cell.
func (c *Canvas) At(row, col int) Cell {
	if row < 0 || row >= c.H || col < 0 || col >= c.W {
		return Cell{}
	}
	return c.cells[row*c.W+col]
}

// Put draws text into row, starting at col, and returns the number of cells
// it filled. The text is placed grapheme by grapheme. A wide character
// (Chinese, emoji) takes two cells and is left out when only one is free
// before the right edge; characters without a width, such as control
// characters, are skipped. Whatever falls off the canvas is dropped. Drawing
// over one half of a wide character blanks its other half. Put leaves the
// Panel marks as they are.
func (c *Canvas) Put(row, col int, text string, st Style) int {
	if row < 0 || row >= c.H {
		return 0
	}
	used := 0
	for text != "" && col < c.W {
		g, w := ansi.FirstGraphemeCluster(text, ansi.GraphemeWidth)
		text = text[len(g):]
		if w > 0 && col >= 0 && col+w <= c.W {
			c.set(row*c.W+col, g, w, st)
			used += w
		}
		col += w
	}
	return used
}

// set stores a grapheme of w cells from index i on, all within one row. A
// wide character it covers only in part is blanked, so that a row never
// renders wider than the canvas.
func (c *Canvas) set(i int, g string, w int, st Style) {
	if c.cells[i].Cont {
		j := i - 1
		for ; c.cells[j].Cont; j-- {
			c.cells[j].Cont = false
		}
		c.cells[j].Text = ""
	}
	for j := i + w; j < len(c.cells) && c.cells[j].Cont; j++ {
		c.cells[j].Cont = false
	}
	for j := i; j < i+w; j++ {
		c.cells[j] = Cell{FG: st.FG, Bold: st.Bold, Faint: st.Faint, Panel: c.cells[j].Panel, Cont: j > i}
	}
	c.cells[i].Text = g
}

// MarkPanel marks the cells of the rectangle of w × h cells at row, col as
// panel cells: boxes do it themselves, the status and key hint rows need it
// too. The part off the canvas is ignored.
func (c *Canvas) MarkPanel(row, col, w, h int) {
	for r := max(row, 0); r < min(row+h, c.H); r++ {
		for i := max(col, 0); i < min(col+w, c.W); i++ {
			c.cells[r*c.W+i].Panel = true
		}
	}
}

// Box draws the border of a box of w × h cells whose top left corner is at
// row, col, with heavy lines for the selected item, and marks the border and
// the interior as panel cells. What is already drawn in the interior stays.
// A box needs two cells each way; a smaller one is not drawn.
func (c *Canvas) Box(row, col, w, h int, st Style, heavy bool) {
	if w < 2 || h < 2 {
		return
	}
	b := LightBorder
	if heavy {
		b = HeavyBorder
	}
	c.MarkPanel(row, col, w, h)
	bottom, right := row+h-1, col+w-1
	for i := col + 1; i < right; i++ {
		c.Put(row, i, b.Horizontal, st)
		c.Put(bottom, i, b.Horizontal, st)
	}
	for r := row + 1; r < bottom; r++ {
		c.Put(r, col, b.Vertical, st)
		c.Put(r, right, b.Vertical, st)
	}
	c.Put(row, col, b.TopLeft, st)
	c.Put(row, right, b.TopRight, st)
	c.Put(bottom, col, b.BottomLeft, st)
	c.Put(bottom, right, b.BottomRight, st)
}
