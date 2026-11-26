import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
    createPaneController,
    directionFor,
    findTty,
    parseSplitResult,
    readSize,
    runFile,
    shellQuote,
} from "../../extension/lib/pane.mjs";
import {
    answerSplit,
    attemptOf,
    collapse,
    command,
    connect,
    countsOf,
    deferred,
    disconnect,
    failuresLeft,
    flush,
    FULL,
    HOLD,
    measuredBefore,
    SCRIPT,
    setup,
    socketOf,
    SPLIT,
    THEMES,
    timeoutError,
    toAwaiting,
    toOpen,
    TTY,
    turn,
    unauthorized,
} from "./pane-fakes.mjs";

const scratch = mkdtempSync(join(process.env.FLEETPANE_TEST_TMPDIR || "/tmp", "fp-pane-"));
// On exit rather than in an after() hook, so that a crashing run does not leave the directory behind either.
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const notExecutable = join(scratch, "fleetpane");
writeFileSync(notExecutable, "#!/bin/sh\n", { mode: 0o644 });

const stdout = (text) => ({ stdout: text, stderr: "" });

describe("shellQuote", () => {
    for (const [name, value] of [
        ["plain path", "/Users/me/.copilot/extensions/fleetpane/bin/fleetpane"],
        ["path with spaces", "/Users/me/Application Support/fleet pane/bin"],
        ["path with a single quote", "/Users/o'brien/it's here/bin"],
    ]) {
        it(`${name} survives sh -c 'printf %s …'`, () => {
            const back = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" });
            assert.equal(back, value);
        });
    }
});

describe("directionFor", () => {
    it("maps the four positions to Ghostty split directions", () => {
        assert.deepEqual(
            ["right", "left", "top", "bottom"].map(directionFor),
            ["right", "left", "up", "down"],
        );
    });

    it("gives nothing for anything else", () => {
        assert.equal(directionFor("middle"), undefined);
        assert.equal(directionFor("constructor"), undefined);
    });
});

describe("parseSplitResult", () => {
    it("ok ABC focus=restored", () => {
        assert.deepEqual(parseSplitResult("ok ABC focus=restored\n"), { kind: "ok", paneId: "ABC", focus: "restored" });
    });

    it("ok ABC focus=failed", () => {
        assert.deepEqual(parseSplitResult("ok ABC focus=failed\n"), { kind: "ok", paneId: "ABC", focus: "failed" });
    });

    it("ok with a UUID and focus=skipped", () => {
        assert.deepEqual(
            parseSplitResult("ok 5E3C1A2B-0000-4F6A-9C1D-ABCDEF012345 focus=skipped"),
            { kind: "ok", paneId: "5E3C1A2B-0000-4F6A-9C1D-ABCDEF012345", focus: "skipped" },
        );
    });

    it("deferred, not-found, not-running", () => {
        assert.deepEqual(parseSplitResult("deferred\n"), { kind: "deferred" });
        assert.deepEqual(parseSplitResult("not-found\n"), { kind: "not-found" });
        assert.deepEqual(parseSplitResult("not-running\n"), { kind: "not-running" });
    });

    it("garbage gives null", () => {
        for (const text of ["", "\n", "wat", "ok", "ok ABC", "ok ABC focus=maybe", "ok A;B focus=restored", "okABC focus=restored", null, undefined]) {
            assert.equal(parseSplitResult(text), null, JSON.stringify(text));
        }
    });

    it("rejects a terminal id the close action would not accept", () => {
        assert.equal(parseSplitResult(`ok ${"A".repeat(65)} focus=restored`), null);
        assert.equal(parseSplitResult("ok $(reboot) focus=restored"), null);
    });
});

describe("findTty", () => {
    it("first level is ??, second is ttys003: tty, the pid that owns it, and its lstart", async () => {
        const seen = [];
        const run = async (file, args) => {
            const key = `${file} ${args.join(" ")}`;
            seen.push(key);
            if (key === "ps -o ppid=,tty= -p 100") return stdout("  200 ??      \n");
            if (key === "ps -o ppid=,tty= -p 200") return stdout("    1 ttys003 \n");
            if (key === "ps -o lstart= -p 200") return stdout("Wed Nov 25 10:06:44 2026\n");
            throw new Error(`unexpected call: ${key}`);
        };
        assert.deepEqual(await findTty({ pid: 100, run }), {
            tty: "/dev/ttys003",
            pid: 200,
            started: "Wed Nov 25 10:06:44 2026",
        });
        assert.deepEqual(seen, ["ps -o ppid=,tty= -p 100", "ps -o ppid=,tty= -p 200", "ps -o lstart= -p 200"]);
    });

    it("always ??: null after six levels", async () => {
        let lookups = 0;
        const run = async (file, args) => {
            lookups += 1;
            return stdout(`${Number(args.at(-1)) + 1} ??\n`);
        };
        assert.equal(await findTty({ pid: 100, run }), null);
        assert.equal(lookups, 6);
    });

    it("garbage output: null", async () => {
        assert.equal(await findTty({ pid: 100, run: async () => stdout("%%% not ps output\n") }), null);
        assert.equal(await findTty({ pid: 100, run: async () => stdout("") }), null);
    });

    it("a tty that is not /dev/ttysNNN: null", async () => {
        assert.equal(await findTty({ pid: 100, run: async () => stdout("    1 console\n") }), null);
    });

    it("ps fails: null, never throws", async () => {
        const run = async () => {
            throw new Error("ps: No such process");
        };
        assert.equal(await findTty({ pid: 100, run }), null);
    });

    it("lstart unavailable: started is the empty string", async () => {
        const run = async (file, args) => {
            if (args[1] === "lstart=") throw new Error("ps failed");
            return stdout("    1 ttys007\n");
        };
        assert.deepEqual(await findTty({ pid: 100, run }), { tty: "/dev/ttys007", pid: 100, started: "" });
    });
});

describe("readSize", () => {
    it("asks stty for the size of the tty", async () => {
        const seen = [];
        const run = async (file, args) => {
            seen.push([file, ...args]);
            return stdout("45 170\n");
        };
        assert.deepEqual(await readSize("/dev/ttys003", run), { rows: 45, cols: 170 });
        assert.deepEqual(seen, [["stty", "-f", "/dev/ttys003", "size"]]);
    });

    it("never throws: a failing stty or garbage gives null", async () => {
        const failing = async () => {
            throw new Error("stty: /dev/ttys003: Device not configured");
        };
        assert.equal(await readSize("/dev/ttys003", failing), null);
        assert.equal(await readSize("/dev/ttys003", async () => stdout("speed 9600 baud;\n")), null);
        assert.equal(await readSize("/dev/ttys999999"), null);
    });
});

describe("runFile", () => {
    const settled = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
    const gone = (pid) => assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });

    it("resolves with stdout and stderr; the child's stdin is closed, not inherited", async () => {
        const out = await runFile("/bin/sh", ["-c", "cat; printf hi; printf warn >&2"], { timeoutMs: 5000 });
        assert.deepEqual(out, { stdout: "hi", stderr: "warn" });
    });

    it("rejects on a non-zero exit, carrying stderr", async () => {
        const { error } = await settled(runFile("/bin/sh", ["-c", "printf 'boom (-1743)' >&2; exit 3"], { timeoutMs: 5000 }));
        assert.equal(error.stderr, "boom (-1743)");
        assert.equal(error.code, 3);
        assert.equal(error.timedOut, false);
    });

    it("rejects when the file cannot be started", async () => {
        const { error } = await settled(runFile(join(scratch, "missing"), [], { timeoutMs: 5000 }));
        assert.equal(error.code, "ENOENT");
        assert.equal(error.timedOut, false);
    });

    it("timeout: SIGTERM, rejected with timedOut, the child is gone", async () => {
        const { error } = await settled(runFile("/bin/sh", ["-c", "echo $$; exec sleep 5"], { timeoutMs: 300 }));
        assert.equal(error.timedOut, true);
        assert.equal(error.signal, "SIGTERM");
        gone(Number(error.stdout));
    });

    it("timeout: a child that ignores SIGTERM gets SIGKILL one second later", async () => {
        const started = Date.now();
        const { error } = await settled(runFile("/bin/sh", ["-c", "trap '' TERM; echo $$; exec sleep 5"], { timeoutMs: 300 }));
        const elapsed = Date.now() - started;
        assert.equal(error.timedOut, true);
        assert.equal(error.signal, "SIGKILL");
        assert.ok(elapsed >= 1200 && elapsed < 4000, `took ${elapsed}ms`);
        gone(Number(error.stdout));
    });

    it("kill() ends a child that ignores SIGTERM at once", async () => {
        const started = Date.now();
        const call = runFile("/bin/sh", ["-c", "trap '' TERM; exec sleep 5"], { timeoutMs: 5000 });
        call.kill();
        const { error } = await settled(call);
        assert.equal(error.signal, "SIGKILL");
        assert.equal(error.timedOut, false);
        assert.ok(Date.now() - started < 1000);
    });
});

// ---------------------------------------------------------------------------
// The controller. Every dependency is a fake; time only moves when a test advances the clock.

