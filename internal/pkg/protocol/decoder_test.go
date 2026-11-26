package protocol

import (
	"errors"
	"fmt"
	"io"
	"reflect"
	"slices"
	"strings"
	"testing"
	"testing/iotest"
)

const mib = 1 << 20

// decodeAll returns every snapshot in input and fails on any error other
// than io.EOF.
func decodeAll(t *testing.T, input string) []Snapshot {
	t.Helper()
	d := NewDecoder(strings.NewReader(input))
	var out []Snapshot
	for {
		s, err := d.Next()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatalf("Next() error = %v, want a snapshot or io.EOF", err)
		}
		out = append(out, s)
	}
}

func seqs(snaps []Snapshot) []int64 {
	out := make([]int64, 0, len(snaps))
	for _, s := range snaps {
		out = append(out, s.Seq)
	}
	return out
}

// paddedLine returns a valid snapshot line, without its newline, that is
// exactly size bytes long.
func paddedLine(seq, size int) string {
	head := fmt.Sprintf(`{"seq":%d,"session":"`, seq)
	const tail = `"}`
	return head + strings.Repeat("x", size-len(head)-len(tail)) + tail
}

func TestDecoderFullSnapshot(t *testing.T) {
	const line = `{"v":1,"seq":42,"session":"61bd9722-e0a3-4582-b704-313f19c3dc40","theme":"gta6","turn":3,` +
		`"stats":{"turnTools":11},"truncated":true,` +
		`"main":{"status":"working","since":"2026-11-23T03:40:00.000Z","intent":"Auditing the extension",` +
		`"error":"rate limited","model":"claude-fable-5.2","wait":"approval",` +
		`"tools":[{"id":"toolu_01","name":"task","summary":"explore-auth","status":"running",` +
		`"startedAt":"2026-11-23T03:40:02.000Z","endedAt":"","error":""}]},` +
		`"agents":[{"id":"a3","call":"toolu_01","spawnTurn":2,"reportedTurn":3,"name":"explore-auth",` +
		`"type":"explore","desc":"Trace how joinSession wires hooks","mode":"background",` +
		`"model":"gemini-4-neon","wait":"answer","status":"failed",` +
		`"startedAt":"2026-11-23T03:40:02.100Z","endedAt":"2026-11-23T03:40:14.445Z","durationMs":12345,` +
		`"error":"boom","depth":1,"parent":"a1","toolCount":7,` +
		`"tools":[{"id":"toolu_02","name":"grep","summary":"\"joinSession\" extension/","status":"failed",` +
		`"startedAt":"2026-11-23T03:40:30.000Z","endedAt":"2026-11-23T03:40:31.000Z","error":"exit 2"}]}],` +
		`"log":[{"seq":116,"t":"2026-11-23T03:40:17.000Z","actor":"a5","name":"docs-outline","kind":"agent",` +
		`"tool":"","summary":"0:12 · 3 tools","status":"done","id":""},` +
		`{"seq":5000000117,"t":"2026-11-23T03:40:30.000Z","actor":"a3","name":"explore-auth","kind":"tool",` +
		`"tool":"grep","summary":"\"joinSession\" extension/","status":"waiting","id":"toolu_02"}]}`

	want := Snapshot{
		Seq:       42,
		Session:   "61bd9722-e0a3-4582-b704-313f19c3dc40",
		Theme:     "gta6",
		Turn:      3,
		Stats:     Stats{TurnTools: 11},
		Truncated: true,
		Main: Main{
			Status: "working",
			Since:  "2026-11-23T03:40:00.000Z",
			Intent: "Auditing the extension",
			Error:  "rate limited",
			Model:  "claude-fable-5.2",
			Wait:   "approval",
			Tools: []Tool{{
				ID: "toolu_01", Name: "task", Summary: "explore-auth", Status: "running",
				StartedAt: "2026-11-23T03:40:02.000Z",
			}},
		},
		Agents: []Agent{{
			ID: "a3", Call: "toolu_01", SpawnTurn: 2, ReportedTurn: 3, Name: "explore-auth",
			Type: "explore", Desc: "Trace how joinSession wires hooks", Mode: "background",
			Model: "gemini-4-neon", Wait: "answer", Status: "failed",
			StartedAt: "2026-11-23T03:40:02.100Z", EndedAt: "2026-11-23T03:40:14.445Z", DurationMs: 12345,
			Error: "boom", Depth: 1, Parent: "a1", ToolCount: 7,
			Tools: []Tool{{
				ID: "toolu_02", Name: "grep", Summary: `"joinSession" extension/`, Status: "failed",
				StartedAt: "2026-11-23T03:40:30.000Z", EndedAt: "2026-11-23T03:40:31.000Z", Error: "exit 2",
			}},
		}},
		Log: []LogEntry{
			{
				Seq: 116, T: "2026-11-23T03:40:17.000Z", Actor: "a5", Name: "docs-outline", Kind: "agent",
				Summary: "0:12 · 3 tools", Status: "done",
			},
			{
				Seq: 5000000117, T: "2026-11-23T03:40:30.000Z", Actor: "a3", Name: "explore-auth", Kind: "tool",
				Tool: "grep", Summary: `"joinSession" extension/`, Status: "waiting", ID: "toolu_02",
			},
		},
	}

	got := decodeAll(t, line+"\n")
	if len(got) != 1 {
		t.Fatalf("decoded %d snapshots, want 1", len(got))
	}
	if !reflect.DeepEqual(got[0], want) {
		t.Errorf("snapshot mismatch\n got: %+v\nwant: %+v", got[0], want)
	}
}

