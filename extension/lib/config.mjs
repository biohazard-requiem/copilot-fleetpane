import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const MIN_SIZE = 10;
const MAX_SIZE = 80;
const MAX_FILE_BYTES = 64 * 1024;
const THEME_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 500;
const LOCK_STALE_MS = 5000;
// rename(directory, lock) fails with one of these when the lock is held (ENOTDIR: `lock` is not a
// directory, as the lock of an older version)
const LOCK_HELD = ["ENOTEMPTY", "EEXIST", "ENOTDIR"];

export const DEFAULTS = { enabled: true, layout: { position: "right", size: 33 }, theme: "gta6" };
export const POSITIONS = ["right", "left", "top", "bottom"];
export const USAGE = `Usage: /fleetpane on|off|hide|show|layout <${POSITIONS.join("|")}> [${MIN_SIZE}-${MAX_SIZE}]|theme [name]|status|help`;

export function normalizeConfig(raw) {
    const { position, size } = raw?.layout ?? {};
    return {
        enabled: typeof raw?.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
        layout: {
            position: POSITIONS.includes(position) ? position : DEFAULTS.layout.position,
            size: Number.isFinite(size)
                ? Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(size)))
                : DEFAULTS.layout.size,
        },
        theme: typeof raw?.theme === "string" && THEME_NAME.test(raw.theme) ? raw.theme : DEFAULTS.theme,
    };
}

// Looked at before it is read: a FIFO would block the event loop for good, a huge file for long.
export function loadConfig(file) {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return normalizeConfig();
        return normalizeConfig(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
        return normalizeConfig();
    }
}

// The lock is the directory `lock` with one file in it, named after its holder. It is held for as
// long as that file is there.
// - Taking it is a single rename of a prepared directory, which only succeeds when `lock` does not
//   exist or is empty.
// - Giving it up, and taking it from a holder that died, removes that holder's file and nothing
//   else. A session that acts on what it saw a moment ago therefore cannot remove the lock of a
//   session that has taken over since: that one's file has another name.
// A plain file at `lock` is a lock left by an older version; it counts as held until it is stale.
// Anything else there is not FleetPane's and is never removed: a symbolic link at `lock` (it is not
// followed either), and in the directory whatever is not a regular file named like a holder. The
// lock then counts as held.
const HOLDER_NAME = /^[1-9]\d*\.[0-9a-f]{8}$/;

const isStale = (file) => {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    return stat !== undefined && Date.now() - stat.mtimeMs > LOCK_STALE_MS;
};

function holderFiles(lock) {
    try {
        const stat = fs.lstatSync(lock);
        if (stat.isFile()) return [lock];
        if (!stat.isDirectory()) return [];
        return fs
            .readdirSync(lock, { withFileTypes: true })
            .filter((entry) => entry.isFile() && HOLDER_NAME.test(entry.name))
            .map((entry) => path.join(lock, entry.name));
    } catch (err) {
        // gone, or replaced, since it was looked at: the next attempt looks again
        if (err.code === "ENOENT" || err.code === "ENOTDIR") return [];
        throw err;
    }
}

// Removes what a session that died while holding the lock left behind. True when it removed something.
function removeStale(lock) {
    let removed = false;
    for (const file of holderFiles(lock)) {
        if (!isStale(file)) continue;
        try {
            fs.unlinkSync(file);
            removed = true;
        } catch {
            // another session was faster, or this is no longer what was looked at
        }
    }
    return removed;
}

async function acquireLock(lock, owner) {
    const mine = `${lock}.${owner}`;
    fs.mkdirSync(mine);
    try {
        const deadline = Date.now() + LOCK_TIMEOUT_MS;
        for (;;) {
            // written anew for every attempt: its age is the time since the lock was taken
            fs.writeFileSync(path.join(mine, owner), "");
            try {
                fs.renameSync(mine, lock);
                return;
            } catch (err) {
                if (!LOCK_HELD.includes(err.code)) throw err;
            }
            if (removeStale(lock)) continue;
            if (Date.now() >= deadline) throw new Error(`config is locked by another session: ${lock}`);
            await sleep(LOCK_RETRY_MS);
        }
    } catch (err) {
        fs.rmSync(mine, { recursive: true, force: true });
        throw err;
    }
}