describe("controller: a turn starts", () => {
    it("prompt while idle: one rotate; one run with split, the tty, right and the quoted command", async () => {
        const h = setup();
        assert.deepEqual(h.pane.status(), { state: "idle", reason: "", override: "none" });
        await turn(h);
        assert.equal(h.state(), "opening");
        assert.equal(h.rotates.length, 1);
        assert.equal(h.calls.length, 1);
        const [call] = h.calls;
        assert.equal(call.file, "osascript");
        assert.deepEqual(call.args, [
            SCRIPT,
            "split",
            TTY,
            "right",
            `${shellQuote("/bin/sh")} --socket ${shellQuote(socketOf(h))} --themes ${shellQuote(THEMES)} --close-pane ${shellQuote(SCRIPT)}`,
        ]);
        assert.deepEqual(call.opts, { timeoutMs: 20000 });
    });

    it("the command handed to the script: --socket is the path rotate returned, --themes the themes dir, --close-pane the script path, all quoted", async () => {
        const h = setup();
        await turn(h);
        const words = execFileSync(
            "/bin/sh",
            ["-c", `for word in ${h.calls[0].args[4]}; do printf '%s\\n' "$word"; done`],
            { encoding: "utf8" },
        );
        assert.deepEqual(words.split("\n").slice(0, -1), ["/bin/sh", "--socket", socketOf(h), "--themes", THEMES, "--close-pane", SCRIPT]);
    });

    it("two onTurnStart calls before the override read-back has finished are merged into one open: one rotate, one split", async () => {
        const h = setup();
        h.pane.onTurnStart();
        h.pane.onTurnStart();
        assert.equal(h.overrideReads.length, 0);
        await flush();
        assert.equal(h.rotates.length, 1);
        assert.equal(h.splits().length, 1);
    });

    it("two onTurnStart calls in a row after the read-back, the first precheck still pending: one precheck, one rotate, one split", async () => {
        const gate = deferred();
        let prechecks = 0;
        const interactive = () => {
            prechecks += 1;
            return gate.promise;
        };
        const h = setup({ deps: { interactive } });
        await flush();
        assert.equal(h.overrideReads.length, 1);
        h.pane.onTurnStart();
        h.pane.onTurnStart();
        assert.equal(h.state(), "opening");
        await flush();
        assert.equal(prechecks, 1);
        gate.resolve(true);
        await flush();
        assert.equal(h.rotates.length, 1);
        assert.equal(h.splits().length, 1);
    });

    it("prompt while the split is still pending: no second split", async () => {
        const h = setup();
        await turn(h);
        await turn(h);
        assert.equal(h.state(), "opening");
        assert.equal(h.rotates.length, 1);
        assert.equal(h.splits().length, 1);
    });

    it("prompt after the script returned but before the client connected: no second split", async () => {
        const h = setup();
        await toAwaiting(h);
        await turn(h);
        assert.equal(h.state(), "awaiting");
        assert.equal(h.rotates.length, 1);
        assert.equal(h.splits().length, 1);
    });

    it("prompt while the client is connected: nothing is called", async () => {
        const h = setup();
        await toOpen(h);
        const counts = countsOf(h);
        await turn(h);
        assert.equal(h.state(), "open");
        assert.deepEqual(countsOf(h), counts);
    });

    it("config enabled: false: nothing is called", async () => {
        const h = setup({ config: { enabled: false } });
        await turn(h);
        assert.equal(h.state(), "idle");
        assert.deepEqual(countsOf(h), { rotates: 0, calls: 0, reads: 0, closes: 0 });
    });

    it("the tty is looked up once and reused by later opens", async () => {
        const h = setup();
        await toOpen(h);
        await disconnect(h);
        await collapse(h);
        await turn(h);
        assert.equal(h.splits().length, 2);
        assert.equal(h.ttyLookups, 1);
    });
});

describe("controller: the user closes the connected panel", () => {
    it("client disconnects, no new turn meanwhile: closing with close <paneId> at once, idle once the pane is gone; no split, no failure counted", async () => {
        const h = setup();
        await toOpen(h);
        const closes = h.closes;
        h.plan.close.push("ok");    // delivered; the pane takes a moment to go
        await disconnect(h);
        assert.equal(h.state(), "closing");
        assert.ok(h.closes > closes);
        const close = h.calls.find((call) => call.action === "close");
        assert.deepEqual(close.args, [SCRIPT, "close", "P1"]);
        assert.deepEqual(close.opts, { timeoutMs: 5000 });
        await h.clock.advance(100);
        assert.equal(h.state(), "closing");
        await collapse(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.clock.armed(), 0);
        assert.equal(h.splits().length, 1);
        assert.deepEqual(h.closedPanes(), ["P1"]);
        assert.equal(await failuresLeft(h), 2);
    });

    it("same, but a new turn starts before the pane is gone: no split yet; one reopen afterwards, measuring the single-pane size", async () => {
        const h = setup();
        await toOpen(h);
        h.plan.close.push("ok");    // delivered; the pane takes a moment to go
        await disconnect(h);
        await turn(h);
        await h.clock.advance(100);
        assert.equal(h.state(), "closing");
        assert.equal(h.splits().length, 1);
        await collapse(h);
        assert.equal(h.state(), "opening");
        assert.equal(h.clock.armed(), 0);
        assert.equal(h.splits().length, 2);
        assert.deepEqual(h.splits()[1].panes, []);
        assert.deepEqual(measuredBefore(h), FULL);
        await h.clock.advance(3000);
        assert.equal(h.splits().length, 2);
    });

    it("the pane stays although close answered ok: idle after 2s, the prompt recorded meanwhile does not reopen, one failure counted", async () => {
        const h = setup();
        await toOpen(h);
        h.plan.close.push("ok");    // Ghostty answered, yet the pane stays on screen (it asks for confirmation)
        await disconnect(h);
        await turn(h);
        await h.clock.advance(1999);
        assert.equal(h.state(), "closing");
        await h.clock.advance(1);
        assert.equal(h.state(), "idle");
        assert.equal(h.clock.armed(), 0);
        await h.clock.advance(10000);
        assert.equal(h.splits().length, 1);
        assert.deepEqual(h.closedPanes(), ["P1"]);
        h.panes.delete("P1");
        h.size = FULL;
        assert.equal(await failuresLeft(h), 1);
    });

    it("a panel whose pane id never arrived (the script failed after the client had connected), top split: it counts as collapsed only when the rows are back", async () => {
        const h = setup({ config: { layout: { position: "top", size: 33 } } });
        await turn(h);
        await connect(h);
        h.splits()[0].fail(new Error("osascript: boom"));
        await flush();
        h.size = { rows: 30, cols: 170 };
        await disconnect(h);
        await h.clock.advance(100);
        assert.equal(h.state(), "closing");
        await collapse(h);
        assert.equal(h.state(), "idle");
        assert.deepEqual(h.calls.map((call) => call.action), ["split"]);
    });

    it("client disconnects, back to idle, then a new turn: opens again with a larger rotate attempt", async () => {
        const h = setup();
        await toOpen(h);
        await disconnect(h);
        await collapse(h);
        assert.equal(h.state(), "idle");
        await turn(h);
        assert.equal(h.state(), "opening");
        assert.equal(h.rotates.length, 2);
        assert.ok(h.rotates[1] > h.rotates[0]);
        assert.equal(h.splits().length, 2);
    });

    it("prompt while awaiting, then the client connects, later the user closes the pane: idle, no reopen", async () => {
        const h = setup();
        await toAwaiting(h);
        await turn(h);
        await connect(h);
        assert.equal(h.state(), "open");
        assert.equal(h.clock.armed(), 0);
        await disconnect(h);
        await collapse(h);
        assert.equal(h.state(), "idle");
        await h.clock.advance(10000);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 1);
    });
});

describe("controller: small window", () => {
    const tooSmall = (h) => h.logs.filter((entry) => entry.kind === "pane" && entry.reason === "too-small");

    it("right 33 on a 45x60 Copilot pane (panel about 20 columns): no rotate, no split, idle, no failure, no notification", async () => {
        const h = setup();
        h.size = { rows: 45, cols: 60 };
        await turn(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.rotates.length, 0);
        assert.equal(h.calls.length, 0);
        assert.deepEqual(h.notes, []);
        assert.equal(tooSmall(h).length, 1);
        assert.equal(tooSmall(h)[0].to, "idle");
        h.size = FULL;
        assert.equal(await failuresLeft(h), 2);
    });

    it("same, then the next turn measures 45x170: opens normally", async () => {
        const h = setup();
        h.size = { rows: 45, cols: 60 };
        await turn(h);
        h.size = FULL;
        await turn(h);
        assert.equal(h.state(), "opening");
        assert.equal(h.rotates.length, 1);
        assert.equal(h.splits().length, 1);
    });

    it("top 33 on 15x170 (panel about 5 rows) does not open; right 33 on 45x73 (panel 24 columns) does", async () => {
        const top = setup({ config: { layout: { position: "top", size: 33 } } });
        top.size = { rows: 15, cols: 170 };
        await turn(top);
        assert.equal(top.state(), "idle");
        assert.equal(top.splits().length, 0);
        assert.equal(tooSmall(top).length, 1);

        const right = setup();
        right.size = { rows: 45, cols: 73 };
        await turn(right);
        assert.equal(right.state(), "opening");
        assert.equal(right.splits().length, 1);
    });

    it("the panel size is rounded: 72 columns give 24 and open, 71 give 23 and do not; 17 rows give 6, 16 give 5", async () => {
        for (const [position, size, opens] of [
            ["right", { rows: 45, cols: 72 }, true],
            ["left", { rows: 45, cols: 71 }, false],
            ["bottom", { rows: 17, cols: 170 }, true],
            ["top", { rows: 16, cols: 170 }, false],
        ]) {
            const h = setup({ config: { layout: { position, size: 33 } } });
            h.size = size;
            await turn(h);
            assert.equal(h.splits().length, opens ? 1 : 0, `${position} ${size.rows}x${size.cols}`);
        }
    });

    it("three turns in a row are too small, then the window grows: the fourth turn opens, never disabled", async () => {
        const h = setup();
        h.size = { rows: 45, cols: 60 };
        for (let n = 0; n < 3; n += 1) {
            await turn(h);
            assert.equal(h.state(), "idle");
        }
        h.size = FULL;
        await turn(h);
        assert.equal(h.state(), "opening");
        assert.equal(h.splits().length, 1);
        assert.deepEqual(h.notes, []);
    });
});

