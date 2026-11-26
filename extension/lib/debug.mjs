import fs from "node:fs";
import path from "node:path";
import { safeSessionId } from "./server.mjs";

const MAX_BYTES = 20 * 1024 * 1024;

export function createDebug({ dir, sessionId, pid = process.pid, env = process.env, maxBytes = MAX_BYTES }) {
    const level = env.FLEETPANE_DEBUG;
    if (level !== "1" && level !== "2") return () => {};

    // Opened once and written through the descriptor: whatever is put at the path later, records
    // keep going to this file. A symlink at the path is not followed (the open fails instead).
    const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants;
    let fd;
    let size;
    try {
        const file = path.join(dir, `${safeSessionId(sessionId)}.${pid}.log`);
        fd = fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600);
        size = fs.fstatSync(fd).size;
    } catch {
        return () => {};
    }
    let stopped = false;

    const append = (kind, payload) => {
        const line = `${JSON.stringify({ t: new Date().toISOString(), kind, ...payload })}\n`;
        size += fs.writeSync(fd, line);
    };

    return (kind, payload = {}) => {
        if (stopped || (kind === "snapshot" && level !== "2")) return;
        try {
            append(kind, payload);
            if (size < maxBytes) return;
            stopped = true;
            append("error", { where: "debug", message: `log reached ${maxBytes} bytes, logging stopped` });
        } catch {
            // logging must never disturb the extension
        }
    };
}
