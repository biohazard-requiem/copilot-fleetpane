import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createServer } from "../../extension/lib/server.mjs";
import { createState } from "../../extension/lib/state.mjs";
import { isInteractive, start } from "../../extension/lib/wire.mjs";

// lets every pending promise callback run
const settled = () => new Promise((resolve) => setImmediate(resolve));

const TRIGGERS = ["SIGTERM", "SIGINT", "session.shutdown", "stdin-end", "stdin-close", "ppid-1"];

async function fire(h, trigger) {
    if (trigger === "SIGTERM" || trigger === "SIGINT") {
        const [fn] = h.processListeners.get(trigger) ?? [];
        assert.equal(typeof fn, "function", `${trigger} listener registered`);
        fn();
    } else if (trigger === "session.shutdown") {
        h.joinOpts.onEvent({ type: "session.shutdown" });
    } else if (trigger === "stdin-end") {
        h.stdin.emit("end");
    } else if (trigger === "stdin-close") {
        h.stdin.emit("close");
    } else if (trigger === "ppid-1") {
        assert.equal(h.intervals[0].ms, 2000);
        assert.equal(h.intervals[0].unrefed, true);
        h.intervals[0].fn();
        await settled();
        assert.equal(h.controllerShutdowns, 0);
        assert.deepEqual(h.exits, []);
        h.setPpid(1);
        h.intervals[0].fn();
    }
    await settled();
}