describe("controller: config changed by another session", () => {
    it("pane open, config becomes enabled: false elsewhere, then a prompt: server.close(), closing, idle once the pane is gone; no split", async () => {
        const h = setup();
        await toOpen(h);
        const closes = h.closes;
        h.config.enabled = false;
        await turn(h);
        assert.equal(h.state(), "closing");
        assert.ok(h.closes > closes);
        await collapse(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 1);
        assert.deepEqual(h.updates, []);
    });

    it("session A runs off, another session sets enabled: true again, A gets a prompt: rotate + split, the client is accepted, open", async () => {
        const h = setup();
        await toOpen(h);
        await command(h, "off");
        await collapse(h);
        assert.equal(h.state(), "idle");
        h.config.enabled = true;
        await turn(h);
        assert.equal(h.rotates.length, 2);
        assert.equal(h.splits().length, 2);
        await answerSplit(h, "P2");
        await connect(h);
        assert.equal(h.state(), "open");
    });
});

describe("controller: flags and the latest config", () => {
    it("a pane closed because the config was switched off elsewhere does not reopen for a prompt recorded earlier", async () => {
        const h = setup();
        await toAwaiting(h);
        await turn(h);
        h.config.enabled = false;
        await turn(h);
        assert.equal(h.state(), "closing");
        h.config.enabled = true;     // switched on again elsewhere; this session has no turn meanwhile
        await collapse(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 1);
    });

    it("closing after a layout change, a turn reads the switch as off, then it is on again elsewhere before the pane has collapsed: idle, no reopen", async () => {
        const h = setup();
        await toOpen(h);
        await command(h, "layout", { position: "top", size: 25 });
        assert.equal(h.state(), "closing");
        h.config.enabled = false;
        await turn(h);
        h.config.enabled = true;     // this session has no turn or command meanwhile
        await collapse(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 1);
    });

    it("the reopen after closing goes by the config as it is by then", async () => {
        const off = setup();
        await toOpen(off);
        await disconnect(off);
        await turn(off);
        off.config.enabled = false;
        await collapse(off);
        assert.equal(off.state(), "idle");
        assert.equal(off.splits().length, 1);

        const moved = setup();
        await toOpen(moved);
        await disconnect(moved);
        await turn(moved);
        moved.config.layout = { position: "bottom", size: 50 };
        await collapse(moved);
        assert.equal(moved.splits().length, 2);
        assert.equal(moved.splits()[1].args[3], "down");
    });

    it("layout during an open that then fails is not carried into the next open", async () => {
        const h = setup();
        await turn(h);
        await command(h, "layout", { position: "left", size: 40 });
        h.splits()[0].fail(timeoutError());
        await flush();
        assert.equal(h.state(), "idle");
        await toOpen(h, "P2");
        assert.equal(h.splits()[1].args[3], "left");
        await h.clock.advance(3000);
        assert.equal(h.state(), "open");
        assert.equal(h.splits().length, 2);
    });

    it("theme() is the theme of the most recent config read", async () => {
        const h = setup({ config: { theme: "auto" } });
        assert.equal(h.pane.theme(), "auto");
        h.config.theme = "solarized";
        assert.equal(h.pane.theme(), "auto");
        await turn(h);
        assert.equal(h.pane.theme(), "solarized");
    });
});

describe("controller: what the split script answers", () => {
    for (const answer of ["not-found", "not-running"]) {
        it(`script answers ${answer}: disabled, nothing is called afterwards, no notification`, async () => {
            const h = setup();
            h.plan.split.push(answer);
            await turn(h);
            assert.deepEqual(h.pane.status(), { state: "disabled", reason: answer, override: "none" });
            const counts = countsOf(h);
            await turn(h);
            assert.deepEqual(countsOf(h), counts);
            assert.deepEqual(h.notes, []);
        });
    }

    it("script answers deferred: back to idle, no failure, no notification; the next turn tries again", async () => {
        const h = setup();
        h.plan.split.push("deferred", "deferred");
        await turn(h);
        assert.equal(h.state(), "idle");
        assert.deepEqual(h.notes, []);
        await turn(h);
        assert.equal(h.splits().length, 2);
        assert.equal(h.state(), "idle");
        assert.equal(await failuresLeft(h), 2);
    });

    it("script answers ok … focus=failed: awaiting as usual, no failure counted", async () => {
        const h = setup();
        h.plan.split.push("ok P1 focus=failed");
        await turn(h);
        assert.equal(h.state(), "awaiting");
        await command(h, "off");    // ends this open without the 5s timeout, which counts as a failure by itself
        await collapse(h);
        assert.equal(h.state(), "idle");
        h.config.enabled = true;
        assert.equal(await failuresLeft(h), 2);
    });

    it("script reports unauthorized (-1743): disabled, one notification", async () => {
        const h = setup();
        h.plan.split.push(unauthorized());
        await turn(h);
        assert.deepEqual(h.pane.status(), { state: "disabled", reason: "unauthorized", override: "none" });
        assert.equal(h.notes.length, 1);
        assert.equal(h.notes[0].level, "warning");
        assert.match(h.notes[0].text, /Automation/);
        await turn(h);
        assert.equal(h.splits().length, 1);
        assert.equal(h.notes.length, 1);
    });

    it("script times out once: idle; times out again: disabled and one notification", async () => {
        const h = setup();
        h.plan.split.push(timeoutError(), timeoutError());
        await turn(h);
        assert.equal(h.state(), "idle");
        assert.deepEqual(h.notes, []);
        await turn(h);
        assert.equal(h.state(), "disabled");
        assert.equal(h.notes.length, 1);
        assert.equal(h.notes[0].level, "warning");
        await turn(h);
        assert.equal(h.splits().length, 2);
        assert.equal(h.notes.length, 1);
    });

    it("output the parser does not recognise counts as a failure", async () => {
        const h = setup();
        h.plan.split.push("split done");
        await turn(h);
        assert.equal(h.state(), "idle");
        assert.equal(await failuresLeft(h), 1);
    });

    it("server.rotate rejects: one failure, idle, the script is not called", async () => {
        const h = setup();
        h.rotateError = new Error("runtime dir is not private");
        await turn(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.calls.length, 0);
        assert.equal(await failuresLeft(h), 1);
    });

    it("the Copilot pane cannot be measured: one failure, idle, no rotate", async () => {
        const h = setup();
        h.size = null;
        await turn(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.rotates.length, 0);
        h.size = FULL;
        assert.equal(await failuresLeft(h), 1);
    });

    for (const [name, error] of [["times out", timeoutError()], ["fails", new Error("osascript: boom")]]) {
        it(`the script ${name} only after the client connected: still open, server.close() not called, no calibration`, async () => {
            const h = setup();
            await turn(h);
            await connect(h);
            assert.equal(h.state(), "open");
            const closes = h.closes;
            h.splits()[0].fail(error);
            await flush();
            assert.equal(h.state(), "open");
            assert.equal(h.closes, closes);
            assert.equal(h.calls.length, 1);
            assert.deepEqual(h.notes, []);
        });
    }

    it("the client connects before the script answers ok X: stays open and X becomes the pane id", async () => {
        const h = setup();
        await turn(h);
        await connect(h);
        await answerSplit(h, "X");
        assert.equal(h.state(), "open");
        assert.equal(h.calls.length, 1);
        await disconnect(h);
        assert.deepEqual(h.closedPanes(), ["X"]);
    });

    it("the client connects and disconnects, then the script answers ok X: X is closed, idle", async () => {
        const h = setup();
        await turn(h);
        await connect(h);
        await disconnect(h);
        assert.equal(h.state(), "closing");
        await answerSplit(h, "X");
        assert.deepEqual(h.closedPanes(), ["X"]);
        assert.equal(h.splits()[0].kills, 0);
        await collapse(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 1);
    });

    it("same, but the script only answers after closing gave up on it: idle with one failure counted, X is still closed", async () => {
        const h = setup();
        await turn(h);
        await connect(h);
        await disconnect(h);
        await h.clock.advance(2000);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits()[0].kills, 1);
        await answerSplit(h, "X");
        assert.equal(h.state(), "idle");
        assert.deepEqual(h.closedPanes(), ["X"]);
        h.size = FULL;
        assert.equal(await failuresLeft(h), 1);
        assert.deepEqual(h.closedPanes(), ["X"]);    // closing never knew the id, so no pane was remembered
    });
});

