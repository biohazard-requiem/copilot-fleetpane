package ui

import (
	"image/color"
	"math/bits"
	"strings"

	"charm.land/lipgloss/v2"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/theme"
)

// look is how a cell finally appears. bg is nil when no background is painted.
type look struct {
	fg, bg      color.Color
	bold, faint bool
}

// render styles s, a piece of one line. A lipgloss.Style writes colors in
// full whatever the terminal is, and nothing at all for lipgloss.NoColor.
func (l look) render(s string) string {
	st := lipgloss.NewStyle().Foreground(l.fg).Bold(l.bold).Faint(l.faint)
	if l.bg != nil {
		st = st.Background(l.bg)
	}
	return st.Render(s)
}

// Render encodes the canvas as styled text: H lines of exactly W cells each,
// joined by "\n". Neighboring cells that look the same are written as one
// run. Colors are written in full; Bubble Tea reduces them to what the
// terminal can show.
//
// dark tells whether the terminal's background is dark, which decides the
// colors of the roles a theme leaves to the terminal. mask is the silhouette
// for the size of the canvas, theme.PalmMask(c.W, c.H), which the caller
// keeps until the pane is resized; a theme without a silhouette ignores it.
//
// A theme without a background gets no background color at all. With one,
// every cell gets a background. Starting from the
// color of its row in the gradient:
//
//   - a panel cell is tinted with the theme's glass;
//   - any other cell is darkened by the silhouette in proportion to how many
//     of its four sub-blocks the mask covers, fully covered being
//     Mix(row color, decor color, decor alpha);
//   - a blank cell that is covered only in part instead shows the covered
//     sub-blocks as a quadrant character in that fully darkened color, on
//     the color of the row.
//
// A wide character is printed in one piece, on the background of its first
// cell.
func (c *Canvas) Render(th *theme.Theme, dark bool, mask theme.Mask) string {
	glass, decor := th.Glass(), th.Decor()
	var (
		out, run strings.Builder
		cur      look
	)
	flush := func() {
		if run.Len() > 0 {
			out.WriteString(cur.render(run.String()))
			run.Reset()
		}
	}
	for row := range c.H {
		if row > 0 {
			out.WriteByte('\n')
		}
		base, painted := th.Background(row, 0, c.W, c.H)
		rowBG, _ := base.RGB()
		tinted := theme.Mix(rowBG, glass.Color, glass.Alpha)
		shade := theme.Mix(rowBG, decor.Color, decor.Alpha)
		for col := range c.W {
			cell := c.cells[row*c.W+col]
			if cell.Cont {
				continue
			}
			text := cell.Text
			if text == "" {
				text = " "
			}
			fg, faint := th.ResolveColor(cell.FG, dark)
			l := look{fg: fg, bold: cell.Bold, faint: cell.Faint || faint}
			if painted {
				covered := 0
				if decor.Kind != theme.DecorNone {
					covered = mask.Bits(row, col)
				}
				switch {
				case cell.Panel:
					l.bg = tinted
				case text == " " && covered != 0 && covered != 15:
					text = theme.QuadrantChar(covered)
					l = look{fg: shade, bg: rowBG}
				default:
					l.bg = theme.Mix(rowBG, shade, float64(bits.OnesCount(uint(covered)))/4)
				}
			}
			if l != cur {
				flush()
				cur = l
			}
			run.WriteString(text)
		}
		flush()
	}
	return out.String()
}