function makeHarness(overrides = {}) {
    const calls = [];
    const logs = [];
    const sessionLogs = [];
    const forbidden = [];
    const onCalls = [];
    const exits = [];
    const processListeners = new Map();
    const intervals = [];
    const timeouts = [];
    const stdin = new EventEmitter();
    let ppid = 12345;
    let joinOpts = null;
    let serverOpts = null;
    let controllerDeps = null;
    let serverSchedules = 0;
    let turnStarts = 0;
    let controllerShutdowns = 0;
    let commandCalls = [];

    const session = {
        sessionId: overrides.sessionId ?? "sess-1",
        capabilities: overrides.capabilities ?? {
            ui: { elicitation: true, mcpApps: false, canvases: true, autoModeRecovery: false },
            extensions: false,
        },
        log: async (text, opts) => {
            sessionLogs.push({ text, opts });
            if (overrides.sessionLog) return await overrides.sessionLog(text, opts);
        },
        on: (...args) => {
            onCalls.push(args);
        },
        send: (...args) => forbidden.push(["send", args]),
        sendAndWait: (...args) => forbidden.push(["sendAndWait", args]),
        abort: (...args) => forbidden.push(["abort", args]),
        // session.rpc is an object of namespaces (rpc.tasks.list()), so reading it at all is recorded
        get rpc() {
            forbidden.push(["rpc"]);
            return {};
        },
    };

    const joinSession = async (opts) => {
        joinOpts = opts;
        if (overrides.duringJoin) await overrides.duringJoin(opts);
        return session;
    };

    const server = {
        rotate: async () => "/fake/runtime/sess-1.1.1.sock",
        schedule: () => {
            serverSchedules += 1;
            calls.push("server.schedule");
        },
        hasClient: () => false,
        close: async () => {
            calls.push("server.close");
            if (overrides.serverClose) return await overrides.serverClose();
        },
    };

    const controller = {
        onTurnStart: () => {
            turnStarts += 1;
            calls.push("controller.onTurnStart");
            if (overrides.onTurnStart) overrides.onTurnStart();
        },
        onCommand: async (parsed) => {
            commandCalls.push(parsed);
            calls.push(`controller.onCommand:${parsed.action}`);
            if (overrides.onCommand) return await overrides.onCommand(parsed);
            return { text: `FleetPane: ${parsed.action}`, level: "info" };
        },
        onClientConnected: (attempt) => calls.push(`controller.connect:${attempt}`),
        onClientDisconnected: (attempt) => calls.push(`controller.disconnect:${attempt}`),
        shutdown: () => {
            controllerShutdowns += 1;
            calls.push("controller.shutdown");
        },
        status: () => ({ state: "idle", reason: "", override: "none" }),
        theme: () => overrides.theme ?? "gta6",
    };

    const fakeState = {
        _turn: 0,
        apply: (event) => {
            calls.push(`state.apply:${event?.type ?? "?"}`);
            return false;
        },
        snapshot: () => ({ turn: 0, stats: { turnTools: 0 }, main: {}, agents: [], log: [] }),
        turn: () => fakeState._turn,
    };

    const make = {
        createState: overrides.createState ?? (() => fakeState),
        runtimeDir: overrides.runtimeDir ?? (() => "/fake/runtime"),
        prepareDir: overrides.prepareDir ?? (() => calls.push("prepareDir")),
        sweepStale: overrides.sweepStale ?? (() => {
            calls.push("sweepStale");
            return 0;
        }),
        createDebug: overrides.createDebug ?? (() => (kind, payload = {}) => {
            logs.push({ kind, ...payload });
        }),
        createServer: overrides.createServer ?? ((opts) => {
            serverOpts = opts;
            return server;
        }),
        createPaneController: overrides.createPaneController ?? ((deps) => {
            controllerDeps = deps;
            return controller;
        }),
        copilotArgs: overrides.copilotArgs ?? (async () => "copilot"),
        exit: (code) => {
            exits.push(code);
            calls.push(`exit:${code}`);
            if (overrides.onExit) overrides.onExit(code);
        },
        processOn: (event, fn) => {
            if (!processListeners.has(event)) processListeners.set(event, []);
            processListeners.get(event).push(fn);
        },
        stdin,
        setInterval: (fn, ms) => {
            const handle = {
                fn,
                ms,
                unrefed: false,
                cleared: false,
                unref() {
                    this.unrefed = true;
                    return this;
                },
            };
            intervals.push(handle);
            return handle;
        },
        clearInterval: (handle) => {
            if (handle) handle.cleared = true;
        },
        setTimeout: (fn, ms) => {
            const handle = { fn, ms, cleared: false };
            timeouts.push(handle);
            return handle;
        },
        clearTimeout: (handle) => {
            if (handle) handle.cleared = true;
        },
        getPpid: () => ppid,
    };

    return {
        joinSession,
        make,
        session,
        server,
        controller,
        fakeState,
        stdin,
        calls,
        logs,
        sessionLogs,
        forbidden,
        onCalls,
        exits,
        processListeners,
        intervals,
        timeouts,
        commandCalls,
        setPpid: (value) => {
            ppid = value;
        },
        get joinOpts() {
            return joinOpts;
        },
        get serverOpts() {
            return serverOpts;
        },
        get controllerDeps() {
            return controllerDeps;
        },
        get serverSchedules() {
            return serverSchedules;
        },
        get turnStarts() {
            return turnStarts;
        },
        get controllerShutdowns() {
            return controllerShutdowns;
        },
    };
}

test("joinSession options: no hooks, no tools, only fleetpane command and onEvent; session.on not called", async () => {
    const h = makeHarness();
    await start({ joinSession: h.joinSession, make: h.make });

    assert.deepEqual(Object.keys(h.joinOpts).sort(), ["commands", "onEvent"]);
    assert.equal("hooks" in h.joinOpts, false);
    assert.equal("tools" in h.joinOpts, false);
    assert.equal(typeof h.joinOpts.onEvent, "function");
    assert.equal(h.joinOpts.commands.length, 1);
    assert.equal(h.joinOpts.commands[0].name, "fleetpane");
    assert.equal(
        h.joinOpts.commands[0].description,
        "Show or change the FleetPane activity pane (on, off, hide, show, layout, theme)",
    );
    assert.equal(typeof h.joinOpts.commands[0].handler, "function");
    assert.deepEqual(h.onCalls, []);
});