describe("controller: no client within 5s", () => {
    it("waiting times out and close answers ok: one failure counted", async () => {
        const h = setup();
        await toAwaiting(h);
        await h.clock.advance(4999);
        assert.equal(h.state(), "awaiting");
        assert.deepEqual(h.closedPanes(), []);
        await h.clock.advance(1);
        assert.equal(h.state(), "closing");
        assert.deepEqual(h.closedPanes(), ["P1"]);
        await collapse(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 1);
        assert.equal(await failuresLeft(h), 1);
    });

    it("waiting times out and close answers gone (the pane closed itself): one failure counted all the same", async () => {
        const h = setup();
        await toAwaiting(h);
        h.panes.delete("P1");
        h.size = FULL;
        await h.clock.advance(5000);
        assert.deepEqual(h.closedPanes(), ["P1"]);
        assert.deepEqual(h.polls(), []);
        await h.clock.advance(100);    // two readings that agree
        assert.equal(h.state(), "idle");
        assert.equal(h.clock.armed(), 0);
        assert.equal(await failuresLeft(h), 1);
    });

    it("a panel that can never connect, three turns in a row: two splits, then disabled with one notification", async () => {
        const h = setup();
        for (const id of ["P1", "P2"]) {
            await turn(h);
            await answerSplit(h, id);
            h.panes.delete(id);    // the panel could not connect and closed its own pane
            h.size = FULL;
            await h.clock.advance(5100);
        }
        assert.deepEqual(h.pane.status(), { state: "disabled", reason: "failed", override: "none" });
        assert.equal(h.notes.length, 1);
        await turn(h);
        await h.clock.advance(5000);
        assert.equal(h.splits().length, 2);
        assert.deepEqual(h.closedPanes(), ["P1", "P2"]);
        assert.equal(h.notes.length, 1);
    });

    it("waiting times out and close itself fails: idle at once, one failure counted, not two", async () => {
        const h = setup();
        await toAwaiting(h);
        h.plan.close.push(new Error("osascript: boom"));
        await h.clock.advance(5000);
        assert.equal(h.state(), "idle");
        assert.equal(h.clock.armed(), 0);
        h.panes.delete("P1");
        h.size = FULL;
        assert.equal(await failuresLeft(h), 1);
    });

    it("prompt while awaiting, then the timeout with close answering gone: reopens once", async () => {
        const h = setup();
        await toAwaiting(h);
        await turn(h);
        h.plan.close.push("gone");
        h.size = FULL;
        await h.clock.advance(5100);
        assert.equal(h.state(), "opening");
        assert.equal(h.splits().length, 2);
        assert.deepEqual(measuredBefore(h), FULL);
        await h.clock.advance(10000);
        assert.equal(h.splits().length, 2);
    });

    it("same, but close answers ok: one failure, then one reopen; a second timeout: disabled, one notification, no further reopen", async () => {
        const h = setup();
        await toAwaiting(h);
        await turn(h);
        await h.clock.advance(5000);
        assert.deepEqual(h.closedPanes(), ["P1"]);
        assert.equal(h.splits().length, 1);
        await collapse(h);
        assert.equal(h.state(), "opening");
        assert.equal(h.splits().length, 2);
        assert.deepEqual(h.notes, []);

        await answerSplit(h, "P2");
        assert.equal(h.state(), "awaiting");
        await turn(h);
        await h.clock.advance(5000);
        assert.deepEqual(h.closedPanes(), ["P1", "P2"]);
        await collapse(h);
        assert.deepEqual(h.pane.status(), { state: "disabled", reason: "failed", override: "none" });
        assert.equal(h.notes.length, 1);
        await h.clock.advance(10000);
        assert.equal(h.splits().length, 2);
        assert.equal(h.notes.length, 1);
    });

    it("timeout with close answering ok and no prompt meanwhile; later an open succeeds and the user closes the pane: idle both times, no automatic reopen", async () => {
        const h = setup();
        await toAwaiting(h);
        await h.clock.advance(5000);
        await collapse(h);
        assert.equal(h.state(), "idle");
        await h.clock.advance(10000);
        assert.equal(h.splits().length, 1);

        await toOpen(h, "P2");
        await disconnect(h);
        await collapse(h);
        assert.equal(h.state(), "idle");
        await h.clock.advance(10000);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 2);
        assert.equal(await failuresLeft(h), 2);    // the connection cleared the earlier failure
    });

    it("a prompt recorded while awaiting does not survive into a later open", async () => {
        const h = setup();
        await toAwaiting(h);
        await turn(h);
        h.config.enabled = false;    // switched off elsewhere; this session has no turn meanwhile
        h.size = FULL;
        await h.clock.advance(5100);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 1);

        await command(h, "on");      // also clears the failure counted above: the next timeout must not trip the breaker
        await answerSplit(h, "P2");
        assert.equal(h.state(), "awaiting");
        h.size = FULL;
        await h.clock.advance(5100);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 2);
    });
});

const unconfirmed = (h) => h.logs.filter((entry) => entry.kind === "pane" && entry.reason === "close-unconfirmed");

describe("controller: closing confirms that the pane is gone", () => {
    for (const action of ["hide", "off"]) {
        it(`${action} right after the split answered, while the reading still shows the size from before the split: that reading proves nothing, the closing lasts until the pane is gone`, async () => {
            const h = setup();
            await turn(h);
            h.splits()[0].ok("ok P1 focus=restored");    // the reading lags behind the split: it still says FULL
            await flush();
            assert.equal(h.state(), "awaiting");
            h.plan.close.push("ok");                      // delivered; the pane takes a moment to go
            await command(h, action);
            assert.deepEqual(h.closedPanes(), ["P1"]);
            await h.clock.advance(150);
            assert.equal(h.state(), "closing");
            await collapse(h);
            assert.equal(h.state(), "idle");
            assert.deepEqual(unconfirmed(h), []);
        });
    }

    // A layout change with a prompt recorded meanwhile is the strongest reason there is to reopen.
    for (const [name, action, answer, waits] of [
        ["close never answers", "close", HOLD, true],
        ["close answers ok but the pane stays", "close", "ok", true],
        ["close answers ok, then the script never says whether the pane is still there", "exists", HOLD, true],
        ["close fails", "close", new Error("osascript: boom"), false],
        ["close answers something else", "close", "fail", false],
    ]) {
        it(`${name}: unconfirmed ${waits ? "after 2s" : "at once"}; no reopen, one failure counted, the pane is remembered`, async () => {
            const h = setup();
            await toOpen(h);
            h.plan[action].push(answer);
            await command(h, "layout", { position: "top", size: 25 });
            assert.deepEqual(h.closedPanes(), ["P1"]);
            if (waits) {
                await turn(h);
                await h.clock.advance(1999);
                assert.equal(h.state(), "closing");
                assert.equal(h.calls.at(-1).kills, 0);
                await h.clock.advance(1);
                assert.equal(h.calls.at(-1).kills, answer === HOLD ? 1 : 0);
            }
            assert.equal(h.state(), "idle");
            assert.equal(h.clock.armed(), 0);
            assert.equal(unconfirmed(h).length, 2);    // what was left behind, then the transition
            assert.equal(unconfirmed(h)[0].leftover, "P1");
            assert.equal(unconfirmed(h)[1].to, "idle");
            await h.clock.advance(10000);
            assert.equal(h.splits().length, 1);
            assert.deepEqual(h.notes, []);

            h.panes.delete("P1");    // by the next turn the pane has closed itself
            h.size = FULL;
            assert.equal(await failuresLeft(h), 1);
            assert.deepEqual(h.closedPanes(), ["P1", "P1"]);
        });
    }

    it("two unconfirmed closings in a row: disabled, one notification", async () => {
        const h = setup();
        await toOpen(h);
        h.plan.close.push(HOLD);
        await disconnect(h);
        await h.clock.advance(2000);
        assert.equal(h.state(), "idle");
        assert.deepEqual(h.notes, []);

        h.panes.delete("P1");
        h.size = FULL;
        await turn(h);
        await h.clock.advance(100);    // the pane left behind is gone, and two readings agree
        await answerSplit(h, "P2");
        assert.equal(h.state(), "awaiting");
        h.plan.close.push(HOLD);
        await command(h, "hide");
        await h.clock.advance(2000);
        assert.deepEqual(h.pane.status(), { state: "disabled", reason: "failed", override: "hidden" });
        assert.equal(h.notes.length, 1);
        assert.equal(unconfirmed(h).at(-1).leftover, "P2");
        await h.clock.advance(10000);
        assert.equal(h.splits().length, 2);
    });

    it("no pane id, so the reading decides; slow readings do not stretch the 2s: a reading that arrives later is dropped", async () => {
        const h = setup();
        await turn(h);
        await connect(h);
        h.splits()[0].fail(new Error("osascript: boom"));    // the panel runs, but its pane id never arrived
        await flush();
        h.size = SPLIT;
        h.readDelay = 900;
        await disconnect(h);            // readings arrive at 900ms and 1850ms; the third one would at 2800ms
        await h.clock.advance(1900);
        h.size = FULL;
        await h.clock.advance(99);
        assert.equal(h.state(), "closing");
        await h.clock.advance(1);
        assert.equal(h.state(), "idle");
        await h.clock.advance(1000);
        assert.equal(unconfirmed(h).length, 2);
    });

    it("close answers ok while the pane is still there: it is asked for at once and every 100ms after that; the closing ends once the answer is gone and the reading has settled", async () => {
        const h = setup();
        await toOpen(h);
        h.plan.close.push("ok");          // delivered; the pane takes a moment to go
        await disconnect(h);
        assert.deepEqual(h.polls().map((call) => call.args), [[SCRIPT, "exists", "P1"]]);
        assert.deepEqual(h.polls()[0].opts, { timeoutMs: 1000 });
        const reads = h.reads.length;
        await h.clock.advance(250);
        assert.equal(h.polls().length, 3);
        assert.equal(h.state(), "closing");
        assert.equal(h.reads.length, reads);
        h.panes.delete("P1");
        h.size = FULL;
        await h.clock.advance(50);
        assert.equal(h.polls().length, 4);
        await h.clock.advance(99);        // the readings at 350ms and 400ms agree
        assert.equal(h.state(), "closing");
        await h.clock.advance(1);
        assert.equal(h.state(), "idle");
        assert.equal(h.clock.armed(), 0);
        assert.equal(h.polls().length, 4);
        assert.deepEqual(unconfirmed(h), []);
        assert.equal(await failuresLeft(h), 2);
    });

    it("the pane is gone just before the 2s are over: waiting for the reading to settle goes on past them, and the closing is still confirmed", async () => {
        const h = setup();
        await toOpen(h);
        h.plan.close.push("ok");          // delivered; the pane takes its time to go
        await disconnect(h);
        await turn(h);
        await h.clock.advance(1850);
        h.panes.delete("P1");
        await h.clock.advance(100);       // gone at the poll at 1900ms; the reading at 1950ms still says SPLIT
        h.size = FULL;
        await h.clock.advance(99);        // 2000ms: changed; 2049ms: the next reading is still to come
        assert.equal(h.state(), "closing");
        await h.clock.advance(1);
        assert.equal(h.state(), "opening");
        assert.deepEqual(measuredBefore(h), FULL);
        assert.deepEqual(unconfirmed(h), []);
    });

    it("an exists call that fails or answers anything but gone proves nothing: the pane counts as still there and is asked for again", async () => {
        const h = setup();
        await toOpen(h);
        h.plan.exists.push(new Error("osascript: boom"), "fail", "");
        await disconnect(h);              // the pane is gone at once; the three presets stand in front of that
        await h.clock.advance(299);
        assert.equal(h.polls().length, 3);
        assert.equal(h.state(), "closing");
        await h.clock.advance(1);
        assert.equal(h.polls().length, 4);
        await h.clock.advance(100);
        assert.equal(h.state(), "idle");
        assert.deepEqual(unconfirmed(h), []);
    });

    it("the window was resized while the pane was open, so the reading never returns to the size from before the split: a layout change still reopens, and the new open measures the size as it is now", async () => {
        const h = setup();
        await toOpen(h);
        h.size = { rows: 60, cols: 150 };    // beside the split, in the resized window
        await command(h, "layout", { position: "top", size: 25 });
        assert.equal(h.state(), "closing");
        h.size = { rows: 60, cols: 224 };    // on its own again
        await h.clock.advance(100);
        assert.equal(h.state(), "opening");
        assert.equal(h.splits().length, 2);
        assert.equal(h.splits()[1].args[3], "up");
        assert.deepEqual(measuredBefore(h), { rows: 60, cols: 224 });
        assert.deepEqual(unconfirmed(h), []);
    });

    // Seen with the real CLI: dropped by the server, the panel quits and closes its own pane; the close
    // script finds the terminal, which is gone by the time it closes it, and Ghostty answers -1728.
    it("close fails because the panel closed its own pane first, and the script then says the pane is gone: confirmed, the layout change reopens, no failure counted", async () => {
        const h = setup();
        await toOpen(h);
        h.plan.close.push(new Error("osascript: Ghostty got an error: Can’t get terminal id \"P1\". (-1728)"));
        h.panes.delete("P1");
        h.size = FULL;
        await command(h, "layout", { position: "top", size: 25 });
        await h.clock.advance(100);
        assert.deepEqual(unconfirmed(h), []);
        assert.equal(h.polls().length, 1);
        assert.equal(h.state(), "opening");
        assert.equal(h.splits().length, 2);
        assert.equal(h.splits()[1].args[3], "up");
    });

    it("same resized window, then the user closes the panel and a prompt follows, or the pane is switched off: the prompt reopens, and no failure is counted", async () => {
        const closed = setup();
        await toOpen(closed);
        closed.size = { rows: 60, cols: 150 };
        await disconnect(closed);
        await turn(closed);
        closed.size = { rows: 60, cols: 224 };
        await closed.clock.advance(100);
        assert.equal(closed.state(), "opening");
        assert.equal(closed.splits().length, 2);
        assert.deepEqual(measuredBefore(closed), { rows: 60, cols: 224 });

        const off = setup();
        await toOpen(off);
        off.size = { rows: 60, cols: 150 };
        await command(off, "off");
        off.size = { rows: 60, cols: 224 };
        await off.clock.advance(100);
        assert.equal(off.state(), "idle");
        assert.deepEqual(unconfirmed(off), []);
        off.config.enabled = true;
        assert.equal(await failuresLeft(off), 2);
    });

    it("off then on right after the split answered, the reading still showing the size from before it: nothing is split until the first pane is gone", async () => {
        const h = setup();
        await turn(h);
        h.splits()[0].ok("ok P1 focus=restored");    // the reading lags behind the split: it still says FULL
        await flush();
        h.plan.close.push("ok");                      // delivered; the pane takes a moment to go
        await command(h, "off");
        await command(h, "on");
        assert.deepEqual(h.closedPanes(), ["P1"]);
        await h.clock.advance(150);
        assert.equal(h.state(), "closing");
        assert.equal(h.splits().length, 1);
        await collapse(h);
        assert.equal(h.state(), "opening");
        assert.equal(h.splits().length, 2);
        assert.deepEqual(h.splits()[1].panes, []);
    });

    it("no pane id, because the split the closing waited for failed or was put off: nobody to ask, the reading being back at the size from before the split is what confirms", async () => {
        for (const settle of [(split) => split.fail(new Error("osascript: boom")), (split) => split.ok("deferred")]) {
            const h = setup();
            await turn(h);
            await command(h, "off");
            h.size = SPLIT;               // whatever the script said, the reading is not what it was
            settle(h.splits()[0]);
            await h.clock.advance(1000);
            assert.equal(h.state(), "closing");
            await collapse(h);
            assert.equal(h.state(), "idle");
            assert.deepEqual(h.calls.map((call) => call.action), ["split"]);
            assert.deepEqual(unconfirmed(h), []);
        }
    });
});

