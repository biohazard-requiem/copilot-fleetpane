import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { test as nodeTest } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
    createServer,
    prepareDir,
    readOverride,
    runtimeDir,
    socketPath,
    sweepStale,
    writeOverride,
} from "../../extension/lib/server.mjs";

// a regression must fail, not hang on an event that never comes
const test = (name, fn) => nodeTest(name, { timeout: 10_000 }, fn);

const mode = (file) => fs.lstatSync(file).mode & 0o777;
const hash16 = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const socks = (dir) => fs.readdirSync(dir).filter((name) => name.endsWith(".sock"));
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

// A fresh 0700 runtime dir "<base>/fp-XXXXXX/r"; siblings of "r" are removed with it.
function runtime(t) {
    const base = fs.mkdtempSync(path.join(process.env.FLEETPANE_TEST_TMPDIR || "/tmp", "fp-"));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const dir = path.join(base, "r");
    fs.mkdirSync(dir, { mode: 0o700 });
    return dir;
}

function waiter() {
    let wake = () => {};
    return {
        notify: () => wake(),
        until: async (done) => {
            while (!done()) await new Promise((resolve) => { wake = resolve; });
        },
    };
}

function harness(t, options = {}) {
    const w = waiter();
    const h = {
        dir: runtime(t),
        state: "s0",
        pad: "",
        calls: 0,
        broken: false,
        connects: [],
        disconnects: [],
        until: w.until,
    };
    h.server = createServer({
        dir: h.dir,
        sessionId: "s1",
        intervalMs: 10,
        getLine: () => {
            if (h.broken) throw new Error("no line");
            return JSON.stringify({ v: 1, seq: ++h.calls, state: h.state, pad: h.pad });
        },
        onConnect: (attempt) => {
            h.connects.push(attempt);
            w.notify();
        },
        onDisconnect: (attempt) => {
            h.disconnects.push(attempt);
            w.notify();
        },
        ...options,
    });
    t.after(() => h.server.close());
    return h;
}

// Resolves once connected; rejects when the path cannot be connected to.
async function connect(t, file, { paused = false } = {}) {
    const w = waiter();
    const socket = net.connect(file);
    t.after(() => socket.destroy());
    const client = { socket, lines: [], closed: false, until: w.until };
    let rest = "";
    if (paused) socket.pause();
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
        const parts = (rest + chunk).split("\n");
        rest = parts.pop();
        client.lines.push(...parts);
        w.notify();
    });
    socket.on("close", () => {
        client.closed = true;
        w.notify();
    });
    await new Promise((resolve, reject) => {
        socket.on("error", reject);
        socket.once("connect", resolve);
    });
    return client;
}

const lastState = (client) => JSON.parse(client.lines.at(-1)).state;

test("runtimeDir: no env var; FLEETPANE_RUNTIME_DIR absolute; relative", () => {
    assert.equal(runtimeDir({ uid: 501, env: {} }), "/tmp/fleetpane-501");
    assert.equal(runtimeDir({ env: {} }), `/tmp/fleetpane-${process.getuid()}`);
    assert.equal(runtimeDir({ uid: 501, env: { FLEETPANE_RUNTIME_DIR: "/var/run/fp" } }), "/var/run/fp");
    assert.equal(runtimeDir({ uid: 501, env: { FLEETPANE_RUNTIME_DIR: "run/fp" } }), "/tmp/fleetpane-501");
});