func TestDecoderIgnoresVersion(t *testing.T) {
	tests := []struct {
		name string
		line string
	}{
		{"v is 2", `{"v":2,"seq":7}`},
		{"v is a string", `{"v":"2","seq":7}`},
		{"v is missing", `{"seq":7}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := seqs(decodeAll(t, tt.line+"\n")); !slices.Equal(got, []int64{7}) {
				t.Errorf("decoded seqs = %v, want [7]", got)
			}
		})
	}
}

func TestDecoderMissingAndUnknownFields(t *testing.T) {
	tests := []struct {
		name string
		line string
		want Snapshot
	}{
		{
			name: "every field missing",
			line: `{}`,
			want: Snapshot{},
		},
		{
			name: "fields missing at every level",
			line: `{"seq":5,"main":{"status":"idle","tools":[{"id":"t1"}]},"agents":[{"id":"a1"}],"log":[{"seq":1}]}`,
			want: Snapshot{
				Seq:    5,
				Main:   Main{Status: "idle", Tools: []Tool{{ID: "t1"}}},
				Agents: []Agent{{ID: "a1"}},
				Log:    []LogEntry{{Seq: 1}},
			},
		},
		{
			name: "unknown fields at every level",
			line: `{"seq":5,"future":{"x":[1,2]},"stats":{"turnTools":2,"tokens":9},` +
				`"main":{"status":"idle","extra":true,"tools":[{"id":"t1","pid":4}]},` +
				`"agents":[{"id":"a1","color":"red"}],"log":[{"seq":1,"extra":null}]}`,
			want: Snapshot{
				Seq:    5,
				Stats:  Stats{TurnTools: 2},
				Main:   Main{Status: "idle", Tools: []Tool{{ID: "t1"}}},
				Agents: []Agent{{ID: "a1"}},
				Log:    []LogEntry{{Seq: 1}},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := decodeAll(t, tt.line+"\n")
			if len(got) != 1 {
				t.Fatalf("decoded %d snapshots, want 1", len(got))
			}
			if !reflect.DeepEqual(got[0], tt.want) {
				t.Errorf("snapshot mismatch\n got: %+v\nwant: %+v", got[0], tt.want)
			}
		})
	}
}

func TestDecoderKeepsUnknownStatus(t *testing.T) {
	const line = `{"main":{"status":"hibernating","wait":"quorum","tools":[{"status":"paused"}]},` +
		`"agents":[{"status":"zombie","wait":"moon","tools":[{"status":"stuck"}]}],"log":[{"status":"??"}]}`

	got := decodeAll(t, line+"\n")
	if len(got) != 1 {
		t.Fatalf("decoded %d snapshots, want 1", len(got))
	}
	s := got[0]
	values := []struct{ field, got, want string }{
		{"main.status", s.Main.Status, "hibernating"},
		{"main.wait", s.Main.Wait, "quorum"},
		{"main.tools[0].status", s.Main.Tools[0].Status, "paused"},
		{"agents[0].status", s.Agents[0].Status, "zombie"},
		{"agents[0].wait", s.Agents[0].Wait, "moon"},
		{"agents[0].tools[0].status", s.Agents[0].Tools[0].Status, "stuck"},
		{"log[0].status", s.Log[0].Status, "??"},
	}
	for _, v := range values {
		if v.got != v.want {
			t.Errorf("%s = %q, want %q", v.field, v.got, v.want)
		}
	}
}

func TestDecoderSkipsEmptyAndMalformedLines(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  []int64
	}{
		{"empty lines", "\n\n" + `{"seq":1}` + "\n\n" + `{"seq":2}` + "\n", []int64{1, 2}},
		{"whitespace-only line", " \t\r\n" + `{"seq":1}` + "\n", []int64{1}},
		{"malformed line followed by a good line", `{"seq":1,` + "\n" + `{"seq":2}` + "\n", []int64{2}},
		{"wrong field type followed by a good line", `{"seq":"one"}` + "\n" + `{"seq":2}` + "\n", []int64{2}},
		{"JSON that is not an object", "null\n[]\n1\n\"x\"\n true\n" + `{"seq":2}` + "\n", []int64{2}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := seqs(decodeAll(t, tt.input)); !slices.Equal(got, tt.want) {
				t.Errorf("decoded seqs = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestDecoderOneMiBLine(t *testing.T) {
	line := paddedLine(3, mib)

	got := decodeAll(t, line+"\n")
	if len(got) != 1 {
		t.Fatalf("decoded %d snapshots, want 1", len(got))
	}
	wantSession := len(line) - len(`{"seq":3,"session":""}`)
	if got[0].Seq != 3 || len(got[0].Session) != wantSession {
		t.Errorf("seq = %d, len(session) = %d, want 3 and %d", got[0].Seq, len(got[0].Session), wantSession)
	}
}

func TestDecoderReleasesLargeLineBuffer(t *testing.T) {
	d := NewDecoder(strings.NewReader(paddedLine(1, mib) + "\n" + `{"seq":2}` + "\n"))
	for _, want := range []int64{1, 2} {
		s, err := d.Next()
		if err != nil || s.Seq != want {
			t.Fatalf("Next() = seq %d, %v, want seq %d", s.Seq, err, want)
		}
	}
	if got := cap(d.line); got > maxKeptBytes {
		t.Errorf("line buffer keeps %d bytes after a 1 MiB line, want at most %d", got, maxKeptBytes)
	}
}

// readerFunc is an io.Reader that calls a function.
type readerFunc func(p []byte) (int, error)

func (f readerFunc) Read(p []byte) (int, error) { return f(p) }

func TestDecoderReleasesOverLongLineBufferBeforeWaiting(t *testing.T) {
	const good = `{"seq":2}` + "\n"
	tests := []struct {
		name string
		sent string // what the peer has sent when it goes quiet
		then string // what it sends after that
	}{
		{"quiet after the line", paddedLine(1, 8*mib+1) + "\n", good},
		{"quiet within the line, past the limit", paddedLine(1, 9*mib), "\n" + good},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var d *Decoder
			kept := -1
			// Read once sent is used up: this is where the Decoder would wait.
			quiet := readerFunc(func([]byte) (int, error) {
				kept = cap(d.line)
				return 0, io.EOF
			})
			d = NewDecoder(io.MultiReader(strings.NewReader(tt.sent), quiet, strings.NewReader(tt.then)))

			if s, err := d.Next(); err != nil || s.Seq != 2 {
				t.Fatalf("Next() = seq %d, %v, want seq 2, nil", s.Seq, err)
			}
			if kept < 0 {
				t.Fatal("the Decoder did not read past what the peer had sent")
			}
			if kept > maxKeptBytes {
				t.Errorf("line buffer keeps %d bytes while the peer is quiet, want at most %d", kept, maxKeptBytes)
			}
		})
	}
}

func TestDecoderLineLimit(t *testing.T) {
	const good = `{"seq":2}` + "\n"
	tests := []struct {
		name  string
		input string
		want  []int64
	}{
		{"line of exactly 8 MiB is decoded", paddedLine(1, 8*mib) + "\n" + good, []int64{1, 2}},
		{"line over 8 MiB followed by a good line", paddedLine(1, 8*mib+1) + "\n" + good, []int64{2}},
		{"line over 8 MiB at the end of the stream", good + paddedLine(3, 8*mib+1), []int64{2}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := seqs(decodeAll(t, tt.input)); !slices.Equal(got, tt.want) {
				t.Errorf("decoded seqs = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestDecoderEndOfStream(t *testing.T) {
	t.Run("empty stream", func(t *testing.T) {
		d := NewDecoder(strings.NewReader(""))
		if _, err := d.Next(); err != io.EOF {
			t.Errorf("Next() error = %v, want io.EOF", err)
		}
	})

	t.Run("after the last snapshot", func(t *testing.T) {
		d := NewDecoder(strings.NewReader(`{"seq":1}` + "\n"))
		if s, err := d.Next(); err != nil || s.Seq != 1 {
			t.Fatalf("Next() = seq %d, %v, want seq 1, nil", s.Seq, err)
		}
		for range 2 {
			if _, err := d.Next(); err != io.EOF {
				t.Errorf("Next() error = %v, want io.EOF", err)
			}
		}
	})

	t.Run("last line without a newline is decoded first", func(t *testing.T) {
		d := NewDecoder(strings.NewReader(`{"seq":1}`))
		if s, err := d.Next(); err != nil || s.Seq != 1 {
			t.Fatalf("Next() = seq %d, %v, want seq 1, nil", s.Seq, err)
		}
		if _, err := d.Next(); err != io.EOF {
			t.Errorf("Next() error = %v, want io.EOF", err)
		}
	})

	t.Run("read error is returned", func(t *testing.T) {
		errBoom := errors.New("boom")
		d := NewDecoder(io.MultiReader(strings.NewReader(`{"seq":1}`+"\n"), iotest.ErrReader(errBoom)))
		if s, err := d.Next(); err != nil || s.Seq != 1 {
			t.Fatalf("Next() = seq %d, %v, want seq 1, nil", s.Seq, err)
		}
		if _, err := d.Next(); !errors.Is(err, errBoom) {
			t.Errorf("Next() error = %v, want %v", err, errBoom)
		}
	})
}
