import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
    DEFAULTS,
    POSITIONS,
    describe,
    listThemes,
    loadConfig,
    normalizeConfig,
    parseCommand,
    updateConfig,
} from "../../extension/lib/config.mjs";

const SAVED = { enabled: true, layout: { position: "left", size: 40 }, theme: "mine" };

function tmpDir(t) {
    const dir = fs.mkdtempSync(path.join(process.env.FLEETPANE_TEST_TMPDIR || "/tmp", "fp-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function configFile(t, content = SAVED) {
    const file = path.join(tmpDir(t), "config.json");
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
    return file;
}

const withLayout = (layout) => normalizeConfig({ layout }).layout;

test("DEFAULTS and POSITIONS match the documented values", () => {
    assert.deepEqual(DEFAULTS, { enabled: true, layout: { position: "right", size: 33 }, theme: "gta6" });
    assert.deepEqual(POSITIONS, ["right", "left", "top", "bottom"]);
});

test("normalizeConfig: undefined, null, array, string → defaults", () => {
    for (const raw of [undefined, null, [], [{ enabled: false }], "abc", 7]) {
        assert.deepEqual(normalizeConfig(raw), DEFAULTS, `input ${JSON.stringify(raw)}`);
    }
});

test("normalizeConfig: a valid config is kept and unknown fields are dropped", () => {
    const raw = { enabled: false, layout: { position: "top", size: 25, gap: 1 }, theme: "auto", extra: true };
    assert.deepEqual(normalizeConfig(raw), { enabled: false, layout: { position: "top", size: 25 }, theme: "auto" });
});

test("normalizeConfig: enabled that is not a boolean → true", () => {
    for (const enabled of ["false", 0, 1, null, undefined, {}]) {
        assert.equal(normalizeConfig({ enabled }).enabled, true, `enabled ${JSON.stringify(enabled)}`);
    }
    assert.equal(normalizeConfig({ enabled: false }).enabled, false);
});

test("normalizeConfig: invalid position → right", () => {
    for (const position of ["middle", "LEFT", "", 7, null, undefined]) {
        assert.equal(withLayout({ position, size: 40 }).position, "right", `position ${JSON.stringify(position)}`);
    }
    for (const layout of [undefined, null, "left", ["left"]]) {
        assert.deepEqual(withLayout(layout), DEFAULTS.layout, `layout ${JSON.stringify(layout)}`);
    }
    for (const position of POSITIONS) {
        assert.equal(withLayout({ position }).position, position);
    }
});

test("normalizeConfig: size 5, 95, 33.6, \"abc\" → 10, 80, 34, 33", () => {
    const cases = [
        [5, 10],
        [95, 80],
        [33.6, 34],
        ["abc", 33],
        [10, 10],
        [80, 80],
        [-1, 10],
        [9.5, 10],
        [80.4, 80],
        ["40", 33],
        [null, 33],
        [undefined, 33],
        [NaN, 33],
    ];
    for (const [size, expected] of cases) {
        assert.equal(withLayout({ position: "left", size }).size, expected, `size ${String(size)}`);
    }
});

test("normalizeConfig: theme missing, auto, my-theme, ../x, \"A B\", number → gta6, auto, my-theme, gta6, gta6, gta6", () => {
    const cases = [
        [undefined, "gta6"],
        ["auto", "auto"],
        ["my-theme", "my-theme"],
        ["../x", "gta6"],
        ["A B", "gta6"],
        [7, "gta6"],
        ["a".repeat(32), "a".repeat(32)],
        ["a".repeat(33), "gta6"],
        ["0_x-1", "0_x-1"],
        ["-x", "gta6"],
        ["", "gta6"],
        ["mine\n", "gta6"],
        [null, "gta6"],
    ];
    for (const [theme, expected] of cases) {
        assert.equal(normalizeConfig({ theme }).theme, expected, `theme ${JSON.stringify(theme)}`);
    }
});

test("loadConfig: missing file → defaults, does not throw", (t) => {
    assert.deepEqual(loadConfig(path.join(tmpDir(t), "config.json")), DEFAULTS);
});

test("loadConfig: content that is not JSON → defaults, does not throw", (t) => {
    for (const content of ["", "{ enabled: false", "not json", "null", "[1]"]) {
        assert.deepEqual(loadConfig(configFile(t, content)), DEFAULTS, `content ${JSON.stringify(content)}`);
    }
    assert.deepEqual(loadConfig(tmpDir(t)), DEFAULTS, "a directory instead of a file");
});

test("loadConfig: reads the file and normalizes it", (t) => {
    const file = configFile(t, { enabled: false, layout: { position: "top", size: 95 }, junk: 1 });
    assert.deepEqual(loadConfig(file), { enabled: false, layout: { position: "top", size: 80 }, theme: "gta6" });
});

test("loadConfig: a FIFO at the path → defaults at once, it is not opened", { timeout: 10_000 }, (t) => {
    const file = path.join(tmpDir(t), "config.json");
    execFileSync("mkfifo", [file]);
    const module = fileURLToPath(new URL("../../extension/lib/config.mjs", import.meta.url));
    const script = `
        const [module, file] = process.argv.slice(1);
        const { loadConfig } = await import(module);
        process.stdout.write(JSON.stringify(loadConfig(file)));
    `;
    // In a process of its own: opening a FIFO that nobody writes to blocks for good, and a blocked
    // process cannot run the timer of its own test timeout.
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", script, module, file], {
        encoding: "utf8",
        timeout: 3000,
    });

    assert.equal(out.error, undefined, "loadConfig blocked on the FIFO");
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), DEFAULTS);
});