// Only this writer's own file is removed: after a long stall the lock may be someone else's by now.
function releaseLock(lock, owner) {
    try {
        fs.rmSync(path.join(lock, owner), { force: true });
        fs.rmdirSync(lock);
    } catch {
        // the next holder has moved in already
    }
}

export async function updateConfig(file, change) {
    const lock = `${file}.lock`;
    // unique to this writer: the name of its file in the lock and part of its temp file names
    const owner = `${process.pid}.${randomBytes(4).toString("hex")}`;
    const tmp = `${file}.${owner}.tmp`;
    await acquireLock(lock, owner);
    try {
        // Re-read under the lock: fields that are not in `change` keep what the file has now.
        const next = loadConfig(file);
        if (change.enabled !== undefined) next.enabled = change.enabled;
        if (change.layout?.position !== undefined) next.layout.position = change.layout.position;
        if (change.layout?.size !== undefined) next.layout.size = change.layout.size;
        if (change.theme !== undefined) next.theme = change.theme;
        const saved = normalizeConfig(next);
        fs.writeFileSync(tmp, `${JSON.stringify(saved, null, 2)}\n`);
        // After a long stall the lock may be someone else's by now, and what was read above is out of date.
        if (!fs.existsSync(path.join(lock, owner))) {
            throw new Error(`config lock was taken over by another session: ${lock}`);
        }
        fs.renameSync(tmp, file);
        return saved;
    } finally {
        fs.rmSync(tmp, { force: true });
        releaseLock(lock, owner);
    }
}

export function listThemes(dir) {
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
            .map((entry) => entry.name.slice(0, -".json".length))
            .filter((name) => THEME_NAME.test(name))
            .sort();
    } catch {
        return [];
    }
}

const SIMPLE_ACTIONS = ["status", "on", "off", "hide", "show", "help"];
const quote = JSON.stringify;
const fail = (message) => ({ action: "error", message });

export function parseCommand(args) {
    const [verb = "status", ...rest] = String(args ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const unexpected = (count) => fail(`unexpected argument ${quote(rest[count])}`);

    if (SIMPLE_ACTIONS.includes(verb)) return rest.length > 0 ? unexpected(0) : { action: verb };

    if (verb === "layout") {
        const [position, size] = rest;
        if (rest.length === 0) return { action: "showLayout" };
        if (rest.length > 2) return unexpected(2);
        if (!POSITIONS.includes(position)) {
            return fail(`invalid position ${quote(position)} (expected ${POSITIONS.join(", ")})`);
        }
        if (size === undefined) return { action: "layout", position };
        const percent = /^\d+(\.\d+)?%?$/.test(size) ? Math.round(parseFloat(size)) : NaN;
        if (!(percent >= MIN_SIZE && percent <= MAX_SIZE)) {
            return fail(`invalid size ${quote(size)} (expected a number from ${MIN_SIZE} to ${MAX_SIZE})`);
        }
        return { action: "layout", position, size: percent };
    }

    if (verb === "theme") {
        const [theme] = rest;
        if (rest.length === 0) return { action: "showTheme" };
        if (rest.length > 1) return unexpected(1);
        if (!THEME_NAME.test(theme)) {
            return fail(
                `invalid theme name ${quote(theme)} (expected 1-32 characters from a-z, 0-9, "-" and "_", starting with a letter or digit)`,
            );
        }
        return { action: "theme", theme };
    }

    return fail(`unknown command ${quote(verb)} (expected on, off, hide, show, layout, theme, status or help)`);
}

export function describe(config) {
    const { enabled, layout, theme } = config;
    return `FleetPane: ${enabled ? "on" : "off"} · layout ${layout.position} ${layout.size}% · theme ${theme}`;
}
