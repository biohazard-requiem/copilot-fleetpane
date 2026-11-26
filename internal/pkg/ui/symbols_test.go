package ui

import (
	"go/ast"
	"go/parser"
	"go/token"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"

	"github.com/biohazard-requiem/copilot-fleetpane/internal/pkg/theme"
)

// declaredSymbols returns every string literal of symbols.go, the one place
// where the symbols of the interface are declared.
func declaredSymbols(t *testing.T) []string {
	t.Helper()
	f, err := parser.ParseFile(token.NewFileSet(), "symbols.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var symbols []string
	ast.Inspect(f, func(n ast.Node) bool {
		if lit, ok := n.(*ast.BasicLit); ok && lit.Kind == token.STRING {
			s, err := strconv.Unquote(lit.Value)
			if err != nil {
				t.Fatalf("symbols.go: %s: %v", lit.Value, err)
			}
			symbols = append(symbols, s)
		}
		return true
	})
	return symbols
}

// The layout gives every symbol exactly one cell. A width library or an
// environment that disagrees would shift everything to the right of it.
func TestSymbolWidths(t *testing.T) {
	symbols := declaredSymbols(t)
	for bits := range 16 {
		symbols = append(symbols, theme.QuadrantChar(bits))
	}
	for _, s := range symbols {
		if w := ansi.StringWidth(s); w != 1 {
			t.Errorf("ansi.StringWidth(%q) = %d, want 1", s, w)
		}
	}
}

func TestSymbolsOfThePlanAreDeclared(t *testing.T) {
	declared := declaredSymbols(t)
	want := strings.Fields(`
		◐ ◓ ◑ ◒
		■ ✓ ✗ ⊘ ○ ! ? ▸ ◆ ↳ ‹ • … ·
		▲ ▼ ◀ ▶
		← ↑ ↓ →
		─ │ ┌ ┐ └ ┘ ┬ ┴ ├ ┤ ┼
		━ ┃ ┏ ┓ ┗ ┛`)
	for _, s := range want {
		if !slices.Contains(declared, s) {
			t.Errorf("symbols.go does not declare %q", s)
		}
	}
}