test("fake state increments turn on 1st and 4th of 5 events: onTurnStart called twice right after each", async () => {
    let seen = 0;
    let turn = 0;
    const order = [];
    const h = makeHarness({
        createState: () => ({
            apply: (ev) => {
                seen += 1;
                order.push(`event:${ev.n}`);
                if (seen === 1 || seen === 4) turn += 1;
                return false;
            },
            snapshot: () => ({}),
            turn: () => turn,
        }),
        onTurnStart: () => order.push("onTurnStart"),
    });

    await start({ joinSession: h.joinSession, make: h.make });
    for (let n = 1; n <= 5; n++) h.joinOpts.onEvent({ type: "test", n });

    assert.equal(h.turnStarts, 2);
    assert.deepEqual(order, [
        "event:1",
        "onTurnStart",
        "event:2",
        "event:3",
        "event:4",
        "onTurnStart",
        "event:5",
    ]);
});

test("real createState: only idle user submission triggers onTurnStart; steering, agentId, source, tool do not", async () => {
    const h = makeHarness({ createState });
    await start({ joinSession: h.joinSession, make: h.make });

    const ts = (s) => `2026-11-25T10:00:0${s}.000Z`;
    h.joinOpts.onEvent({ id: "u1", type: "user.message", timestamp: ts(1), data: { content: "hi", delivery: "idle" } });
    assert.equal(h.turnStarts, 1);

    h.joinOpts.onEvent({
        id: "u2",
        type: "user.message",
        timestamp: ts(2),
        data: { content: "steer", delivery: "steering" },
    });
    h.joinOpts.onEvent({
        id: "u3",
        type: "user.message",
        agentId: "agent-1",
        timestamp: ts(3),
        data: { content: "subagent" },
    });
    h.joinOpts.onEvent({
        id: "u4",
        type: "user.message",
        timestamp: ts(4),
        data: { content: "", source: "memory" },
    });
    h.joinOpts.onEvent({
        id: "t1",
        type: "tool.execution_start",
        timestamp: ts(5),
        data: { toolCallId: "tc1", toolName: "bash", arguments: { command: "ls" } },
    });

    assert.equal(h.turnStarts, 1);
});

test("real createState: duplicate event id and checkpoint user.message do not re-trigger onTurnStart", async () => {
    const h = makeHarness({ createState });
    await start({ joinSession: h.joinSession, make: h.make });

    const first = {
        id: "dup-1",
        type: "user.message",
        timestamp: "2026-11-25T10:00:01.000Z",
        data: { content: "hello", delivery: "idle" },
    };
    h.joinOpts.onEvent(first);
    assert.equal(h.turnStarts, 1);

    h.joinOpts.onEvent({ ...first });
    h.joinOpts.onEvent({
        id: "cp-1",
        type: "user.message",
        checkpoint: true,
        timestamp: "2026-11-25T10:00:02.000Z",
        data: { content: "replayed", delivery: "idle" },
    });

    assert.equal(h.turnStarts, 1);
});

test("after a full turn of prompt, events, command and notify: forbidden methods never called, every log is ephemeral", async () => {
    const h = makeHarness({ createState });
    await start({ joinSession: h.joinSession, make: h.make });

    h.joinOpts.onEvent({
        id: "e1",
        type: "user.message",
        timestamp: "2026-11-25T10:00:00.000Z",
        data: { content: "do something", delivery: "idle" },
    });
    h.joinOpts.onEvent({
        id: "e2",
        type: "tool.execution_start",
        timestamp: "2026-11-25T10:00:01.000Z",
        data: { toolCallId: "tc1", toolName: "bash", arguments: { command: "echo ok" } },
    });
    await h.joinOpts.commands[0].handler({ args: "layout left 40" });
    await h.controllerDeps.notify("heads up", "warning");

    assert.deepEqual(h.forbidden, []);
    assert.deepEqual(h.onCalls, []);
    assert.equal(h.sessionLogs.length, 2);
    for (const entry of h.sessionLogs) {
        assert.equal(entry.opts.ephemeral, true);
    }
    assert.equal(h.sessionLogs[0].text, "FleetPane: layout");
    assert.equal(h.sessionLogs[0].opts.level, "info");
    assert.equal(h.sessionLogs[1].text, "heads up");
    assert.equal(h.sessionLogs[1].opts.level, "warning");
});

