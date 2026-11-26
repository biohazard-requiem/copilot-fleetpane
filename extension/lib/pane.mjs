import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";

import { describe, listThemes, USAGE } from "./config.mjs";

const SPLIT_TIMEOUT_MS = 20000;
const CLOSE_TIMEOUT_MS = 5000;
const RESIZE_TIMEOUT_MS = 5000;
const EXISTS_TIMEOUT_MS = 1000;
const AWAIT_CLIENT_MS = 5000;
const CLOSING_BUDGET_MS = 2000;
const CLOSING_POLL_MS = 50;
const LEFTOVER_BUDGET_MS = 1000;
const EXISTS_POLL_MS = 100;
const SETTLE_POLL_MS = 50;
const SETTLE_LIMIT_MS = 600;
const CALIBRATE_POLL_MS = 30;
const CALIBRATE_SPLIT_LIMIT_MS = 600;
const CALIBRATE_RESIZE_LIMIT_MS = 400;
const PROBE_PX = 80;
const PROBE_RETRY_PX = 240;
const MAX_RESIZES = 4;
const MAX_RESIZE_PX = 4000;
const MIN_COLS = 24;
const MIN_ROWS = 6;
const MAX_FAILURES = 2;
const BUILTIN_THEMES = ["auto", "gta6"];
const SWITCH_ACTIONS = ["on", "off", "hide", "show"];

const NOTICE_INCOMPLETE = (binPath) =>
    `FleetPane: the install is incomplete (${binPath} is missing or not executable). ` +
    "Reinstall FleetPane, then run /fleetpane on.";
const NOTICE_UNAUTHORIZED =
    "FleetPane: macOS did not allow control of Ghostty. " +
    "Allow it in System Settings → Privacy & Security → Automation, then run /fleetpane on.";
const NOTICE_FAILED =
    "FleetPane: the pane failed to open twice in a row and stays off for this session. " +
    "Run /fleetpane on to try again.";

const TTY_RE = /^\/dev\/ttys\d+$/;
// The terminal id is passed back to the script's `close` action, so only ids it accepts are recognised.
const SPLIT_OK_RE = /^ok ([A-Za-z0-9-]{1,64}) focus=(restored|failed|skipped)$/;
const DIRECTIONS = new Map([["right", "right"], ["left", "left"], ["top", "up"], ["bottom", "down"]]);
const OPPOSITE = new Map([["right", "left"], ["left", "right"], ["up", "down"], ["down", "up"]]);

// Never inherits stdio: the extension's own stdout is the JSON-RPC channel.
export function runFile(file, args, { timeoutMs } = {}) {
    let child;
    const promise = new Promise((resolve, reject) => {
        let timedOut = false;
        let timer = null;
        child = execFile(file, args, { encoding: "utf8" }, (err, stdout, stderr) => {
            clearTimeout(timer);
            if (!err) return resolve({ stdout, stderr });
            reject(Object.assign(err, { stdout, stderr, timedOut }));
        });
        child.stdin?.end();
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
                // An osascript stuck on the authorisation prompt may ignore SIGTERM.
                timer = setTimeout(() => child.kill("SIGKILL"), 1000);
            }, timeoutMs);
        }
    });
    promise.kill = () => child.kill("SIGKILL");
    return promise;
}

export async function readSize(tty, run = runFile) {
    try {
        const { stdout } = await run("stty", ["-f", tty, "size"], { timeoutMs: 1000 });
        const match = /^(\d+) (\d+)\s*$/.exec(stdout);
        return match ? { rows: Number(match[1]), cols: Number(match[2]) } : null;
    } catch {
        return null;
    }
}

export async function findTty({ pid = process.ppid, run = runFile, maxDepth = 6 } = {}) {
    try {
        for (let depth = 0; depth < maxDepth; depth += 1) {
            const { stdout } = await run("ps", ["-o", "ppid=,tty=", "-p", String(pid)], { timeoutMs: 2000 });
            const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(stdout);
            if (!match) return null;
            if (match[2] !== "??") {
                const tty = `/dev/${match[2]}`;
                if (!TTY_RE.test(tty)) return null;
                const started = await run("ps", ["-o", "lstart=", "-p", String(pid)], { timeoutMs: 2000 })
                    .then((out) => out.stdout.trim(), () => "");
                return { tty, pid, started };
            }
            pid = Number(match[1]);
        }
    } catch {
        // ps failed: the process is gone, or there is no ps
    }
    return null;
}