test("loadConfig: a file over 64 KiB → defaults, it is not read; 64 KiB exactly and a symlink to a config still load", (t) => {
    const saved = JSON.stringify(SAVED);
    const padded = (bytes) => configFile(t, saved + " ".repeat(bytes - saved.length));
    const read = t.mock.method(fs, "readFileSync");

    assert.deepEqual(loadConfig(padded(100 * 1024)), DEFAULTS);
    assert.deepEqual(loadConfig(padded(64 * 1024 + 1)), DEFAULTS);
    assert.equal(read.mock.callCount(), 0);

    assert.deepEqual(loadConfig(padded(64 * 1024)), SAVED);
    const link = path.join(tmpDir(t), "config.json");
    fs.symlinkSync(configFile(t), link);
    assert.deepEqual(loadConfig(link), SAVED);
});

test("updateConfig then loadConfig: the changed field is new, the others are unchanged, no temp or lock file is left", async (t) => {
    const file = configFile(t, { ...SAVED, junk: 1 });
    const dir = path.dirname(file);

    const returned = await updateConfig(file, { enabled: false });
    assert.deepEqual(returned, { ...SAVED, enabled: false });
    assert.deepEqual(loadConfig(file), { ...SAVED, enabled: false });
    assert.deepEqual(fs.readdirSync(dir), ["config.json"]);

    await updateConfig(file, { layout: { position: "top", size: 25 } });
    assert.deepEqual(loadConfig(file), { enabled: false, layout: { position: "top", size: 25 }, theme: "mine" });

    await updateConfig(file, { theme: "auto" });
    const expected = { enabled: false, layout: { position: "top", size: 25 }, theme: "auto" };
    assert.deepEqual(loadConfig(file), expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), expected, "unknown fields are not saved");
    assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
});

test("updateConfig: a layout change without size keeps the size in the file", async (t) => {
    const file = configFile(t);
    assert.deepEqual(await updateConfig(file, { layout: { position: "bottom" } }), {
        ...SAVED,
        layout: { position: "bottom", size: 40 },
    });
    assert.deepEqual(await updateConfig(file, { layout: { position: "top", size: undefined } }), {
        ...SAVED,
        layout: { position: "top", size: 40 },
    });
});