test("event arriving via onEvent before joinSession returns: no throw, onTurnStart called once after init", async () => {
    const h = makeHarness({
        createState,
        duringJoin: (opts) => {
            opts.onEvent({
                id: "early-1",
                type: "user.message",
                timestamp: "2026-11-25T10:00:00.000Z",
                data: { content: "early prompt", delivery: "idle" },
            });
            assert.equal(h.turnStarts, 0);
        },
    });

    await start({ joinSession: h.joinSession, make: h.make });
    assert.equal(h.turnStarts, 1);
});

test("fake apply throws after incrementing turn vs throws without incrementing turn", async () => {
    let turn = 0;
    let mode = "inc-and-throw";
    const h = makeHarness({
        createState: () => ({
            apply: () => {
                if (mode === "inc-and-throw") {
                    turn += 1;
                    throw new Error("boom-after-turn");
                }
                throw new Error("boom-no-turn");
            },
            snapshot: () => ({}),
            turn: () => turn,
        }),
    });

    await start({ joinSession: h.joinSession, make: h.make });

    assert.doesNotThrow(() => h.joinOpts.onEvent({ type: "user.message" }));
    assert.equal(h.turnStarts, 1);
    const firstErrors = h.logs.filter((r) => r.kind === "error");
    assert.equal(firstErrors.length, 1);
    assert.match(firstErrors[0].message, /boom-after-turn/);

    mode = "throw-only";
    assert.doesNotThrow(() => h.joinOpts.onEvent({ type: "user.message" }));
    assert.equal(h.turnStarts, 1);
    const allErrors = h.logs.filter((r) => r.kind === "error");
    assert.equal(allErrors.length, 2);
    assert.match(allErrors[1].message, /boom-no-turn/);
});

test("uncaughtException and unhandledRejection handlers via processOn: no throw, error logged, exit not called", async () => {
    const h = makeHarness();
    await start({ joinSession: h.joinSession, make: h.make });

    const [onUncaught] = h.processListeners.get("uncaughtException") ?? [];
    const [onRejection] = h.processListeners.get("unhandledRejection") ?? [];
    assert.equal(typeof onUncaught, "function");
    assert.equal(typeof onRejection, "function");

    assert.doesNotThrow(() => onUncaught(new Error("uncaught boom")));
    assert.doesNotThrow(() => onRejection("rejected reason"));

    const errors = h.logs.filter((r) => r.kind === "error");
    assert.equal(errors.length, 2);
    assert.match(errors[0].message, /uncaught boom/);
    assert.match(errors[1].message, /rejected reason/);
    assert.deepEqual(h.exits, []);
});

test("command handler called before joinSession returns: ignored without throwing", async () => {
    let earlyResult;
    const h = makeHarness({
        duringJoin: async (opts) => {
            earlyResult = await opts.commands[0].handler({ args: "status" });
        },
    });

    await start({ joinSession: h.joinSession, make: h.make });
    assert.equal(earlyResult, undefined);
    assert.deepEqual(h.sessionLogs, []);
    assert.deepEqual(h.commandCalls, []);
});

