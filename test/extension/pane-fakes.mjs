import assert from "node:assert/strict";

import { createPaneController } from "../../extension/lib/pane.mjs";

export const FULL = { rows: 45, cols: 170 };    // the Copilot pane on its own: this is `before`
export const SPLIT = { rows: 45, cols: 113 };   // the Copilot pane while the FleetPane split exists
export const TTY = "/dev/ttys003";
export const SCRIPT = "/ext/ghostty-split.applescript";
export const THEMES = "/ext dir/it's themes";
export const HOLD = Symbol("hold");

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

export const timeoutError = () => Object.assign(new Error("Command failed: osascript"), { timedOut: true, stderr: "" });
export const unauthorized = () => Object.assign(new Error("Command failed: osascript"), {
    timedOut: false,
    stderr: "execution error: Not authorized to send Apple events to Ghostty. (-1743)\n",
});

export function makeClock() {
    let now = 0;
    let nextId = 1;
    const timers = new Map();
    const setTimer = (fn, ms) => {
        const id = nextId++;
        timers.set(id, { at: now + ms, fn });
        return id;
    };
    const clearTimer = (id) => {
        timers.delete(id);
    };
    const sleep = (ms) => new Promise((resolve) => {
        timers.get(setTimer(resolve, ms)).sleep = true;
    });
    // Timers still armed through setTimer (pending sleeps cannot be cancelled and are not counted).
    const armed = () => [...timers.values()].filter((timer) => !timer.sleep).length;
    // How far ahead the latest of them is due (0 when none is armed).
    const horizon = () => Math.max(0, ...[...timers.values()].filter((timer) => !timer.sleep).map((timer) => timer.at - now));
    // Fires everything due within the next `ms`, in order, draining microtasks after each.
    const advance = async (ms) => {
        const end = now + ms;
        await flush();
        for (;;) {
            let due = null;
            for (const [id, timer] of timers) {
                if (timer.at <= end && (!due || timer.at < due.at)) due = { id, ...timer };
            }
            if (!due) break;
            timers.delete(due.id);
            now = due.at;
            due.fn();
            await flush();
        }
        now = end;
    };
    return { now: () => now, setTimer, clearTimer, sleep, advance, armed, horizon };
}

