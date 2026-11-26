import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createState } from "../../extension/lib/state.mjs";
import { FAILED_COUNT, THRESHOLDS, formatJsonl, generate } from "../../hack/gen-many-agents.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SAMPLE_PATH = path.join(REPO_ROOT, "test", "testdata", "many-agents.jsonl");

describe("many-agents sample and generator", () => {
    it("matches the committed test/testdata/many-agents.jsonl byte for byte", () => {
        const { events } = generate();
        const committed = fs.readFileSync(SAMPLE_PATH, "utf8");
        assert.equal(formatJsonl(events), committed);
    });

    it("reaches exact running counts at every reported pause index", () => {
        const { events, pauses } = generate();
        assert.deepEqual(pauses.map((p) => p.running), THRESHOLDS);

        const byEvent = new Map(pauses.map((p) => [p.event, p.running]));
        const state = createState();
        const observed = new Map();

        for (let i = 0; i < events.length; i++) {
            state.apply(events[i]);
            const expected = byEvent.get(i + 1);
            if (expected === undefined) continue;
            const snap = state.snapshot();
            const running = snap.agents.filter((a) => a.status === "running");
            assert.equal(running.length, expected);
            if (expected === 60) {
                assert.equal(snap.agents.length, 60);
                observed.set(60, snap);
            }
        }

        const full = observed.get(60);
        assert.ok(full, "expected to hit the 60-running pause index");
        const nested = full.agents.filter((a) => a.parent !== "");
        assert.equal(nested.length, 1);

        const [child] = nested;
        const parentIndex = full.agents.findIndex((a) => a.id === child.parent);
        assert.ok(parentIndex >= 0, "child parent must exist in the snapshot");
        assert.equal(full.agents[parentIndex + 1]?.id, child.id);
        assert.equal(child.depth, 1);
    });

    it("finishes with all 60 reported in the current turn, expected failures, and main idle", () => {
        const { events, failedCount } = generate();
        assert.equal(failedCount, FAILED_COUNT);

        const state = createState();
        for (const event of events) state.apply(event);
        const snap = state.snapshot();

        assert.equal(snap.main.status, "idle");
        assert.equal(snap.agents.length, 60);
        assert.equal(snap.agents.filter((a) => a.status === "running").length, 0);
        assert.equal(snap.agents.filter((a) => a.status === "failed").length, failedCount);
        assert.ok(snap.agents.every((a) => a.reportedTurn === snap.turn));
    });

    it("leaves no tool record running or waiting once every agent has ended", () => {
        const state = createState();
        for (const event of generate().events) state.apply(event);
        const open = state.snapshot().log.filter((e) => e.kind === "tool" && (e.status === "running" || e.status === "waiting"));
        assert.deepEqual(open.map((e) => `${e.name} / ${e.tool} ${e.id}: ${e.status}`), []);
    });
});