describe("controller: a pane left behind by an unconfirmed closing", () => {
    // P1 was open; its closing ran out of time. `answer` is what `close P1` said: nothing, or ok while the pane stayed.
    async function leftBehind(h, answer = HOLD) {
        await toOpen(h);
        h.plan.close.push(answer);
        await disconnect(h);
        await h.clock.advance(2000);
        assert.equal(h.state(), "idle");
        assert.deepEqual(h.closedPanes(), ["P1"]);
        assert.deepEqual([...h.panes], ["P1"]);
    }

    it("the next open closes it before it measures anything; gone: the pane is not asked for, the open goes on once two readings agree, and the pane is forgotten", async () => {
        const h = setup();
        await leftBehind(h);
        h.plan.close.push(HOLD);
        const counts = countsOf(h);
        await turn(h);
        assert.equal(h.state(), "opening");
        assert.deepEqual(h.calls.at(-1).args, [SCRIPT, "close", "P1"]);
        assert.deepEqual(countsOf(h), { ...counts, calls: counts.calls + 1 });

        h.panes.delete("P1");
        h.size = FULL;
        h.calls.at(-1).ok("gone");
        await h.clock.advance(99);
        assert.equal(h.splits().length, 1);
        await h.clock.advance(1);
        assert.equal(h.splits().length, 2);
        assert.deepEqual(h.polls(), []);
        assert.deepEqual(measuredBefore(h), FULL);

        await answerSplit(h, "P2");
        await connect(h);
        await disconnect(h);
        await collapse(h);
        await turn(h);
        assert.equal(h.splits().length, 3);
        assert.deepEqual(h.closedPanes(), ["P1", "P1", "P2"]);
    });

    it("close answers ok and the pane is gone at the first poll: the reading is polled every 50ms until two in a row are equal, only then before is measured", async () => {
        const h = setup();
        await leftBehind(h, "ok");
        const polls = h.polls().length;
        await turn(h);
        assert.deepEqual(h.closedPanes(), ["P1", "P1"]);
        assert.deepEqual([...h.panes], []);
        assert.equal(h.polls().length - polls, 1);
        await h.clock.advance(60);        // the reading at 50ms still says SPLIT
        h.size = FULL;
        await h.clock.advance(40);        // at 100ms it has changed
        assert.equal(h.splits().length, 1);
        await h.clock.advance(49);
        assert.equal(h.splits().length, 1);
        await h.clock.advance(1);         // at 150ms it is the same again
        assert.equal(h.splits().length, 2);
        assert.deepEqual(measuredBefore(h), FULL);
    });

    it("the pane is gone but the reading does not settle: the open goes on after 600ms", async () => {
        let cols = 200;
        const h = setup({ deps: { readSize: async () => ({ rows: 45, cols: (cols -= 1) }) } });
        await leftBehind(h, "ok");
        await turn(h);
        assert.deepEqual([...h.panes], []);
        await h.clock.advance(599);
        assert.equal(h.splits().length, 1);
        await h.clock.advance(1);
        assert.equal(h.splits().length, 2);
    });

    it("close fails again: the open fails before it measures or splits, counts towards the breaker, and the pane stays remembered", async () => {
        const h = setup();
        await leftBehind(h);
        h.plan.close.push(new Error("osascript: boom"), "fail");
        const counts = countsOf(h);
        await command(h, "on");           // starts counting afresh
        assert.equal(h.state(), "idle");
        assert.equal(h.logs.filter((entry) => entry.kind === "pane").at(-1).reason, "leftover-close-failed");
        await turn(h);
        assert.deepEqual(h.pane.status(), { state: "disabled", reason: "failed", override: "none" });
        assert.equal(h.notes.length, 1);
        assert.deepEqual(countsOf(h), { ...counts, calls: counts.calls + 4, closes: h.closes });    // each failed close is asked about once
        assert.deepEqual(h.closedPanes(), ["P1", "P1", "P1"]);
        assert.equal(h.polls().length, 2);

        h.panes.delete("P1");
        h.size = FULL;
        const on = h.pane.onCommand({ action: "on" });
        await h.clock.advance(100);       // gone, and two readings that agree
        await on;
        assert.deepEqual(h.closedPanes(), ["P1", "P1", "P1", "P1"]);
        assert.equal(h.splits().length, 2);
    });

    for (const action of ["close", "exists"]) {
        it(`off while ${action} <leftover> is still running: idle at once; its late gone still makes the controller forget the pane`, async () => {
            const h = setup();
            await leftBehind(h);
            h.plan[action].push(HOLD);
            await turn(h);
            const pending = h.calls.at(-1);
            assert.equal(pending.action, action);
            await command(h, "off");
            assert.equal(h.state(), "idle");
            h.panes.delete("P1");
            h.size = FULL;
            pending.ok("gone");
            await flush();
            assert.equal(h.state(), "idle");

            await command(h, "on");
            assert.equal(h.splits().length, 2);
            assert.deepEqual(h.closedPanes(), ["P1", "P1"]);
        });
    }

    it("close answers ok and the pane is gone by the third poll: only then, and once the reading has settled, the open goes on; the pane is forgotten", async () => {
        const h = setup();
        await leftBehind(h, "ok");
        h.plan.close.push("ok");
        const counts = countsOf(h);
        const polls = h.polls().length;
        await turn(h);
        assert.deepEqual(h.closedPanes(), ["P1", "P1"]);
        await h.clock.advance(199);
        assert.equal(h.polls().length - polls, 2);
        assert.equal(h.reads.length, counts.reads);    // nothing is measured next to a pane that may still be there
        h.panes.delete("P1");
        h.size = FULL;
        await h.clock.advance(1);
        assert.equal(h.polls().length - polls, 3);
        await h.clock.advance(99);                     // the readings at 250ms and 300ms agree
        assert.equal(h.splits().length, 1);
        await h.clock.advance(1);
        assert.equal(h.splits().length, 2);
        assert.deepEqual(h.splits()[1].panes, []);
        assert.deepEqual(measuredBefore(h), FULL);

        await answerSplit(h, "P2");
        await connect(h);
        await disconnect(h);
        await collapse(h);
        await turn(h);
        assert.equal(h.splits().length, 3);
        assert.deepEqual(h.closedPanes(), ["P1", "P1", "P2"]);
    });

    it("a confirmation sheet keeps the pane, close answers ok every time: the open gives up when its 1s are over, without measuring, rotating or splitting, and the pane stays remembered", async () => {
        const h = setup();
        await leftBehind(h, "ok");
        h.plan.close.push("ok", "ok");
        const counts = countsOf(h);
        const on = h.pane.onCommand({ action: "on" });    // starts counting failures afresh
        await h.clock.advance(999);
        assert.equal(h.state(), "opening");
        await h.clock.advance(1);
        await on;
        assert.equal(h.state(), "idle");
        assert.equal(h.logs.filter((entry) => entry.kind === "pane").at(-1).reason, "leftover-close-failed");
        // One close and ten polls, none of them given more time than the open had left for this.
        assert.deepEqual(countsOf(h), { ...counts, calls: counts.calls + 11, closes: h.closes });
        assert.deepEqual(h.calls.slice(counts.calls).map((call) => call.opts.timeoutMs), [1000, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100]);
        assert.deepEqual([...h.panes], ["P1"]);

        await turn(h);
        await h.clock.advance(1000);
        assert.deepEqual(h.pane.status(), { state: "disabled", reason: "failed", override: "none" });
        assert.deepEqual(h.closedPanes(), ["P1", "P1", "P1"]);
        assert.equal(h.splits().length, 1);
        assert.equal(h.rotates.length, counts.rotates);
    });
});