export function shellQuote(s) {
    return `'${String(s).replace(/'/g, "'\\''")}'`;
}

export function directionFor(position) {
    return DIRECTIONS.get(position);
}

export function parseSplitResult(stdout) {
    const line = String(stdout ?? "").trim();
    const ok = SPLIT_OK_RE.exec(line);
    if (ok) return { kind: "ok", paneId: ok[1], focus: ok[2] };
    if (line === "deferred" || line === "not-found" || line === "not-running") return { kind: line };
    return null;
}

export function planResize({ before, size, current, probe }) {
    const target = Math.round((before * (100 - size)) / 100);
    const need = target - current;
    if (Math.abs(need) <= 1) return { done: true };
    if (!probe) return { dirSign: need > 0 ? 1 : -1, px: PROBE_PX };
    if (!Number.isFinite(probe.delta) || probe.delta === 0 || !(probe.px > 0)) return { done: true };
    const px = Math.round((Math.abs(need) * probe.px) / Math.abs(probe.delta));
    if (px < 1) return { done: true };
    const sameSign = (need > 0) === (probe.delta > 0);
    return { dirSign: sameSign ? probe.dirSign : -probe.dirSign, px };
}

const sameSize = (a, b) => Boolean(a && b) && a.rows === b.rows && a.cols === b.cols;

