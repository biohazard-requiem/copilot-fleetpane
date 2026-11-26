import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const MAX_PATH_BYTES = 100;
const MAX_BUFFERED_BYTES = 256 * 1024;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
// The names FleetPane writes into the runtime directory and nothing else: <sessionId>.<pid>.<attempt>.sock,
// <sessionId>.<pid>.log, override.<pid>.json and the temp file of writeOverride. The group is the pid.
const SWEPT = [
    /^[A-Za-z0-9_-]{1,64}\.([1-9]\d*)\.(?:\d+\.sock|log)$/,
    /^override\.([1-9]\d*)\.(?:[1-9]\d*\.tmp\.)?json$/,
];

export function runtimeDir({ uid = process.getuid(), env = process.env } = {}) {
    const dir = env.FLEETPANE_RUNTIME_DIR;
    return dir && path.isAbsolute(dir) ? dir : `/tmp/fleetpane-${uid}`;
}

const hashId = (sessionId) => createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 16);

// File-name-safe form of a session id. It never contains a dot, so the pid stays the
// second dot-segment of every file name built from it (the patterns of sweepStale rely on that).
export function safeSessionId(sessionId) {
    return SESSION_ID.test(sessionId) ? sessionId : hashId(sessionId);
}

export function socketPath(dir, sessionId, pid, attempt) {
    const build = (id) => path.join(dir, `${id}.${pid}.${attempt}.sock`);
    let file = build(safeSessionId(sessionId));
    if (Buffer.byteLength(file) > MAX_PATH_BYTES) file = build(hashId(sessionId));
    if (Buffer.byteLength(file) > MAX_PATH_BYTES) {
        throw new Error(`runtime directory ${dir} is too long for a socket path`);
    }
    return file;
}

export function prepareDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) throw new Error(`runtime directory ${dir} is not a real directory`);
    if (stat.uid !== process.getuid()) throw new Error(`runtime directory ${dir} is owned by another user`);
    if (stat.mode & 0o077) throw new Error(`runtime directory ${dir} is accessible to other users`);
}

// The checks of prepareDir, creating nothing. Removing a file by its path is safe only where this holds.
function isTrustedDir(dir) {
    try {
        const stat = fs.lstatSync(dir);
        return stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
    } catch {
        return false;
    }
}

export function sweepStale(dir) {
    let removed = 0;
    for (const name of fs.readdirSync(dir)) {
        const pid = SWEPT.map((shape) => shape.exec(name)?.[1]).find(Boolean);
        if (!pid) continue;
        try {
            process.kill(Number(pid), 0);
        } catch (err) {
            if (err.code !== "ESRCH") continue;
            fs.rmSync(path.join(dir, name), { force: true });
            removed++;
        }
    }
    return removed;
}

const overridePath = (dir, pid) => path.join(dir, `override.${pid}.json`);
const isKnown = (started) => typeof started === "string" && started !== "";

export function readOverride(dir, proc) {
    if (!isTrustedDir(dir)) return "";
    try {
        const file = overridePath(dir, proc.pid);
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        // Without a start time on both sides nobody can tell whose marker this is: it is neither
        // trusted nor deleted.
        if (!isKnown(data.started) || !isKnown(proc.started)) return "";
        if (data.started !== proc.started) {
            // the pid was reused: the marker belongs to an earlier Copilot process
            fs.rmSync(file, { force: true });
            return "";
        }
        return data.override === "hidden" || data.override === "shown" ? data.override : "";
    } catch {
        return "";
    }
}

export function writeOverride(dir, proc, value) {
    const file = overridePath(dir, proc.pid);
    if (value === "") {
        if (isTrustedDir(dir)) fs.rmSync(file, { force: true });
        return;
    }
    prepareDir(dir);
    // named so that sweepStale also collects a temp file left behind by a crash
    const temp = path.join(dir, `override.${proc.pid}.${process.pid}.tmp.json`);
    fs.writeFileSync(temp, JSON.stringify({ override: value, started: proc.started }), { mode: 0o600 });
    fs.renameSync(temp, file);
}

export function createServer({ dir, sessionId, pid = process.pid, getLine, onConnect, onDisconnect, intervalMs = 50 }) {
    let listener = null; // { server, file }
    let client = null; // { socket, attempt }
    let timer = null;

    // null when getLine throws: that line is not sent
    const nextLine = () => {
        try {
            return `${getLine()}\n`;
        } catch {
            return null;
        }
    };

    const schedule = () => {
        if (!client || timer) return;
        timer = setTimeout(() => {
            timer = null;
            if (client.socket.writableLength > MAX_BUFFERED_BYTES) {
                schedule();
                return;
            }
            const line = nextLine();
            if (line !== null) client.socket.write(line);
        }, intervalMs);
    };

    // A pending timer implies a client: dropping the client clears the timer.
    const drop = () => {
        if (!client) return;
        const { socket, attempt } = client;
        client = null;
        clearTimeout(timer);
        timer = null;
        socket.destroy();
        onDisconnect(attempt);
    };

    const accept = (socket, attempt) => {
        if (client) {
            socket.destroy();
            return;
        }
        const first = nextLine();
        if (first === null) {
            // never announced with onConnect, so there is no onDisconnect for it either
            socket.destroy();
            return;
        }
        client = { socket, attempt };
        const gone = () => {
            if (client?.socket === socket) drop();
        };
        socket.on("error", gone);
        socket.on("close", gone);
        // the protocol is one-way; discard input so that the peer's FIN is noticed
        socket.resume();
        socket.write(first);
        onConnect(attempt);
    };

    // Closes the client and the listener and returns the listener's path, if there was one. Nothing
    // is removed by path here. (Node itself unlinks the path a Unix listener was bound to when the
    // listener closes; that is not ours to prevent.)
    const closeHandles = () => {
        drop();
        const closed = listener;
        listener = null;
        closed?.server.close();
        return closed?.file;
    };

    const teardown = () => {
        const file = closeHandles();
        if (file && isTrustedDir(dir)) fs.rmSync(file, { force: true });
    };

    // rotate and close run one at a time, in call order. When nothing is in flight the
    // operation starts synchronously, so an idle close() is complete when it returns.
    let busy = false;
    const waiting = [];
    const serial = async (operation) => {
        if (busy) await new Promise((resolve) => waiting.push(resolve));
        busy = true;
        try {
            return await operation();
        } finally {
            const next = waiting.shift();
            if (next) next();
            else busy = false;
        }
    };

    const rotate = (attempt) =>
        serial(async () => {
            try {
                prepareDir(dir);
            } catch (err) {
                // the directory is not ours any more: the old socket's path may lead anywhere
                closeHandles();
                throw err;
            }
            teardown();
            const file = socketPath(dir, sessionId, pid, attempt);
            const server = net.createServer((socket) => accept(socket, attempt));
            await new Promise((resolve, reject) => {
                // stays registered: a later accept error must not become an uncaught exception
                server.on("error", reject);
                server.listen(file, resolve);
            });
            listener = { server, file };
            fs.chmodSync(file, 0o600);
            return file;
        });

    return {
        rotate,
        schedule,
        hasClient: () => client !== null,
        close: () => serial(teardown),
    };
}