describe("controller: prechecks", () => {
    for (const [name, binPath] of [["is not executable", notExecutable], ["does not exist", join(scratch, "missing")]]) {
        it(`the binary ${name}: disabled, one notification, the script is never called`, async () => {
            const h = setup({ deps: { binPath } });
            await turn(h);
            assert.deepEqual(h.pane.status(), { state: "disabled", reason: "install-incomplete", override: "none" });
            assert.equal(h.notes.length, 1);
            assert.equal(h.notes[0].level, "warning");
            assert.match(h.notes[0].text, /install/i);
            assert.equal(h.rotates.length, 0);
            assert.equal(h.calls.length, 0);
            await command(h, "on");
            assert.equal(h.state(), "disabled");
            assert.equal(h.notes.length, 1);
            assert.equal(h.calls.length, 0);
        });
    }

    for (const [name, deps] of [
        ["TERM_PROGRAM is another terminal", { env: { TERM_PROGRAM: "Apple_Terminal" } }],
        ["TERM_PROGRAM is tmux", { env: { TERM_PROGRAM: "tmux" } }],
        ["the session is not interactive (copilot -p)", { interactive: async () => false }],
        ["the platform is not darwin", { platform: "linux" }],
        ["findTty finds nothing", { findTty: async () => null }],
        ["findTty returns something other than /dev/ttysNNN", { findTty: async () => ({ tty: "/dev/console", pid: 1, started: "" }) }],
    ]) {
        it(`${name}: disabled, the script is never called, no notification`, async () => {
            const h = setup({ deps });
            await turn(h);
            assert.equal(h.state(), "disabled");
            await turn(h);
            assert.equal(h.rotates.length, 0);
            assert.equal(h.calls.length, 0);
            assert.deepEqual(h.notes, []);
        });
    }

    it("a position that is not one of the four never reaches the script: a failed open", async () => {
        const h = setup({ config: { layout: { position: "middle", size: 33 } } });
        await turn(h);
        assert.equal(h.state(), "idle");
        assert.deepEqual([h.rotates.length, h.calls.length], [0, 0]);
        h.config.layout.position = "right";
        assert.equal(await failuresLeft(h), 1);
    });

    it("TERM_PROGRAM undefined passes", async () => {
        const h = setup({ deps: { env: {} } });
        await turn(h);
        assert.equal(h.splits().length, 1);
    });
});

describe("controller: off and on", () => {
    it("off while opening, then the pending split answers ok X: closing with server.close() and no kill(); X is closed; idle once X is gone", async () => {
        const h = setup();
        await turn(h);
        const closes = h.closes;
        const out = await command(h, "off");
        assert.equal(typeof out.text, "string");
        assert.equal(out.level, "info");
        assert.deepEqual(h.updates, [{ enabled: false }]);
        assert.equal(h.state(), "closing");
        assert.ok(h.closes > closes);
        await h.clock.advance(1000);
        assert.equal(h.splits()[0].kills, 0);
        assert.deepEqual(h.closedPanes(), []);
        await answerSplit(h, "X");
        assert.deepEqual(h.closedPanes(), ["X"]);
        assert.equal(h.state(), "closing");
        await collapse(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits()[0].kills, 0);
    });

    it("off while opening and the split never answers: kill() after 2s, idle, one failure counted", async () => {
        const h = setup();
        await turn(h);
        await command(h, "off");
        await h.clock.advance(1999);
        assert.equal(h.state(), "closing");
        assert.equal(h.splits()[0].kills, 0);
        await h.clock.advance(1);
        assert.equal(h.splits()[0].kills, 1);
        assert.equal(h.state(), "idle");
        h.config.enabled = true;
        assert.equal(await failuresLeft(h), 1);
    });

    it("off while awaiting: closing with close <paneId> at once, idle once the pane is gone; the 5s timer never fires, no failure counted", async () => {
        const h = setup();
        await toAwaiting(h);
        assert.equal(h.clock.horizon(), 5000);
        h.plan.close.push("ok");    // delivered; the pane takes a moment to go
        await command(h, "off");
        assert.equal(h.state(), "closing");
        assert.deepEqual(h.closedPanes(), ["P1"]);
        assert.ok(h.clock.horizon() <= 2000);    // the 5s timer is gone, only the closing budget is left
        await h.clock.advance(100);
        assert.equal(h.state(), "closing");
        await collapse(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.clock.armed(), 0);
        await h.clock.advance(6000);
        assert.equal(h.state(), "idle");
        assert.deepEqual(h.closedPanes(), ["P1"]);
        h.config.enabled = true;
        assert.equal(await failuresLeft(h), 2);
    });

    it("off while awaiting, the pane stays although close answered ok: idle after 2s with one failure counted; the 5s timer never fires", async () => {
        const h = setup();
        await toAwaiting(h);
        h.plan.close.push("ok");    // Ghostty answered, yet the pane stays on screen (it asks for confirmation)
        await command(h, "off");
        assert.deepEqual(h.closedPanes(), ["P1"]);
        await h.clock.advance(1999);
        assert.equal(h.state(), "closing");
        await h.clock.advance(1);
        assert.equal(h.state(), "idle");
        assert.equal(h.clock.armed(), 0);
        await h.clock.advance(6000);
        assert.equal(h.state(), "idle");
        assert.deepEqual(h.closedPanes(), ["P1"]);
        h.config.enabled = true;
        h.panes.delete("P1");
        h.size = FULL;
        assert.equal(await failuresLeft(h), 1);
    });

    it("off while awaiting, close answers gone: the pane is not asked for; idle once two readings agree, whatever size they show", async () => {
        const h = setup();
        await toAwaiting(h);
        h.plan.close.push("gone");
        await command(h, "off");
        assert.deepEqual(h.closedPanes(), ["P1"]);
        await h.clock.advance(99);
        assert.equal(h.state(), "closing");
        await h.clock.advance(1);     // the readings at 50ms and 100ms both still say SPLIT
        assert.equal(h.state(), "idle");
        assert.deepEqual(h.polls(), []);
        assert.deepEqual(unconfirmed(h), []);
        h.config.enabled = true;
        assert.equal(await failuresLeft(h), 2);
    });

    it("off while the pane is open, then on without waiting: no split while the pane is still there; one reopen once it is gone, measuring the single-pane size", async () => {
        const h = setup();
        await toOpen(h);
        h.plan.close.push("ok");    // delivered; the pane takes a moment to go
        const off = h.pane.onCommand({ action: "off" });
        const on = h.pane.onCommand({ action: "on" });
        await Promise.all([off, on]);
        await flush();
        assert.deepEqual(h.updates, [{ enabled: false }, { enabled: true }]);
        assert.equal(h.state(), "closing");
        await h.clock.advance(100);
        assert.equal(h.state(), "closing");
        assert.equal(h.splits().length, 1);
        await collapse(h);
        assert.equal(h.state(), "opening");
        assert.equal(h.splits().length, 2);
        assert.deepEqual(h.splits()[1].panes, []);
        assert.deepEqual(measuredBefore(h), FULL);
        await h.clock.advance(3000);
        assert.equal(h.splits().length, 2);
    });

    it("off then on while opening, then the first split answers ok X: no second split after on; X is closed; the second split waits until X is gone and measures the single-pane size; ok Y makes Y the pane id", async () => {
        const h = setup();
        await turn(h);
        await command(h, "off");
        await command(h, "on");
        assert.equal(h.state(), "closing");
        assert.equal(h.splits().length, 1);
        h.plan.close.push("ok");    // delivered; X takes a moment to go
        await answerSplit(h, "X");
        assert.deepEqual(h.closedPanes(), ["X"]);
        await h.clock.advance(100);
        assert.equal(h.splits().length, 1);
        await collapse(h);
        assert.equal(h.splits().length, 2);
        assert.deepEqual(h.splits()[1].panes, []);
        assert.deepEqual(measuredBefore(h), FULL);
        await answerSplit(h, "Y");
        assert.equal(h.state(), "awaiting");
        await h.clock.advance(5000);
        assert.deepEqual(h.closedPanes(), ["X", "Y"]);
    });

    it("the late split's pane: closing waits for close X to answer and then for X to be gone, whatever the reading says; without an answer within the 2s it does not reopen", async () => {
        for (const answers of [true, false]) {
            const h = setup();
            await turn(h);
            await command(h, "off");
            await command(h, "on");
            h.plan.close.push(HOLD);
            h.splits()[0].ok("ok X focus=restored");    // the reported size lags behind the split: it still reads FULL
            await flush();
            assert.deepEqual(h.closedPanes(), ["X"]);
            await h.clock.advance(200);
            assert.equal(h.state(), "closing");
            assert.equal(h.splits().length, 1);
            if (answers) {
                h.calls.at(-1).ok("ok");
                await h.clock.advance(150);
                assert.equal(h.state(), "closing");
                assert.equal(h.splits().length, 1);
                await collapse(h);
                assert.equal(h.state(), "opening");
                assert.equal(h.splits().length, 2);
                assert.deepEqual(h.splits()[1].panes, []);
            } else {
                await h.clock.advance(1800);
                assert.equal(h.state(), "idle");
                assert.equal(h.calls.at(-1).kills, 1);
                await h.clock.advance(10000);
                assert.equal(h.splits().length, 1);
            }
            assert.equal(h.splits()[0].kills, 0);
        }
    });

    it("on while the pane is open: no rotate, no split, state unchanged", async () => {
        const h = setup();
        await toOpen(h);
        const counts = countsOf(h);
        await command(h, "on");
        assert.deepEqual(h.updates, [{ enabled: true }]);
        assert.equal(h.state(), "open");
        assert.deepEqual(countsOf(h), counts);
    });

    it("on while opening: no rotate, no split, state unchanged", async () => {
        const h = setup();
        await turn(h);
        await command(h, "on");
        assert.equal(h.state(), "opening");
        assert.equal(h.rotates.length, 1);
        assert.equal(h.splits().length, 1);
    });

    it("on while awaiting: no rotate, no split, state unchanged; it reopens once if this open never connects", async () => {
        const h = setup();
        await toAwaiting(h);
        await command(h, "on");
        assert.equal(h.state(), "awaiting");
        assert.equal(h.rotates.length, 1);
        assert.equal(h.splits().length, 1);
        h.plan.close.push("gone");
        h.size = FULL;
        await h.clock.advance(5100);
        assert.equal(h.splits().length, 2);
    });

    it("on while disabled: opens again and starts counting failures afresh", async () => {
        const h = setup();
        h.plan.split.push(timeoutError(), timeoutError());
        await turn(h);
        await turn(h);
        assert.equal(h.state(), "disabled");
        await command(h, "on");
        assert.equal(h.state(), "opening");
        assert.equal(h.splits().length, 3);
        h.splits()[2].fail(timeoutError());
        await flush();
        assert.equal(h.state(), "idle");
        assert.equal(h.notes.length, 1);
    });

    it("on while idle opens without waiting for a prompt", async () => {
        const h = setup({ config: { enabled: false } });
        await command(h, "on");
        assert.deepEqual(h.updates, [{ enabled: true }]);
        assert.equal(h.state(), "opening");
        assert.equal(h.splits().length, 1);
    });

    it("off while idle only stores enabled: false", async () => {
        const h = setup();
        await command(h, "off");
        assert.deepEqual(h.updates, [{ enabled: false }]);
        assert.equal(h.state(), "idle");
        await turn(h);
        assert.equal(h.calls.length, 0);
    });

    it("off while closing drops the prompt recorded during it: idle, no reopen", async () => {
        const h = setup();
        await toOpen(h);
        await disconnect(h);
        await turn(h);
        await command(h, "off");
        assert.equal(h.state(), "closing");
        h.config.enabled = true;    // switched on again elsewhere; this session has no turn or command meanwhile
        await collapse(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 1);
    });

    it("commands run one at a time: the next one starts only after the previous config write is done", async () => {
        const firstWrite = deferred();
        const h = setup();
        const updateConfig = async (change) => {
            h.updates.push(change);
            if (h.updates.length === 1) await firstWrite.promise;
            h.config = { ...h.config, ...change };
            return structuredClone(h.config);
        };
        h.pane = createPaneController({ ...h.deps, updateConfig });
        await toOpen(h);
        const off = h.pane.onCommand({ action: "off" });
        const on = h.pane.onCommand({ action: "on" });
        await flush();
        assert.deepEqual(h.updates, [{ enabled: false }]);
        assert.equal(h.state(), "open");
        firstWrite.resolve();
        await Promise.all([off, on]);
        assert.deepEqual(h.updates, [{ enabled: false }, { enabled: true }]);
        assert.equal(h.config.enabled, true);
        assert.equal(h.state(), "closing");
        await collapse(h);
        assert.equal(h.splits().length, 2);
    });

    it("updateConfig rejects: a warning comes back, nothing changes", async () => {
        const updateConfig = async () => {
            throw new Error("config.json is locked");
        };
        const h = setup({ deps: { updateConfig } });
        await toOpen(h);
        const counts = countsOf(h);
        const out = await command(h, "off");
        assert.equal(out.level, "warning");
        assert.match(out.text, /locked/);
        assert.equal(h.state(), "open");
        assert.deepEqual(countsOf(h), counts);
    });
});