function isExecutable(file) {
    try {
        accessSync(file, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export function createPaneController(deps) {
    let state = "idle";
    let reason = "";              // why `disabled`
    let override = "none";        // session override: "none" | "hidden" | "shown"
    let overrideReady = false;    // becomes true once the startup findTty + readOverride has finished
    let deferredTurn = false;     // a turn started while override read-back was still in flight
    let proc = { pid: process.ppid, started: "" };
    let attempt = 0;              // open-attempt number, only ever grows; continuations compare against it
    let failures = 0;             // consecutive failed opens
    let pendingPrompt = false;    // reopen once the closing pane has collapsed
    let pendingLayout = false;    // close and reopen as soon as this open reaches `open`
    let config = null;            // last config read
    let tty = "";                 // Copilot's tty, cached after the first successful lookup
    let before = null;            // Copilot pane size measured before the current split
    let paneId = "";              // terminal id of the current split
    let leftover = "";            // pane of an earlier open whose closing could not be confirmed; the next open closes it first
    let splitCall = null;         // `split` script still running
    let sizeCheck = null;         // { attempt, resolve } for a command-initiated open waiting on the size check
    let dead = false;             // after shutdown
    let queue = Promise.resolve();
    const measured = new Map();   // "cols" | "rows" -> { px, delta, dirSign }: the resize step last measured on that axis
    const timers = new Set();
    const scripts = new Set();    // every script call still running
    const notified = new Set();
    const now = deps.now ?? Date.now;

    let resolveReady;
    const ready = new Promise((resolve) => {
        resolveReady = resolve;
    });

    const log = (kind, payload) => {
        try {
            deps.log(kind, payload);
        } catch {
            // the debug log must never get in the way
        }
    };
    const logError = (where, err) => log("error", { where, message: String(err?.message ?? err) });

    function schedulePush() {
        try {
            deps.server.schedule();
        } catch (err) {
            logError("server.schedule", err);
        }
    }

    function reload() {
        const prevTheme = config?.theme ?? null;
        config = deps.loadConfig();
        if (prevTheme !== null && config.theme !== prevTheme) schedulePush();
    }

    const isOn = () => (override === "shown" ? true : override === "hidden" ? false : config.enabled);
    const paneActive = () => state === "opening" || state === "awaiting" || state === "open";

    function notifyOnce(why, text) {
        if (notified.has(why)) return;
        notified.add(why);
        Promise.resolve()
            .then(() => deps.notify(text, "warning"))
            .catch((err) => logError("notify", err));
    }

    function arm(fn, ms) {
        const timer = deps.setTimer(() => {
            timers.delete(timer);
            try {
                fn();
            } catch (err) {
                logError("timer", err);
            }
        }, ms);
        timers.add(timer);
    }

    function disarm() {
        for (const timer of timers) deps.clearTimer(timer);
        timers.clear();
    }

    function closeServer() {
        try {
            Promise.resolve(deps.server.close()).catch((err) => logError("server.close", err));
        } catch (err) {
            logError("server.close", err);
        }
    }

    function settleSizeCheck(my, result) {
        if (!sizeCheck || (my !== null && sizeCheck.attempt !== my)) return;
        const { resolve } = sizeCheck;
        sizeCheck = null;
        resolve(result);
    }

    function script(action, args, timeoutMs) {
        const started = now();
        const call = deps.run("osascript", [deps.scriptPath, action, ...args], { timeoutMs });
        scripts.add(call);
        call.then(
            (out) => {
                scripts.delete(call);
                log("script", { action, args, ms: now() - started, output: String(out?.stdout ?? "").trim() });
            },
            (err) => {
                scripts.delete(call);
                log("script", {
                    action,
                    args,
                    ms: now() - started,
                    error: String(err?.stderr || err?.message || err).trim(),
                    timedOut: err?.timedOut === true,
                });
            },
        );
        return call;
    }

    // For the moments when nobody waits for an answer any more: a closing that ran out of time, and shutdown.
    function killScripts() {
        for (const call of scripts) {
            try {
                call.kill();
            } catch (err) {
                logError("kill", err);
            }
        }
        scripts.clear();
    }

    // Resolves "ok", "gone" or null (failed, timed out, killed, or some other answer); never rejects.
    // `id` always comes out of parseSplitResult, which only lets valid terminal ids through.
    async function closePane(id, timeoutMs = CLOSE_TIMEOUT_MS) {
        try {
            const answer = String((await script("close", [id], timeoutMs)).stdout).trim();
            return answer === "ok" || answer === "gone" ? answer : null;
        } catch {
            return null;
        }
    }

    // Resolves false only on the script's word that there is no such pane: a call that failed proves nothing.
    async function paneExists(id, timeoutMs) {
        try {
            return String((await script("exists", [id], timeoutMs)).stdout).trim() !== "gone";
        } catch {
            return true;
        }
    }

    // Closes the pane and resolves true once it is known to be gone. `ok` only says that the close was
    // delivered: Ghostty answers it while a confirmation sheet keeps the pane. So the pane is then asked
    // for until it is gone. Resolves false when `over()` says to stop or the deadline passes before that.
    // A close that failed is asked about once: the panel, dropped by the server, may have closed its own
    // pane between the script finding the terminal and closing it.
    async function closeAndConfirm(id, over, deadline = Infinity) {
        const left = () => (over() ? 0 : deadline - now());
        const answer = await closePane(id, Math.min(CLOSE_TIMEOUT_MS, left()));
        if (answer === "gone") return true;
        if (answer !== "ok") {
            const ms = left();
            return ms > 0 && !(await paneExists(id, Math.min(EXISTS_TIMEOUT_MS, ms)));
        }
        for (;;) {
            let ms = left();
            if (ms <= 0) return false;
            if (!(await paneExists(id, Math.min(EXISTS_TIMEOUT_MS, ms)))) return true;
            ms = left();
            if (ms <= 0) return false;
            await deps.sleep(Math.min(EXISTS_POLL_MS, ms));
        }
    }

    // The space of a pane that is gone returns to the Copilot pane a moment later, and the reading lags
    // behind that. It counts as settled once it comes out the same twice in a row, or after 600ms.
    async function settled(stale) {
        const deadline = now() + SETTLE_LIMIT_MS;
        let last = null;
        for (;;) {
            const left = deadline - now();
            if (stale() || left <= 0) return;
            await deps.sleep(Math.min(SETTLE_POLL_MS, left));
            if (stale()) return;
            const size = await deps.readSize(tty);
            if (sameSize(size, last)) return;
            last = size;
        }
    }

    function go(to, why) {
        log("pane", { from: state, to, reason: why, attempt });
        state = to;
        reason = to === "disabled" ? why : "";
    }

    // The wrap-up every path into idle, closing or disabled shares. Whatever the previous attempt
    // left in flight no longer matches `attempt`, and nothing is listening any more.
    function finish(to, why) {
        attempt += 1;
        disarm();
        settleSizeCheck(null, null);
        pendingLayout = false;
        if (to !== "closing") pendingPrompt = false;
        go(to, why);
        closeServer();
    }

    function disable(why, notice) {
        finish("disabled", why);
        if (notice) notifyOnce(why, notice);
    }

    function tripBreaker() {
        disable("failed", NOTICE_FAILED);
    }

    function fail(why) {
        failures += 1;
        if (failures >= MAX_FAILURES) tripBreaker();
        else finish("idle", why);
    }

    // Claims the slot synchronously, before any await: two prompts in a row cannot both get here.
    function startOpen(why, trackSize = false) {
        attempt += 1;
        const my = attempt;
        let wait = null;
        if (trackSize) {
            settleSizeCheck(null, null);
            wait = new Promise((resolve) => {
                sizeCheck = { attempt: my, resolve };
            });
        }
        go("opening", why);
        before = null;
        paneId = "";
        open(my, config.layout).catch((err) => {
            logError("open", err);
            settleSizeCheck(my, null);
            if (my === attempt && (state === "opening" || state === "awaiting")) fail("error");
        });
        return wait;
    }

    function startCalibration(my, id, beforeSize, layout, direction, ttyPath) {
        calibrate(my, id, beforeSize, layout, direction, ttyPath).catch((err) => logError("resize", err));
    }

    async function calibrate(my, id, beforeSize, layout, direction, ttyPath) {
        const stale = () => dead || my !== attempt;
        const sideways = direction === "right" || direction === "left";
        const axis = sideways ? "cols" : "rows";
        const beforeCells = sideways ? beforeSize.cols : beforeSize.rows;
        let resizes = 0;
        let widest = 0;     // most cells a resize of this run was measured to move

        // Polls until the reading differs from `previous`. The limit is a point in time, not a sum of the
        // pauses: a reading that arrives after it is dropped. By then the user may have moved the divider,
        // and a resize computed from that reading would undo it.
        async function pollSize(previous, limitMs) {
            const deadline = now() + limitMs;
            for (;;) {
                if (stale()) return null;
                const size = await deps.readSize(ttyPath);
                const left = deadline - now();
                if (stale() || left < 0) return null;
                if (size) {
                    const cells = sideways ? size.cols : size.rows;
                    if (cells !== previous) return cells;
                }
                if (left === 0) return null;
                await deps.sleep(Math.min(CALIBRATE_POLL_MS, left));
            }
        }

        async function doResize(dirSign, px) {
            if (stale() || resizes >= MAX_RESIZES) return false;
            const dir = dirSign > 0 ? direction : OPPOSITE.get(direction);
            if (!OPPOSITE.has(dir) || !Number.isInteger(px) || px < 1 || px > MAX_RESIZE_PX) {
                log("resize", { step: "validate-failed", dir, px });
                return false;
            }
            resizes += 1;
            try {
                const out = await script("resize", [id, dir, String(px)], RESIZE_TIMEOUT_MS);
                if (stale()) return false;
                return String(out?.stdout ?? "").trim() === "ok";
            } catch {
                return false;
            }
        }

        // The first step a run measures replaces what an earlier run left; after that only a step that
        // moved more cells does: the more cells, the more precise its pixels per cell.
        function remember(step) {
            if (Math.abs(step.delta) <= widest) return;
            widest = Math.abs(step.delta);
            measured.set(axis, step);
        }

        const s1 = await pollSize(beforeCells, CALIBRATE_SPLIT_LIMIT_MS);
        if (stale()) return;
        if (s1 === null) {
            log("resize", { step: "after-split", before: beforeCells, cells: null, outcome: "unchanged" });
            return;
        }
        const first = planResize({ before: beforeCells, size: layout.size, current: s1 });
        log("resize", { step: "after-split", before: beforeCells, cells: s1, plan: first });
        if (first.done) return;

        let probe = null;
        let current = s1;
        const known = measured.get(axis);
        if (known) {
            // An earlier open measured this axis: the whole way in one step, no probe.
            const plan = planResize({ before: beforeCells, size: layout.size, current: s1, probe: known });
            log("resize", { step: "cached", cells: s1, probe: known, plan });
            if (plan.done || !(await doResize(plan.dirSign, plan.px))) {
                // Left in place, a measurement that only yields steps outside the limits would stop
                // every later open right here.
                if (!stale()) measured.delete(axis);
                return;
            }
            const next = await pollSize(s1, CALIBRATE_RESIZE_LIMIT_MS);
            if (stale()) return;
            if (next === null) {
                measured.delete(axis);
            } else {
                probe = { px: plan.px, delta: next - s1, dirSign: plan.dirSign };
                remember(probe);
                current = next;
            }
        }
        if (!probe) {
            let probePx = first.px;
            let s2 = null;
            for (const px of [PROBE_PX, PROBE_RETRY_PX]) {
                probePx = px;
                if (!(await doResize(first.dirSign, px))) return;
                s2 = await pollSize(s1, CALIBRATE_RESIZE_LIMIT_MS);
                if (stale()) return;
                if (s2 !== null) break;
                log("resize", { step: "probe", px, dirSign: first.dirSign, cells: s1, delta: 0 });
            }
            if (s2 === null) return;
            probe = { px: probePx, delta: s2 - s1, dirSign: first.dirSign };
            log("resize", { step: "probe", ...probe, cells: s2 });
            remember(probe);
            current = s2;
        }

        for (let step = 1; step <= 2; step += 1) {
            const plan = planResize({ before: beforeCells, size: layout.size, current, probe });
            log("resize", { step: `correct-${step}`, cells: current, plan });
            if (plan.done) return;
            if (!(await doResize(plan.dirSign, plan.px))) return;
            if (step === 2) return;
            const next = await pollSize(current, CALIBRATE_RESIZE_LIMIT_MS);
            if (stale() || next === null) return;
            remember({ px: plan.px, delta: next - current, dirSign: plan.dirSign });
            current = next;
        }
    }

    async function open(my, layout) {
        const stale = () => my !== attempt;

        // Prechecks, in order. Unsupported environments are silent.
        const interactive = await deps.interactive();
        if (stale()) return;
        if (!interactive) return disable("not-interactive");
        if (deps.platform !== "darwin") return disable("unsupported-platform");
        const term = deps.env.TERM_PROGRAM;
        if (term !== undefined && term !== "ghostty") return disable("unsupported-terminal");
        if (!tty) {
            const found = await deps.findTty();
            if (stale()) return;
            if (!TTY_RE.test(found?.tty ?? "")) return disable("no-tty");
            tty = found.tty;
            proc = { pid: found.pid, started: found.started ?? "" };
        }
        if (!isExecutable(deps.binPath)) return disable("install-incomplete", NOTICE_INCOMPLETE(deps.binPath));
        const direction = directionFor(layout.position);
        if (!direction) return fail("bad-layout");

        // With the pane of an earlier open still on screen, `before` would be the size of a split pane.
        if (leftover && !(await closeLeftover(stale))) {
            if (!stale()) fail("leftover-close-failed");
            return;
        }
        if (stale()) return;

        const size = await deps.readSize(tty);
        if (stale()) return;
        if (!size) return fail("no-size");
        before = size;

        // Not even the compact list would fit: skip this turn. Not a failure, the next turn checks again.
        const sideways = direction === "right" || direction === "left";
        const cols = sideways ? Math.round((size.cols * layout.size) / 100) : size.cols;
        const rows = sideways ? size.rows : Math.round((size.rows * layout.size) / 100);
        if (cols < MIN_COLS || rows < MIN_ROWS) {
            settleSizeCheck(my, { tooSmall: true, cols, rows });
            return finish("idle", "too-small");
        }
        settleSizeCheck(my, null);

        let socketPath;
        try {
            socketPath = await deps.server.rotate(my);
        } catch (err) {
            logError("rotate", err);
            if (!stale()) fail("rotate-failed");
            return;
        }
        if (stale()) return;

        const command =
            `${shellQuote(deps.binPath)} --socket ${shellQuote(socketPath)}` +
            ` --themes ${shellQuote(deps.themesDir)} --close-pane ${shellQuote(deps.scriptPath)}`;
        const call = script("split", [tty, direction, command], SPLIT_TIMEOUT_MS);
        splitCall = call;
        let result = null;
        let error = null;
        try {
            result = parseSplitResult((await call).stdout);
        } catch (err) {
            error = err;
        } finally {
            if (splitCall === call) splitCall = null;
        }

        // Invalidated while the script ran: the closing that did it picks the answer up and closes the pane.
        if (stale()) return;
        if (state === "open") {
            // The client connected before the script returned. The panel works, so a late error is only logged.
            if (result?.kind === "ok") {
                paneId = result.paneId;
                startCalibration(my, paneId, before, layout, direction, tty);
            }
            return;
        }
        if (result?.kind === "ok") {
            paneId = result.paneId;
            go("awaiting", "split-ok");
            arm(() => {
                if (!stale() && state === "awaiting") enterClosing("timeout");
            }, AWAIT_CLIENT_MS);
            startCalibration(my, paneId, before, layout, direction, tty);
            return;
        }
        if (result?.kind === "deferred") return finish("idle", "deferred");
        if (result) return disable(result.kind);
        if (String(error?.stderr ?? "").includes("-1743")) return disable("unauthorized", NOTICE_UNAUTHORIZED);
        fail(error?.timedOut ? "split-timeout" : "split-failed");
    }

    // Closes the pane an earlier closing left behind. Resolves false when it cannot be known to be gone
    // within 1s: it stays remembered.
    async function closeLeftover(stale) {
        const id = leftover;
        if (!(await closeAndConfirm(id, stale, now() + LEFTOVER_BUDGET_MS))) return false;
        if (leftover === id) leftover = "";
        await settled(stale);
        return true;
    }

    // cause: "off" | "layout" | "timeout" | "client-gone"
    function enterClosing(cause) {
        finish("closing", cause);
        if (cause === "layout") pendingPrompt = true;
        const my = attempt;
        closing(my, cause).catch((err) => {
            logError("closing", err);
            if (my === attempt) finish("idle", "error");
        });
    }

    async function closing(my, cause) {
        let gone = false;
        try {
            gone = await paneGone(my);
        } catch (err) {
            logError("closing", err);
        }
        if (my !== attempt) return;
        disarm();
        if (!gone) {
            // Having waited is no proof. Nothing is opened next to a pane that may still be there:
            // the open has failed, and the next one closes the pane before it measures.
            if (paneId) leftover = paneId;
            log("pane", { from: state, to: state, reason: "close-unconfirmed", attempt, leftover });
            return fail("close-unconfirmed");
        }
        // The panel never connected. That is a failed open whether the pane was still there (`ok`)
        // or had closed itself by now (`gone`), which is what a panel that cannot connect does.
        if (cause === "timeout") failures += 1;
        if (failures >= MAX_FAILURES) return tripBreaker();
        reload();
        if (isOn() && pendingPrompt) {
            pendingPrompt = false;
            return startOpen("reopen");
        }
        finish("idle", "collapsed");
    }

    // Resolves true once the pane of the open just wrapped up is known to be gone, false when that cannot
    // be had within 2s. The pane is asked for by its id. The Copilot pane's reading cannot tell: it lags
    // behind a split by up to 0.1s, and it never returns to `before` once the window has been resized.
    // Only an open that never learned its pane id has nothing else to go by.
    async function paneGone(my) {
        const stale = () => my !== attempt;
        let expired = false;
        const expiry = new Promise((resolve) => {
            arm(() => {
                expired = true;
                killScripts();
                resolve();
            }, CLOSING_BUDGET_MS);
        });

        const split = splitCall;
        if (split) {
            // Wait for it rather than kill it: killing osascript does not undo a split Ghostty
            // already made, it only loses the new pane's id.
            const answer = split.then((out) => parseSplitResult(out?.stdout), () => null);
            const result = await Promise.race([answer, expiry]);
            if (stale()) return false;
            if (expired) {
                if (splitCall === split) splitCall = null;
                // Killed by now. Should it have answered `ok <id>` all the same, nobody else knows that pane.
                answer.then((late) => {
                    if (late?.kind === "ok" && !dead) closePane(late.paneId);
                });
                return false;
            }
            if (result?.kind === "ok") paneId = result.paneId;
        }

        if (paneId) {
            const gone = await Promise.race([closeAndConfirm(paneId, () => stale() || expired), expiry]);
            if (stale() || expired || !gone) return false;
            // The 2s were for finding out. Waiting for the reading only delays what comes next.
            await settled(stale);
            return true;
        }

        if (!before) return true;     // interrupted before anything was split off
        for (;;) {
            const size = await Promise.race([deps.readSize(tty), expiry]);
            if (stale() || expired) return false;
            if (sameSize(size, before)) return true;
            await Promise.race([deps.sleep(CLOSING_POLL_MS), expiry]);
            if (stale() || expired) return false;
        }
    }

    // Neither a pane nor an earlier intent to open one outlives the switch: seeing it off is handled
    // like `off`, without writing the config. The flags go in every state, a pane only if there is one.
    function align() {
        if (isOn()) return;
        pendingPrompt = false;
        pendingLayout = false;
        if (paneActive()) enterClosing("off");
    }

    function onTurnStart() {
        try {
            if (dead) return;
            log("turn", { state, overrideReady });
            if (!overrideReady) {
                deferredTurn = true;
                return;
            }
            reload();
            align();
            if (!isOn()) return;
            if (state === "idle") startOpen("turn");
            else if (state === "awaiting" || state === "closing") pendingPrompt = true;
        } catch (err) {
            logError("turn", err);
        }
    }

    function onClientConnected(clientAttempt) {
        try {
            if (dead) return;
            log("client", { event: "connect", attempt: clientAttempt });
            if (clientAttempt !== attempt || (state !== "opening" && state !== "awaiting")) return;
            disarm();
            failures = 0;
            pendingPrompt = false;
            go("open", "connected");
            if (pendingLayout) enterClosing("layout");
        } catch (err) {
            logError("client", err);
        }
    }

    function onClientDisconnected(clientAttempt) {
        try {
            if (dead) return;
            log("client", { event: "disconnect", attempt: clientAttempt });
            if (clientAttempt !== attempt || state !== "open") return;
            enterClosing("client-gone");
        } catch (err) {
            logError("client", err);
        }
    }

    async function save(change) {
        config = await deps.updateConfig(change);
        if (dead) throw new Error("shutting down");
    }

    // Takes effect in this process whether or not the marker file can be written: the file only carries
    // the override across /clear. Returns what went wrong, for the command's answer, or "".
    function setOverride(value) {
        override = value;
        try {
            deps.writeOverride(proc, value === "none" ? "" : value);
            return "";
        } catch (err) {
            logError("writeOverride", err);
            const why = err?.message ?? err;
            return value === "none"
                ? `could not clear this session's hide/show marker: ${why}`
                : `could not save this session's marker, so it will not survive /clear: ${why}`;
        }
    }

    // A command that did its job but has a problem to mention answers with a warning.
    const answer = (text, problem, level = "info") =>
        problem ? { text: `${text} (${problem})`, level: "warning" } : { text, level };

    function formatStatus() {
        const paneState = state === "disabled" ? `disabled (${reason})` : state === "open" ? "pane open" : "pane closed";
        const sessionPart = override !== "none" ? ` · this session: ${override}` : "";
        return `${describe(config)} · ${paneState}${sessionPart}\n${USAGE}`;
    }

    function formatThemes() {
        const custom = listThemes(deps.themesDir).filter((name) => !BUILTIN_THEMES.includes(name));
        return `FleetPane: theme ${config.theme} (available: ${[...BUILTIN_THEMES, ...custom].join(", ")})`;
    }

    function applyEnable() {
        failures = 0;
        align();
        if (state === "idle" || state === "disabled") return startOpen("command", true);
        if (state === "awaiting" || state === "closing") pendingPrompt = true;
        return null;
    }

    async function handle(parsed) {
        try {
            await ready;
            if (dead) throw new Error("shutting down");
            log("command", parsed);
            const action = parsed?.action;
            // Every command re-reads the config and aligns the pane with it. The four that change the switch
            // do so first and align with the new value: with the old one, `show` after the config was switched
            // off elsewhere would close an open pane only to open it again.
            reload();
            if (!SWITCH_ACTIONS.includes(action)) align();
            switch (action) {
                case "help":
                    return { reply: { text: USAGE, level: "info" } };
                case "error":
                    return { reply: { text: `FleetPane: ${parsed.message}\n${USAGE}`, level: "warning" } };
                case "status":
                    return { reply: { text: formatStatus(), level: "info" } };
                case "showLayout":
                    return {
                        reply: {
                            text: `FleetPane: layout ${config.layout.position} ${config.layout.size}%\n${USAGE}`,
                            level: "info",
                        },
                    };
                case "showTheme":
                    return { reply: { text: formatThemes(), level: "info" } };
                case "on": {
                    await save({ enabled: true });
                    const problem = setOverride("none");
                    const wait = applyEnable();
                    return { reply: answer(describe(config), problem), wait, problem };
                }
                case "off": {
                    await save({ enabled: false });
                    const problem = setOverride("none");
                    align();
                    return { reply: answer("FleetPane: off", problem) };
                }
                case "hide": {
                    const problem = setOverride("hidden");
                    align();
                    return { reply: answer("FleetPane: hidden in this session", problem) };
                }
                case "show": {
                    const problem = setOverride("shown");
                    const wait = applyEnable();
                    return { reply: answer("FleetPane: shown in this session", problem), wait, problem };
                }
                case "layout": {
                    // Without a size only the position is written: the size stays whatever is stored by then.
                    const { position, size } = parsed;
                    await save({ layout: size === undefined ? { position } : { position, size } });
                    align();
                    if (state === "open") enterClosing("layout");
                    else if (state === "opening" || state === "awaiting") pendingLayout = true;
                    return {
                        reply: { text: `FleetPane: layout ${config.layout.position} ${config.layout.size}%`, level: "info" },
                    };
                }
                case "theme":
                    await save({ theme: parsed.theme });
                    align();
                    schedulePush();
                    return { reply: { text: `FleetPane: theme ${config.theme}`, level: "info" } };
                default:
                    return {
                        reply: { text: `FleetPane: unsupported command: ${action}\n${USAGE}`, level: "warning" },
                    };
            }
        } catch (err) {
            logError("command", err);
            return { reply: { text: `FleetPane: ${err?.message ?? err}`, level: "warning" } };
        }
    }

    // One command at a time: the next one starts after the previous one, config write included, is done.
    // Waiting on an explicit on/show size check happens outside the queue so a following off/hide can cancel it.
    function onCommand(parsed) {
        const step = queue.then(() => handle(parsed));
        queue = step.then(() => undefined);
        return step.then(async ({ reply, wait, problem }) => {
            if (!wait) return reply;
            const outcome = await wait;
            if (!outcome?.tooSmall) return reply;
            return answer(
                `FleetPane: window too small (pane would be ${outcome.cols}x${outcome.rows}, needs ${MIN_COLS}x${MIN_ROWS})`,
                problem,
                "warning",
            );
        });
    }

    // No desktop actions here: the pane collapses by itself once its connection is gone.
    function shutdown() {
        if (dead) return;
        dead = true;
        attempt += 1;
        disarm();
        resolveReady();
        settleSizeCheck(null, null);
        log("pane", { from: state, to: state, reason: "shutdown", attempt });
        killScripts();
        closeServer();
    }

    async function init() {
        try {
            const found = await deps.findTty();
            if (dead) return;
            if (TTY_RE.test(found?.tty ?? "")) {
                tty = found.tty;
                proc = { pid: found.pid, started: found.started ?? "" };
            }
            const saved = deps.readOverride(proc);
            if (saved === "hidden" || saved === "shown") override = saved;
        } catch (err) {
            logError("init", err);
        } finally {
            overrideReady = true;
            resolveReady();
            if (!dead && deferredTurn) {
                deferredTurn = false;
                onTurnStart();
            }
        }
    }
    init();

    return {
        onTurnStart,
        onCommand,
        onClientConnected,
        onClientDisconnected,
        shutdown,
        status: () => ({ state, reason, override }),
        theme: () => {
            if (!config) reload();
            return config.theme;
        },
    };
}
