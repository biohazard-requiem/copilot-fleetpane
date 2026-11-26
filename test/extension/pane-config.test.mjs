import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { USAGE } from "../../extension/lib/config.mjs";
import { planResize } from "../../extension/lib/pane.mjs";
import {
    answerSplit,
    collapse,
    command,
    connect,
    countsOf,
    deferred,
    disconnect,
    flush,
    FULL,
    HOLD,
    measuredBefore,
    SCRIPT,
    setup,
    toAwaiting,
    toOpen,
    TTY,
    turn,
} from "./pane-fakes.mjs";

const scratch = mkdtempSync(join(process.env.FLEETPANE_TEST_TMPDIR || "/tmp", "fp-panecfg-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const notExecutable = join(scratch, "fleetpane-noexec");
writeFileSync(notExecutable, "#!/bin/sh\n", { mode: 0o644 });

const themesDir = join(scratch, "themes");
mkdirSync(themesDir);
writeFileSync(join(themesDir, "solarized.json"), "{}");
writeFileSync(join(themesDir, "nord_dark.json"), "{}");
writeFileSync(join(themesDir, "gta6.json"), "{}");        // built-in duplicate: should appear once
writeFileSync(join(themesDir, "Bad Name.json"), "{}");    // invalid theme name: ignored
writeFileSync(join(themesDir, "notes.txt"), "hi");        // not .json: ignored
mkdirSync(join(themesDir, "subdir.json"));                // directory, not a file: ignored

describe("planResize", () => {
    it("target already reached (exact or within 1 cell): done", () => {
        // before 170, size 33 -> target = round(170 * 67 / 100) = 114
        assert.deepEqual(planResize({ before: 170, size: 33, current: 114 }), { done: true });
        assert.deepEqual(planResize({ before: 170, size: 33, current: 113 }), { done: true });
        assert.deepEqual(planResize({ before: 170, size: 33, current: 115 }), { done: true });
        assert.deepEqual(
            planResize({ before: 170, size: 33, current: 114, probe: { px: 80, delta: 8, dirSign: 1 } }),
            { done: true },
        );
        assert.deepEqual(
            planResize({ before: 170, size: 33, current: 113, probe: { px: 80, delta: 8, dirSign: 1 } }),
            { done: true },
        );
    });

    it("initial probe: positive and negative need pick opposite direction signs and 80px", () => {
        // before 168, size 33 -> target 113, current 83 -> need +30
        assert.deepEqual(planResize({ before: 168, size: 33, current: 83 }), { dirSign: 1, px: 80 });
        // before 168, size 60 -> target 67, current 83 -> need -16
        assert.deepEqual(planResize({ before: 168, size: 60, current: 83 }), { dirSign: -1, px: 80 });
    });

    it("correction: delta same sign as remaining keeps direction, opposite sign flips direction, px is proportional", () => {
        // target 113, current 91 -> remaining +22; probe delta +8 -> same sign -> keep dirSign +1, px = round(22 * 80 / 8) = 220
        assert.deepEqual(
            planResize({ before: 168, size: 33, current: 91, probe: { px: 80, delta: 8, dirSign: 1 } }),
            { dirSign: 1, px: 220 },
        );
        // target 113, current 75 -> remaining +38; probe delta -8 -> opposite sign -> flip to -1, px = round(38 * 80 / 8) = 380
        assert.deepEqual(
            planResize({ before: 168, size: 33, current: 75, probe: { px: 80, delta: -8, dirSign: 1 } }),
            { dirSign: -1, px: 380 },
        );
        // probe overshot target: target 55, current 60 -> remaining -5; probe delta +10 (dirSign +1) -> flip to -1, px = 40
        assert.deepEqual(
            planResize({ before: 100, size: 45, current: 60, probe: { px: 80, delta: 10, dirSign: 1 } }),
            { dirSign: -1, px: 40 },
        );
        // degenerate probe delta 0: done
        assert.deepEqual(
            planResize({ before: 168, size: 33, current: 83, probe: { px: 80, delta: 0, dirSign: 1 } }),
            { done: true },
        );
    });
});

describe("controller: commands and outputs (7.3)", () => {
    it("off while the pane is open: updateConfig({ enabled: false }), server.close(), closing -> idle after collapse", async () => {
        const h = setup();
        await toOpen(h);
        const closes = h.closes;
        const out = await command(h, "off");
        assert.deepEqual(out, { text: "FleetPane: off", level: "info" });
        assert.deepEqual(h.updates, [{ enabled: false }]);
        assert.ok(h.closes > closes);
        assert.equal(h.state(), "closing");
        await collapse(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 1);
    });

    it("off during closing caused by layout: idle after collapse, no reopen", async () => {
        const h = setup();
        await toOpen(h);
        await command(h, "layout", { position: "top", size: 25 });
        assert.equal(h.state(), "closing");
        await command(h, "off");
        assert.equal(h.state(), "closing");
        await collapse(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 1);
    });

    it("exact outputs for on, off, status (open, closed, disabled, with override), layout, showLayout, theme, showTheme, help, error", async () => {
        const h = setup({ deps: { themesDir } });

        const statusClosed = await command(h, "status");
        assert.equal(statusClosed.level, "info");
        assert.equal(
            statusClosed.text,
            `FleetPane: on · layout right 33% · theme gta6 · pane closed\n${USAGE}`,
        );

        await toOpen(h);
        const statusOpen = await command(h, "status");
        assert.equal(statusOpen.level, "info");
        assert.equal(
            statusOpen.text,
            `FleetPane: on · layout right 33% · theme gta6 · pane open\n${USAGE}`,
        );

        const onOut = await command(h, "on");
        assert.deepEqual(onOut, { text: "FleetPane: on · layout right 33% · theme gta6", level: "info" });

        const showLayoutOut = await command(h, "showLayout");
        assert.deepEqual(showLayoutOut, { text: `FleetPane: layout right 33%\n${USAGE}`, level: "info" });

        const showThemeOut = await command(h, "showTheme");
        assert.deepEqual(showThemeOut, {
            text: "FleetPane: theme gta6 (available: auto, gta6, nord_dark, solarized)",
            level: "info",
        });

        const themeOut = await command(h, "theme", { theme: "auto" });
        assert.deepEqual(themeOut, { text: "FleetPane: theme auto", level: "info" });

        const helpOut = await command(h, "help");
        assert.deepEqual(helpOut, { text: USAGE, level: "info" });

        const errOut = await command(h, "error", { message: 'unknown command "wat"' });
        assert.deepEqual(errOut, { text: `FleetPane: unknown command "wat"\n${USAGE}`, level: "warning" });

        const offOut = await command(h, "off");
        assert.deepEqual(offOut, { text: "FleetPane: off", level: "info" });
        await collapse(h);

        const disabled = setup({ deps: { platform: "linux" } });
        await turn(disabled);
        const statusDisabled = await command(disabled, "status");
        assert.equal(statusDisabled.level, "info");
        assert.equal(
            statusDisabled.text,
            `FleetPane: on · layout right 33% · theme gta6 · disabled (unsupported-platform)\n${USAGE}`,
        );
    });
});

describe("controller: every command aligns the pane with the config it reads (7.2)", () => {
    for (const [name, parsed] of [
        ["status", { action: "status" }],
        ["layout without arguments", { action: "showLayout" }],
        ["theme without arguments", { action: "showTheme" }],
        ["help", { action: "help" }],
        ["a command that does not parse", { action: "error", message: 'unknown command "wat"' }],
        ["layout top 25", { action: "layout", position: "top", size: 25 }],
        ["theme auto", { action: "theme", theme: "auto" }],
    ]) {
        it(`${name} after another session switched off: the pane is closed and does not come back`, async () => {
            const h = setup();
            await toOpen(h);
            h.config.enabled = false;
            await h.pane.onCommand(parsed);
            await flush();
            assert.equal(h.state(), "closing");
            assert.deepEqual(h.closedPanes(), ["P1"]);
            await collapse(h);
            assert.equal(h.state(), "idle");
            await h.clock.advance(10000);
            assert.equal(h.splits().length, 1);
        });
    }

    it("status after another session switched off reports off and the pane as closed", async () => {
        const h = setup();
        await toOpen(h);
        h.config.enabled = false;
        const out = await command(h, "status");
        assert.deepEqual(out, {
            text: `FleetPane: off · layout right 33% · theme gta6 · pane closed\n${USAGE}`,
            level: "info",
        });
    });

    it("status during the closing of a layout change, the switch off elsewhere and on again before the pane has collapsed: no reopen", async () => {
        const h = setup();
        await toOpen(h);
        await command(h, "layout", { position: "top", size: 25 });
        h.config.enabled = false;
        await command(h, "status");
        h.config.enabled = true;
        await collapse(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 1);
    });

    it("shown in this session: a query leaves the pane alone although the config says off", async () => {
        const h = setup({ config: { enabled: false } });
        await command(h, "show");
        await answerSplit(h, "P1");
        await connect(h);
        const counts = countsOf(h);
        const out = await command(h, "status");
        assert.match(out.text, /^FleetPane: off .* pane open · this session: shown\n/);
        assert.equal(h.state(), "open");
        assert.deepEqual(countsOf(h), counts);
    });
});

describe("controller: hide / show session override", () => {
    it("hide while open: no updateConfig, writeOverride(hidden), closing -> idle, returns hidden message", async () => {
        const h = setup();
        await toOpen(h);
        const out = await command(h, "hide");
        assert.deepEqual(out, { text: "FleetPane: hidden in this session", level: "info" });
        assert.deepEqual(h.updates, []);
        assert.deepEqual(h.overrides, [{ proc: { pid: 4242, started: "Wed Nov 25 10:06:44 2026" }, value: "hidden" }]);
        assert.equal(h.pane.status().override, "hidden");
        assert.equal(h.state(), "closing");
        await collapse(h);
        assert.equal(h.state(), "idle");
    });

    it("new turn after hide: does not open", async () => {
        const h = setup();
        await command(h, "hide");
        await turn(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.rotates.length, 0);
        assert.equal(h.splits().length, 0);
    });

    it("hide then show: writeOverride(shown), opens, returns shown message", async () => {
        const h = setup();
        await command(h, "hide");
        const out = await command(h, "show");
        assert.deepEqual(out, { text: "FleetPane: shown in this session", level: "info" });
        assert.deepEqual(h.updates, []);
        assert.equal(h.overrides.at(-1).value, "shown");
        assert.equal(h.pane.status().override, "shown");
        assert.equal(h.state(), "opening");
        assert.equal(h.splits().length, 1);
    });

    it("config enabled: false, then show: opens without updateConfig; closing pane and starting a new turn opens again", async () => {
        const h = setup({ config: { enabled: false } });
        const out = await command(h, "show");
        assert.deepEqual(out, { text: "FleetPane: shown in this session", level: "info" });
        assert.deepEqual(h.updates, []);
        assert.equal(h.state(), "opening");
        assert.equal(h.splits().length, 1);

        await answerSplit(h, "P1");
        await connect(h);
        await disconnect(h);
        await collapse(h);
        assert.equal(h.state(), "idle");

        await turn(h);
        assert.equal(h.state(), "opening");
        assert.equal(h.splits().length, 2);
    });

    it("session is shown, another session sets enabled: false, new turn starts: pane stays open", async () => {
        const h = setup({ config: { enabled: false } });
        await command(h, "show");
        await answerSplit(h, "P1");
        await connect(h);
        const counts = countsOf(h);

        h.config.enabled = false;
        await turn(h);
        assert.equal(h.state(), "open");
        assert.deepEqual(countsOf(h), counts);
    });

    it("hide then on; show then off: writeOverride receives empty string AFTER updateConfig succeeds", async () => {
        // hide -> on
        const onOrder = [];
        const onWrite = deferred();
        const h1 = setup({
            deps: {
                updateConfig: async (change) => {
                    onOrder.push(["updateConfig:start", change]);
                    await onWrite.promise;
                    onOrder.push(["updateConfig:done", change]);
                    h1.config = { ...h1.config, ...change };
                    return structuredClone(h1.config);
                },
                writeOverride: (proc, value) => {
                    onOrder.push(["writeOverride", value]);
                    h1.overrides.push({ proc, value });
                    h1.override = value;
                },
            },
        });
        await command(h1, "hide");
        onOrder.length = 0;
        const onP = h1.pane.onCommand({ action: "on" });
        await flush();
        assert.deepEqual(onOrder, [["updateConfig:start", { enabled: true }]]);
        assert.equal(h1.pane.status().override, "hidden");
        onWrite.resolve();
        const onOut = await onP;
        await flush();
        assert.equal(onOut.level, "info");
        assert.deepEqual(onOrder, [
            ["updateConfig:start", { enabled: true }],
            ["updateConfig:done", { enabled: true }],
            ["writeOverride", ""],
        ]);
        assert.equal(h1.pane.status().override, "none");
        assert.equal(h1.state(), "opening");
        assert.equal(h1.splits().length, 1);

        // show -> off
        const offOrder = [];
        const offWrite = deferred();
        const h2 = setup({
            config: { enabled: false },
            deps: {
                updateConfig: async (change) => {
                    offOrder.push(["updateConfig:start", change]);
                    await offWrite.promise;
                    offOrder.push(["updateConfig:done", change]);
                    h2.config = { ...h2.config, ...change };
                    return structuredClone(h2.config);
                },
                writeOverride: (proc, value) => {
                    offOrder.push(["writeOverride", value]);
                    h2.overrides.push({ proc, value });
                    h2.override = value;
                },
            },
        });
        await command(h2, "show");
        await answerSplit(h2, "P1");
        await connect(h2);
        offOrder.length = 0;
        const offP = h2.pane.onCommand({ action: "off" });
        await flush();
        assert.deepEqual(offOrder, [["updateConfig:start", { enabled: false }]]);
        assert.equal(h2.pane.status().override, "shown");
        offWrite.resolve();
        const offOut = await offP;
        await flush();
        assert.equal(offOut.level, "info");
        assert.deepEqual(offOrder, [
            ["updateConfig:start", { enabled: false }],
            ["updateConfig:done", { enabled: false }],
            ["writeOverride", ""],
        ]);
        assert.equal(h2.pane.status().override, "none");
        assert.equal(h2.state(), "closing");
        await collapse(h2);
        assert.equal(h2.state(), "idle");
    });

    it("session is hidden, off called, updateConfig rejects: warning, writeOverride not called, next turn still does not open", async () => {
        const h = setup({
            deps: {
                updateConfig: async () => {
                    throw new Error("config is locked");
                },
            },
        });
        await command(h, "hide");
        h.overrides.length = 0;
        const out = await command(h, "off");
        assert.equal(out.level, "warning");
        assert.match(out.text, /locked/);
        assert.deepEqual(h.overrides, []);
        assert.equal(h.pane.status().override, "hidden");
        await turn(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 0);
    });

    describe("the marker file cannot be written", () => {
        const refuse = (h) => {
            h.deps.writeOverride = (proc, value) => {
                h.overrides.push({ proc, value });
                throw new Error("EACCES: permission denied");
            };
        };
        const NOT_CLEARED = "(could not clear this session's hide/show marker: EACCES: permission denied)";
        const NOT_SAVED = "(could not save this session's marker, so it will not survive /clear: EACCES: permission denied)";

        it("off after the config was written: off takes effect at once, the answer is a warning that names the marker", async () => {
            const h = setup({ config: { enabled: false }, override: "shown" });
            await flush();
            await toOpen(h);
            refuse(h);
            const out = await command(h, "off");
            assert.deepEqual(out, { text: `FleetPane: off ${NOT_CLEARED}`, level: "warning" });
            assert.deepEqual(h.updates, [{ enabled: false }]);
            assert.equal(h.overrides.at(-1).value, "");
            assert.equal(h.pane.status().override, "none");
            assert.equal(h.state(), "closing");
            await collapse(h);
            await turn(h);
            assert.equal(h.state(), "idle");
            assert.equal(h.splits().length, 1);
        });

        it("on after the config was written: on takes effect at once, the answer is a warning that names the marker", async () => {
            const h = setup({ override: "hidden" });
            await flush();
            refuse(h);
            const out = await command(h, "on");
            assert.deepEqual(out, { text: `FleetPane: on · layout right 33% · theme gta6 ${NOT_CLEARED}`, level: "warning" });
            assert.deepEqual(h.updates, [{ enabled: true }]);
            assert.equal(h.pane.status().override, "none");
            assert.equal(h.state(), "opening");
            assert.equal(h.splits().length, 1);
        });

        it("on with a window that is too small: the answer names both", async () => {
            const h = setup({ override: "hidden" });
            await flush();
            refuse(h);
            h.size = { rows: 45, cols: 60 };
            const out = await command(h, "on");
            assert.deepEqual(out, {
                text: `FleetPane: window too small (pane would be 20x45, needs 24x6) ${NOT_CLEARED}`,
                level: "warning",
            });
        });

        it("hide: hidden for as long as this extension process lives, the answer warns that it will not survive /clear", async () => {
            const h = setup();
            await toOpen(h);
            refuse(h);
            const out = await command(h, "hide");
            assert.deepEqual(out, { text: `FleetPane: hidden in this session ${NOT_SAVED}`, level: "warning" });
            assert.equal(h.overrides.at(-1).value, "hidden");
            assert.equal(h.pane.status().override, "hidden");
            assert.equal(h.state(), "closing");
            await collapse(h);
            await turn(h);
            assert.equal(h.state(), "idle");
            assert.equal(h.splits().length, 1);
        });

        it("show: shown for as long as this extension process lives, the answer warns that it will not survive /clear", async () => {
            const h = setup({ config: { enabled: false } });
            refuse(h);
            const out = await command(h, "show");
            assert.deepEqual(out, { text: `FleetPane: shown in this session ${NOT_SAVED}`, level: "warning" });
            assert.equal(h.pane.status().override, "shown");
            assert.equal(h.state(), "opening");
            assert.equal(h.splits().length, 1);
        });
    });

    it("no override, pane open, config becomes enabled: false elsewhere, then show: pane stays open, no new split", async () => {
        const h = setup();
        await toOpen(h);
        const counts = countsOf(h);
        h.config.enabled = false;
        const out = await command(h, "show");
        assert.deepEqual(out, { text: "FleetPane: shown in this session", level: "info" });
        assert.equal(h.state(), "open");
        assert.equal(h.pane.status().override, "shown");
        assert.deepEqual(countsOf(h), counts);
    });

    it("session is shown, global is off, pane open, then on: no close, no new split", async () => {
        const h = setup({ config: { enabled: false } });
        await command(h, "show");
        await answerSplit(h, "P1");
        await connect(h);
        const counts = countsOf(h);
        const out = await command(h, "on");
        assert.deepEqual(out, { text: "FleetPane: on · layout right 33% · theme gta6", level: "info" });
        assert.equal(h.state(), "open");
        assert.equal(h.pane.status().override, "none");
        assert.deepEqual(countsOf(h), counts);
    });

    it("show while awaiting, then timeout with close answering gone: reopens once", async () => {
        const h = setup();
        await toAwaiting(h);
        const out = await command(h, "show");
        assert.deepEqual(out, { text: "FleetPane: shown in this session", level: "info" });
        assert.equal(h.state(), "awaiting");
        assert.equal(h.splits().length, 1);
        h.plan.close.push("gone");
        h.size = FULL;
        await h.clock.advance(5100);
        assert.equal(h.state(), "opening");
        assert.equal(h.splits().length, 2);
    });

    it("show while disabled: clears disabled and opens again", async () => {
        const h = setup({ deps: { env: { TERM_PROGRAM: "ghostty" } } });
        h.plan.split.push(new Error("fail 1"), new Error("fail 2"));
        await turn(h);
        await turn(h);
        assert.equal(h.state(), "disabled");
        const out = await command(h, "show");
        assert.deepEqual(out, { text: "FleetPane: shown in this session", level: "info" });
        assert.equal(h.state(), "opening");
        assert.equal(h.splits().length, 3);
    });

    it("show while closing and window is too small on reopen: command already returned shown; reopen is silent -> idle", async () => {
        const h = setup();
        await toOpen(h);
        await disconnect(h);
        assert.equal(h.state(), "closing");
        const out = await command(h, "show");
        assert.deepEqual(out, { text: "FleetPane: shown in this session", level: "info" });
        h.size = { rows: 45, cols: 60 };    // the pane is gone, and what the reopen measures is too small
        await h.clock.advance(100);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 1);
        assert.deepEqual(h.notes, []);
    });
});

describe("controller: override read-back at creation", () => {
    it("readOverride returns hidden at creation: new turn does not open, status includes this session: hidden", async () => {
        const h = setup({ override: "hidden" });
        await flush();
        assert.equal(h.pane.status().override, "hidden");
        await turn(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 0);
        const out = await command(h, "status");
        assert.equal(out.level, "info");
        assert.match(out.text, /this session: hidden/);
    });

    it("turn starts while read-back (findTty) is pending: no loadConfig, no rotate, no precheck", async () => {
        const lookup = deferred();
        const h = setup({ deps: { findTty: () => lookup.promise, binPath: notExecutable } });
        await turn(h);
        assert.equal(h.state(), "idle");
        assert.equal(h.loadConfigs, 0);
        assert.equal(h.rotates.length, 0);
        assert.equal(h.calls.length, 0);
        assert.deepEqual(h.notes, []);
    });

    it("pending read-back, enabled: true and binary not executable, then reads back hidden: no split, no notification, idle", async () => {
        const lookup = deferred();
        const h = setup({ override: "hidden", deps: { findTty: () => lookup.promise, binPath: notExecutable } });
        await turn(h);
        lookup.resolve({ tty: TTY, pid: 4242, started: "Wed Nov 25 10:06:44 2026" });
        await flush();
        assert.equal(h.state(), "idle");
        assert.equal(h.pane.status().override, "hidden");
        assert.equal(h.splits().length, 0);
        assert.deepEqual(h.notes, []);
    });

    it("pending read-back, enabled: false, then reads back shown: opens once after read-back", async () => {
        const lookup = deferred();
        const h = setup({
            config: { enabled: false },
            override: "shown",
            deps: { findTty: () => lookup.promise },
        });
        await turn(h);
        await turn(h);    // multiple turns before read-back only trigger once
        assert.equal(h.splits().length, 0);
        lookup.resolve({ tty: TTY, pid: 4242, started: "Wed Nov 25 10:06:44 2026" });
        await flush();
        assert.equal(h.state(), "opening");
        assert.equal(h.pane.status().override, "shown");
        assert.equal(h.splits().length, 1);
    });

    it("pending read-back, findTty returns null: treated as none, normal precheck disables silently; hide uses process.ppid fallback", async () => {
        const lookup = deferred();
        const h = setup({ deps: { findTty: () => lookup.promise } });
        await turn(h);
        lookup.resolve(null);
        await flush();
        assert.deepEqual(h.pane.status(), { state: "disabled", reason: "no-tty", override: "none" });
        assert.deepEqual(h.notes, []);
        assert.equal(h.splits().length, 0);
        await command(h, "hide");
        assert.deepEqual(h.overrides, [{ proc: { pid: process.ppid, started: "" }, value: "hidden" }]);
    });

    it("/fleetpane while read-back is pending: waits until read-back finishes and reports the read-back override", async () => {
        const lookup = deferred();
        const h = setup({ override: "shown", deps: { findTty: () => lookup.promise } });
        let resolved = false;
        const pending = h.pane.onCommand({ action: "status" }).then((res) => {
            resolved = true;
            return res;
        });
        await flush();
        assert.equal(resolved, false);
        lookup.resolve({ tty: TTY, pid: 4242, started: "Wed Nov 25 10:06:44 2026" });
        const out = await pending;
        assert.equal(resolved, true);
        assert.equal(out.level, "info");
        assert.match(out.text, /this session: shown/);
    });

    it("shutdown while read-back is pending unblocks waiting command and ignores late findTty", async () => {
        const lookup = deferred();
        const h = setup({ deps: { findTty: () => lookup.promise } });
        await turn(h);
        const pending = h.pane.onCommand({ action: "status" });
        await flush();
        h.pane.shutdown();
        const out = await pending;
        assert.equal(out.level, "warning");
        lookup.resolve({ tty: TTY, pid: 4242, started: "" });
        await flush();
        assert.equal(h.state(), "idle");
        assert.equal(h.splits().length, 0);
    });
});

describe("controller: small window on explicit on / show", () => {
    it("window too small on on and on show: warning with dimensions, switch still saved", async () => {
        const h1 = setup({ config: { enabled: false } });
        h1.size = { rows: 45, cols: 60 };
        const out1 = await command(h1, "on");
        assert.deepEqual(out1, {
            text: "FleetPane: window too small (pane would be 20x45, needs 24x6)",
            level: "warning",
        });
        assert.deepEqual(h1.updates, [{ enabled: true }]);
        assert.equal(h1.state(), "idle");
        assert.equal(h1.splits().length, 0);

        const h2 = setup({ config: { enabled: false } });
        h2.size = { rows: 45, cols: 60 };
        const out2 = await command(h2, "show");
        assert.deepEqual(out2, {
            text: "FleetPane: window too small (pane would be 20x45, needs 24x6)",
            level: "warning",
        });
        assert.deepEqual(h2.updates, []);
        assert.equal(h2.overrides.at(-1).value, "shown");
        assert.equal(h2.pane.status().override, "shown");
        assert.equal(h2.state(), "idle");
        assert.equal(h2.splits().length, 0);
    });

    it("on-initiated open invalidated by immediate off before measurement: both return, on returns normal line, idle", async () => {
        const sizeGate = deferred();
        const h = setup({
            config: { enabled: false },
            deps: { readSize: () => sizeGate.promise },
        });
        await flush();
        const onP = h.pane.onCommand({ action: "on" });
        const offP = h.pane.onCommand({ action: "off" });
        const [onOut, offOut] = await Promise.all([onP, offP]);
        assert.deepEqual(onOut, { text: "FleetPane: on · layout right 33% · theme gta6", level: "info" });
        assert.deepEqual(offOut, { text: "FleetPane: off", level: "info" });
        assert.equal(h.state(), "idle");
        sizeGate.resolve({ rows: 45, cols: 60 });
        await flush();
        assert.equal(h.state(), "idle");
    });

    it("on-initiated open interrupted by shutdown before measurement: on returns normal line", async () => {
        const sizeGate = deferred();
        const h = setup({
            config: { enabled: false },
            deps: { readSize: () => sizeGate.promise },
        });
        await flush();
        const onP = h.pane.onCommand({ action: "on" });
        await flush();
        h.pane.shutdown();
        const onOut = await onP;
        assert.deepEqual(onOut, { text: "FleetPane: on · layout right 33% · theme gta6", level: "info" });
    });
});

describe("controller: layout and four positions", () => {
    it("all four positions pass right, left, up, down to split", async () => {
        for (const [position, expected] of [
            ["right", "right"],
            ["left", "left"],
            ["top", "up"],
            ["bottom", "down"],
        ]) {
            const h = setup({ config: { layout: { position, size: 33 } } });
            await turn(h);
            assert.equal(h.splits().length, 1);
            assert.equal(h.splits()[0].args[3], expected, position);
        }
    });

    it("layout top 25 while open, close answers ok but the pane stays: no reopen at 2s; the next turn closes the old pane first, then opens with up", async () => {
        const h = setup();
        await toOpen(h, "P1");
        h.plan.close.push("ok");    // Ghostty answered, yet the pane stays on screen (it asks for confirmation)
        await command(h, "layout", { position: "top", size: 25 });
        assert.equal(h.state(), "closing");
        assert.deepEqual(h.closedPanes(), ["P1"]);
        await h.clock.advance(1999);
        assert.equal(h.state(), "closing");
        await h.clock.advance(1);
        assert.equal(h.state(), "idle");
        await h.clock.advance(10000);
        assert.equal(h.splits().length, 1);

        h.panes.delete("P1");
        h.size = FULL;
        await turn(h);
        assert.deepEqual(h.closedPanes(), ["P1", "P1"]);
        await h.clock.advance(100);    // gone, and two readings that agree
        assert.equal(h.splits().length, 2);
        assert.equal(h.splits()[1].args[3], "up");
        assert.deepEqual(measuredBefore(h), FULL);
    });

    it("consecutive layout left 40 then layout top 25 while opening: reopens once with up", async () => {
        const h = setup();
        await turn(h);
        await command(h, "layout", { position: "left", size: 40 });
        await command(h, "layout", { position: "top", size: 25 });
        assert.equal(h.splits().length, 1);
        await answerSplit(h, "P1");
        await connect(h);
        assert.equal(h.state(), "closing");
        await collapse(h);
        assert.equal(h.state(), "opening");
        assert.equal(h.splits().length, 2);
        assert.equal(h.splits()[1].args[3], "up");
        await answerSplit(h, "P2");
        await connect(h);
        assert.equal(h.state(), "open");
        await h.clock.advance(3000);
        assert.equal(h.splits().length, 2);
    });
});

describe("controller: theme", () => {
    it("theme auto while open: updateConfig and server.schedule(), no close, no script calls", async () => {
        const h = setup();
        await toOpen(h);
        const counts = countsOf(h);
        const schedules = h.schedules;
        const out = await command(h, "theme", { theme: "auto" });
        assert.deepEqual(out, { text: "FleetPane: theme auto", level: "info" });
        assert.deepEqual(h.updates, [{ theme: "auto" }]);
        assert.equal(h.schedules, schedules + 1);
        assert.equal(h.pane.theme(), "auto");
        assert.equal(h.state(), "open");
        assert.deepEqual(countsOf(h), counts);
    });

    it("another session changes theme, then a turn starts: server.schedule() called and theme() updated", async () => {
        const h = setup({ config: { theme: "gta6" } });
        await toOpen(h);
        assert.equal(h.schedules, 0);
        await turn(h);    // unchanged theme -> no schedule
        assert.equal(h.schedules, 0);
        h.config.theme = "auto";
        await turn(h);
        assert.equal(h.schedules, 1);
        assert.equal(h.pane.theme(), "auto");
        await turn(h);    // unchanged again -> no extra schedule
        assert.equal(h.schedules, 1);
    });
});

describe("controller: ratio calibration (7.9)", () => {
    // Helper: creates a controller whose fake `run` updates `h.size` after each resize according to a script.
    function setupCalibration({ config = {}, before = { rows: 45, cols: 168 }, onResize } = {}) {
        const h = setup({ config });
        h.size = before;
        const origRun = h.deps.run;
        h.deps.run = (file, args, opts) => {
            const p = origRun(file, args, opts);
            if (args[1] === "resize" && onResize) {
                onResize(h, { paneId: args[2], dir: args[3], px: Number(args[4]) });
            }
            return p;
        };
        return h;
    }

    it("preset reading sequence: probe 80px then correction lands on target, <= 4 resizes, logs resize events", async () => {
        // Real Ghostty numbers: before 168, size 33 -> target 113; split halves to 83; 10px/col; right moves divider right (Copilot grows)
        const h = setupCalibration({
            before: { rows: 45, cols: 168 },
            onResize: (ctx, { dir, px }) => {
                const delta = Math.round(px / 10) * (dir === "right" ? 1 : -1);
                ctx.size = { rows: 45, cols: ctx.size.cols + delta };
            },
        });
        await turn(h);
        h.splits()[0].ok("ok P1 focus=restored");
        // Size updates 60ms after split
        await h.clock.advance(60);
        h.size = { rows: 45, cols: 83 };
        await h.clock.advance(500);

        const resizes = h.resizes();
        assert.equal(resizes.length, 2);
        assert.deepEqual(resizes[0].args, [SCRIPT, "resize", "P1", "right", "80"]);
        assert.deepEqual(resizes[0].opts, { timeoutMs: 5000 });
        assert.deepEqual(resizes[1].args, [SCRIPT, "resize", "P1", "right", "220"]);
        assert.equal(h.size.cols, 113);
        assert.ok(h.logs.some((entry) => entry.kind === "resize"));
    });

    it("probe 80px yields delta 0 -> retries 240px -> up to 2 corrections, total resizes <= 4", async () => {
        // First probe (80px) does not move cols; 240px moves +12 (20px/col); first correction slightly under-shoots; second finishes
        let step = 0;
        const h = setupCalibration({
            before: { rows: 45, cols: 168 },
            onResize: (ctx, { px }) => {
                step += 1;
                if (step === 1) return; // 80px -> delta 0
                if (step === 2) ctx.size = { rows: 45, cols: 95 };  // 240px -> +12 (20px/col); remaining = 18 -> 360px
                else if (step === 3) ctx.size = { rows: 45, cols: 110 }; // still 3 off -> 60px
                else if (step === 4) ctx.size = { rows: 45, cols: 113 }; // target reached (4th and final resize)
                else ctx.size = { rows: 45, cols: 113 };
            },
        });
        await turn(h);
        h.splits()[0].ok("ok P1 focus=restored");
        h.size = { rows: 45, cols: 83 };
        await h.clock.advance(2000);

        const resizes = h.resizes();
        assert.equal(resizes.length, 4);
        assert.deepEqual(
            resizes.map((call) => call.args.slice(2)),
            [
                ["P1", "right", "80"],
                ["P1", "right", "240"],
                ["P1", "right", "360"],
                ["P1", "right", "60"],
            ],
        );
    });

    it("reversed direction response: correction flips direction", async () => {
        // Moving `right` shrinks Copilot instead of growing it -> calibration flips to `left`
        const h = setupCalibration({
            before: { rows: 45, cols: 168 },
            onResize: (ctx, { dir, px }) => {
                const delta = Math.round(px / 10) * (dir === "right" ? -1 : 1);
                ctx.size = { rows: 45, cols: ctx.size.cols + delta };
            },
        });
        await turn(h);
        h.splits()[0].ok("ok P1 focus=restored");
        h.size = { rows: 45, cols: 83 };
        await h.clock.advance(500);

        const resizes = h.resizes();
        assert.equal(resizes.length, 2);
        assert.deepEqual(resizes[0].args, [SCRIPT, "resize", "P1", "right", "80"]);
        assert.deepEqual(resizes[1].args, [SCRIPT, "resize", "P1", "left", "380"]);
        assert.equal(h.size.cols, 113);
    });

    it("top split calibrates vertically using rows and up/down", async () => {
        // before 45 rows, size 33 -> target 30; split halves to 22; 20px/row
        const h = setupCalibration({
            config: { layout: { position: "top", size: 33 } },
            before: { rows: 45, cols: 168 },
            onResize: (ctx, { dir, px }) => {
                const delta = Math.round(px / 20) * (dir === "up" ? 1 : -1);
                ctx.size = { rows: ctx.size.rows + delta, cols: 168 };
            },
        });
        await turn(h);
        h.splits()[0].ok("ok P1 focus=restored");
        h.size = { rows: 22, cols: 168 };
        await h.clock.advance(500);

        const resizes = h.resizes();
        assert.equal(resizes.length, 2);
        assert.deepEqual(resizes[0].args, [SCRIPT, "resize", "P1", "up", "80"]);
        assert.deepEqual(resizes[1].args, [SCRIPT, "resize", "P1", "up", "80"]);
        assert.equal(h.size.rows, 30);
    });

    it("reading never changes after split: gives up after 600ms with no resize calls", async () => {
        const h = setupCalibration({ before: { rows: 45, cols: 168 } });
        await turn(h);
        h.splits()[0].ok("ok P1 focus=restored");
        await h.clock.advance(1000);
        assert.deepEqual(h.resizes(), []);
    });

    it("a reading that only arrives after the 600ms following the split is dropped: no resize comes of it", async () => {
        const h = setupCalibration({ before: { rows: 45, cols: 168 } });
        await turn(h);
        h.readDelay = 900;
        h.splits()[0].ok("ok P1 focus=restored");
        h.size = { rows: 45, cols: 83 };
        await connect(h);
        await h.clock.advance(4000);
        assert.deepEqual(h.resizes(), []);
        assert.ok(h.logs.some((entry) => entry.kind === "resize" && entry.step === "after-split" && entry.outcome === "unchanged"));
    });

    it("the 400ms following a resize are a deadline too: with readings arriving later, calibration ends after the two probes", async () => {
        const h = setupCalibration({
            before: { rows: 45, cols: 168 },
            onResize: (ctx, { px }) => {
                ctx.readDelay = 500;
                ctx.size = { rows: 45, cols: ctx.size.cols + Math.round(px / 10) };
            },
        });
        await turn(h);
        h.splits()[0].ok("ok P1 focus=restored");
        h.size = { rows: 45, cols: 83 };
        await connect(h);
        await h.clock.advance(4000);
        assert.deepEqual(
            h.resizes().map((call) => call.args.slice(2)),
            [
                ["P1", "right", "80"],
                ["P1", "right", "240"],
            ],
        );
    });

    it("reading never changes after probes (clamped): stops after 80px and 240px probes", async () => {
        const h = setupCalibration({ before: { rows: 45, cols: 168 } });
        await turn(h);
        h.splits()[0].ok("ok P1 focus=restored");
        h.size = { rows: 45, cols: 83 };
        await h.clock.advance(2000);
        assert.deepEqual(
            h.resizes().map((call) => call.args.slice(2)),
            [
                ["P1", "right", "80"],
                ["P1", "right", "240"],
            ],
        );
    });

    it("client disconnects halfway through calibration: no further resize calls", async () => {
        const h = setupCalibration({
            before: { rows: 45, cols: 168 },
            onResize: (ctx, { dir, px }) => {
                const delta = Math.round(px / 10) * (dir === "right" ? 1 : -1);
                ctx.size = { rows: 45, cols: ctx.size.cols + delta };
            },
        });
        await turn(h);
        // Pause the first resize call so we can disconnect mid-calibration
        h.plan.resize.push(HOLD);
        h.splits()[0].ok("ok P1 focus=restored");
        h.size = { rows: 45, cols: 83 };
        await connect(h);
        await flush();
        assert.equal(h.resizes().length, 1);

        await disconnect(h);
        h.resizes()[0].ok("ok");
        await h.clock.advance(1000);
        assert.equal(h.resizes().length, 1);
    });

    it("client connects before split answers ok: calibration still runs", async () => {
        const h = setupCalibration({
            before: { rows: 45, cols: 168 },
            onResize: (ctx, { dir, px }) => {
                const delta = Math.round(px / 10) * (dir === "right" ? 1 : -1);
                ctx.size = { rows: 45, cols: ctx.size.cols + delta };
            },
        });
        await turn(h);
        await connect(h);
        h.splits()[0].ok("ok P1 focus=restored");
        h.size = { rows: 45, cols: 83 };
        await h.clock.advance(500);
        assert.equal(h.resizes().length, 2);
        assert.equal(h.size.cols, 113);
    });

    it("computed px outside 1-4000 is rejected before calling osascript", async () => {
        // 80px -> delta 0; 240px -> delta +1 (240px/col); remaining 29 -> 6960px > 4000 -> give up without a 3rd resize
        let step = 0;
        const h = setupCalibration({
            before: { rows: 45, cols: 168 },
            onResize: (ctx) => {
                step += 1;
                if (step === 2) ctx.size = { rows: 45, cols: 84 };
            },
        });
        await turn(h);
        h.splits()[0].ok("ok P1 focus=restored");
        h.size = { rows: 45, cols: 83 };
        await h.clock.advance(2000);
        assert.equal(h.resizes().length, 2);
    });

    // The tests below open more than once in one controller. 168 columns at 33% -> target 113; the split leaves 83.
    const WIDE = { rows: 45, cols: 168 };
    const HALVED = { rows: 45, cols: 83 };

    // A divider like Ghostty's: a resize moves the Copilot pane by px / pxPerCol columns, growing it when the
    // divider moves towards the new pane. The next `fake.ignore` resizes answer ok and leave the reading alone.
    function setupColumns() {
        const fake = { pxPerCol: 10, ignore: 0 };
        const h = setupCalibration({
            before: WIDE,
            onResize: (ctx, { dir, px }) => {
                if (fake.ignore > 0) {
                    fake.ignore -= 1;
                    return;
                }
                const delta = Math.round(px / fake.pxPerCol) * (dir === ctx.config.layout.position ? 1 : -1);
                ctx.size = { rows: 45, cols: ctx.size.cols + delta };
            },
        });
        return { h, fake };
    }

    // The split answers and leaves `halved`, the panel connects, calibration runs to its end.
    async function settle(h, id, halved = HALVED) {
        h.splits().at(-1).ok(`ok ${id} focus=restored`);
        h.size = halved;
        await connect(h);
        await h.clock.advance(2000);
    }

    // The pane is gone and the Copilot pane reads its full size again, twice in a row.
    async function collapsed(h) {
        h.size = WIDE;
        await h.clock.advance(100);
    }

    // The panel goes away, the pane collapses, and the next turn opens again.
    async function reopen(h, id) {
        await disconnect(h);
        await collapsed(h);
        await turn(h);
        await settle(h, id);
    }

    const resizesOf = (h, id) => h.resizes().filter((call) => call.args[2] === id).map((call) => call.args.slice(3));

    it("a later open on the same axis goes to the target in one resize computed from the earlier measurement, with no 80px probe: right again, then left", async () => {
        const { h } = setupColumns();
        await turn(h);
        await settle(h, "P1");
        assert.deepEqual(resizesOf(h, "P1"), [["right", "80"], ["right", "220"]]);

        // 30 columns to go at the measured 220px per 22 columns
        await reopen(h, "P2");
        assert.deepEqual(resizesOf(h, "P2"), [["right", "300"]]);
        assert.equal(h.size.cols, 113);
        assert.ok(h.logs.some((entry) => entry.kind === "resize" && entry.step === "cached" && entry.plan.px === 300));

        // The pane on the other side: growing the Copilot pane is still "towards the new pane", now `left`
        await command(h, "layout", { position: "left" });
        await collapsed(h);
        await settle(h, "P3");
        assert.deepEqual(resizesOf(h, "P3"), [["left", "300"]]);
        assert.equal(h.size.cols, 113);
    });

    it("the remembered step lands more than one column off (the cell size changed): one correction from the step just measured, and the next open uses that step", async () => {
        const { h, fake } = setupColumns();
        await turn(h);
        await settle(h, "P1");      // remembered: 220px per 22 columns

        // 300px now move 19 columns -> 102; 11 to go at 300px per 19 -> 174px -> 113
        fake.pxPerCol = 16;
        await reopen(h, "P2");
        assert.deepEqual(resizesOf(h, "P2"), [["right", "300"], ["right", "174"]]);
        assert.equal(h.size.cols, 113);

        // 30 columns at 300px per 19, the larger of the two steps the second open measured (174px per 11 would give 475)
        await reopen(h, "P3");
        assert.deepEqual(resizesOf(h, "P3"), [["right", "474"]]);
        assert.equal(h.size.cols, 113);
    });

    it("the remembered step has no effect within 400ms: it is forgotten, and the open probes with 80px and corrects as a first open does, 3 resizes in all", async () => {
        const { h, fake } = setupColumns();
        await turn(h);
        await settle(h, "P1");

        await disconnect(h);
        await collapsed(h);
        fake.ignore = 1;
        await turn(h);
        h.splits().at(-1).ok("ok P2 focus=restored");
        h.size = HALVED;
        await connect(h);
        await h.clock.advance(399);
        assert.deepEqual(resizesOf(h, "P2"), [["right", "300"]]);
        await h.clock.advance(1);
        assert.deepEqual(resizesOf(h, "P2"), [["right", "300"], ["right", "80"], ["right", "220"]]);
        assert.equal(h.size.cols, 113);
    });

    it("neither the remembered step nor the two probes have any effect: nothing stays remembered, the next open starts with the 80px probe", async () => {
        const { h, fake } = setupColumns();
        await turn(h);
        await settle(h, "P1");

        fake.ignore = 3;
        await reopen(h, "P2");
        assert.deepEqual(resizesOf(h, "P2"), [["right", "300"], ["right", "80"], ["right", "240"]]);

        await reopen(h, "P3");
        assert.deepEqual(resizesOf(h, "P3"), [["right", "80"], ["right", "220"]]);
    });

    it("the remembered step and the 80px probe have no effect, 240px does: room for one correction only, the open stops at 4 resizes", async () => {
        // First open: 80px -> +8, 220px -> +22. Second open: 300px and 80px -> nothing, 240px -> +12 (95),
        // 360px -> +15 (110): 3 columns short, and the 60px that would close the gap is a fifth resize
        const gains = [8, 22, 0, 0, 12, 15];
        const h = setupCalibration({
            before: WIDE,
            onResize: (ctx) => {
                ctx.size = { rows: 45, cols: ctx.size.cols + gains.shift() };
            },
        });
        await turn(h);
        await settle(h, "P1");

        await reopen(h, "P2");
        assert.deepEqual(resizesOf(h, "P2"), [["right", "300"], ["right", "80"], ["right", "240"], ["right", "360"]]);
        assert.equal(h.size.cols, 110);
    });

    it("the pane closes while the remembered step is under way, its script still running or its reading still awaited: the measurement is kept for the next open", async () => {
        const { h, fake } = setupColumns();
        await turn(h);
        await settle(h, "P1");

        await disconnect(h);
        await collapsed(h);
        h.plan.resize.push(HOLD);
        await turn(h);
        h.splits().at(-1).ok("ok P2 focus=restored");
        h.size = HALVED;
        await connect(h);
        await disconnect(h);
        h.resizes().at(-1).ok("ok");    // the script answers for a pane that is closing by now
        await collapsed(h);
        assert.deepEqual(resizesOf(h, "P2"), [["right", "300"]]);

        fake.ignore = 1;
        await turn(h);
        h.splits().at(-1).ok("ok P3 focus=restored");
        h.size = HALVED;
        await connect(h);
        await h.clock.advance(100);     // the step is out, the reading has not followed yet
        assert.deepEqual(resizesOf(h, "P3"), [["right", "300"]]);

        await reopen(h, "P4");
        assert.deepEqual(resizesOf(h, "P3"), [["right", "300"]]);
        assert.deepEqual(resizesOf(h, "P4"), [["right", "300"]]);
        assert.equal(h.size.cols, 113);
    });

    it("the remembered measurement gives a step beyond 4000px: no resize is made, it is forgotten, and the next open probes again", async () => {
        // First open: 80px -> nothing, 240px -> +1 column; 29 columns to go at 240px each -> 6960px, rejected.
        // Second open: 30 columns -> 7200px, rejected as well. Third open: 10px per column, as usual.
        const gains = [0, 1, 8, 22];
        const h = setupCalibration({
            before: WIDE,
            onResize: (ctx) => {
                ctx.size = { rows: 45, cols: ctx.size.cols + gains.shift() };
            },
        });
        await turn(h);
        await settle(h, "P1");
        assert.deepEqual(resizesOf(h, "P1"), [["right", "80"], ["right", "240"]]);

        await reopen(h, "P2");
        assert.deepEqual(resizesOf(h, "P2"), []);

        await reopen(h, "P3");
        assert.deepEqual(resizesOf(h, "P3"), [["right", "80"], ["right", "220"]]);
        assert.equal(h.size.cols, 113);
    });

    it("a measurement of columns is not used for rows: after right, a top open probes with 80px again; right afterwards still goes in one resize", async () => {
        // 10px per column, 20px per row
        const h = setupCalibration({
            before: WIDE,
            onResize: (ctx, { dir, px }) => {
                if (dir === "right" || dir === "left") {
                    ctx.size = { rows: 45, cols: ctx.size.cols + Math.round(px / 10) * (dir === "right" ? 1 : -1) };
                } else {
                    ctx.size = { rows: ctx.size.rows + Math.round(px / 20) * (dir === "up" ? 1 : -1), cols: 168 };
                }
            },
        });
        await turn(h);
        await settle(h, "P1");
        assert.deepEqual(resizesOf(h, "P1"), [["right", "80"], ["right", "220"]]);

        // 45 rows at 25% -> target 34; the split leaves 22. The columns measurement would have given 120px.
        await command(h, "layout", { position: "top", size: 25 });
        await collapsed(h);
        await settle(h, "P2", { rows: 22, cols: 168 });
        assert.deepEqual(resizesOf(h, "P2"), [["up", "80"], ["up", "160"]]);
        assert.equal(h.size.rows, 34);

        // Back to columns: 220px per 22 columns again; the rows measurement (160px per 8) would have given 600px
        await command(h, "layout", { position: "right", size: 33 });
        await collapsed(h);
        await settle(h, "P3");
        assert.deepEqual(resizesOf(h, "P3"), [["right", "300"]]);
        assert.equal(h.size.cols, 113);
    });

    it("the probe alone reaches the target: it stays remembered, and the next open computes its one resize from it", async () => {
        // 45% -> target 92; the split leaves 83; the 80px probe moves 8 columns -> 91, one column off: done
        const { h } = setupColumns();
        h.config.layout.size = 45;
        await turn(h);
        await settle(h, "P1");
        assert.deepEqual(resizesOf(h, "P1"), [["right", "80"]]);

        // 9 columns at 80px per 8
        await reopen(h, "P2");
        assert.deepEqual(resizesOf(h, "P2"), [["right", "90"]]);
        assert.equal(h.size.cols, 92);
    });

    it("on a probing open the first correction moved more cells than the probe: it is what stays remembered, and the corrections still compute with the probe", async () => {
        // First open: 80px -> +8 (91), 220px -> +20 (111), then 2 columns at the probe's 80px per 8 -> 20px -> +2 (113).
        // Second open: 30 columns at the correction's 220px per 20 -> 330px (the probe's ratio would give 300px)
        const gains = [8, 20, 2, 30];
        const h = setupCalibration({
            before: WIDE,
            onResize: (ctx) => {
                ctx.size = { rows: 45, cols: ctx.size.cols + gains.shift() };
            },
        });
        await turn(h);
        await settle(h, "P1");
        assert.deepEqual(resizesOf(h, "P1"), [["right", "80"], ["right", "220"], ["right", "20"]]);

        await reopen(h, "P2");
        assert.deepEqual(resizesOf(h, "P2"), [["right", "330"]]);
        assert.equal(h.size.cols, 113);
    });
});

describe("controller: async server.close() rejection", () => {
    it("server.close() returning a rejected promise is logged, causes no unhandled rejection, and leaves transitions intact", async () => {
        const unhandled = [];
        const onUnhandled = (err) => unhandled.push(err);
        process.on("unhandledRejection", onUnhandled);
        try {
            const h = setup();
            h.deps.server.close = () => {
                h.closes += 1;
                return Promise.reject(new Error("close failed async"));
            };
            await toOpen(h);
            await disconnect(h);
            assert.equal(h.state(), "closing");
            await collapse(h);
            assert.equal(h.state(), "idle");
            h.pane.shutdown();
            await flush();
            assert.deepEqual(unhandled, []);
            assert.ok(h.logs.some((entry) => entry.kind === "error" && entry.where === "server.close"));
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
    });
});