describe("controller: layout", () => {
    it("layout while the pane is open: stores it, closing, reopens with the new direction once the pane is gone", async () => {
        const h = setup();
        await toOpen(h);
        h.plan.close.push("ok");    // delivered; the pane takes a moment to go
        await command(h, "layout", { position: "top", size: 25 });
        assert.deepEqual(h.updates, [{ layout: { position: "top", size: 25 } }]);
        assert.equal(h.state(), "closing");
        await h.clock.advance(100);
        assert.equal(h.splits().length, 1);
        await collapse(h);
        assert.equal(h.splits().length, 2);
        assert.equal(h.splits()[1].args[3], "up");
    });

    it("layout while opening keeps the current size when none is given; once the client connects the pane is reopened once", async () => {
        const h = setup();
        await turn(h);
        await command(h, "layout", { position: "left" });
        assert.deepEqual(h.updates, [{ layout: { position: "left" } }]);
        assert.deepEqual(h.config.layout, { position: "left", size: 33 });
        assert.equal(h.state(), "opening");
        assert.equal(h.splits().length, 1);
        await answerSplit(h, "P1");
        await connect(h);
        assert.equal(h.state(), "closing");
        await collapse(h);
        assert.equal(h.splits().length, 2);
        assert.equal(h.splits()[1].args[3], "left");
        await answerSplit(h, "P2");
        await connect(h);
        assert.equal(h.state(), "open");
        await h.clock.advance(3000);
        assert.equal(h.splits().length, 2);
    });

    it("layout without a size keeps a size another session stores after this one has read the config and before it writes", async () => {
        const h = setup();
        await turn(h);
        const read = h.deps.loadConfig;
        h.deps.loadConfig = () => {
            const seen = read();
            h.config.layout.size = 50;    // stored elsewhere right after this session's read
            return seen;
        };
        const out = await command(h, "layout", { position: "left" });
        assert.deepEqual(h.updates, [{ layout: { position: "left" } }]);
        assert.deepEqual(h.config.layout, { position: "left", size: 50 });
        assert.deepEqual(out, { text: "FleetPane: layout left 50%", level: "info" });
    });

    it("layout while idle only stores it", async () => {
        const h = setup();
        await command(h, "layout", { position: "bottom", size: 40 });
        assert.deepEqual(h.updates, [{ layout: { position: "bottom", size: 40 } }]);
        assert.equal(h.state(), "idle");
        assert.equal(h.calls.length, 0);
    });
});