test("updateConfig: values in the change are normalized before they are saved", async (t) => {
    const file = configFile(t);
    const expected = { ...SAVED, layout: { position: "left", size: 80 } };
    assert.deepEqual(await updateConfig(file, { layout: { size: 95 } }), expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), expected);
});

test("updateConfig: missing file → defaults plus the change", async (t) => {
    const file = path.join(tmpDir(t), "config.json");
    assert.deepEqual(await updateConfig(file, { theme: "auto" }), { ...DEFAULTS, theme: "auto" });
    assert.deepEqual(loadConfig(file), { ...DEFAULTS, theme: "auto" });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"]);
});

test("updateConfig: writes config.json.<pid>.<random>.tmp in the same directory, then renames it", async (t) => {
    const file = configFile(t);
    const rename = t.mock.method(fs, "renameSync");

    await updateConfig(file, { enabled: false });
    await updateConfig(file, { enabled: true });

    // taking the lock is a rename as well; only the ones onto config.json are looked at
    const [first, second, ...rest] = rename.mock.calls.map((call) => call.arguments).filter(([, to]) => to === file);
    assert.deepEqual(rest, []);
    const pattern = new RegExp(`^config\\.json\\.${process.pid}\\.[0-9a-z]+\\.tmp$`);
    for (const [from, to] of [first, second]) {
        assert.equal(path.dirname(from), path.dirname(file));
        assert.match(path.basename(from), pattern);
        assert.equal(to, file);
    }
    assert.notEqual(first[0], second[0]);
});