test("socketPath: ordinary id; id with illegal characters; dir that pushes the path over 100 bytes", () => {
    const dir = "/tmp/fleetpane-501";
    const uuid = "61bd9722-e0a3-4582-b704-313f19c3dc40";

    const plain = socketPath(dir, uuid, 4242, 3);
    assert.equal(plain, `${dir}/${uuid}.4242.3.sock`);

    const illegal = socketPath(dir, "../a b.c", 4242, 3);
    assert.equal(illegal, `${dir}/${hash16("../a b.c")}.4242.3.sock`);
    assert.equal(socketPath(dir, "a".repeat(65), 4242, 3), `${dir}/${hash16("a".repeat(65))}.4242.3.sock`);

    // 65-byte dir: 114 bytes with the uuid, 94 with its hash
    const longDir = `/tmp/${"d".repeat(60)}`;
    const shortened = socketPath(longDir, uuid, 4242, 3);
    assert.equal(shortened, `${longDir}/${hash16(uuid)}.4242.3.sock`);

    for (const file of [plain, illegal, shortened]) assert.ok(Buffer.byteLength(file) <= 100, file);

    assert.throws(() => socketPath(`/tmp/${"d".repeat(80)}`, uuid, 4242, 3));
    // 47 characters but 107 bytes: the limit is in bytes
    assert.throws(() => socketPath(`/tmp/${"目".repeat(30)}`, "s1", 1, 1));
});

test("prepareDir creates a new dir with mode 0700", (t) => {
    const dir = path.join(runtime(t), "new");
    prepareDir(dir);
    assert.equal(fs.lstatSync(dir).isDirectory(), true);
    assert.equal(mode(dir), 0o700);
    prepareDir(dir);
});

test("prepareDir on a symlink; on a dir readable by others", (t) => {
    const dir = runtime(t);
    const link = path.join(dir, "link");
    fs.symlinkSync(dir, link);
    assert.throws(() => prepareDir(link));

    const open = path.join(dir, "open");
    fs.mkdirSync(open);
    fs.chmodSync(open, 0o755);
    assert.throws(() => prepareDir(open));
});

// File names for a runtime dir: what a sweep removes (FleetPane's own, of a dead pid) and what it keeps.
function sweepCases(dead, live) {
    const uuid = "61bd9722-e0a3-4582-b704-313f19c3dc40";
    const stale = [
        `s1.${dead}.1.sock`,
        `${uuid}.${dead}.12.sock`,
        `s1.${dead}.log`,
        `override.${dead}.json`,
        `override.${dead}.${live}.tmp.json`,
    ];
    const kept = [`s1.${live}.1.sock`, `s1.${live}.log`, `override.${live}.json`, `notes.${dead}.txt`];
    // not the shape of anything FleetPane writes, whatever the pid in them
    const foreign = [
        "notes.txt",
        "a.b.c.d.sock",
        "x.notapid.log",
        `a.${dead}.c.d.sock`,
        `s1.${dead}.x.sock`,
        `s1.${dead}.sock`,
        `s1.${dead}.1.log`,
        `s 1.${dead}.log`,
        `.${dead}.log`,
        `${"a".repeat(65)}.${dead}.log`,
        `override.${dead}.bak.json`,
        `override.${dead}.x.tmp.json`,
        `s1.${dead}.json`,
    ];
    return { stale, kept, foreign };
}

test("sweepStale removes .sock, .log and override.<pid>.json of dead pids, keeps the live pid's and every name FleetPane does not write", (t) => {
    const dir = runtime(t);
    const { stale, kept, foreign } = sweepCases(deadPid(), process.pid);
    for (const name of [...stale, ...kept, ...foreign]) fs.writeFileSync(path.join(dir, name), "");

    assert.equal(sweepStale(dir), stale.length);
    assert.deepEqual(fs.readdirSync(dir).sort(), [...kept, ...foreign].sort());
});

test("hack/uninstall.sh removes the extension and sweeps the runtime dir by the same names as sweepStale", (t) => {
    const dir = runtime(t);
    const home = path.join(path.dirname(dir), "home");
    const dest = path.join(home, "extensions", "fleetpane");
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "extension.mjs"), "");
    const { stale, kept, foreign } = sweepCases(deadPid(), process.pid);
    for (const name of [...stale, ...kept, ...foreign]) fs.writeFileSync(path.join(dir, name), "");

    const script = fileURLToPath(new URL("../../hack/uninstall.sh", import.meta.url));
    const env = { ...process.env, COPILOT_HOME: home, FLEETPANE_RUNTIME_DIR: dir };
    const out = spawnSync("bash", [script], { env, encoding: "utf8" });

    assert.equal(out.status, 0, out.stderr);
    assert.equal(fs.existsSync(dest), false);
    assert.deepEqual(fs.readdirSync(dir).sort(), [...kept, ...foreign].sort());
});

