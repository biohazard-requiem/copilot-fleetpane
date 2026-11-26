package protocol

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
)

// maxLineBytes is the longest line, newline excluded, the Decoder accepts.
const maxLineBytes = 8 << 20

// maxKeptBytes is the largest line buffer kept between lines: one huge line
// must not pin megabytes for the rest of the session.
const maxKeptBytes = 256 << 10

// Decoder reads snapshots from an NDJSON stream, one snapshot per line.
type Decoder struct {
	r    *bufio.Reader
	line []byte
}

// NewDecoder returns a Decoder that reads from r.
func NewDecoder(r io.Reader) *Decoder {
	return &Decoder{r: bufio.NewReaderSize(r, 64<<10)}
}

// Next returns the next snapshot in the stream. Lines that are empty, are not
// a JSON object holding a valid snapshot or are longer than 8 MiB are
// skipped. At the end of the stream Next returns io.EOF.
func (d *Decoder) Next() (Snapshot, error) {
	for {
		ok, err := d.readLine()
		if ok {
			var s Snapshot
			// json.Unmarshal accepts null and leaves s empty: that would blank the pane.
			line := bytes.TrimSpace(d.line)
			decoded := len(line) > 0 && line[0] == '{' && json.Unmarshal(line, &s) == nil
			if cap(d.line) > maxKeptBytes {
				d.line = nil
			}
			if decoded {
				return s, nil
			}
		}
		if err != nil {
			return Snapshot{}, err
		}
	}
}

// readLine reads the next line into d.line, without its newline. It reports
// false for a line longer than maxLineBytes, which is consumed up to its
// newline and dropped. bufio.Scanner is not used because it cannot recover
// from an over-long line.
func (d *Decoder) readLine() (bool, error) {
	d.line = d.line[:0]
	ok := true
	for {
		part, err := d.r.ReadSlice('\n')
		if err == nil {
			part = part[:len(part)-1]
		}
		if ok && len(d.line)+len(part) <= maxLineBytes {
			d.line = append(d.line, part...)
		} else {
			// Released at once: the rest of the line, or the next line, may be
			// long in coming.
			ok, d.line = false, nil
		}
		if err != bufio.ErrBufferFull {
			return ok, err
		}
	}
}
