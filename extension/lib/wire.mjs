import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { loadConfig, parseCommand, updateConfig } from "./config.mjs";
import { createDebug } from "./debug.mjs";
import { createPaneController, findTty, readSize, runFile } from "./pane.mjs";
import {
    createServer,
    prepareDir,
    readOverride,
    runtimeDir,
    sweepStale,
    writeOverride,
} from "./server.mjs";
import { createState, encodeSnapshot } from "./state.mjs";

const ORPHAN_CHECK_MS = 2000;
// the CLI allows an extension 1s to exit
const SHUTDOWN_WAIT_MS = 500;
const extDir = dirname(dirname(fileURLToPath(import.meta.url)));

// A `copilot -p` run loads user extensions too and reports the same capabilities as an interactive
// session (E3-10), so it is recognised by its command line. Words after -i are prompt text.
export function isInteractive(args) {
    for (const word of String(args ?? "").trim().split(/\s+/).slice(1)) {
        if (word === "-i" || word === "--interactive" || word.startsWith("--interactive=")) return true;
        if (word === "-p" || word === "--prompt" || word.startsWith("--prompt=")) return false;
    }
    return true;
}

export async function start({ joinSession, make = {} }) {
    const state = (make.createState ?? createState)();
    const exit = make.exit ?? process.exit;
    const processOn = make.processOn ?? process.on.bind(process);
    const stdin = make.stdin ?? process.stdin;
    const startInterval = make.setInterval ?? setInterval;
    const stopInterval = make.clearInterval ?? clearInterval;
    const startTimer = make.setTimeout ?? setTimeout;
    const stopTimer = make.clearTimeout ?? clearTimeout;
    const getPpid = make.getPpid ?? (() => process.ppid);
    const copilotArgs =
        make.copilotArgs ??
        (() => runFile("ps", ["-o", "args=", "-p", String(process.ppid)], { timeoutMs: 2000 }).then((out) => out.stdout));

    let session = null;
    let server = null;
    let controller = null;
    let initError = "";
    let pendingPrompt = false;
    let closed = false;
    let orphanTimer = null;
    let seq = 0;
    let debug = () => {};

    const say = async (text, level = "info") => {
        await session?.log(text, { level, ephemeral: true });
    };

    const notify = (text, level = "warning") =>
        Promise.resolve()
            .then(() => session?.log(text, { level, ephemeral: true }))
            .catch((err) => debug("error", { where: "notify", message: String(err?.message ?? err) }));

    // Exists before joinSession is called: the session can end before the join has returned.
    const shutdown = () => {
        if (closed) return;
        closed = true;
        if (orphanTimer !== null) {
            stopInterval(orphanTimer);
            orphanTimer = null;
        }
        if (!controller) {
            exit(0);
            return;
        }
        try {
            controller.shutdown();
        } catch (err) {
            debug("error", { where: "shutdown", message: String(err?.message ?? err) });
        }
        // Closing the socket is asynchronous, and a rotate may still be in flight. Exit once the
        // listener and its file are gone, or after SHUTDOWN_WAIT_MS, whichever comes first.
        let left = false;
        const leave = () => {
            if (left) return;
            left = true;
            stopTimer(bound);
            exit(0);
        };
        const bound = startTimer(leave, SHUTDOWN_WAIT_MS);
        const closing = async () => server.close();
        closing()
            .catch((err) => debug("error", { where: "shutdown", message: String(err?.message ?? err) }))
            .then(leave);
    };

    const onEvent = (event) => {
        if (event?.type === "session.shutdown") {
            try {
                shutdown();
            } catch (err) {
                debug("error", { where: "shutdown", message: String(err) });
            }
            return;
        }
        let turn = 0;
        try {
            turn = state.turn();
            if (state.apply(event)) server?.schedule();
        } catch (err) {
            debug("error", { where: "event", message: String(err) });
        }
        try {
            if (state.turn() === turn) return;
            if (controller) controller.onTurnStart();
            else if (!initError) pendingPrompt = true;
        } catch (err) {
            debug("error", { where: "turn", message: String(err) });
        }
    };

    session = await joinSession({
        onEvent,
        commands: [
            {
                name: "fleetpane",
                description: "Show or change the FleetPane activity pane (on, off, hide, show, layout, theme)",
                handler: async (ctx) => {
                    let out;
                    try {
                        if (initError) out = { text: `FleetPane unavailable: ${initError}`, level: "warning" };
                        else if (!controller) return;
                        else out = await controller.onCommand(parseCommand(ctx?.args));
                    } catch (err) {
                        debug("error", { where: "command", message: String(err?.message ?? err) });
                        out = { text: `FleetPane: command failed: ${err?.message ?? err}`, level: "warning" };
                    }
                    // an answer that cannot be delivered does not make the command a failed one
                    await say(out.text, out.level).catch((err) => {
                        debug("error", { where: "say", message: String(err?.message ?? err) });
                    });
                },
            },
        ],
    });
    // The session ended while it was being joined: nothing is started, not even a pending turn.
    if (closed) return { shutdown };

    try {
        const dir = (make.runtimeDir ?? runtimeDir)();
        (make.prepareDir ?? prepareDir)(dir);
        (make.sweepStale ?? sweepStale)(dir);
        debug = (make.createDebug ?? createDebug)({ dir, sessionId: session.sessionId });
        debug("boot", {
            pid: process.pid,
            ppid: process.ppid,
            node: process.version,
            extDir,
            tty: process.env.TTY ?? "",
            runtimeDir: dir,
        });
        const getLine = () => {
            try {
                const line = encodeSnapshot({
                    v: 1,
                    seq: ++seq,
                    session: session.sessionId,
                    theme: controller.theme(),
                    ...state.snapshot(),
                });
                debug("snapshot", { line });
                return line;
            } catch (err) {
                // the server skips a line it cannot get; this record is all that is left of the reason
                debug("error", { where: "getLine", message: String(err?.message ?? err) });
                throw err;
            }
        };
        server = (make.createServer ?? createServer)({
            dir,
            sessionId: session.sessionId,
            getLine,
            onConnect: (attempt) => controller.onClientConnected(attempt),
            onDisconnect: (attempt) => controller.onClientDisconnected(attempt),
        });
        const configFile = join(extDir, "config.json");
        controller = (make.createPaneController ?? createPaneController)({
            loadConfig: () => loadConfig(configFile),
            updateConfig: (change) => updateConfig(configFile, change),
            readOverride: (proc) => readOverride(dir, proc),
            writeOverride: (proc, value) => writeOverride(dir, proc, value),
            server,
            run: runFile,
            readSize: (tty) => readSize(tty),
            findTty: () => findTty(),
            binPath: join(extDir, "bin", "fleetpane"),
            scriptPath: join(extDir, "ghostty-split.applescript"),
            themesDir: join(extDir, "themes"),
            log: debug,
            notify,
            sleep,
            setTimer: setTimeout,
            clearTimer: clearTimeout,
            env: process.env,
            platform: process.platform,
            interactive: () => copilotArgs().then(isInteractive, () => true),
        });
    } catch (err) {
        initError = String(err?.message ?? err);
        server = null;
        controller = null;
    }

    if (pendingPrompt && controller) {
        try {
            controller.onTurnStart();
        } catch (err) {
            debug("error", { where: "turn", message: String(err) });
        }
    }

    processOn("SIGTERM", shutdown);
    processOn("SIGINT", shutdown);
    processOn("uncaughtException", (err) => {
        debug("error", { where: "uncaughtException", message: String(err?.message ?? err) });
    });
    processOn("unhandledRejection", (reason) => {
        debug("error", { where: "unhandledRejection", message: String(reason?.message ?? reason) });
    });

    stdin.on("end", shutdown);
    stdin.on("close", shutdown);
    orphanTimer = startInterval(() => {
        if (getPpid() === 1) shutdown();
    }, ORPHAN_CHECK_MS);
    orphanTimer?.unref?.();

    return { shutdown };
}