export function setup({ config = {}, deps = {}, override = "" } = {}) {
    const clock = makeClock();
    const h = {
        clock,
        config: { enabled: true, layout: { position: "right", size: 33 }, theme: "gta6", ...config },
        override,
        // Three things a test sets independently of each other: which panes exist, what a script answers,
        // and what the Copilot pane's size reads as (in a real terminal the reading lags behind the other two).
        panes: new Set(),                             // ids of the FleetPane panes that exist on the fake desktop
        // Preset script answers per action, used in order; they leave `panes` alone.
        plan: { split: [], close: [], resize: [], exists: [] },
        size: FULL,                                   // what `stty size` reports right now
        readDelay: 0,                                 // fake milliseconds one size reading takes
        reads: [],                                    // every readSize call: the size it got and the state it was made in
        calls: [],                                    // every run() call
        rotates: [],                                  // attempts passed to server.rotate
        rotateError: null,
        rotateGate: null,                             // a deferred: rotate hangs until the test settles it
        closes: 0,                                    // server.close() calls
        schedules: 0,                                 // server.schedule() calls
        loadConfigs: 0,                               // loadConfig() calls
        updates: [],
        overrideReads: [],
        overrides: [],
        notes: [],
        logs: [],
        ttyLookups: 0,
    };
    const run = (file, args, opts) => {
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        const call = {
            file,
            args,
            opts,
            action: args[1],
            panes: [...h.panes],    // the panes that existed when the script was called
            kills: 0,
            ok: (text) => {
                // The real script only answers `ok <id>` to a split once that pane exists.
                if (call.action === "split" && text.startsWith("ok ")) h.panes.add(text.split(" ")[1]);
                resolve({ stdout: `${text}\n`, stderr: "" });
            },
            fail: (err) => reject(err),
        };
        promise.kill = () => {
            call.kills += 1;
        };
        h.calls.push(call);
        // Nothing preset: split hangs, resize answers ok, close and exists do what the real script does.
        // A pane closed that way is gone from then on; one whose `ok` was preset stays until the test removes it.
        const queue = h.plan[call.action] ?? [];
        let preset = "ok";
        if (queue.length) preset = queue.shift();
        else if (call.action === "split") preset = HOLD;
        else if (call.action === "close") preset = h.panes.delete(call.args[2]) ? "ok" : "gone";
        else if (call.action === "exists") preset = h.panes.has(call.args[2]) ? "yes" : "gone";
        if (preset instanceof Error) call.fail(preset);
        else if (preset !== HOLD) call.ok(preset);
        return promise;
    };
    h.splits = () => h.calls.filter((call) => call.action === "split");
    h.resizes = () => h.calls.filter((call) => call.action === "resize");
    h.closedPanes = () => h.calls.filter((call) => call.action === "close").map((call) => call.args[2]);
    h.polls = () => h.calls.filter((call) => call.action === "exists");
    h.state = () => h.pane.status().state;
    h.deps = {
        loadConfig: () => {
            h.loadConfigs += 1;
            return structuredClone(h.config);
        },
        // Like the real one: only the fields present in `change`, on top of what is stored by then.
        updateConfig: async (change) => {
            h.updates.push(change);
            const next = structuredClone(h.config);
            if (change.enabled !== undefined) next.enabled = change.enabled;
            if (change.layout?.position !== undefined) next.layout.position = change.layout.position;
            if (change.layout?.size !== undefined) next.layout.size = change.layout.size;
            if (change.theme !== undefined) next.theme = change.theme;
            h.config = next;
            return structuredClone(h.config);
        },
        readOverride: (proc) => {
            h.overrideReads.push(proc);
            return h.override;
        },
        writeOverride: (proc, value) => {
            h.overrides.push({ proc, value });
            h.override = value;
        },
        server: {
            rotate: (attempt) => {
                h.rotates.push(attempt);
                if (h.rotateGate) return h.rotateGate.promise;
                if (h.rotateError) return Promise.reject(h.rotateError);
                return Promise.resolve(`/run/fleet pane/s.77.${attempt}.sock`);
            },
            // Like the real one: starts at once and returns a Promise.
            close: async () => {
                h.closes += 1;
            },
            schedule: () => {
                h.schedules += 1;
            },
        },
        run,
        readSize: async (tty) => {
            if (h.readDelay > 0) await clock.sleep(h.readDelay);
            h.reads.push({ tty, size: h.size, state: h.state() });
            return h.size;
        },
        findTty: async () => {
            h.ttyLookups += 1;
            return { tty: TTY, pid: 4242, started: "Wed Nov 25 10:06:44 2026" };
        },
        binPath: "/bin/sh",
        scriptPath: SCRIPT,
        themesDir: THEMES,
        log: (kind, payload) => {
            h.logs.push({ kind, ...payload });
        },
        notify: (text, level) => {
            h.notes.push({ text, level });
        },
        now: clock.now,
        sleep: clock.sleep,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        env: { TERM_PROGRAM: "ghostty" },
        platform: "darwin",
        interactive: async () => true,
        ...deps,
    };
    h.pane = createPaneController(h.deps);
    return h;
}

export const attemptOf = (h) => h.rotates.at(-1);
export const socketOf = (h) => `/run/fleet pane/s.77.${attemptOf(h)}.sock`;
export const countsOf = (h) => ({ rotates: h.rotates.length, calls: h.calls.length, reads: h.reads.length, closes: h.closes });
// The size the latest open measured as `before`.
export const measuredBefore = (h) => h.reads.filter((read) => read.state === "opening").at(-1).size;

export async function turn(h) {
    h.pane.onTurnStart();
    await flush();
}

export async function command(h, action, extra = {}) {
    const out = await h.pane.onCommand({ action, ...extra });
    await flush();
    return out;
}

export async function connect(h) {
    h.pane.onClientConnected(attemptOf(h));
    await flush();
}

export async function disconnect(h) {
    h.pane.onClientDisconnected(attemptOf(h));
    await flush();
}

// The script answers `ok <id>`: the pane exists and the Copilot pane's reading has shrunk.
export async function answerSplit(h, id) {
    h.splits().at(-1).ok(`ok ${id} focus=restored`);
    h.size = SPLIT;
    await flush();
}

export async function toAwaiting(h, id = "P1") {
    await turn(h);
    await answerSplit(h, id);
    assert.equal(h.state(), "awaiting");
}

export async function toOpen(h, id = "P1") {
    await toAwaiting(h, id);
    await connect(h);
    assert.equal(h.state(), "open");
}

// The pane is gone and the Copilot pane has its space back. Long enough for whoever waits for that to
// find out: the next `exists` poll (every 100ms), then two readings 50ms apart that agree.
export async function collapse(h) {
    h.panes.clear();
    h.size = FULL;
    await h.clock.advance(200);
}

// Black-box probe of the failure counter: how many more failed opens trip the breaker (2 means none counted so far).
export async function failuresLeft(h) {
    assert.equal(h.state(), "idle");
    h.rotateError = new Error("probe");
    for (let n = 1; n <= 3; n += 1) {
        await turn(h);
        await h.clock.advance(100);    // an open that first closes a pane left behind waits for the reading to settle
        if (h.state() === "disabled") return n;
    }
    return Infinity;
}