test("updateConfig: rejects when the write fails, leaving no temp or lock file", async (t) => {
    const file = configFile(t);
    const before = fs.readFileSync(file, "utf8");
    const { renameSync } = fs;
    t.mock.method(fs, "renameSync", (from, to) => {
        if (to === file) throw new Error("rename failed");
        return renameSync(from, to);
    });

    await assert.rejects(updateConfig(file, { enabled: false }), /rename failed/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"]);
});

test("updateConfig: rejects when the directory does not exist", async (t) => {
    const file = path.join(tmpDir(t), "missing", "config.json");
    await assert.rejects(updateConfig(file, { enabled: false }), { code: "ENOENT" });
});

test("two interleaved writers that both read the old config: enabled false and theme auto are both kept", async (t) => {
    const file = configFile(t);
    assert.deepEqual([loadConfig(file), loadConfig(file)], [SAVED, SAVED]);

    await Promise.all([updateConfig(file, { enabled: false }), updateConfig(file, { theme: "auto" })]);

    assert.deepEqual(loadConfig(file), { ...SAVED, enabled: false, theme: "auto" });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"]);
});

test("two interleaved writers: the file is re-read after the lock is taken", async (t) => {
    const file = configFile(t);
    const lock = `${file}.lock`;

    // The other writer holds the lock, and saves its change while this one is waiting.
    fs.writeFileSync(lock, "", { flag: "wx" });
    const waiting = updateConfig(file, { theme: "auto" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    fs.writeFileSync(file, JSON.stringify({ ...SAVED, enabled: false }));
    fs.rmSync(lock);

    assert.deepEqual(await waiting, { ...SAVED, enabled: false, theme: "auto" });
    assert.deepEqual(loadConfig(file), { ...SAVED, enabled: false, theme: "auto" });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"]);
});

test("lock file exists and is fresh: updateConfig rejects after 500ms, the file is not changed", async (t) => {
    // A brand-new lock, and one that is old but still younger than the 5 seconds that make it stale.
    await Promise.all(
        [0, 3000].map(async (ageMs) => {
            const file = configFile(t);
            const lock = `${file}.lock`;
            const mtime = new Date(Date.now() - ageMs);
            fs.writeFileSync(lock, "");
            fs.utimesSync(lock, mtime, mtime);
            const before = fs.readFileSync(file, "utf8");

            const started = Date.now();
            await assert.rejects(updateConfig(file, { enabled: false }), /lock/i);
            const elapsed = Date.now() - started;

            assert.ok(elapsed >= 500 && elapsed < 1500, `lock aged ${ageMs}ms: rejected after ${elapsed}ms`);
            assert.equal(fs.readFileSync(file, "utf8"), before);
            assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["config.json", "config.json.lock"]);
        }),
    );
});

test("lock file exists but was modified more than 5 seconds ago: removed as a leftover, the write succeeds", async (t) => {
    const file = configFile(t);
    const lock = `${file}.lock`;
    const mtime = new Date(Date.now() - 6000);
    fs.writeFileSync(lock, "");
    fs.utimesSync(lock, mtime, mtime);

    const started = Date.now();
    assert.deepEqual(await updateConfig(file, { enabled: false }), { ...SAVED, enabled: false });
    assert.ok(Date.now() - started < 400, "did not wait for the lock");
    assert.deepEqual(loadConfig(file), { ...SAVED, enabled: false });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"]);
});

// A lock left by a session that died 6 seconds ago: in today's form, or as the plain file of an older version.
function staleLock(lock, form) {
    const holder = form === "directory" ? path.join(lock, "4242.0badc0de") : lock;
    if (form === "directory") fs.mkdirSync(lock);
    fs.writeFileSync(holder, "");
    const mtime = new Date(Date.now() - 6000);
    fs.utimesSync(holder, mtime, mtime);
    return holder;
}

test("while a writer works, config.json.lock is a directory holding one file named <pid>.<random>, unique per writer", async (t) => {
    const file = configFile(t);
    const lock = `${file}.lock`;
    const { renameSync } = fs;
    const holders = [];
    t.mock.method(fs, "renameSync", (from, to) => {
        if (to === file) holders.push(fs.readdirSync(lock));
        return renameSync(from, to);
    });

    await updateConfig(file, { enabled: false });
    await updateConfig(file, { enabled: true });

    assert.equal(holders.length, 2);
    for (const names of holders) {
        assert.equal(names.length, 1);
        assert.match(names[0], new RegExp(`^${process.pid}\\.[0-9a-f]{8}$`));
    }
    assert.notEqual(holders[0][0], holders[1][0]);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"]);
});

test("lock held by another session (its fresh file in the lock directory): rejects after 500ms, nothing is changed or left", async (t) => {
    const file = configFile(t);
    const lock = `${file}.lock`;
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "another-session"), "");
    const before = fs.readFileSync(file, "utf8");

    const started = Date.now();
    await assert.rejects(updateConfig(file, { enabled: false }), /lock/i);
    const elapsed = Date.now() - started;

    assert.ok(elapsed >= 500 && elapsed < 1500, `rejected after ${elapsed}ms`);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.deepEqual(fs.readdirSync(lock), ["another-session"]);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["config.json", "config.json.lock"]);
});

test("a writer that had to wait for the lock: the age of its file in the lock counts from when it took the lock", async (t) => {
    const file = configFile(t);
    const lock = `${file}.lock`;
    const { renameSync } = fs;
    let heldSince;
    t.mock.method(fs, "renameSync", (from, to) => {
        if (to === file) heldSince = fs.statSync(path.join(lock, fs.readdirSync(lock)[0])).mtimeMs;
        return renameSync(from, to);
    });

    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "another-session"), "");
    const waiting = updateConfig(file, { theme: "auto" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const released = Date.now();
    fs.rmSync(lock, { recursive: true });
    await waiting;

    // not from when it started waiting, 100ms earlier: a wait must not eat into the 5 seconds
    assert.ok(heldSince > released - 50, `dated ${Math.round(released - heldSince)}ms before the lock was free`);
});

