import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createDebug } from "../../extension/lib/debug.mjs";

function runtime(t) {
    const dir = fs.mkdtempSync(path.join(process.env.FLEETPANE_TEST_TMPDIR || "/tmp", "fp-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

const records = (file) =>
    fs
        .readFileSync(file, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));

test("FLEETPANE_DEBUG unset or not 1/2: debug() is a no-op and creates no file", (t) => {
    const dir = runtime(t);
    for (const env of [{}, { FLEETPANE_DEBUG: "0" }, { FLEETPANE_DEBUG: "3" }, { FLEETPANE_DEBUG: "true" }]) {
        const debug = createDebug({ dir, sessionId: "s1", pid: 7, env });
        debug("boot", { pid: 7 });
        debug("snapshot", { line: "{}" });
    }
    assert.deepEqual(fs.readdirSync(dir), []);
});

test("level 1 appends JSONL to <sessionId>.<pid>.log with mode 0600 and drops snapshot", (t) => {
    const dir = runtime(t);
    const debug = createDebug({ dir, sessionId: "s1", pid: 7, env: { FLEETPANE_DEBUG: "1" } });
    debug("boot", { pid: 7, tty: "/dev/ttys003" });
    debug("snapshot", { line: "{}" });
    debug("turn");

    const file = path.join(dir, "s1.7.log");
    assert.deepEqual(fs.readdirSync(dir), ["s1.7.log"]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const [boot, turn, ...rest] = records(file);
    assert.deepEqual(rest, []);
    assert.equal(new Date(boot.t).toISOString(), boot.t);
    assert.deepEqual({ ...boot, t: "" }, { t: "", kind: "boot", pid: 7, tty: "/dev/ttys003" });
    assert.deepEqual({ ...turn, t: "" }, { t: "", kind: "turn" });
});

test("level 2 also records snapshot", (t) => {
    const dir = runtime(t);
    const debug = createDebug({ dir, sessionId: "s1", pid: 7, env: { FLEETPANE_DEBUG: "2" } });
    debug("client", { event: "connect", attempt: 1 });
    debug("snapshot", { line: "{}" });
    assert.deepEqual(
        records(path.join(dir, "s1.7.log")).map((r) => r.kind),
        ["client", "snapshot"],
    );
});

test("session id that is not file-safe is hashed, so the 2nd dot-segment stays the pid", (t) => {
    const dir = runtime(t);
    const debug = createDebug({ dir, sessionId: "a.b/c", pid: 7, env: { FLEETPANE_DEBUG: "1" } });
    debug("boot");
    const hash = createHash("sha256").update("a.b/c").digest("hex").slice(0, 16);
    assert.deepEqual(fs.readdirSync(dir), [`${hash}.7.log`]);
});

test("cap reached (counting what the file already holds): one final error record, then nothing", (t) => {
    const dir = runtime(t);
    const env = { FLEETPANE_DEBUG: "1" };
    const file = path.join(dir, "s1.7.log");
    const earlier = createDebug({ dir, sessionId: "s1", pid: 7, env });
    for (let i = 0; i < 3; i++) earlier("turn", { i });

    const debug = createDebug({ dir, sessionId: "s1", pid: 7, env, maxBytes: fs.statSync(file).size + 1 });
    for (let i = 3; i < 10; i++) debug("turn", { i });

    const got = records(file);
    assert.deepEqual(
        got.map((r) => r.kind),
        ["turn", "turn", "turn", "turn", "error"],
    );
    assert.equal(got[3].i, 3);
    assert.match(got[4].message, /stopped/);
});

test("a failing write does not throw", (t) => {
    const missing = path.join(runtime(t), "missing");
    const debug = createDebug({ dir: missing, sessionId: "s1", pid: 7, env: { FLEETPANE_DEBUG: "2" } });
    debug("boot", { pid: 7 });
    debug("snapshot", { loop: 1n });
    assert.equal(fs.existsSync(missing), false);
});

test("the log is opened once: a symlink put at its path later does not redirect records", (t) => {
    const dir = runtime(t);
    const debug = createDebug({ dir, sessionId: "s1", pid: 7, env: { FLEETPANE_DEBUG: "1" } });
    debug("boot");

    const file = path.join(dir, "s1.7.log");
    const moved = path.join(dir, "moved.log");
    const other = path.join(dir, "other.txt");
    fs.renameSync(file, moved);
    fs.writeFileSync(other, "");
    fs.symlinkSync(other, file);
    debug("turn");

    assert.equal(fs.readFileSync(other, "utf8"), "");
    assert.deepEqual(
        records(moved).map((r) => r.kind),
        ["boot", "turn"],
    );
});

test("log path that already is a symlink: it is not followed, nothing is written, debug() does not throw", (t) => {
    const dir = runtime(t);
    const other = path.join(dir, "other.txt");
    fs.writeFileSync(other, "");
    fs.symlinkSync(other, path.join(dir, "s1.7.log"));

    const debug = createDebug({ dir, sessionId: "s1", pid: 7, env: { FLEETPANE_DEBUG: "1" } });
    debug("boot");
    debug("turn");

    assert.equal(fs.readFileSync(other, "utf8"), "");
    assert.deepEqual(fs.readdirSync(dir).sort(), ["other.txt", "s1.7.log"]);
});