test("prepareDir throws: start does not throw; /fleetpane on reports unavailable; prompts do nothing; events still fold", async () => {
    const state = createState();
    let controllerCreated = false;
    let serverCreated = false;
    const h = makeHarness({
        createState: () => state,
        prepareDir: () => {
            throw new Error("owned by another user");
        },
        createServer: () => {
            serverCreated = true;
            return {};
        },
        createPaneController: () => {
            controllerCreated = true;
            return {};
        },
    });

    await assert.doesNotReject(() => start({ joinSession: h.joinSession, make: h.make }));
    assert.equal(serverCreated, false);
    assert.equal(controllerCreated, false);

    await h.joinOpts.commands[0].handler({ args: "on" });
    assert.equal(h.sessionLogs.length, 1);
    assert.equal(h.sessionLogs[0].text, "FleetPane unavailable: owned by another user");
    assert.deepEqual(h.sessionLogs[0].opts, { level: "warning", ephemeral: true });

    assert.doesNotThrow(() => {
        h.joinOpts.onEvent({
            id: "e1",
            type: "user.message",
            timestamp: "2026-11-25T10:00:00.000Z",
            data: { content: "hello", delivery: "idle" },
        });
    });
    assert.equal(state.turn(), 1);
    assert.equal(h.turnStarts, 0);
    assert.equal(h.serverSchedules, 0);
});

test("controller.onCommand throws: outputs warning command failed, logs error, does not throw", async () => {
    const h = makeHarness({
        onCommand: async () => {
            throw new Error("disk full");
        },
    });
    await start({ joinSession: h.joinSession, make: h.make });

    await assert.doesNotReject(() => h.joinOpts.commands[0].handler({ args: "on" }));
    assert.equal(h.sessionLogs.length, 1);
    assert.equal(h.sessionLogs[0].text, "FleetPane: command failed: disk full");
    assert.deepEqual(h.sessionLogs[0].opts, { level: "warning", ephemeral: true });
    assert.equal(h.logs.filter((r) => r.kind === "error").length, 1);
});

test("session.log fails after the command succeeded: not reported as a failed command, the failure is logged", async () => {
    const failing = [
        () => Promise.reject(new Error("log down")),
        () => {
            throw new Error("log down");
        },
    ];
    for (const sessionLog of failing) {
        const h = makeHarness({ sessionLog });
        await start({ joinSession: h.joinSession, make: h.make });

        await assert.doesNotReject(() => h.joinOpts.commands[0].handler({ args: "off" }));
        assert.deepEqual(h.commandCalls, [{ action: "off" }]);
        assert.deepEqual(h.sessionLogs.map((entry) => entry.text), ["FleetPane: off"]);
        assert.deepEqual(h.logs.filter((r) => r.kind === "error"), [{ kind: "error", where: "say", message: "log down" }]);
    }

    const h = makeHarness({
        sessionLog: failing[0],
        prepareDir: () => {
            throw new Error("owned by another user");
        },
    });
    await start({ joinSession: h.joinSession, make: h.make });
    await assert.doesNotReject(() => h.joinOpts.commands[0].handler({ args: "off" }));
    assert.deepEqual(h.sessionLogs.map((entry) => entry.text), ["FleetPane unavailable: owned by another user"]);
});

test("getLine fails: the error is logged and passed on to the server, which skips that line", async () => {
    const h = makeHarness();
    h.controller.theme = () => {
        throw new Error("no theme");
    };
    await start({ joinSession: h.joinSession, make: h.make });

    assert.throws(() => h.serverOpts.getLine(), /no theme/);
    assert.deepEqual(h.logs.filter((r) => r.kind === "error"), [{ kind: "error", where: "getLine", message: "no theme" }]);
});

test("onEvent: state.apply returning true schedules server, returning false does not", async () => {
    let changed = true;
    const h = makeHarness({
        createState: () => ({
            apply: () => changed,
            snapshot: () => ({}),
            turn: () => 0,
        }),
    });
    await start({ joinSession: h.joinSession, make: h.make });

    h.joinOpts.onEvent({ type: "a" });
    assert.equal(h.serverSchedules, 1);

    changed = false;
    h.joinOpts.onEvent({ type: "b" });
    assert.equal(h.serverSchedules, 1);
});