test("stale lock in today's form (a directory with the dead holder's file): taken over, the write succeeds", async (t) => {
    const file = configFile(t);
    staleLock(`${file}.lock`, "directory");

    const started = Date.now();
    assert.deepEqual(await updateConfig(file, { enabled: false }), { ...SAVED, enabled: false });
    assert.ok(Date.now() - started < 400, "did not wait for the lock");
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"]);
});

// Makes a file or directory as old as what a holder that died 6 seconds ago left behind.
function aged(target) {
    const mtime = new Date(Date.now() - 6000);
    fs.utimesSync(target, mtime, mtime);
}

test("lock path is a symbolic link to a directory with old files: not followed, nothing there is removed, the write is rejected as locked", async (t) => {
    const file = configFile(t);
    const lock = `${file}.lock`;
    const linked = path.join(tmpDir(t), "linked");
    fs.mkdirSync(linked);
    const names = ["4242.0badc0de", "notes.txt"];
    for (const name of names) {
        fs.writeFileSync(path.join(linked, name), "");
        aged(path.join(linked, name));
    }
    fs.symlinkSync(linked, lock);
    const before = fs.readFileSync(file, "utf8");

    const started = Date.now();
    await assert.rejects(updateConfig(file, { enabled: false }), /locked/);
    const elapsed = Date.now() - started;

    assert.ok(elapsed >= 500 && elapsed < 1500, `rejected after ${elapsed}ms`);
    assert.deepEqual(fs.readdirSync(linked).sort(), names);
    assert.equal(fs.lstatSync(lock).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["config.json", "config.json.lock"]);
});

test("old entries in the lock directory that are not a holder's file: none is removed, the write is rejected as locked", async (t) => {
    const file = configFile(t);
    const lock = `${file}.lock`;
    const elsewhere = path.join(tmpDir(t), "old-file");
    fs.writeFileSync(elsewhere, "");
    aged(elsewhere);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "notes.txt"), "");
    // the whole name has to be <pid>.<8 hex>, and it has to be a regular file
    fs.writeFileSync(path.join(lock, "4242.0badc0de.bak"), "");
    fs.mkdirSync(path.join(lock, "4242.0badc0de"));
    fs.symlinkSync(elsewhere, path.join(lock, "4343.0badc0de"));
    const names = fs.readdirSync(lock).sort();
    for (const name of names) aged(path.join(lock, name));
    const before = fs.readFileSync(file, "utf8");

    const started = Date.now();
    await assert.rejects(updateConfig(file, { enabled: false }), /locked/);
    const elapsed = Date.now() - started;

    assert.ok(elapsed >= 500 && elapsed < 1500, `rejected after ${elapsed}ms`);
    assert.deepEqual(fs.readdirSync(lock).sort(), names);
    assert.equal(fs.existsSync(elsewhere), true);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["config.json", "config.json.lock"]);
});

test("empty lock directory left by a crash between a holder's two steps of giving it up: not held", async (t) => {
    const file = configFile(t);
    fs.mkdirSync(`${file}.lock`);

    const started = Date.now();
    assert.deepEqual(await updateConfig(file, { enabled: false }), { ...SAVED, enabled: false });
    assert.ok(Date.now() - started < 400, "did not wait for the lock");
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"]);
});

test("two writers judge the same lock stale: one takes it over, the other waits its turn; both changes are kept", async (t) => {
    for (const form of ["directory", "file"]) {
        const file = configFile(t);
        const lock = `${file}.lock`;
        const holder = staleLock(lock, form);

        const { statSync, renameSync } = fs;
        const events = [];
        let raced = false;
        let first;
        // The second writer has just looked at the dead holder's age when the first one takes the lock over.
        const stat = t.mock.method(fs, "statSync", (target, ...rest) => {
            const result = statSync(target, ...rest);
            if (target === holder && !raced) {
                raced = true;
                first = updateConfig(file, { enabled: false });
            }
            return result;
        });
        const rename = t.mock.method(fs, "renameSync", (from, to) => {
            renameSync(from, to);
            if (to === lock) events.push("lock");
            if (to === file) events.push("save");
        });

        const second = updateConfig(file, { theme: "auto" });
        await Promise.all([first, second]);
        stat.mock.restore();
        rename.mock.restore();

        assert.deepEqual(events, ["lock", "save", "lock", "save"], form);
        assert.deepEqual(loadConfig(file), { ...SAVED, enabled: false, theme: "auto" }, form);
        assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"], form);
    }
});