describe("controller: stale callbacks, shutdown, failing dependencies", () => {
    it("onClientConnected / onClientDisconnected carrying another attempt: state unchanged", async () => {
        const h = setup();
        await turn(h);
        const attempt = attemptOf(h);
        h.pane.onClientConnected(attempt - 1);
        h.pane.onClientConnected(attempt + 1);
        h.pane.onClientDisconnected(attempt - 1);
        await flush();
        assert.equal(h.state(), "opening");

        await answerSplit(h, "P1");
        await connect(h);
        h.pane.onClientDisconnected(attempt - 1);
        h.pane.onClientDisconnected(attempt + 1);
        await flush();
        assert.equal(h.state(), "open");

        await disconnect(h);
        await collapse(h);
        h.pane.onClientConnected(attempt);
        h.pane.onClientDisconnected(attempt);
        await flush();
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 1);
    });

    it("off while the tty lookup is still pending: the open is abandoned, the late answer does nothing", async () => {
        const lookup = deferred();
        let calls = 0;
        const h = setup({ deps: { findTty: () => (++calls === 1 ? Promise.resolve(null) : lookup.promise) } });
        await flush();
        await turn(h);
        assert.equal(h.state(), "opening");
        await command(h, "off");
        assert.equal(h.state(), "idle");    // nothing was split off, so there is nothing to wait for
        lookup.resolve({ tty: TTY, pid: 4242, started: "" });
        await flush();
        assert.equal(h.state(), "idle");
        assert.deepEqual([h.reads.length, h.rotates.length, h.calls.length], [0, 0, 0]);
        await command(h, "on");
        assert.equal(h.splits().length, 1);
    });

    it("off while before is still being measured: the open is abandoned, the late reading does nothing", async () => {
        let reading = null;
        const h = setup({ deps: { readSize: async () => (reading ? reading.promise : h.size) } });
        await toOpen(h);            // an earlier open has measured its own before
        await disconnect(h);
        await collapse(h);
        const counts = countsOf(h);

        reading = deferred();
        await turn(h);
        assert.equal(h.state(), "opening");
        await command(h, "off");
        assert.equal(h.state(), "idle");    // this open measured nothing yet, so there is nothing to wait for
        reading.resolve(FULL);
        await flush();
        assert.equal(h.state(), "idle");
        assert.deepEqual([h.rotates.length, h.calls.length], [counts.rotates, counts.calls]);
    });

    it("the pane id of an earlier open is not reused when the current one never learned its own", async () => {
        const h = setup();
        await toOpen(h, "P1");
        await disconnect(h);
        await collapse(h);

        await turn(h);
        await connect(h);
        h.size = SPLIT;
        h.splits()[1].fail(new Error("osascript: boom"));
        await flush();
        assert.equal(h.state(), "open");
        await disconnect(h);
        await h.clock.advance(2000);
        assert.equal(h.state(), "idle");
        assert.deepEqual(h.closedPanes(), ["P1"]);    // only by its own closing; not again by the second open's
    });

    it("off while server.rotate is still pending: no split when it resolves, no failure when it rejects", async () => {
        for (const settle of [(gate) => gate.resolve("/run/late.sock"), (gate) => gate.reject(new Error("late"))]) {
            const h = setup();
            h.rotateGate = deferred();
            await turn(h);
            assert.equal(h.state(), "opening");
            await command(h, "off");
            assert.equal(h.state(), "idle");    // the reading already equals before
            settle(h.rotateGate);
            h.rotateGate = null;
            await flush();
            assert.equal(h.state(), "idle");
            assert.equal(h.calls.length, 0);
            h.config.enabled = true;
            assert.equal(await failuresLeft(h), 2);
        }
    });

    it("a command still writing the config at shutdown, and commands after it, change nothing", async () => {
        const write = deferred();
        let writes = 0;
        const updateConfig = () => {
            writes += 1;
            return write.promise;
        };
        const h = setup({ config: { enabled: false }, deps: { updateConfig } });
        const pending = h.pane.onCommand({ action: "on" });
        await flush();
        h.pane.shutdown();
        write.resolve({ ...h.config, enabled: true });
        assert.equal((await pending).level, "warning");
        assert.equal((await h.pane.onCommand({ action: "on" })).level, "warning");
        await flush();
        assert.equal(writes, 1);
        assert.equal(h.state(), "idle");
        assert.deepEqual([h.rotates.length, h.calls.length], [0, 0]);
    });

    it("after shutdown a new turn and a client connection are ignored, whatever attempt it carries", async () => {
        const idle = setup();
        idle.pane.shutdown();
        await turn(idle);
        assert.equal(idle.state(), "idle");
        assert.deepEqual(countsOf(idle), { rotates: 0, calls: 0, reads: 0, closes: 1 });

        const awaiting = setup();
        await toAwaiting(awaiting);
        awaiting.pane.shutdown();
        for (let attempt = 0; attempt <= attemptOf(awaiting) + 3; attempt += 1) awaiting.pane.onClientConnected(attempt);
        await flush();
        assert.equal(awaiting.state(), "awaiting");
    });

    it("server.close() throwing does not leave a transition half done", async () => {
        const h = setup();
        h.deps.server.close = () => {
            throw new Error("boom");
        };
        await toOpen(h);
        await disconnect(h);
        assert.equal(h.state(), "closing");
        await collapse(h);
        assert.equal(h.state(), "idle");
        h.plan.split.push(timeoutError(), timeoutError());
        await turn(h);
        await turn(h);
        assert.equal(h.state(), "disabled");
        assert.equal(h.notes.length, 1);
        assert.doesNotThrow(() => h.pane.shutdown());
    });

    it("shutdown while the script is running: its kill() and server.close() are called; a late ok X changes nothing and is not closed", async () => {
        const h = setup();
        await turn(h);
        const closes = h.closes;
        h.pane.shutdown();
        assert.equal(h.splits()[0].kills, 1);
        assert.equal(h.closes, closes + 1);
        assert.equal(h.clock.armed(), 0);
        const state = h.state();
        await answerSplit(h, "X");
        assert.equal(h.state(), state);
        assert.deepEqual(h.closedPanes(), []);

        h.pane.onTurnStart();
        h.pane.onClientConnected(attemptOf(h));
        h.pane.shutdown();
        await h.clock.advance(10000);
        assert.equal(h.state(), state);
        assert.equal(h.calls.length, 1);
        assert.equal(h.rotates.length, 1);
        assert.equal(h.closes, closes + 1);
    });

    it("shutdown while awaiting or closing: no timer fires afterwards, no desktop action", async () => {
        const awaiting = setup();
        await toAwaiting(awaiting);
        awaiting.pane.shutdown();
        assert.equal(awaiting.clock.armed(), 0);
        await awaiting.clock.advance(10000);
        assert.deepEqual(awaiting.closedPanes(), []);

        const closing = setup();
        await toOpen(closing);
        await disconnect(closing);
        const calls = closing.calls.length;
        closing.pane.shutdown();
        assert.equal(closing.clock.armed(), 0);
        await closing.clock.advance(10000);
        assert.equal(closing.calls.length, calls);
        assert.equal(closing.state(), "closing");
    });

    it("shutdown kills every script still running, whatever it is: a resize, the close of a closing pane, the close of a pane left behind", async () => {
        const resizing = setup();
        resizing.plan.resize.push(HOLD);
        await turn(resizing);
        resizing.splits()[0].ok("ok P1 focus=restored");
        resizing.size = { rows: 45, cols: 85 };    // an even split: calibration starts with a probe
        await connect(resizing);
        assert.equal(resizing.resizes().length, 1);
        resizing.pane.shutdown();
        assert.equal(resizing.resizes()[0].kills, 1);
        assert.equal(resizing.splits()[0].kills, 0);    // it had answered long before

        const closing = setup();
        await toOpen(closing);
        closing.plan.close.push(HOLD);
        await disconnect(closing);
        assert.equal(closing.calls.at(-1).action, "close");
        closing.pane.shutdown();
        assert.equal(closing.calls.at(-1).kills, 1);

        const leftover = setup();
        await toOpen(leftover);
        leftover.plan.close.push(HOLD, HOLD);
        await disconnect(leftover);
        await leftover.clock.advance(2000);
        await turn(leftover);
        assert.deepEqual(leftover.closedPanes(), ["P1", "P1"]);
        leftover.pane.shutdown();
        assert.equal(leftover.calls.at(-1).kills, 1);

        for (const h of [resizing, closing, leftover]) {
            const calls = h.calls.length;
            for (const call of h.calls) call.ok("ok");
            await h.clock.advance(10000);
            assert.equal(h.calls.length, calls);
        }
    });

    it("shutdown while a closing or the next open asks whether the pane is still there, or waits for the reading to settle: the script is killed, and nothing happens afterwards", async () => {
        const closing = setup();
        await toOpen(closing);
        closing.plan.exists.push(HOLD);
        await disconnect(closing);

        const opening = setup();
        await toOpen(opening);
        opening.plan.close.push(HOLD);
        await disconnect(opening);
        await opening.clock.advance(2000);
        opening.plan.exists.push(HOLD);
        await turn(opening);

        for (const h of [closing, opening]) {
            const poll = h.calls.at(-1);
            assert.equal(poll.action, "exists");
            h.pane.shutdown();
            assert.equal(poll.kills, 1);
            const counts = countsOf(h);
            const state = h.state();
            poll.ok("gone");
            await h.clock.advance(10000);
            assert.deepEqual(countsOf(h), counts);
            assert.equal(h.state(), state);
        }

        const settling = setup();
        await toOpen(settling);
        await disconnect(settling);
        assert.equal(settling.polls().length, 1);    // gone at once; the first reading is due in 50ms
        settling.pane.shutdown();
        const counts = countsOf(settling);
        await settling.clock.advance(10000);
        assert.deepEqual(countsOf(settling), counts);
        assert.equal(settling.state(), "closing");
    });

    it("shutdown does not throw when killing a script does", async () => {
        const stuck = () => Object.assign(new Promise(() => {}), {
            kill: () => {
                throw new Error("kill EPERM");
            },
        });
        const h = setup({ deps: { run: stuck } });
        await turn(h);
        assert.equal(h.state(), "opening");
        const closes = h.closes;
        assert.doesNotThrow(() => h.pane.shutdown());
        assert.equal(h.closes, closes + 1);
    });

    it("onTurnStart does not throw when a dependency does", async () => {
        const boom = () => {
            throw new Error("boom");
        };
        const rejecting = () => Promise.reject(new Error("boom"));
        const server = { rotate: boom, close: boom, schedule: boom };
        // Three turns each. A failing step of the open is a failed open, so two of them trip the breaker;
        // a failing debug log or notification changes nothing.
        for (const [name, deps, end] of [
            ["loadConfig", { loadConfig: boom }, "idle"],
            ["findTty throws", { findTty: boom }, "disabled"],
            ["findTty rejects", { findTty: rejecting }, "disabled"],
            ["readSize", { readSize: rejecting }, "disabled"],
            ["server", { server }, "disabled"],
            ["run", { run: boom }, "disabled"],
            ["log", { log: boom }, "opening"],
            ["notify throws", { notify: boom, binPath: notExecutable }, "disabled"],
            ["notify rejects", { notify: rejecting, binPath: notExecutable }, "disabled"],
        ]) {
            const h = setup({ deps });
            for (let n = 0; n < 3; n += 1) {
                assert.doesNotThrow(() => h.pane.onTurnStart(), name);
                await flush();
            }
            assert.equal(h.state(), end, name);
        }
    });

    it("a dependency failing in the middle of an open counts as a failed open", async () => {
        const h = setup({ deps: { readSize: () => Promise.reject(new Error("boom")) } });
        await turn(h);
        assert.equal(h.state(), "idle");
        await turn(h);
        assert.equal(h.state(), "disabled");
        assert.equal(h.notes.length, 1);
    });
});
