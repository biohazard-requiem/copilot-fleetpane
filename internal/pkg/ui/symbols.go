package ui

// This file is the one place that declares the symbols of the interface. The
// layout gives each of them exactly one cell, so every string literal in this
// file must be one cell wide: TestSymbolWidths checks them all. The quadrant
// characters of the silhouette are theme.QuadrantChar.

// Spinner holds the frames of the icon of whatever is running.
var Spinner = [...]string{"◐", "◓", "◑", "◒"}

// The other status icons.
const (
	IconWaiting   = "!" // waiting for the user
	IconOK        = "✓"
	IconFail      = "✗"
	IconCancelled = "⊘"
	IconIdle      = "○"
	IconUnknown   = "?"
)

// Marks and separators.
const (
	MarkTool      = "■" // a finished tool call in a tool trail
	MarkSelected  = "▸" // starts the selected list row
	MarkParent    = "◆" // starts the list row of the selected item's parent
	MarkChild     = "↳" // precedes a spawned sub-agent, or the name of its parent
	MarkSpawnedBy = "‹" // between a spawned sub-agent's name and its parent's
	Dot           = "•" // the moving dot on an active connector
	Ellipsis      = "…" // ends truncated text
	Separator     = "·" // between the parts of a line
)

// Arrowheads of connectors and scroll marks.
const (
	ArrowUp    = "▲"
	ArrowDown  = "▼"
	ArrowLeft  = "◀"
	ArrowRight = "▶"
)

// The arrow keys as the key hints write them.
const (
	HintLeft  = "←"
	HintUp    = "↑"
	HintDown  = "↓"
	HintRight = "→"
)

// Border is a set of box-drawing characters for a frame.
type Border struct {
	Horizontal, Vertical                       string
	TopLeft, TopRight, BottomLeft, BottomRight string
}

// The borders Canvas.Box draws. Connectors use the lines of LightBorder.
var (
	LightBorder = Border{"─", "│", "┌", "┐", "└", "┘"}
	HeavyBorder = Border{"━", "┃", "┏", "┓", "┗", "┛"} // the selected item
)

// Light junctions, for connectors and for where one meets a light border.
// Each is named after the direction of its stem.
const (
	TeeDown  = "┬"
	TeeUp    = "┴"
	TeeRight = "├"
	TeeLeft  = "┤"
	Cross    = "┼"
)
