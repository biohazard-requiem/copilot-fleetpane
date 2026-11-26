import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createServer, prepareDir, runtimeDir } from "../extension/lib/server.mjs";
import { createState, encodeSnapshot } from "../extension/lib/state.mjs";

const USAGE =
    "usage: node hack/replay.mjs <events.jsonl> [--step-ms <n>] [--pause-at <n>[,<n>...]]... [--theme <name>]";

function failUsage(message) {
    if (message) process.stderr.write(`error: ${message}\n`);
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
}

function parsePauseList(raw, target) {
    if (!raw) failUsage("--pause-at requires a value");
    for (const part of raw.split(",")) {
        if (!/^[1-9]\d*$/.test(part)) failUsage(`invalid --pause-at index: ${part}`);
        target.add(Number(part));
    }
}

function parseArgs(argv) {
    let file = "";
    let stepMs = 150;
    let theme = "gta6";
    const pauses = new Set();

    const nextValue = (flag, i) => {
        if (i + 1 >= argv.length) failUsage(`${flag} requires a value`);
        return argv[i + 1];
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--step-ms" || arg.startsWith("--step-ms=")) {
            const raw = arg === "--step-ms" ? nextValue("--step-ms", i++) : arg.slice("--step-ms=".length);
            if (!/^\d+$/.test(raw)) failUsage(`invalid --step-ms value: ${raw}`);
            stepMs = Number(raw);
        } else if (arg === "--pause-at" || arg.startsWith("--pause-at=")) {
            const raw = arg === "--pause-at" ? nextValue("--pause-at", i++) : arg.slice("--pause-at=".length);
            parsePauseList(raw, pauses);
        } else if (arg === "--theme" || arg.startsWith("--theme=")) {
            const raw = arg === "--theme" ? nextValue("--theme", i++) : arg.slice("--theme=".length);
            if (!raw) failUsage("--theme requires a non-empty value");
            theme = raw;
        } else if (arg.startsWith("-")) {
            failUsage(`unknown option: ${arg}`);
        } else if (file) {
            failUsage(`unexpected argument: ${arg}`);
        } else {
            file = arg;
        }
    }

    if (!file) failUsage();
    return { file, stepMs, theme, pauses };
}

function loadEvents(file) {
    let text;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch (err) {
        process.stderr.write(`error: cannot read ${file}: ${err.message}\n`);
        process.exit(1);
    }
    const events = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
            events.push(JSON.parse(line));
        } catch (err) {
            process.stderr.write(`error: ${file}:${i + 1}: invalid JSON: ${err.message}\n`);
            process.exit(1);
        }
    }
    return events;
}

const { file, stepMs, theme, pauses } = parseArgs(process.argv.slice(2));
const events = loadEvents(file);
const state = createState();
const dir = runtimeDir();
prepareDir(dir);

const controller = new AbortController();
const { signal } = controller;

let resolveFirstClient;
const firstClient = new Promise((resolve) => {
    resolveFirstClient = resolve;
});

let resumePause = null;
// Keep SIGUSR1 handled for the whole process lifetime so an early/late signal never starts the inspector.
process.on("SIGUSR1", () => resumePause?.());

let seq = 0;
const server = createServer({
    dir,
    sessionId: "replay",
    getLine: () => encodeSnapshot({ v: 1, seq: ++seq, session: "replay", theme, ...state.snapshot() }),
    onConnect: () => resolveFirstClient(),
    onDisconnect: () => {},
});

let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    controller.abort();
    resolveFirstClient();
    resumePause?.();
    await server.close();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function waitForResume(eventNum) {
    process.stderr.write(`paused after event ${eventNum}; press Enter or send SIGUSR1 to continue\n`);
    return new Promise((resolve) => {
        const finish = () => {
            if (resumePause !== finish) return;
            resumePause = null;
            signal.removeEventListener("abort", finish);
            if (onData) {
                process.stdin.off("data", onData);
                process.stdin.pause();
            }
            resolve();
        };
        let onData = null;
        resumePause = finish;
        signal.addEventListener("abort", finish, { once: true });
        if (process.stdin.isTTY && !process.stdin.destroyed) {
            onData = (chunk) => {
                if (/[\r\n]/.test(String(chunk))) finish();
            };
            process.stdin.on("error", () => {});
            process.stdin.resume();
            process.stdin.on("data", onData);
        }
    });
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fleetpaneBin = path.join(repoRoot, "bin", "fleetpane");
const sockPath = await server.rotate(1);
process.stdout.write(`socket: ${sockPath}\n`);
process.stdout.write(`${fleetpaneBin} --socket ${sockPath}\n`);

await firstClient;

for (let i = 0; i < events.length && !signal.aborted; i++) {
    if (i > 0 && stepMs > 0) {
        try {
            await sleep(stepMs, undefined, { signal });
        } catch {
            break;
        }
    }
    if (signal.aborted) break;
    if (state.apply(events[i])) server.schedule();
    const eventNum = i + 1;
    if (pauses.has(eventNum)) await waitForResume(eventNum);
}

if (!signal.aborted) {
    process.stderr.write("replay finished; still serving, press ctrl+c to exit\n");
}