test("getLine called twice without state change: seq increments by 1, rest identical, has v/session/theme, logs snapshot", async () => {
    const h = makeHarness({ sessionId: "s-42", theme: "cyber" });
    await start({ joinSession: h.joinSession, make: h.make });

    const line1 = h.serverOpts.getLine();
    const line2 = h.serverOpts.getLine();
    const parsed1 = JSON.parse(line1);
    const parsed2 = JSON.parse(line2);

    assert.equal(parsed1.v, 1);
    assert.equal(parsed1.session, "s-42");
    assert.equal(parsed1.theme, "cyber");
    assert.equal(parsed2.seq - parsed1.seq, 1);
    assert.deepEqual({ ...parsed2, seq: parsed1.seq }, parsed1);

    const snapshots = h.logs.filter((r) => r.kind === "snapshot");
    assert.deepEqual(snapshots, [
        { kind: "snapshot", line: line1 },
        { kind: "snapshot", line: line2 },
    ]);
});

test("shutdown() twice: controller.shutdown, server.close and exit(0) each called once, in that order", async () => {
    const h = makeHarness();
    const handle = await start({ joinSession: h.joinSession, make: h.make });

    handle.shutdown();
    handle.shutdown();
    await settled();
    handle.shutdown();
    await settled();

    assert.equal(h.controllerShutdowns, 1);
    assert.deepEqual(h.exits, [0]);
    assert.deepEqual(
        h.calls.filter((call) => !call.startsWith("prepareDir") && !call.startsWith("sweepStale")),
        ["controller.shutdown", "server.close", "exit:0"],
    );
    assert.equal(h.timeouts.length, 1);
    assert.equal(h.intervals.length, 1);
    assert.equal(h.intervals[0].unrefed, true);
    assert.equal(h.intervals[0].cleared, true);
});

test("shutdown: exit(0) is called only after server.close() has settled, and the 500ms bound is then cancelled", async () => {
    let finishClose;
    const h = makeHarness({
        serverClose: () =>
            new Promise((resolve) => {
                finishClose = resolve;
            }),
    });
    const handle = await start({ joinSession: h.joinSession, make: h.make });

    handle.shutdown();
    await settled();
    assert.equal(h.controllerShutdowns, 1);
    assert.equal(typeof finishClose, "function", "server.close() was called");
    assert.deepEqual(h.exits, []);
    assert.deepEqual(h.timeouts.map((timer) => [timer.ms, timer.cleared]), [[500, false]]);

    finishClose();
    await settled();
    assert.deepEqual(h.exits, [0]);
    assert.equal(h.timeouts[0].cleared, true);
});

test("shutdown with a server.close() that does not settle in time: exit(0) when the 500ms bound elapses, only once", async () => {
    let finishClose;
    const h = makeHarness({
        serverClose: () =>
            new Promise((resolve) => {
                finishClose = resolve;
            }),
    });
    const handle = await start({ joinSession: h.joinSession, make: h.make });

    handle.shutdown();
    await settled();
    assert.deepEqual(h.exits, []);

    h.timeouts[0].fn();
    assert.deepEqual(h.exits, [0]);

    // the close settling after all, and a second shutdown(), change nothing
    finishClose();
    handle.shutdown();
    await settled();
    assert.deepEqual(h.exits, [0]);
    assert.equal(h.controllerShutdowns, 1);
});

test("controller.shutdown() throws or server.close() rejects during shutdown: logged, exit(0) all the same", async () => {
    const throwing = makeHarness();
    throwing.controller.shutdown = () => {
        throw new Error("controller broke");
    };
    const rejecting = makeHarness({ serverClose: () => Promise.reject(new Error("close rejected")) });

    for (const [h, reason] of [[throwing, /controller broke/], [rejecting, /close rejected/]]) {
        const handle = await start({ joinSession: h.joinSession, make: h.make });

        assert.doesNotThrow(() => handle.shutdown());
        await settled();
        assert.ok(h.calls.includes("server.close"));
        assert.deepEqual(h.exits, [0]);
        const errors = h.logs.filter((r) => r.kind === "error");
        assert.equal(errors.length, 1);
        assert.match(errors[0].message, reason);
    }
});