test("a writer whose lock was taken over while it worked rejects, saves nothing and does not remove the new holder's lock", async (t) => {
    const file = configFile(t);
    const lock = `${file}.lock`;
    const { writeFileSync } = fs;
    // The writer stalled for more than 5 seconds with its temp file written. Another session took
    // the lock over, saved its own change and still holds the lock.
    t.mock.method(fs, "writeFileSync", (target, ...rest) => {
        writeFileSync(target, ...rest);
        if (!String(target).endsWith(".tmp")) return;
        fs.rmSync(lock, { recursive: true });
        fs.mkdirSync(lock);
        writeFileSync(path.join(lock, "another-session"), "");
        writeFileSync(file, JSON.stringify({ ...SAVED, theme: "auto" }));
    });

    await assert.rejects(updateConfig(file, { enabled: false }), /config lock was taken over by another session/);

    assert.deepEqual(loadConfig(file), { ...SAVED, theme: "auto" });
    assert.deepEqual(fs.readdirSync(lock), ["another-session"]);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["config.json", "config.json.lock"]);
});

// Runs updateConfig(file, change) in a process of its own, starting at the wall-clock time `at`.
function writerProcess(file, change, at) {
    const module = fileURLToPath(new URL("../../extension/lib/config.mjs", import.meta.url));
    const script = `
        const [module, file, change, at] = process.argv.slice(1);
        const { updateConfig } = await import(module);
        while (Date.now() < Number(at));
        await updateConfig(file, JSON.parse(change));
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, module, file, JSON.stringify(change), String(at)], {
        stdio: "ignore",
    });
    return new Promise((resolve) => child.on("close", resolve));
}

test("six processes go for the same stale lock at the same moment: every change is kept, nothing is left behind", { timeout: 60_000 }, async (t) => {
    const changes = [
        { enabled: false },
        { layout: { position: "top" } },
        { layout: { size: 55 } },
        { theme: "auto" },
        { enabled: false },
        { theme: "auto" },
    ];
    for (const form of ["directory", "file", "directory", "file"]) {
        const file = configFile(t, DEFAULTS);
        staleLock(`${file}.lock`, form);

        const at = Date.now() + 300;
        const codes = await Promise.all(changes.map((change) => writerProcess(file, change, at)));

        assert.deepEqual(codes, changes.map(() => 0), form);
        assert.deepEqual(loadConfig(file), { enabled: false, layout: { position: "top", size: 55 }, theme: "auto" }, form);
        assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"], form);
    }
});

test("listThemes: mine.json, \"Bad Name.json\", x.txt and a directory named dir.json → only mine", (t) => {
    const dir = tmpDir(t);
    fs.writeFileSync(path.join(dir, "mine.json"), "{}");
    fs.writeFileSync(path.join(dir, "Bad Name.json"), "{}");
    fs.writeFileSync(path.join(dir, "x.txt"), "{}");
    fs.mkdirSync(path.join(dir, "dir.json"));

    assert.deepEqual(listThemes(dir), ["mine"]);
});

test("listThemes: missing directory → empty list, does not throw", (t) => {
    assert.deepEqual(listThemes(path.join(tmpDir(t), "themes")), []);
});

test("parseCommand: empty, status, on, OFF, hide, SHOW, layout, layout top, layout top 25, layout top 25%, extra whitespace", () => {
    const cases = [
        ["", { action: "status" }],
        [undefined, { action: "status" }],
        ["status", { action: "status" }],
        ["on", { action: "on" }],
        ["OFF", { action: "off" }],
        ["hide", { action: "hide" }],
        ["SHOW", { action: "show" }],
        ["help", { action: "help" }],
        ["layout", { action: "showLayout" }],
        ["layout top", { action: "layout", position: "top" }],
        ["layout top 25", { action: "layout", position: "top", size: 25 }],
        ["layout top 25%", { action: "layout", position: "top", size: 25 }],
        ["   ", { action: "status" }],
        ["  on  ", { action: "on" }],
        ["  layout   top \t 25%  ", { action: "layout", position: "top", size: 25 }],
        ["\tLAYOUT\tLeft\t40\n", { action: "layout", position: "left", size: 40 }],
        ["layout right 10", { action: "layout", position: "right", size: 10 }],
        ["layout bottom 80%", { action: "layout", position: "bottom", size: 80 }],
        ["layout top 33.6", { action: "layout", position: "top", size: 34 }],
    ];
    for (const [args, expected] of cases) {
        assert.deepEqual(parseCommand(args), expected, `args ${JSON.stringify(args)}`);
    }
});

test("parseCommand: layout middle, layout top 5, layout top abc, bogus → error with the reason and the valid values", () => {
    const cases = [
        ["layout middle", [/middle/, /right/, /left/, /top/, /bottom/]],
        ["layout top 5", [/5/, /10/, /80/]],
        ["layout top abc", [/abc/, /10/, /80/]],
        ["bogus", [/bogus/, /on/, /off/, /hide/, /show/, /layout/, /theme/, /status/, /help/]],
        ["layout top 9", [/10/, /80/]],
        ["layout top 81%", [/10/, /80/]],
        ["layout top -25", [/10/, /80/]],
        ["layout top %", [/10/, /80/]],
        ["layout top 25%%", [/10/, /80/]],
        ["layout top 1e1", [/10/, /80/]],
        ["layout 40", [/40/, /right/, /left/, /top/, /bottom/]],
        ["layout top 25 30", [/30/]],
        ["off now", [/now/]],
        ["constructor", [/constructor/]],
    ];
    for (const [args, patterns] of cases) {
        const result = parseCommand(args);
        assert.equal(result.action, "error", `args ${JSON.stringify(args)}`);
        for (const pattern of patterns) assert.match(result.message, pattern, `args ${JSON.stringify(args)}`);
        assert.equal("size" in result || "position" in result || "theme" in result, false);
    }
});

test("parseCommand: theme, theme auto, theme My-Theme, theme ../x → showTheme, theme auto, theme lower-cased, error", () => {
    assert.deepEqual(parseCommand("theme"), { action: "showTheme" });
    assert.deepEqual(parseCommand("theme auto"), { action: "theme", theme: "auto" });
    assert.deepEqual(parseCommand("theme My-Theme"), { action: "theme", theme: "my-theme" });
    assert.deepEqual(parseCommand("  THEME   GTA6 "), { action: "theme", theme: "gta6" });

    for (const args of ["theme ../x", "theme -x", `theme ${"a".repeat(33)}`, "theme a b"]) {
        const result = parseCommand(args);
        assert.equal(result.action, "error", `args ${JSON.stringify(args)}`);
        assert.equal("theme" in result, false);
        assert.equal(typeof result.message, "string");
    }
    assert.match(parseCommand("theme ../x").message, /theme/);
    assert.match(parseCommand("theme ../x").message, /a-z/);
});

test("describe: one line with switch, layout and theme", () => {
    assert.equal(describe(DEFAULTS), "FleetPane: on · layout right 33% · theme gta6");
    assert.equal(
        describe({ enabled: false, layout: { position: "top", size: 25 }, theme: "auto" }),
        "FleetPane: off · layout top 25% · theme auto",
    );
});