const repo = fileURLToPath(new URL("../..", import.meta.url));

// Runs a script of hack/ with the Copilot home ("home", next to the runtime dir) and the runtime
// dir of the test, never the user's. /bin/bash is the oldest bash the scripts have to work with:
// 3.2 on macOS.
function hack(name, dir, { env = {}, cwd, root = repo } = {}) {
    const script = path.join(root, "hack", name);
    const home = path.join(path.dirname(dir), "home");
    return spawnSync("/bin/bash", [script], {
        env: { ...process.env, COPILOT_HOME: home, FLEETPANE_RUNTIME_DIR: dir, ...env },
        cwd,
        encoding: "utf8",
    });
}

// hack/install.sh installs from the directory above its own, and bin/ there is build output that
// a fresh clone does not have. So the tests run a copy of the script from "src", next to the
// runtime dir, with a copy of extension/ and a stub in place of bin/fleetpane.
function install(dir) {
    const root = path.join(path.dirname(dir), "src");
    fs.mkdirSync(path.join(root, "hack"), { recursive: true });
    fs.copyFileSync(path.join(repo, "hack", "install.sh"), path.join(root, "hack", "install.sh"));
    fs.cpSync(path.join(repo, "extension"), path.join(root, "extension"), { recursive: true });
    fs.mkdirSync(path.join(root, "bin"));
    fs.writeFileSync(path.join(root, "bin", "fleetpane"), "#!/bin/sh\n", { mode: 0o755 });
    return hack("install.sh", dir, { root });
}

const destOf = (dir) => path.join(path.dirname(dir), "home", "extensions", "fleetpane");