test("shutdown while a rotate is still in flight, with the real server: no socket file is left when exit is called", { timeout: 10_000 }, async (t) => {
    const dir = fs.mkdtempSync(path.join(process.env.FLEETPANE_TEST_TMPDIR || "/tmp", "fp-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    let server;
    let leftAtExit;
    const h = makeHarness({
        sessionId: "s1",
        runtimeDir: () => dir,
        createServer: (opts) => {
            server = createServer(opts);
            return server;
        },
        onExit: () => {
            leftAtExit = fs.readdirSync(dir);
        },
    });
    const handle = await start({ joinSession: h.joinSession, make: h.make });
    t.after(() => server.close());

    const rotating = server.rotate(1);
    assert.deepEqual(fs.readdirSync(dir), [`s1.${process.pid}.1.sock`], "the socket is bound, the rotate is not finished");
    handle.shutdown();
    await rotating;
    while (h.exits.length === 0) await settled();

    assert.deepEqual(leftAtExit, []);
    assert.deepEqual(h.exits, [0]);
});

test("shutdown triggers: SIGTERM, SIGINT, session.shutdown event, stdin end/close, and ppid === 1 interval", async () => {
    for (const trigger of TRIGGERS) {
        const h = makeHarness();
        await start({ joinSession: h.joinSession, make: h.make });

        await fire(h, trigger);

        assert.equal(h.controllerShutdowns, 1, trigger);
        assert.deepEqual(h.exits, [0], trigger);
        assert.deepEqual(h.forbidden, [], trigger);
    }
});

test("prepareDir throws: signals, stdin end/close, ppid 1 and session.shutdown still exit; uncaught errors are still caught", async () => {
    for (const trigger of TRIGGERS) {
        const h = makeHarness({
            prepareDir: () => {
                throw new Error("owned by another user");
            },
        });
        const handle = await start({ joinSession: h.joinSession, make: h.make });

        const [onUncaught] = h.processListeners.get("uncaughtException") ?? [];
        const [onRejection] = h.processListeners.get("unhandledRejection") ?? [];
        assert.equal(typeof onUncaught, "function");
        assert.equal(typeof onRejection, "function");
        assert.doesNotThrow(() => onUncaught(new Error("uncaught boom")));
        assert.doesNotThrow(() => onRejection("rejected reason"));
        assert.deepEqual(h.exits, []);

        await fire(h, trigger);

        assert.deepEqual(h.exits, [0], trigger);
        assert.equal(h.controllerShutdowns, 0, trigger);
        assert.equal(h.intervals[0].cleared, true, trigger);
        handle.shutdown();
        await settled();
        assert.deepEqual(h.exits, [0], trigger);
    }
});

test("user.message and session.shutdown arrive before joinSession returns: nothing is initialised or replayed, exit(0) once", async () => {
    const prompt = {
        id: "early-1",
        type: "user.message",
        timestamp: "2026-11-25T10:00:00.000Z",
        data: { content: "early prompt", delivery: "idle" },
    };
    for (const early of [[prompt, { type: "session.shutdown" }], [{ type: "session.shutdown" }, prompt]]) {
        const h = makeHarness({
            createState,
            duringJoin: (opts) => {
                for (const event of early) opts.onEvent(event);
            },
        });

        const handle = await start({ joinSession: h.joinSession, make: h.make });
        await settled();

        assert.deepEqual(h.exits, [0]);
        assert.equal(h.turnStarts, 0);
        assert.equal(h.serverOpts, null, "no server");
        assert.equal(h.controllerDeps, null, "no controller");
        assert.deepEqual(h.calls, ["exit:0"]);

        handle.shutdown();
        await settled();
        assert.deepEqual(h.exits, [0]);
        assert.deepEqual(h.forbidden, []);
    }
});

test("isInteractive reads the Copilot command line: -p / --prompt means a one-shot run", () => {
    assert.equal(isInteractive("copilot"), true);
    assert.equal(isInteractive("copilot --experimental --model claude-fable-5.2"), true);
    assert.equal(isInteractive("copilot --experimental -p Reply with the single word: ok"), false);
    assert.equal(isInteractive("/opt/bin/copilot --prompt hello"), false);
    assert.equal(isInteractive("copilot --prompt=hello"), false);
    assert.equal(isInteractive("copilot -i use grep -p here"), true);
    assert.equal(isInteractive("copilot --interactive=fix -p"), true);
    assert.equal(isInteractive(""), true);
    assert.equal(isInteractive(undefined), true);
});

test("wiring passes expected deps to createPaneController, logs boot after sweepStale, and notify swallows errors", async (t) => {
    const dir = fs.mkdtempSync(path.join(process.env.FLEETPANE_TEST_TMPDIR || "/tmp", "fp-wire-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    let logMode = "reject";
    const h = makeHarness({
        runtimeDir: () => dir,
        copilotArgs: async () => "copilot --experimental -p hi",
        sessionLog: () => {
            if (logMode === "throw") throw new Error("sync boom");
            return Promise.reject(new Error("log down"));
        },
    });
    await start({ joinSession: h.joinSession, make: h.make });

    // boot record logged with expected fields after sweepStale
    const boot = h.logs.find((r) => r.kind === "boot");
    assert.ok(boot);
    assert.equal(boot.pid, process.pid);
    assert.equal(boot.ppid, process.ppid);
    assert.equal(boot.node, process.version);
    assert.equal(boot.runtimeDir, dir);
    assert.equal(typeof boot.extDir, "string");
    assert.equal(typeof boot.tty, "string");
    assert.ok(h.calls.indexOf("prepareDir") < h.calls.indexOf("sweepStale"));

    // controller deps wired properly
    const deps = h.controllerDeps;
    assert.equal(deps.server, h.server);
    assert.equal(await deps.interactive(), false);
    assert.equal(deps.platform, process.platform);
    assert.equal(deps.env, process.env);
    assert.equal(deps.binPath, path.join(boot.extDir, "bin", "fleetpane"));
    assert.equal(deps.scriptPath, path.join(boot.extDir, "ghostty-split.applescript"));
    assert.equal(deps.themesDir, path.join(boot.extDir, "themes"));
    assert.equal(typeof deps.loadConfig, "function");
    assert.equal(typeof deps.updateConfig, "function");
    assert.equal(typeof deps.readOverride, "function");
    assert.equal(typeof deps.writeOverride, "function");
    assert.equal(typeof deps.run, "function");
    assert.equal(typeof deps.readSize, "function");
    assert.equal(typeof deps.findTty, "function");
    assert.equal(typeof deps.log, "function");
    assert.equal(typeof deps.notify, "function");
    assert.equal(typeof deps.sleep, "function");
    assert.equal(typeof deps.setTimer, "function");
    assert.equal(typeof deps.clearTimer, "function");

    // readOverride/writeOverride bound to runtime dir
    const proc = { pid: process.pid, started: "Wed Nov 25 10:00:00 2026" };
    deps.writeOverride(proc, "hidden");
    assert.equal(deps.readOverride(proc), "hidden");
    deps.writeOverride(proc, "");
    assert.equal(deps.readOverride(proc), "");

    // server callbacks wire to controller
    h.serverOpts.onConnect(3);
    h.serverOpts.onDisconnect(3);
    assert.ok(h.calls.includes("controller.connect:3"));
    assert.ok(h.calls.includes("controller.disconnect:3"));

    // notify must never throw or reject outward (async rejection and sync throw)
    await assert.doesNotReject(() => deps.notify("notice"));
    logMode = "throw";
    await assert.doesNotReject(() => deps.notify("notice-sync"));
    assert.ok(h.logs.some((r) => r.kind === "error" && /log down/.test(r.message)));
    assert.ok(h.logs.some((r) => r.kind === "error" && /sync boom/.test(r.message)));
});