test("hack/uninstall.sh with a relative FLEETPANE_RUNTIME_DIR: it does not count, as in runtimeDir; the directory of that name in the working directory is left alone", (t) => {
    const dir = runtime(t);
    const base = path.dirname(dir);
    const { stale, kept } = sweepCases(deadPid(), process.pid);
    for (const name of [...stale, ...kept]) fs.writeFileSync(path.join(dir, name), "");

    // The script then falls back to /tmp/fleetpane-<uid>. That must not be the user's real one: an
    // `id` that comes first on PATH reports a uid for which no such directory can exist.
    const uid = `nobody-${randomBytes(8).toString("hex")}`;
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "id"), `#!/bin/sh\necho ${uid}\n`, { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env.PATH}` };
    const probe = spawnSync("/bin/bash", ["-c", "id -u"], { env: { ...process.env, ...env }, encoding: "utf8" });
    assert.equal(probe.stdout, `${uid}\n`, "the script would see the real uid");
    assert.equal(fs.existsSync(`/tmp/fleetpane-${uid}`), false);

    const out = hack("uninstall.sh", dir, { env: { ...env, FLEETPANE_RUNTIME_DIR: path.basename(dir) }, cwd: base });

    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stderr, "");
    assert.deepEqual(fs.readdirSync(dir).sort(), [...stale, ...kept].sort());
});

test("hack/uninstall.sh with a runtime dir that is a symlink: what it points to is left alone, one line on stderr says so", (t) => {
    const dir = runtime(t);
    const link = path.join(path.dirname(dir), "link");
    fs.symlinkSync(dir, link);
    const { stale } = sweepCases(deadPid(), process.pid);
    for (const name of stale) fs.writeFileSync(path.join(dir, name), "");

    const out = hack("uninstall.sh", link);

    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(fs.readdirSync(dir).sort(), [...stale].sort());
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.match(out.stderr, /^uninstall: [^\n]+\n$/);
    assert.ok(out.stderr.includes(link), out.stderr);
});

test("hack/uninstall.sh while a session still has its socket in the runtime dir: says that its pane stays, how to close it, and to uninstall again", (t) => {
    const dir = runtime(t);
    const note = /still open/;

    // a session without a pane, and a socket nobody listens on any more
    for (const name of [`s1.${process.pid}.log`, `override.${process.pid}.json`, `s1.${deadPid()}.1.sock`]) {
        fs.writeFileSync(path.join(dir, name), "");
    }
    const without = hack("uninstall.sh", dir);
    assert.equal(without.status, 0, without.stderr);
    assert.doesNotMatch(without.stdout, note);

    fs.writeFileSync(path.join(dir, `s1.${process.pid}.1.sock`), "");
    const out = hack("uninstall.sh", dir);
    assert.equal(out.status, 0, out.stderr);
    for (const part of [note, /press any key/i, /make uninstall/]) assert.match(out.stdout, part);
    assert.ok(out.stdout.indexOf("Removed ") < out.stdout.search(note), "after the removal message");
});

test("hack/install.sh when the destination, or its lib, bin or themes, is a symlink: refuses, nothing is copied", (t) => {
    for (const sub of ["", "lib", "bin", "themes"]) {
        const dir = runtime(t);
        const elsewhere = path.join(path.dirname(dir), "elsewhere");
        const link = path.join(destOf(dir), sub);
        fs.mkdirSync(elsewhere);
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(elsewhere, link);

        const out = install(dir);

        assert.notEqual(out.status, 0, `"${sub}": ${out.stdout}`);
        assert.ok(out.stderr.startsWith("install: ") && out.stderr.includes(link), out.stderr);
        assert.deepEqual(fs.readdirSync(elsewhere), [], sub);
        assert.deepEqual(fs.readdirSync(path.dirname(link)), [path.basename(link)], sub);
    }
});

test("hack/install.sh over files that are symlinks (to a file, to a directory): each becomes a regular file, what it pointed to is left alone", (t) => {
    const dir = runtime(t);
    const base = path.dirname(dir);
    const dest = destOf(dir);
    const otherFile = path.join(base, "other.mjs");
    const otherDir = path.join(base, "other-dir");
    fs.mkdirSync(path.join(dest, "lib"), { recursive: true });
    fs.writeFileSync(otherFile, "not FleetPane's");
    fs.mkdirSync(otherDir);
    fs.symlinkSync(otherFile, path.join(dest, "extension.mjs"));
    fs.symlinkSync(otherFile, path.join(dest, "lib", "config.mjs"));
    fs.symlinkSync(otherDir, path.join(dest, "ghostty-split.applescript"));

    const out = install(dir);

    assert.equal(fs.readFileSync(otherFile, "utf8"), "not FleetPane's");
    assert.deepEqual(fs.readdirSync(otherDir), []);
    assert.equal(out.status, 0, out.stderr);
    const source = fileURLToPath(new URL("../../extension", import.meta.url));
    for (const name of ["extension.mjs", "lib/config.mjs", "ghostty-split.applescript"]) {
        assert.equal(fs.lstatSync(path.join(dest, name)).isFile(), true, name);
        assert.equal(fs.readFileSync(path.join(dest, name), "utf8"), fs.readFileSync(path.join(source, name), "utf8"), name);
    }
    assert.deepEqual(fs.readdirSync(dest, { recursive: true }).filter((name) => name.includes(".tmp.")), []);
});

const proc = { pid: 4242, started: "Wed Nov 25 09:00:00 2026" };
const overrideFile = (dir) => path.join(dir, `override.${proc.pid}.json`);

test("readOverride: no file; not JSON; value hidden, shown, something else", (t) => {
    const dir = runtime(t);
    assert.equal(readOverride(dir, proc), "");

    for (const text of ["{not json", "null"]) {
        fs.writeFileSync(overrideFile(dir), text);
        assert.equal(readOverride(dir, proc), "");
    }
    for (const [value, want] of [["hidden", "hidden"], ["shown", "shown"], ["sideways", ""]]) {
        fs.writeFileSync(overrideFile(dir), JSON.stringify({ override: value, started: proc.started }));
        assert.equal(readOverride(dir, proc), want);
    }
});

test("writeOverride hidden then read; then empty string; then empty string again", (t) => {
    const dir = runtime(t);
    writeOverride(dir, proc, "hidden");
    assert.equal(readOverride(dir, proc), "hidden");
    assert.equal(mode(overrideFile(dir)), 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(overrideFile(dir), "utf8")), {
        override: "hidden",
        started: proc.started,
    });
    assert.deepEqual(fs.readdirSync(dir), [path.basename(overrideFile(dir))]);

    writeOverride(dir, proc, "shown");
    assert.equal(readOverride(dir, proc), "shown");

    writeOverride(dir, proc, "");
    assert.equal(fs.existsSync(overrideFile(dir)), false);
    writeOverride(dir, proc, "");
});

test("override written with start time A, read with the same pid and start time B (pid reuse)", (t) => {
    const dir = runtime(t);
    writeOverride(dir, { pid: proc.pid, started: "A" }, "hidden");
    assert.equal(readOverride(dir, { pid: proc.pid, started: "B" }), "");
    assert.equal(fs.existsSync(overrideFile(dir)), false);
});

test("override when a start time is unknown: stored but not current, current but not stored, neither", (t) => {
    const dir = runtime(t);
    const marker = (started) => JSON.stringify({ override: "hidden", started });
    const cases = [
        ["A", ""],
        ["", "A"],
        ["", ""],
        [undefined, "A"],
        [7, "A"],
        ["A", undefined],
    ];
    for (const [stored, current] of cases) {
        const label = `stored ${JSON.stringify(stored)}, current ${JSON.stringify(current)}`;
        fs.writeFileSync(overrideFile(dir), marker(stored));
        assert.equal(readOverride(dir, { pid: proc.pid, started: current }), "", label);
        assert.equal(fs.readFileSync(overrideFile(dir), "utf8"), marker(stored), `${label}: the file is left alone`);
    }

    // not knowing left the marker in place for a later read that does know
    fs.writeFileSync(overrideFile(dir), marker("A"));
    assert.equal(readOverride(dir, { pid: proc.pid, started: "" }), "");
    assert.equal(readOverride(dir, { pid: proc.pid, started: "A" }), "hidden");
});

test("runtime dir that is not trusted (a symlink; a dir open to others): readOverride reads and removes nothing, writeOverride with an empty value removes nothing", (t) => {
    const base = path.dirname(runtime(t));
    const target = path.join(base, "target");
    const link = path.join(base, "link");
    const open = path.join(base, "open");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, link);
    fs.mkdirSync(open);
    fs.chmodSync(open, 0o755);

    const marker = JSON.stringify({ override: "hidden", started: "A" });
    for (const [dir, real] of [[link, target], [open, open]]) {
        fs.writeFileSync(overrideFile(real), marker);

        assert.equal(readOverride(dir, { pid: proc.pid, started: "B" }), "");
        assert.equal(fs.existsSync(overrideFile(real)), true, `${dir}: not removed as the marker of a reused pid`);
        assert.equal(readOverride(dir, { pid: proc.pid, started: "A" }), "", `${dir}: not read`);
        writeOverride(dir, { pid: proc.pid, started: "A" }, "");
        assert.equal(fs.readFileSync(overrideFile(real), "utf8"), marker, dir);
    }
});

test("writeOverride after the runtime dir was removed", (t) => {
    const dir = runtime(t);
    fs.rmSync(dir, { recursive: true });
    writeOverride(dir, proc, "hidden");
    assert.equal(mode(dir), 0o700);
    assert.equal(readOverride(dir, proc), "hidden");
});

test("rotate after the runtime dir was removed", async (t) => {
    const h = harness(t);
    fs.rmSync(h.dir, { recursive: true });
    const file = await h.server.rotate(1);
    assert.equal(mode(h.dir), 0o700);
    const client = await connect(t, file);
    await client.until(() => client.lines.length === 1);
});

test("rotate after the runtime dir was replaced by a symlink", async (t) => {
    const h = harness(t);
    const file = await h.server.rotate(1);
    const client = await connect(t, file);
    await client.until(() => client.lines.length === 1);

    const moved = path.join(path.dirname(h.dir), "moved");
    const target = path.join(path.dirname(h.dir), "target");
    fs.renameSync(h.dir, moved);
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, h.dir);
    // the old socket stays reachable through "moved" for as long as it is listening
    const old = path.join(moved, path.basename(file));
    await connect(t, old);

    await assert.rejects(h.server.rotate(2));
    await client.until(() => client.closed);
    assert.deepEqual(h.disconnects, [1]);
    assert.equal(h.server.hasClient(), false);
    assert.deepEqual(fs.readdirSync(target), []);
    await assert.rejects(connect(t, old));
});

test("rotate rejected by prepareDir: the handles are closed, server.mjs removes nothing by path", async (t) => {
    const h = harness(t);
    const file = await h.server.rotate(1);
    const client = await connect(t, file);
    await client.until(() => client.lines.length === 1);

    const moved = path.join(path.dirname(h.dir), "moved");
    const target = path.join(path.dirname(h.dir), "target");
    fs.renameSync(h.dir, moved);
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, h.dir);

    // The old socket's path now resolves inside "target". Node unlinks the path of a Unix listener
    // when the listener closes, so a file of that very name cannot be kept there; what is checked
    // is that server.mjs does not remove anything by path on top of that.
    const rm = t.mock.method(fs, "rmSync");
    const unlink = t.mock.method(fs, "unlinkSync");
    await assert.rejects(h.server.rotate(2), /not a real directory/);
    assert.deepEqual([...rm.mock.calls, ...unlink.mock.calls].map((call) => call.arguments[0]), []);

    await client.until(() => client.closed);
    assert.equal(h.server.hasClient(), false);
    await assert.rejects(connect(t, path.join(moved, path.basename(file))));
});

test("close() after the runtime dir was replaced by a symlink: the handles are closed, server.mjs removes nothing by path", async (t) => {
    const h = harness(t);
    const file = await h.server.rotate(1);
    const client = await connect(t, file);
    await client.until(() => client.lines.length === 1);

    const moved = path.join(path.dirname(h.dir), "moved");
    const target = path.join(path.dirname(h.dir), "target");
    fs.renameSync(h.dir, moved);
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, h.dir);
    // Named like the old socket. A plain file of that name cannot be kept (Node unlinks it, see
    // above); a directory is out of Node's reach and shows what server.mjs does on top of that.
    const lookalike = path.join(target, path.basename(file));
    fs.mkdirSync(lookalike);

    const rm = t.mock.method(fs, "rmSync");
    const unlink = t.mock.method(fs, "unlinkSync");
    await h.server.close();
    assert.deepEqual([...rm.mock.calls, ...unlink.mock.calls].map((call) => call.arguments[0]), []);
    assert.deepEqual(fs.readdirSync(target), [path.basename(file)]);

    await client.until(() => client.closed);
    assert.deepEqual(h.disconnects, [1]);
    assert.equal(h.server.hasClient(), false);
    await assert.rejects(connect(t, path.join(moved, path.basename(file))));
});

test("rotate(1) then a client connects: first line is a snapshot, onConnect receives 1", async (t) => {
    const h = harness(t);
    const file = await h.server.rotate(1);
    assert.equal(file, path.join(h.dir, `s1.${process.pid}.1.sock`));
    assert.equal(h.server.hasClient(), false);

    const client = await connect(t, file);
    await client.until(() => client.lines.length === 1);
    await h.until(() => h.connects.length === 1);
    assert.deepEqual(JSON.parse(client.lines[0]), { v: 1, seq: 1, state: "s0", pad: "" });
    assert.deepEqual(h.connects, [1]);
    assert.equal(h.server.hasClient(), true);
});

test("socket file after listening has mode 0600", async (t) => {
    const h = harness(t);
    const file = await h.server.rotate(1);
    assert.equal(fs.lstatSync(file).isSocket(), true);
    assert.equal(mode(file), 0o600);
});

test("schedule() without a client does nothing", async (t) => {
    const h = harness(t);
    await h.server.rotate(1);
    h.server.schedule();
    await sleep(30);
    assert.equal(h.calls, 0);
});

test("10 schedule() calls within one interval, state changed before each", async (t) => {
    const h = harness(t, { intervalMs: 20 });
    const client = await connect(t, await h.server.rotate(1));
    await client.until(() => client.lines.length === 1);

    for (let i = 1; i <= 10; i++) {
        h.state = `s${i}`;
        h.server.schedule();
    }
    await client.until(() => client.lines.length >= 2);
    await sleep(60);
    const extra = client.lines.length - 1;
    assert.ok(extra >= 1 && extra <= 2, `${extra} extra lines`);
    assert.equal(lastState(client), "s10");
});

test("second client while one is connected: second is dropped, first is unaffected", async (t) => {
    const h = harness(t);
    const file = await h.server.rotate(1);
    const first = await connect(t, file);
    await first.until(() => first.lines.length === 1);

    const second = await connect(t, file);
    await second.until(() => second.closed);
    assert.deepEqual(second.lines, []);
    assert.deepEqual(h.connects, [1]);
    assert.deepEqual(h.disconnects, []);
    assert.equal(h.server.hasClient(), true);

    h.state = "after";
    h.server.schedule();
    await first.until(() => first.lines.length === 2);
    assert.equal(lastState(first), "after");
    assert.equal(first.closed, false);
});

test("rotate(2): first client ends, onDisconnect receives 1, old path gone, new path accepts", async (t) => {
    const h = harness(t);
    const old = await h.server.rotate(1);
    const first = await connect(t, old);
    await first.until(() => first.lines.length === 1);

    const file = await h.server.rotate(2);
    assert.notEqual(file, old);
    await first.until(() => first.closed);
    assert.deepEqual(h.disconnects, [1]);
    assert.equal(fs.existsSync(old), false);
    await assert.rejects(connect(t, old));

    const second = await connect(t, file);
    await second.until(() => second.lines.length === 1);
    await h.until(() => h.connects.length === 2);
    assert.deepEqual(h.connects, [1, 2]);
    assert.deepEqual(h.disconnects, [1]);
});

test("client disconnects by itself, then a new client connects to the same path", async (t) => {
    const h = harness(t);
    const file = await h.server.rotate(1);
    const first = await connect(t, file);
    await first.until(() => first.lines.length === 1);

    // unread input must not hide the disconnect
    first.socket.end("stray input\n");
    await h.until(() => h.disconnects.length === 1);
    assert.deepEqual(h.disconnects, [1]);
    assert.equal(h.server.hasClient(), false);

    const second = await connect(t, file);
    await second.until(() => second.lines.length === 1);
    assert.deepEqual(h.connects, [1, 1]);
    assert.deepEqual(h.disconnects, [1]);
    assert.equal(h.server.hasClient(), true);
});

test("client does not read while schedule() keeps coming, then starts reading", async (t) => {
    const h = harness(t, { intervalMs: 1 });
    h.pad = "x".repeat(64 * 1024);
    const client = await connect(t, await h.server.rotate(1), { paused: true });
    await h.until(() => h.connects.length === 1);

    const rounds = 60;
    for (let i = 1; i <= rounds; i++) {
        h.state = `s${i}`;
        h.server.schedule();
        await sleep(3);
    }
    // Unbounded queueing would be ~61 lines (4 MiB). The cap is 256 KiB plus one line plus
    // whatever the kernel buffers hold, so 16 lines (1 MiB) is a generous bound.
    assert.ok(h.calls <= 16, `${h.calls} lines written to a client that is not reading`);

    // no schedule() from here on: the skipped write must have re-armed the timer by itself
    h.state = "latest";
    client.socket.resume();
    await client.until(() => client.lines.length > 0 && lastState(client) === "latest");
    await sleep(10);
    assert.equal(lastState(client), "latest");
    assert.equal(client.lines.length, h.calls);
});

test("close(): client ends, file removed, connecting fails, getLine is not called again", async (t) => {
    const h = harness(t);
    const file = await h.server.rotate(1);
    const client = await connect(t, file);
    await client.until(() => client.lines.length === 1);

    h.server.schedule();
    h.server.close();
    // with no rotate in flight close() takes effect before it returns
    assert.equal(fs.existsSync(file), false);
    assert.equal(h.server.hasClient(), false);
    assert.deepEqual(h.disconnects, [1]);

    await client.until(() => client.closed);
    await assert.rejects(connect(t, file));
    await sleep(40);
    assert.equal(h.calls, 1);
    assert.equal(client.lines.length, 1);
    assert.deepEqual(h.disconnects, [1]);
});

test("close() twice; rotate(3) after close()", async (t) => {
    const h = harness(t);
    await h.server.close();
    await h.server.rotate(1);
    await h.server.close();
    await h.server.close();

    const client = await connect(t, await h.server.rotate(3));
    await client.until(() => client.lines.length === 1);
    await h.until(() => h.connects.length === 1);
    assert.deepEqual(h.connects, [3]);
});

test("close() while rotate(4) is still in flight", async (t) => {
    const h = harness(t);
    const rotating = h.server.rotate(4);
    const closing = h.server.close();
    const file = await rotating;
    await closing;
    assert.equal(file, path.join(h.dir, `s1.${process.pid}.4.sock`));
    assert.deepEqual(socks(h.dir), []);
    await assert.rejects(connect(t, file));
    assert.equal(h.server.hasClient(), false);
});

test("rotate(5) and rotate(6) without awaiting", async (t) => {
    const h = harness(t);
    const [five, six] = await Promise.all([h.server.rotate(5), h.server.rotate(6)]);
    assert.deepEqual(socks(h.dir), [path.basename(six)]);
    assert.equal(fs.existsSync(five), false);
    await assert.rejects(connect(t, five));

    const client = await connect(t, six);
    await client.until(() => client.lines.length === 1);
    await h.until(() => h.connects.length === 1);
    assert.deepEqual(h.connects, [6]);
});

test("getLine throws while a client is being accepted: that client is dropped without onConnect or onDisconnect", async (t) => {
    const h = harness(t);
    const file = await h.server.rotate(1);

    h.broken = true;
    const refused = await connect(t, file);
    await refused.until(() => refused.closed);
    assert.deepEqual(refused.lines, []);
    assert.equal(h.server.hasClient(), false);
    assert.deepEqual([h.connects, h.disconnects], [[], []]);

    h.broken = false;
    const client = await connect(t, file);
    await client.until(() => client.lines.length === 1);
    await h.until(() => h.connects.length === 1);
    assert.deepEqual([h.connects, h.disconnects], [[1], []]);
    assert.equal(h.server.hasClient(), true);
});

test("getLine throws in a scheduled write: that write is skipped, the client stays, the next one is sent", async (t) => {
    const h = harness(t);
    const client = await connect(t, await h.server.rotate(1));
    await client.until(() => client.lines.length === 1);

    h.broken = true;
    h.server.schedule();
    await sleep(40);
    assert.equal(client.lines.length, 1);
    assert.equal(client.closed, false);
    assert.equal(h.server.hasClient(), true);
    assert.deepEqual(h.disconnects, []);

    h.broken = false;
    h.state = "recovered";
    h.server.schedule();
    await client.until(() => client.lines.length === 2);
    assert.equal(lastState(client), "recovered");
});
