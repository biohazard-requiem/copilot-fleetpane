import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
    HIDDEN_TOOLS,
    createState,
    encodeSnapshot,
    isUserSubmission,
    startsTurn,
    summarizeArgs,
} from "../../extension/lib/state.mjs";

// One describe per group of cases. The samples under
// test/testdata that are replayed here are trimmed from real captures.

const T0 = Date.parse("2026-11-23T03:40:00.000Z");
let lastId = 0;

// An SDK-shaped event. Each call gets the next id and a timestamp one second after the previous one.
function ev(type, data, extra) {
    lastId += 1;
    const timestamp = new Date(T0 + lastId * 1000).toISOString();
    return { id: `ev-${lastId}`, timestamp, parentId: null, type, data, ...extra };
}

// In the helpers below, agentId is the envelope's: leave it out (or pass null) for the main agent.
const from = (agentId) => (agentId ? { agentId } : undefined);
const NAMES = { agentName: "explore", agentDisplayName: "Explore" };

const prompt = (data, extra) => ev("user.message", { content: "go", ...data }, extra);
const idle = (agentId) => ev("assistant.idle", {}, from(agentId));
const sessionIdle = () => ev("session.idle", {});
const abort = (agentId) => ev("abort", { reason: "user initiated" }, from(agentId));
const sessionError = (message, agentId) => ev("session.error", { message, errorType: "quota" }, from(agentId));
const turnStart = (data, agentId) => ev("assistant.turn_start", { turnId: "0", ...data }, from(agentId));
const intent = (value, agentId) => ev("assistant.intent", { intent: value }, from(agentId));
const toolStart = (toolCallId, agentId, toolName = "view", args = { path: "README.md" }) =>
    ev("tool.execution_start", { toolCallId, toolName, arguments: args }, from(agentId));
const toolEnd = (toolCallId, agentId, success = true) =>
    ev("tool.execution_complete", { toolCallId, success }, from(agentId));
const toolFail = (toolCallId, agentId, message) =>
    ev("tool.execution_complete", { toolCallId, success: false, error: { message } }, from(agentId));
const spawn = (toolCallId, agentId, args = { prompt: "Do it" }) => toolStart(toolCallId, agentId, "task", args);
const started = (toolCallId, agentId, data) =>
    ev("subagent.started", { toolCallId, ...NAMES, agentDescription: "Looks around", ...data }, from(agentId));
const completed = (toolCallId, agentId, data) =>
    ev("subagent.completed", { toolCallId, ...NAMES, ...data }, from(agentId));
const failed = (toolCallId, agentId, error = "boom", data) =>
    ev("subagent.failed", { toolCallId, ...NAMES, error, ...data }, from(agentId));

function run(events, options) {
    const state = createState(options);
    for (const event of events) state.apply(event);
    return state;
}

// The events of a sample file, one per line.
const sample = (name) =>
    readFileSync(new URL(`../testdata/${name}`, import.meta.url), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

const agentByCall = (state, call) => state.snapshot().agents.find((agent) => agent.call === call);
const calls = (state) => state.snapshot().agents.map((agent) => agent.call);
const ms = (event) => Date.parse(event.timestamp);
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

describe("failure events", () => {
    it("subagent.failed → status failed, error and duration recorded", () => {
        const end = failed("call-1", "agent-1", "model refused\nstack line", { durationMs: 4200 });
        const agent = agentByCall(run([started("call-1", "agent-1"), end]), "call-1");
        assert.equal(agent.status, "failed");
        assert.equal(agent.error, "model refused");
        assert.equal(agent.durationMs, 4200);
        assert.equal(agent.endedAt, end.timestamp);
    });

    it("tool completes with success: false and error.message → tool failed with the message; its agent still running", () => {
        const state = run([
            started("call-1", "agent-1"),
            toolStart("tool-1", "agent-1"),
            toolFail("tool-1", "agent-1", "ENOENT: no such file\n    at read"),
        ]);
        const agent = agentByCall(state, "call-1");
        assert.equal(agent.status, "running");
        assert.deepEqual(agent.tools.map((tool) => [tool.status, tool.error]), [["failed", "ENOENT: no such file"]]);
    });

    it("root session.error → main.status error, main.error is the message", () => {
        const error = sessionError("rate limited");
        const { main } = run([prompt(), error]).snapshot();
        assert.deepEqual([main.status, main.error, main.since], ["error", "rate limited", error.timestamp]);
    });

    it("session.idle and assistant.idle after session.error → still error", () => {
        const state = run([prompt(), sessionError("rate limited")]);
        for (const event of [idle(), sessionIdle()]) {
            state.apply(event);
            assert.deepEqual([state.snapshot().main.status, state.snapshot().main.error], ["error", "rate limited"]);
        }
    });

    it("after an error: root assistant.turn_start; a new turn → both back to working, main.error cleared", () => {
        for (const recover of [turnStart, prompt]) {
            const state = run([prompt(), sessionError("rate limited")]);
            state.apply(recover());
            assert.deepEqual([state.snapshot().main.status, state.snapshot().main.error], ["working", ""]);
        }
    });

    it("session.error and abort carrying an agentId → main unchanged", () => {
        const state = run([prompt(), started("call-1", "agent-1")]);
        const before = state.snapshot();
        assert.equal(state.apply(sessionError("sub-agent broke", "agent-1")), false);
        assert.equal(state.apply(abort("agent-1")), false);
        assert.deepEqual(state.snapshot(), before);
    });

    it("subagent.completed with cancelled: true → status cancelled", () => {
        const state = run([started("call-1", "agent-1"), completed("call-1", "agent-1", { cancelled: true })]);
        assert.equal(agentByCall(state, "call-1").status, "cancelled");
    });

    it("root abort → main.status idle", () => {
        const state = run([prompt()]);
        assert.equal(state.snapshot().main.status, "working");
        state.apply(abort());
        assert.equal(state.snapshot().main.status, "idle");
    });
});

describe("duplicate events", () => {
    it("the same event object applied twice → second apply returns false, snapshot unchanged", () => {
        const state = run([prompt(), started("call-1", "agent-1")]);
        const event = toolStart("tool-1", "agent-1");
        assert.equal(state.apply(event), true);
        const before = state.snapshot();
        assert.equal(state.apply(event), false);
        assert.deepEqual(state.snapshot(), before);
    });

    it("event ids are remembered for the latest 2000 handled events", () => {
        const first = intent("first");
        const state = run([first, ...range(1999).map((i) => intent(`step ${i}`))]);
        // Types that are not handled take no room in that window.
        for (const i of range(3000)) state.apply(ev("assistant.message_delta", { deltaContent: `${i}` }));
        assert.equal(state.apply(first), false);

        state.apply(intent("one more"));
        assert.equal(state.apply(first), true);
        assert.equal(state.snapshot().main.intent, "first");
    });

    it("two tool.execution_start with different ids and the same toolCallId → one tool record, turnTools grows by 1", () => {
        const snapshot = run([prompt(), toolStart("tool-1"), toolStart("tool-1")]).snapshot();
        assert.equal(snapshot.main.tools.length, 1);
        assert.equal(snapshot.stats.turnTools, 1);
        assert.equal(snapshot.log.length, 1);
    });

    it("two tool.execution_complete with the same toolCallId and opposite results → the first one wins", () => {
        const first = toolEnd("tool-1");
        const state = run([prompt(), toolStart("tool-1"), first]);
        assert.equal(state.apply(toolFail("tool-1", null, "late failure")), false);
        const [tool] = state.snapshot().main.tools;
        assert.deepEqual([tool.status, tool.error, tool.endedAt], ["ok", "", first.timestamp]);
    });

    it("two subagent.started with the same toolCallId → one agent, startedAt is the first one's", () => {
        const first = started("call-1", "agent-1");
        const { agents } = run([first, started("call-1", "agent-1")]).snapshot();
        assert.equal(agents.length, 1);
        assert.equal(agents[0].startedAt, first.timestamp);
    });

    it("subagent.completed after subagent.failed → still failed", () => {
        const end = failed("call-1", "agent-1", "boom");
        const state = run([started("call-1", "agent-1"), end]);
        assert.equal(state.apply(completed("call-1", "agent-1")), false);
        const agent = agentByCall(state, "call-1");
        assert.deepEqual([agent.status, agent.error, agent.endedAt], ["failed", "boom", end.timestamp]);
    });

    it("subagent.started arriving after its subagent.completed → still done, times unchanged; empty name and type filled in", () => {
        const end = ev("subagent.completed", { toolCallId: "call-1", durationMs: 3000 });
        const state = run([end]);
        const before = agentByCall(state, "call-1");
        assert.deepEqual([before.status, before.name, before.type], ["done", "agent-a1", ""]);

        state.apply(started("call-1", "agent-1", { agentType: "explore-type", executionMode: "background" }));
        const after = agentByCall(state, "call-1");
        assert.equal(state.snapshot().agents.length, 1);
        assert.deepEqual([after.status, after.startedAt, after.endedAt, after.durationMs],
            ["done", before.startedAt, end.timestamp, 3000]);
        assert.deepEqual([after.name, after.type, after.desc, after.mode],
            ["Explore", "explore-type", "Looks around", "background"]);
    });

    it("tool events for an agent that already finished → the tool is recorded, the agent's status is unchanged", () => {
        const state = run([started("call-1", "agent-1"), completed("call-1", "agent-1")]);
        state.apply(toolStart("tool-late", "agent-1"));
        state.apply(toolEnd("tool-late", "agent-1"));
        const agent = agentByCall(state, "call-1");
        assert.deepEqual([agent.status, agent.toolCount], ["done", 1]);
        assert.deepEqual(agent.tools.map((tool) => [tool.id, tool.status]), [["tool-late", "ok"]]);
    });

    it("events with checkpoint: true → ignored", () => {
        const state = createState();
        const before = state.snapshot();
        const replayed = [started("call-1", "agent-1"), toolStart("tool-1"), sessionError("old"), intent("old")];
        for (const event of replayed) assert.equal(state.apply({ ...event, checkpoint: true }), false, event.type);
        assert.deepEqual(state.snapshot(), before);
    });
});

describe("missing optional fields", () => {
    it("subagent.started without agentType, executionMode, parentId → type falls back to agentName, mode and parent empty", () => {
        const data = { toolCallId: "call-1", ...NAMES, agentDescription: "d" };
        const agent = agentByCall(run([ev("subagent.started", data, from("agent-1"))]), "call-1");
        assert.deepEqual([agent.type, agent.mode, agent.parent, agent.depth], ["explore", "", "", 0]);
    });

    it("subagent.completed without durationMs → duration computed from the timestamps", () => {
        const begin = started("call-1", "agent-1");
        const work = toolStart("tool-1", "agent-1");
        const end = completed("call-1", "agent-1");
        const agent = agentByCall(run([begin, work, end]), "call-1");
        assert.equal(agent.durationMs, ms(end) - ms(begin));
        assert.equal(agent.durationMs, 2000);
    });

    it("subagent.completed stamped before its started, or events without timestamps → durationMs is 0", () => {
        const end = completed("call-1", "agent-1"); // stamped first, arrives second
        assert.equal(agentByCall(run([started("call-1", "agent-1"), end]), "call-1").durationMs, 0);

        const bare = (type) => ({ type, data: { toolCallId: "call-2", ...NAMES } });
        const agent = agentByCall(run([bare("subagent.started"), bare("subagent.completed")]), "call-2");
        assert.deepEqual([agent.status, agent.durationMs, agent.startedAt, agent.endedAt], ["done", 0, "", ""]);
    });

    it("tool start without arguments → empty summary", () => {
        const state = run([ev("tool.execution_start", { toolCallId: "tool-1", toolName: "view" })]);
        assert.equal(state.snapshot().main.tools[0].summary, "");
    });

    it("arguments that are a string, null or an array → empty summary, no throw", () => {
        const state = run([
            toolStart("tool-1", null, "view", "path=README.md"),
            toolStart("tool-2", null, "view", null),
            toolStart("tool-3", null, "view", [{ path: "README.md" }]),
        ]);
        assert.deepEqual(state.snapshot().main.tools.map((tool) => tool.summary), ["", "", ""]);
    });

    it("tool completion without a matching start → ignored, no throw", () => {
        const state = createState();
        const before = state.snapshot();
        assert.equal(state.apply(toolEnd("tool-unknown")), false);
        assert.deepEqual(state.snapshot(), before);
    });

    it("tool fails without an error object → failed, empty error", () => {
        const [tool] = run([toolStart("tool-1"), toolEnd("tool-1", null, false)]).snapshot().main.tools;
        assert.deepEqual([tool.status, tool.error], ["failed", ""]);
    });

    it("event with neither agentId nor parentToolCallId → belongs to main", () => {
        const snapshot = run([started("call-1", "agent-1"), toolStart("tool-1")]).snapshot();
        assert.deepEqual(snapshot.main.tools.map((tool) => tool.id), ["tool-1"]);
        assert.equal(snapshot.agents[0].tools.length, 0);
        assert.equal(snapshot.log[0].actor, "main");
    });

    it("subagent.completed with no earlier started → a new ended agent, spawnTurn and reportedTurn are the current turn", () => {
        const end = completed("call-1", "agent-1", { durationMs: 1500 });
        const { agents } = run([prompt(), prompt(), end]).snapshot();
        assert.equal(agents.length, 1);
        assert.deepEqual([agents[0].status, agents[0].name, agents[0].type], ["done", "Explore", "explore"]);
        assert.deepEqual([agents[0].spawnTurn, agents[0].reportedTurn], [2, 2]);
        assert.deepEqual([agents[0].endedAt, agents[0].durationMs], [end.timestamp, 1500]);
    });
});

describe("malformed input", () => {
    it("subagent.started without agentDisplayName and agentDescription (required by the SDK) → name falls back to agentName, empty desc", () => {
        const state = run([ev("subagent.started", { toolCallId: "call-1", agentName: "explore" }, from("agent-1"))]);
        const agent = agentByCall(state, "call-1");
        assert.deepEqual([agent.name, agent.desc], ["explore", ""]);
    });

    it("not even agentName → name is agent- plus the id prefix", () => {
        const state = run([ev("subagent.started", { toolCallId: "call-1" }, from("1a2b3c4d-5e6f"))]);
        const agent = agentByCall(state, "call-1");
        assert.deepEqual([agent.name, agent.type, agent.status], ["agent-1a2b3c", "", "running"]);
    });

    it("event without data, or of an unknown type → returns false, no throw", () => {
        const state = run([prompt()]);
        const before = state.snapshot();
        const odd = [
            ev("tool.execution_start"),
            ev("subagent.started", null),
            ev("subagent.completed", "text"),
            ev("session.error", 42),
            ev("user.message", [{ content: "go" }]),
            ev("elicitation.requested"),
            ev("no.such.event", { toolCallId: "tool-1" }),
            ev("constructor", {}),
            ev(undefined, {}),
            ev({ toString: () => "user.message" }, {}),
            { type: "tool.execution_start" },
            {},
            [],
            null,
            undefined,
            "user.message",
            7,
        ];
        for (const event of odd) assert.equal(state.apply(event), false);
        assert.deepEqual(state.snapshot(), before);
    });

    it("handled events whose data lacks the fields they need → no throw", () => {
        const state = run([prompt()]);
        const types = [
            "user.message", "assistant.turn_start", "assistant.message", "assistant.turn_end", "assistant.intent",
            "tool.execution_start", "tool.execution_complete", "subagent.started", "subagent.completed",
            "subagent.failed", "assistant.idle", "session.idle", "abort", "session.error", "permission.completed",
            "exit_plan_mode.requested", "exit_plan_mode.completed", "user_input.requested", "user_input.completed",
            "elicitation.requested", "elicitation.completed", "system.notification",
        ];
        const odd = { toolCallId: 7, requestId: {}, toolRequests: "x", error: 5, arguments: 3, model: [] };
        for (const type of types) {
            for (const data of [{}, odd]) {
                assert.doesNotThrow(() => state.apply(ev(type, data)), type);
                assert.doesNotThrow(() => state.apply(ev(type, data, { agentId: "agent-odd" })), type);
                assert.doesNotThrow(() => state.apply(ev(type, data, { agentId: 5, timestamp: 5 })), type);
                assert.doesNotThrow(() => state.apply({ type, data }), type);
                assert.doesNotThrow(() => state.apply({ type, data, id: null }), type);
            }
        }
        assert.doesNotThrow(() => encodeSnapshot(state.snapshot()));
    });
});

describe("attribution and merging", () => {
    const AGENT = "1a2b3c4d-0000";
    // A legacy-shaped sub-agent event: no envelope agentId, only the spawning call in its data.
    const childTool = (toolCallId, parentToolCallId) =>
        ev("tool.execution_start", { toolCallId, toolName: "view", parentToolCallId });

    it("a sub-agent's tool events before its subagent.started → a placeholder first; one agent once started arrives, no tool lost", () => {
        const first = toolStart("tool-1", AGENT);
        const state = run([first, toolEnd("tool-1", AGENT), toolStart("tool-2", AGENT)]);
        const [placeholder] = state.snapshot().agents;
        assert.equal(state.snapshot().agents.length, 1);
        assert.deepEqual([placeholder.name, placeholder.status, placeholder.call], ["agent-1a2b3c", "running", ""]);

        state.apply(started("call-1", AGENT));
        const { agents, main } = state.snapshot();
        assert.equal(agents.length, 1);
        assert.deepEqual([agents[0].id, agents[0].name, agents[0].call], [placeholder.id, "Explore", "call-1"]);
        assert.equal(agents[0].startedAt, first.timestamp);
        assert.equal(agents[0].toolCount, 2);
        const tools = agents[0].tools.map((tool) => [tool.id, tool.status]);
        assert.deepEqual(tools, [["tool-1", "ok"], ["tool-2", "running"]]);
        assert.equal(main.tools.length, 0);
    });

    it("same, with activity records written before the merge → their actor is the surviving id, their name the real name", () => {
        const state = run([toolStart("tool-1", AGENT), toolStart("tool-2", AGENT)]);
        const before = state.snapshot().log;
        assert.deepEqual(before.map((entry) => entry.name), ["agent-1a2b3c", "agent-1a2b3c"]);

        state.apply(started("call-1", AGENT));
        const { agents, log } = state.snapshot();
        assert.deepEqual(
            log.map((entry) => [entry.seq, entry.actor, entry.name]),
            before.map((entry) => [entry.seq, agents[0].id, "Explore"]),
        );
    });

    it("the link comes from assistant.turn_start's parentToolCallId → merged the same way", () => {
        const state = run([
            started("call-1"), // no envelope agentId: known by its spawn call only
            childTool("tool-1", "call-1"),
            toolStart("tool-2", AGENT),
            childTool("tool-3", "call-1"),
            toolStart("tool-4", AGENT),
        ]);
        const before = state.snapshot();
        const names = before.agents.map((agent) => [agent.id, agent.name]);
        assert.deepEqual(names, [["a1", "Explore"], ["a2", "agent-1a2b3c"]]);

        assert.equal(state.apply(turnStart({ parentToolCallId: "call-1" }, AGENT)), true);
        const { agents, log, main } = state.snapshot();
        assert.equal(agents.length, 1);
        // The one created first survives.
        assert.deepEqual([agents[0].id, agents[0].name, agents[0].call], ["a1", "Explore", "call-1"]);
        assert.equal(agents[0].startedAt, before.agents[0].startedAt);
        assert.equal(agents[0].toolCount, 4);
        // Tools are merged by start time.
        assert.deepEqual(agents[0].tools.map((tool) => tool.id), ["tool-1", "tool-2", "tool-3", "tool-4"]);
        assert.deepEqual(log.map((entry) => [entry.actor, entry.name]), Array(4).fill(["a1", "Explore"]));
        assert.equal(main.status, "idle"); // a sub-agent's turn_start says nothing about main

        // Both aliases and the tool index now lead to the survivor.
        state.apply(toolEnd("tool-2", AGENT));
        state.apply(toolStart("tool-5", AGENT));
        const [merged] = state.snapshot().agents;
        assert.equal(state.snapshot().agents.length, 1);
        assert.equal(merged.tools.find((tool) => tool.id === "tool-2").status, "ok");
        assert.equal(merged.toolCount, 5);
    });

    it("tool events of two sub-agents and of main arrive interleaved → each tool lands on its owner", () => {
        const state = run([
            started("call-a", "agent-a"),
            started("call-b", "agent-b"),
            toolStart("tool-a1", "agent-a"),
            toolStart("tool-m1"),
            toolStart("tool-b1", "agent-b"),
            toolEnd("tool-a1", "agent-a"),
            toolStart("tool-a2", "agent-a"),
            toolFail("tool-b1", "agent-b", "nope"),
            toolStart("tool-m2"),
            toolEnd("tool-m1"),
        ]);
        const tools = (owner) => owner.tools.map((tool) => [tool.id, tool.status]);
        const { main, log } = state.snapshot();
        assert.deepEqual(tools(main), [["tool-m1", "ok"], ["tool-m2", "running"]]);
        assert.deepEqual(tools(agentByCall(state, "call-a")), [["tool-a1", "ok"], ["tool-a2", "running"]]);
        assert.deepEqual(tools(agentByCall(state, "call-b")), [["tool-b1", "failed"]]);
        assert.deepEqual(log.map((entry) => entry.actor), ["a1", "main", "a2", "a1", "main"]);
    });

    it("after a merge, the absorbed agent used to be someone's parent → the child's parent points to the surviving id", () => {
        const state = run([
            started("call-1"),
            spawn("call-child", AGENT), // placeholder a2 spawns a child
            started("call-child", "agent-child"),
        ]);
        assert.equal(agentByCall(state, "call-child").parent, "a2");

        state.apply(spawn("call-later", AGENT));
        state.apply(turnStart({ parentToolCallId: "call-1" }, AGENT));
        const child = agentByCall(state, "call-child");
        assert.deepEqual(state.snapshot().agents.map((agent) => agent.id).sort(), ["a1", "a3"]);
        assert.deepEqual([child.parent, child.depth], ["a1", 1]);

        // A call the absorbed agent made before the merge belongs to the survivor as well.
        state.apply(started("call-later", "agent-later"));
        assert.deepEqual([agentByCall(state, "call-later").parent, agentByCall(state, "call-later").depth], ["a1", 1]);
    });

    it("merging a running placeholder with an agent that already ended → the result is ended", () => {
        const end = completed("call-1");
        const state = run([end, toolStart("tool-1", AGENT), turnStart({ parentToolCallId: "call-1" }, AGENT)]);
        const { agents } = state.snapshot();
        assert.equal(agents.length, 1);
        assert.deepEqual([agents[0].status, agents[0].endedAt, agents[0].toolCount], ["done", end.timestamp, 1]);
    });

    it("the placeholder is the older record → its id survives, with the other's real name, earlier start and ended state", () => {
        // Stamped first, arrives second.
        const end = completed("call-1", null, { durationMs: 900, model: "gemini-4-neon" });
        const state = run([toolStart("tool-1", AGENT), end]);
        const before = state.snapshot().agents.map((agent) => [agent.id, agent.name, agent.status]);
        assert.deepEqual(before, [["a1", "agent-1a2b3c", "running"], ["a2", "Explore", "done"]]);

        state.apply(turnStart({ parentToolCallId: "call-1" }, AGENT));
        const { agents, log } = state.snapshot();
        assert.equal(agents.length, 1);
        assert.deepEqual([agents[0].id, agents[0].name, agents[0].status], ["a1", "Explore", "done"]);
        assert.deepEqual([agents[0].call, agents[0].type, agents[0].model], ["call-1", "explore", "gemini-4-neon"]);
        assert.deepEqual([agents[0].startedAt, agents[0].endedAt], [end.timestamp, end.timestamp]);
        assert.equal(agents[0].durationMs, 900);
        assert.deepEqual(
            log.map((entry) => [entry.kind, entry.actor, entry.name]),
            [["tool", "a1", "Explore"], ["agent", "a1", "Explore"]],
        );
    });

    it("subagent.started stamped earlier than the placeholder's first event → startedAt is the earlier of the two", () => {
        const begin = started("call-1", AGENT); // stamped first, arrives second
        const state = run([toolStart("tool-1", AGENT), begin]);
        assert.equal(agentByCall(state, "call-1").startedAt, begin.timestamp);
    });

    it("a merged agent keeps its parent, whichever of the two records had it", () => {
        for (const childFirst of [true, false]) {
            const child = started("call-1"); // known by its spawn call, which agent-p made
            const placeholder = toolStart("tool-1", AGENT);
            const state = run([
                started("call-p", "agent-p"),
                spawn("call-1", "agent-p"),
                ...(childFirst ? [child, placeholder] : [placeholder, child]),
                turnStart({ parentToolCallId: "call-1" }, AGENT),
            ]);
            const agent = agentByCall(state, "call-1");
            assert.equal(state.snapshot().agents.length, 2);
            assert.deepEqual([agent.id, agent.parent, agent.depth], ["a2", "a1", 1]);
        }
    });

    it("a placeholder known only by its spawn call is renamed once its agentId is learned", () => {
        const state = run([childTool("tool-1", "call-1")]);
        assert.equal(state.snapshot().agents[0].name, "agent-a1");
        state.apply(turnStart({ parentToolCallId: "call-1" }, AGENT));
        const { agents, log } = state.snapshot();
        assert.deepEqual([agents[0].name, log[0].name], ["agent-1a2b3c", "agent-1a2b3c"]);
    });

    it("an agent that shows up under a second spawn call keeps the first as its call; both lead to it", () => {
        const second = turnStart({ parentToolCallId: "call-2" }, AGENT);
        const { agents } = run([started("call-1", AGENT), second, childTool("tool-1", "call-2")]).snapshot();
        assert.deepEqual(agents.map((agent) => [agent.call, agent.toolCount]), [["call-1", 1]]);
    });

    it("a merge that brings more tools than the cap → the earliest finished ones go, toolCount is the sum", () => {
        const state = run([
            started("call-1"),
            toolStart("tool-slow", AGENT, "bash", { command: "sleep 600" }), // stays running
            ...range(14).flatMap((i) => [toolStart(`p-${i}`, AGENT), toolEnd(`p-${i}`, AGENT)]),
            ...range(15).map((i) => childTool(`c-${i}`, "call-1")),
            turnStart({ parentToolCallId: "call-1" }, AGENT),
        ]);
        const [agent] = state.snapshot().agents;
        assert.deepEqual([state.snapshot().agents.length, agent.toolCount, agent.tools.length], [1, 30, 20]);
        const kept = ["tool-slow", ...range(4).map((i) => `p-${i + 10}`), ...range(15).map((i) => `c-${i}`)];
        assert.deepEqual(agent.tools.map((tool) => tool.id), kept);
        assert.equal(state.apply(toolEnd("p-1", AGENT)), false); // a trimmed call is forgotten
    });

    it("the absorbed record had a running call that left its tool list → the surviving agent's end cancels it too", () => {
        const state = run([
            started("call-1"),
            ...range(4).map((i) => toolStart(`tool-${i}`, AGENT)), // the placeholder's: tool-1 leaves its list
            turnStart({ parentToolCallId: "call-1" }, AGENT),
        ], { maxTools: 3 });
        assert.deepEqual(state.snapshot().agents.map((agent) => agent.id), ["a1"]);

        state.apply(completed("call-1", AGENT, { cancelled: true }));
        const records = state.snapshot().log.filter((entry) => entry.kind === "tool");
        assert.deepEqual(
            records.map((entry) => [entry.id, entry.actor, entry.status]),
            range(4).map((i) => [`tool-${i}`, "a1", "cancelled"]),
        );
    });

    it("name and desc come from the spawn tool call's arguments first, then agentDisplayName, then agentName", () => {
        const named = { name: "explore-auth", description: "Trace how joinSession wires hooks", prompt: "p" };
        const state = run([
            spawn("call-1", null, named),
            started("call-1", "agent-1"),
            spawn("call-2", null, { prompt: "no name here" }),
            started("call-2", "agent-2"),
            started("call-3", "agent-3"), // the spawn call's start arrives late
            spawn("call-3", null, { name: "late-name", description: "Late description" }),
            toolStart("call-4", null, "not_the_spawn_tool", { name: "ignored", description: "Ignored" }),
            started("call-4", "agent-4"),
        ]);
        const names = (call) => [agentByCall(state, call).name, agentByCall(state, call).desc];
        assert.deepEqual(names("call-1"), ["explore-auth", "Trace how joinSession wires hooks"]);
        assert.deepEqual(names("call-2"), ["Explore", "Looks around"]);
        assert.deepEqual(names("call-3"), ["late-name", "Late description"]);
        assert.deepEqual(names("call-4"), ["Explore", "Looks around"]);
    });
});

describe("parent and child", () => {
    const family = (state, ...list) => list.map((call) => agentByCall(state, call));

    it("sub-agent A calls the spawn tool, then subagent.started carries that toolCallId → the new agent's parent is A, depth 1", () => {
        const state = run([
            spawn("call-a"), started("call-a", "agent-a"),
            spawn("call-b", "agent-a"), started("call-b", "agent-b"),
        ]);
        const [a, b] = family(state, "call-a", "call-b");
        assert.deepEqual([a.parent, a.depth], ["", 0]);
        assert.deepEqual([b.parent, b.depth], [a.id, 1]);
    });

    it("grandchild: A spawns B, B spawns C → depth 0, 1, 2", () => {
        const state = run([
            spawn("call-a"), started("call-a", "agent-a"),
            spawn("call-b", "agent-a"), started("call-b", "agent-b"),
            spawn("call-c", "agent-b"), started("call-c", "agent-c"),
        ]);
        const [a, b, c] = family(state, "call-a", "call-b", "call-c");
        assert.deepEqual([a.depth, b.depth, c.depth], [0, 1, 2]);
        assert.deepEqual([a.parent, b.parent, c.parent], ["", a.id, b.id]);
    });

    it("subagent.started first, the spawn tool call's start later → parent filled in when it arrives", () => {
        const state = run([
            started("call-a", "agent-a"),
            started("call-b", "agent-b"),
            spawn("call-c", "agent-b"), started("call-c", "agent-c"),
        ]);
        assert.deepEqual([agentByCall(state, "call-b").parent, agentByCall(state, "call-b").depth], ["", 0]);
        assert.equal(agentByCall(state, "call-c").depth, 1);

        state.apply(spawn("call-b", "agent-a"));
        const [a, b, c] = family(state, "call-a", "call-b", "call-c");
        assert.deepEqual([b.parent, b.depth], [a.id, 1]);
        assert.deepEqual([c.parent, c.depth], [b.id, 2]); // descendants move down with it
    });

    it("only data.parentId, equal to the parent's agentId → parent is the parent's internal id", () => {
        const state = run([started("call-a", "agent-a"), started("call-b", "agent-b", { parentId: "agent-a" })]);
        const [a, b] = family(state, "call-a", "call-b");
        assert.deepEqual([b.parent, b.depth], [a.id, 1]);
    });

    it("data.parentId is an unknown id and the spawn call belongs to main → parent empty, depth 0, no throw", () => {
        const state = run([spawn("call-a"), started("call-a", "agent-a", { parentId: "agent-unknown" })]);
        const [a] = family(state, "call-a");
        assert.deepEqual([a.parent, a.depth], ["", 0]);
    });

    it("the spawn call's owner wins over data.parentId", () => {
        const state = run([
            started("call-a", "agent-a"),
            started("call-x", "agent-x"),
            spawn("call-b"), // main spawned B, whatever parentId says
            started("call-b", "agent-b", { parentId: "agent-x" }),
            started("call-c", "agent-c", { parentId: "agent-x" }),
            spawn("call-c", "agent-a"), // arrives late and corrects the fallback
            started("call-d", "agent-d", { parentId: "agent-x" }),
        ]);
        const [a, b, c, x] = family(state, "call-a", "call-b", "call-c", "call-x");
        assert.equal(b.parent, "");
        assert.equal(c.parent, a.id);

        assert.deepEqual([agentByCall(state, "call-d").parent, agentByCall(state, "call-d").depth], [x.id, 1]);
        state.apply(spawn("call-d")); // main's call arrives late: no parent after all
        assert.deepEqual([agentByCall(state, "call-d").parent, agentByCall(state, "call-d").depth], ["", 0]);
    });

    it("events that would make an agent its own ancestor → that link is refused, no throw", () => {
        const state = run([
            started("call-a", "agent-a"),
            spawn("call-b", "agent-a"), started("call-b", "agent-b"),
            spawn("call-a", "agent-b"), // B claims to have spawned its own parent
            spawn("call-self", "agent-s"), started("call-self", "agent-s"), // S claims to have spawned itself
        ]);
        const [a, b, s] = family(state, "call-a", "call-b", "call-self");
        assert.deepEqual([a.parent, a.depth], ["", 0]);
        assert.deepEqual([b.parent, b.depth], [a.id, 1]);
        assert.deepEqual([s.parent, s.depth], ["", 0]);
        assert.equal(state.snapshot().agents.length, 3);
    });
});

describe("caps and ordering", () => {
    const life = (call) => [started(call, `agent-${call}`), completed(call, `agent-${call}`)];

    it("60 parallel sub-agents end one after another within one turn → all 60 in the snapshot, the first and the last to end included", () => {
        const state = run([
            prompt(),
            ...range(60).map((i) => started(`call-${i}`, `agent-${i}`)),
            ...range(60).map((i) => completed(`call-${i}`, `agent-${i}`)),
        ]);
        const { agents } = state.snapshot();
        assert.equal(agents.length, 60);
        assert.deepEqual([agents[0].call, agents[59].call], ["call-1", "call-60"]);
        assert.ok(agents.every((agent) => agent.status === "done" && agent.reportedTurn === 1));
    });

    it("60 that ended last turn plus 5 of this turn → 50 of last turn's stay, the earliest to end are gone; this turn's 5 all stay", () => {
        const state = run([
            prompt(),
            ...range(60).map((i) => started(`old-${i}`, `agent-old-${i}`)),
            ...range(60).reverse().map((i) => completed(`old-${i}`, `agent-old-${i}`)), // old-60 ends first
        ]);
        assert.equal(state.snapshot().agents.length, 60);

        for (const event of [prompt(), ...range(5).flatMap((i) => life(`new-${i}`))]) state.apply(event);
        const kept = [...range(50).reverse().map((i) => `old-${i}`), ...range(5).map((i) => `new-${i}`)];
        assert.deepEqual(calls(state), kept);
    });

    it("50 that ended earlier plus 5 running → no running one is removed", () => {
        const state = run([
            prompt(),
            ...range(5).map((i) => started(`run-${i}`, `agent-run-${i}`)),
            ...range(50).flatMap((i) => life(`old-${i}`)),
            prompt(),
        ]);
        const { agents } = state.snapshot();
        assert.equal(agents.length, 55);
        assert.deepEqual(
            agents.slice(0, 5).map((agent) => [agent.call, agent.status]),
            range(5).map((i) => [`run-${i}`, "running"]),
        );
    });

    it("more than 500 ended within one turn → the earliest to end are removed", () => {
        const list = calls(run([prompt(), ...range(501).flatMap((i) => life(`call-${i}`))]));
        assert.equal(list.length, 500);
        assert.deepEqual([list[0], list[499]], ["call-2", "call-501"]);
    });

    it("an agent with 30 tool calls → 20 kept, toolCount is 30", () => {
        const state = run([
            started("call-1", "agent-1"),
            ...range(30).flatMap((i) => [toolStart(`tool-${i}`, "agent-1"), toolEnd(`tool-${i}`, "agent-1")]),
        ]);
        const agent = agentByCall(state, "call-1");
        assert.equal(agent.toolCount, 30);
        assert.deepEqual(agent.tools.map((tool) => tool.id), range(20).map((i) => `tool-${i + 10}`));
    });

    it("over the tool cap the earliest finished call goes first; a running one stays", () => {
        const state = run([
            started("call-1", "agent-1"),
            toolStart("tool-1", "agent-1", "bash", { command: "sleep 600" }),
            ...range(29).flatMap((i) => [toolStart(`tool-${i + 1}`, "agent-1"), toolEnd(`tool-${i + 1}`, "agent-1")]),
        ]);
        const agent = agentByCall(state, "call-1");
        assert.deepEqual(agent.tools.map((tool) => tool.id), ["tool-1", ...range(19).map((i) => `tool-${i + 11}`)]);
        assert.equal(agent.tools[0].status, "running");
        assert.equal(state.apply(toolEnd("tool-1", "agent-1")), true);
        assert.equal(agentByCall(state, "call-1").tools[0].status, "ok");
    });

    it("maxTools sets the tool cap", () => {
        const state = run(range(5).flatMap((i) => [toolStart(`tool-${i}`), toolEnd(`tool-${i}`)]), { maxTools: 3 });
        assert.deepEqual(state.snapshot().main.tools.map((tool) => tool.id), ["tool-3", "tool-4", "tool-5"]);
    });

    it("over the tool cap with nothing finished → the earliest call leaves the list; its completion still ends its record, once", () => {
        const state = run(range(4).map((i) => toolStart(`tool-${i}`)), { maxTools: 3 });
        assert.deepEqual(state.snapshot().main.tools.map((tool) => tool.id), ["tool-2", "tool-3", "tool-4"]);
        const before = state.snapshot();
        assert.equal(state.apply(toolEnd("tool-1")), true);
        const after = state.snapshot();
        assert.deepEqual(after.main, before.main);
        assert.deepEqual(after.log.map((entry) => [entry.id, entry.status, entry.seq]), [
            ["tool-1", "ok", 1], ["tool-2", "running", 2], ["tool-3", "running", 3], ["tool-4", "running", 4],
        ]);
        assert.equal(state.apply(toolFail("tool-1", null, "late")), false);
        assert.deepEqual(state.snapshot(), after);
    });

    it("25 calls of one agent running at once, then the 5 that left the list complete → their records turn ok or failed in place; toolCount and turnTools stay 25", () => {
        const state = run([
            prompt(),
            started("call-1", "agent-1"),
            ...range(25).map((i) => toolStart(`tool-${i}`, "agent-1")),
        ]);
        const listed = range(20).map((i) => `tool-${i + 5}`);
        assert.deepEqual(agentByCall(state, "call-1").tools.map((tool) => tool.id), listed);
        const before = state.snapshot().log;
        assert.deepEqual(before.map((entry) => [entry.id, entry.status]), range(25).map((i) => [`tool-${i}`, "running"]));

        for (const i of [1, 2, 3]) assert.equal(state.apply(toolEnd(`tool-${i}`, "agent-1")), true);
        assert.equal(state.apply(toolFail("tool-4", "agent-1", "nope")), true);
        assert.equal(state.apply(toolEnd("tool-5", "agent-1", false)), true);

        const { log, stats } = state.snapshot();
        const ended = ["ok", "ok", "ok", "failed", "failed"];
        assert.deepEqual(log.map((entry) => entry.status), [...ended, ...range(20).map(() => "running")]);
        assert.deepEqual(log.map((entry) => entry.seq), before.map((entry) => entry.seq));
        const agent = agentByCall(state, "call-1");
        assert.deepEqual([agent.toolCount, stats.turnTools], [25, 25]);
        assert.deepEqual(agent.tools.map((tool) => [tool.id, tool.status]), listed.map((id) => [id, "running"]));
    });

    it("a call that left the tool list while running, its start record pushed out of the log, fails → a failed record is appended", () => {
        const slow = toolStart("tool-slow", null, "bash", { command: "make test" });
        const state = run([prompt(), slow, ...range(200).map((i) => toolStart(`tool-${i}`))]);
        const before = state.snapshot();
        assert.ok(before.main.tools.every((tool) => tool.id !== "tool-slow"));
        assert.ok(before.log.every((entry) => entry.id !== "tool-slow"));

        const end = toolFail("tool-slow", null, "exit 2");
        assert.equal(state.apply(end), true);
        const { log, main, stats } = state.snapshot();
        assert.equal(log.length, 200);
        assert.deepEqual(log[199], {
            seq: before.log[199].seq + 1, t: end.timestamp, actor: "main", name: "main", kind: "tool", tool: "bash",
            summary: "make test", status: "failed", id: "tool-slow",
        });
        assert.deepEqual(main, before.main);
        assert.equal(stats.turnTools, 201);
    });

    it("an agent is removed while a call that left its tool list still runs → the call is forgotten with it", () => {
        const state = run([
            prompt(),
            ...life("call-x"),
            ...range(4).map((i) => toolStart(`late-${i}`, "agent-call-x")), // late calls of an agent that ended
            ...life("call-y"),
            prompt(), // both ended in an earlier turn now, and only one may stay
        ], { maxAgents: 1, maxTools: 3 });
        assert.deepEqual(calls(state), ["call-y"]);
        const before = state.snapshot();
        assert.equal(state.apply(toolEnd("late-1", "agent-call-x")), false);
        assert.deepEqual(state.snapshot(), before);
    });

    it("51 sub-agents in the snapshot → each carries at most 5 tools", () => {
        const busy = (i) => [
            started(`call-${i}`, `agent-${i}`),
            ...range(8).map((n) => toolStart(`tool-${i}-${n}`, `agent-${i}`)),
        ];
        const state = run(range(50).flatMap(busy));
        assert.ok(state.snapshot().agents.every((agent) => agent.tools.length === 8));

        for (const event of busy(51)) state.apply(event);
        const { agents } = state.snapshot();
        assert.equal(agents.length, 51);
        assert.ok(agents.every((agent) => agent.tools.length === 5 && agent.toolCount === 8));
        // Those are the latest ones.
        assert.deepEqual(agents[0].tools.map((tool) => tool.id), [4, 5, 6, 7, 8].map((n) => `tool-1-${n}`));
    });

    it("running and ended mixed → running first; ended after them, by end time ascending", () => {
        const state = run([
            started("call-a", "agent-a"),
            started("call-b", "agent-b"),
            started("call-c", "agent-c"),
            started("call-d", "agent-d"),
            completed("call-c", "agent-c"),
            failed("call-a", "agent-a"),
        ]);
        assert.deepEqual(calls(state), ["call-b", "call-d", "call-c", "call-a"]);
    });

    it("running agents go by start time, not by arrival", () => {
        const [first, second] = [started("call-first", "agent-1"), started("call-second", "agent-2")];
        assert.deepEqual(calls(run([second, first])), ["call-first", "call-second"]);
    });

    it("A and B running, C's parent is A and C started after B → snapshot order A, C, B: a child right after its parent", () => {
        const state = run([
            started("call-a", "agent-a"),
            started("call-b", "agent-b"),
            spawn("call-c", "agent-a"), started("call-c", "agent-c"),
        ]);
        assert.deepEqual(calls(state), ["call-a", "call-c", "call-b"]);

        // Deeper and wider: a grandchild follows its own parent, siblings go by start time.
        for (const event of [
            spawn("call-d", "agent-a"), started("call-d", "agent-d"),
            spawn("call-e", "agent-c"), started("call-e", "agent-e"),
        ]) state.apply(event);
        assert.deepEqual(calls(state), ["call-a", "call-c", "call-e", "call-d", "call-b"]);
    });

    it("parent A ends first, child C still running → C is a root in the running part and keeps parent A; A is in the ended part", () => {
        const state = run([
            started("call-a", "agent-a"),
            started("call-b", "agent-b"),
            spawn("call-c", "agent-a"), started("call-c", "agent-c"),
            completed("call-a", "agent-a"),
        ]);
        const { agents } = state.snapshot();
        assert.deepEqual(
            agents.map((agent) => [agent.call, agent.status]),
            [["call-b", "running"], ["call-c", "running"], ["call-a", "done"]],
        );
        assert.deepEqual([agents[1].parent, agents[1].depth], [agents[2].id, 1]);
    });

    it("after an agent is removed → the tool index and the alias indexes no longer lead to it", () => {
        const events = [
            prompt(),
            spawn("call-x", null, { name: "gone", prompt: "p" }),
            started("call-x", "agent-x"),
            toolStart("tool-x1", "agent-x", "bash", { command: "sleep 600" }),
            completed("call-x", "agent-x"),
            ...life("call-y"),
            prompt(), // both ended in an earlier turn now, and only one may stay
        ];
        const state = run(events, { maxAgents: 1 });
        assert.deepEqual(calls(state), ["call-y"]);
        const before = state.snapshot();

        // toolOwner: the removed agent's running tool is unknown now.
        assert.equal(state.apply(toolEnd("tool-x1", "agent-x")), false);
        assert.deepEqual(state.snapshot(), before);

        // byAgentId and bySpawnCall: its old aliases make new placeholders instead of leading to it.
        state.apply(toolStart("tool-x2", "agent-x"));
        const viaSpawnCall = { toolCallId: "tool-x3", toolName: "view", parentToolCallId: "call-x" };
        state.apply(ev("tool.execution_start", viaSpawnCall));
        const fresh = state.snapshot().agents.filter((agent) => agent.status === "running");
        assert.deepEqual(
            fresh.map((agent) => [agent.id, agent.toolCount, agent.name]),
            [["a3", 1, "agent-agent-"], ["a4", 1, "agent-a4"]],
        );
    });
});

describe("main agent", () => {
    const mainOf = (state) => state.snapshot().main;

    it("user submission → root assistant.idle: working → idle, since follows", () => {
        const submit = prompt();
        const state = run([submit]);
        assert.deepEqual([mainOf(state).status, mainOf(state).since], ["working", submit.timestamp]);

        const stop = idle();
        assert.equal(state.apply(stop), true);
        assert.deepEqual([mainOf(state).status, mainOf(state).since], ["idle", stop.timestamp]);
    });

    it("root assistant.idle while a sub-agent is still running → main.status idle, the sub-agent still running", () => {
        const state = run([prompt(), started("call-1", "agent-1"), idle()]);
        assert.equal(mainOf(state).status, "idle");
        assert.equal(agentByCall(state, "call-1").status, "running");
    });

    it("user submission → session.idle: working → idle", () => {
        const state = run([prompt()]);
        assert.equal(mainOf(state).status, "working");
        state.apply(sessionIdle());
        assert.equal(mainOf(state).status, "idle");
    });

    it("session.idle after assistant.idle → still idle since the first of the two", () => {
        const stop = idle();
        const state = run([prompt(), stop]);
        assert.equal(state.apply(sessionIdle()), false);
        assert.deepEqual([mainOf(state).status, mainOf(state).since], ["idle", stop.timestamp]);
    });

    it("assistant.idle carrying an agentId → main unchanged", () => {
        const state = run([prompt(), started("call-1", "agent-1")]);
        assert.equal(state.apply(idle("agent-1")), false);
        assert.equal(mainOf(state).status, "working");
    });

    it("main's assistant.turn_start carries model → written to main.model", () => {
        const state = run([prompt()]);
        assert.equal(mainOf(state).model, "");
        state.apply(turnStart({ model: "claude-fable-5.2" }));
        assert.equal(mainOf(state).model, "claude-fable-5.2");
        state.apply(turnStart());
        assert.equal(mainOf(state).model, "claude-fable-5.2");
        state.apply(turnStart({ model: "gpt-6.2-sol" }));
        assert.equal(mainOf(state).model, "gpt-6.2-sol");
    });

    it("main's turn_start carries no model (as in the real capture) → its message or its tool call supplies main.model; a sub-agent's does not", () => {
        const withModel = (event, model) => ({ ...event, data: { ...event.data, model } });
        const said = (model, agentId) => withModel(ev("assistant.message", { turnId: "0", toolRequests: [] }, from(agentId)), model);
        const state = run([prompt(), turnStart(), started("call-1", "agent-1")]);
        assert.equal(mainOf(state).model, "");

        assert.equal(state.apply(said("gpt-6-luna", "agent-1")), false);
        state.apply(withModel(toolStart("tool-a", "agent-1"), "gpt-6-luna"));
        assert.equal(mainOf(state).model, "");

        assert.equal(state.apply(said("claude-fable-5.2")), true);
        assert.equal(mainOf(state).model, "claude-fable-5.2");
        assert.equal(state.apply(said("claude-fable-5.2")), false);

        state.apply(withModel(toolStart("tool-m"), "gpt-6.2-sol"));
        assert.equal(mainOf(state).model, "gpt-6.2-sol");
    });

    it("root assistant.turn_start while working → since kept; while idle → working, since updated", () => {
        const submit = prompt();
        const state = run([submit, turnStart()]);
        assert.equal(mainOf(state).since, submit.timestamp);

        state.apply(idle());
        const resume = turnStart();
        state.apply(resume);
        assert.deepEqual([mainOf(state).status, mainOf(state).since], ["working", resume.timestamp]);
    });

    it("a root user.message that starts no turn (system notification): idle → working, turn unchanged; error stays error", () => {
        const notice = () => prompt({ source: "agent-1a2b3c", delivery: "idle" });
        const state = run([prompt(), idle()]);
        const wake = notice();
        state.apply(wake);
        assert.deepEqual([mainOf(state).status, mainOf(state).since, state.turn()], ["working", wake.timestamp, 1]);

        const error = sessionError("broken");
        state.apply(error);
        assert.equal(state.apply(notice()), false);
        assert.deepEqual([mainOf(state).status, mainOf(state).since, state.turn()], ["error", error.timestamp, 1]);
    });
});

describe("turns", () => {
    it("two user submissions → turn is 1, then 2", () => {
        const state = createState();
        assert.equal(state.turn(), 0);
        state.apply(prompt());
        assert.equal(state.turn(), 1);
        state.apply(prompt());
        assert.equal(state.turn(), 2);
    });

    it("user.message with an agentId; with source; with isAutopilotContinuation → turn unchanged, both predicates false", () => {
        const state = run([prompt()]);
        const events = [
            prompt({}, { agentId: "agent-1" }),
            prompt({ source: "skill-pdf" }),
            prompt({ isAutopilotContinuation: true }),
        ];
        for (const event of events) {
            assert.equal(isUserSubmission(event), false);
            assert.equal(startsTurn(event), false);
            state.apply(event);
            assert.equal(state.turn(), 1);
        }
    });

    it("user submission with delivery idle, queued, or without the field → startsTurn true, turn grows by 1 each", () => {
        const state = createState();
        const events = [prompt({ delivery: "idle" }), prompt({ delivery: "queued" }), prompt()];
        events.forEach((event, i) => {
            assert.equal(isUserSubmission(event), true);
            assert.equal(startsTurn(event), true);
            state.apply(event);
            assert.equal(state.turn(), i + 1);
        });
    });

    it("steering: delivery is steering while one sub-agent already ended this turn → a submission, but no new turn", () => {
        const state = run([prompt(), spawn("call-1"), started("call-1", "agent-1"), completed("call-1", "agent-1")]);
        const before = state.snapshot();
        const steer = prompt({ delivery: "steering" });
        assert.equal(isUserSubmission(steer), true);
        assert.equal(startsTurn(steer), false);

        state.apply(steer);
        const after = state.snapshot();
        assert.equal(state.turn(), 1);
        assert.deepEqual([after.turn, after.stats.turnTools], [1, 1]);
        assert.equal(after.agents[0].reportedTurn, after.turn);
        assert.deepEqual([after.main.status, after.main.since], ["working", before.main.since]);
    });

    it("user submission with checkpoint: true; user.message without data → startsTurn false, no throw; turn() unchanged", () => {
        const state = run([prompt()]);
        const replayed = prompt({}, { checkpoint: true });
        const bare = ev("user.message");
        assert.equal(isUserSubmission(replayed), true);
        assert.equal(startsTurn(replayed), false);
        assert.equal(isUserSubmission(bare), false);
        assert.equal(startsTurn(bare), false);
        assert.equal(state.apply(replayed), false);
        assert.equal(state.apply(bare), false);
        assert.equal(state.turn(), 1);
    });

    it("isUserSubmission and startsTurn on malformed input → false, no throw", () => {
        const odd = [
            undefined, null, 7, "user.message", [], {}, { data: {} }, { type: "user.message" },
            { type: "user.message", data: null }, { type: "user.message", data: "x" },
            { type: "user.message", data: [] },
        ];
        for (const event of odd) {
            assert.equal(isUserSubmission(event), false);
            assert.equal(startsTurn(event), false);
        }
    });

    it("the same user submission (same id) delivered twice → turn() grows by 1 only", () => {
        const state = createState();
        const submit = prompt();
        assert.equal(state.apply(submit), true);
        assert.equal(state.apply(submit), false);
        assert.equal(state.apply({ ...submit }), false);
        assert.equal(state.turn(), 1);
    });

    it("applying a submission that starts a turn → turn() is one more than before and equals the snapshot's turn", () => {
        const state = run([prompt(), prompt()]);
        const before = state.turn();
        state.apply(prompt());
        assert.equal(state.turn(), before + 1);
        assert.equal(state.snapshot().turn, state.turn());
    });

    it("a new turn clears main.intent and main.error", () => {
        const state = run([prompt(), intent("Auditing"), sessionError("broken")]);
        assert.deepEqual([state.snapshot().main.intent, state.snapshot().main.error], ["Auditing", "broken"]);
        state.apply(prompt());
        assert.deepEqual([state.snapshot().main.intent, state.snapshot().main.error], ["", ""]);
    });

    it("a sub-agent started in turn 1 ends in turn 1 → spawnTurn and reportedTurn are 1", () => {
        const state = run([prompt(), started("call-1", "agent-1"), completed("call-1", "agent-1")]);
        const agent = agentByCall(state, "call-1");
        assert.deepEqual([agent.spawnTurn, agent.reportedTurn], [1, 1]);
    });

    it("a background sub-agent started in turn 1, still running in turn 2 → spawnTurn 1, reportedTurn 0; it ends in turn 2 → reportedTurn 2", () => {
        const state = run([prompt(), started("call-1", "agent-1", { executionMode: "background" }), idle(), prompt()]);
        const running = agentByCall(state, "call-1");
        assert.deepEqual([running.status, running.spawnTurn, running.reportedTurn], ["running", 1, 0]);

        state.apply(completed("call-1", "agent-1"));
        const ended = agentByCall(state, "call-1");
        assert.deepEqual([ended.status, ended.spawnTurn, ended.reportedTurn], ["done", 1, 2]);
    });

    it("main calls 201 tools in one turn → stats.turnTools is 201, main.tools has 20; the next turn starts → turnTools is 0", () => {
        const state = run([prompt()]);
        for (const i of range(201)) {
            state.apply(toolStart(`tool-${i}`));
            state.apply(toolEnd(`tool-${i}`));
        }
        const snapshot = state.snapshot();
        assert.equal(snapshot.stats.turnTools, 201);
        assert.equal(snapshot.main.tools.length, 20);
        assert.equal(snapshot.main.tools[19].id, "tool-201");

        state.apply(prompt());
        assert.equal(state.snapshot().stats.turnTools, 0);
    });

    it("turnTools counts sub-agent tool calls too", () => {
        const events = [prompt(), started("call-1", "agent-1"), toolStart("tool-1", "agent-1"), toolStart("tool-2")];
        assert.equal(run(events).snapshot().stats.turnTools, 2);
    });
});

describe("waiting for the user", () => {
    const AGENT = "1a2b3c4d-0000";
    const KINDS = [["exit_plan_mode", "approval"], ["elicitation", "answer"], ["user_input", "answer"]];
    const requested = (kind, requestId, data, agentId) =>
        ev(`${kind}.requested`, { requestId, ...data }, from(agentId));
    const answered = (kind, requestId) => ev(`${kind}.completed`, { requestId });
    const askUser = (toolCallId, agentId) => toolStart(toolCallId, agentId, "ask_user", { message: "Which one?" });
    // The request ask_user makes: it names the tool call it belongs to.
    const asked = (requestId, toolCallId, agentId) => requested("elicitation", requestId, { toolCallId }, agentId);
    const plan = (requestId, agentId) => requested("exit_plan_mode", requestId, { summary: "Plan" }, agentId);
    const question = (requestId, data, agentId) =>
        requested("user_input", requestId, { question: "Which one?", ...data }, agentId);
    const waitOf = (state, call) => agentByCall(state, call).wait;
    const mainWait = (state) => state.snapshot().main.wait;
    const recordStatus = (state, id) => state.snapshot().log.find((entry) => entry.id === id).status;

    it("the three *.requested in turn, all for main, each followed by its completed → main.wait approval, answer, answer, then empty; main.status unchanged", () => {
        const state = run([prompt()]);
        const steps = [
            ["exit_plan_mode", { summary: "Plan", planContent: "1. do it", actions: ["autopilot"] }, "approval"],
            ["elicitation", { message: "Fill this in", mode: "form", requestedSchema: { type: "object" } }, "answer"],
            ["user_input", { question: "Which one?", choices: ["a", "b"], allowFreeform: true }, "answer"],
        ];
        steps.forEach(([kind, data, wait], i) => {
            assert.equal(state.apply(requested(kind, `req-${i}`, data)), true);
            assert.deepEqual([mainWait(state), state.snapshot().main.status], [wait, "working"], kind);
            assert.equal(state.apply(answered(kind, `req-${i}`)), true);
            assert.deepEqual([mainWait(state), state.snapshot().main.status], ["", "working"], kind);
        });
    });

    it("elicitation.requested whose toolCallId is a sub-agent's ask_user call → its wait is answer, its status still running; main.wait empty", () => {
        const state = run([prompt(), started("call-1", "agent-1"), askUser("tool-1", "agent-1")]);
        state.apply(asked("req-1", "tool-1"));
        const agent = agentByCall(state, "call-1");
        assert.deepEqual([agent.wait, agent.status], ["answer", "running"]);
        assert.equal(mainWait(state), "");
    });

    it("each of the three kinds: toolCallId is a sub-agent's tool call; only the envelope agentId; neither → that sub-agent, that sub-agent, main", () => {
        for (const [kind, wait] of KINDS) {
            const state = run([
                prompt(),
                started("call-a", "agent-a"),
                started("call-b", "agent-b"),
                toolStart("tool-a", "agent-a", kind, {}),
            ]);
            const waits = () => [waitOf(state, "call-a"), waitOf(state, "call-b"), mainWait(state)];

            state.apply(requested(kind, "req-1", { toolCallId: "tool-a" }));
            assert.deepEqual(waits(), [wait, "", ""], kind);
            state.apply(requested(kind, "req-2", {}, "agent-b"));
            assert.deepEqual(waits(), [wait, wait, ""], kind);
            state.apply(requested(kind, "req-3"));
            assert.deepEqual(waits(), [wait, wait, wait], kind);
        }
    });

    it("toolCallId beats the envelope agentId; a toolCallId that is no known tool call is skipped", () => {
        const state = run([started("call-a", "agent-a"), started("call-b", "agent-b"), askUser("tool-b", "agent-b")]);
        const waits = () => [waitOf(state, "call-a"), waitOf(state, "call-b"), mainWait(state)];

        state.apply(asked("req-1", "tool-b", "agent-a"));
        assert.deepEqual(waits(), ["", "answer", ""]);
        state.apply(answered("elicitation", "req-1"));

        state.apply(asked("req-2", "tool-unknown", "agent-a"));
        assert.deepEqual(waits(), ["answer", "", ""]);
        state.apply(answered("elicitation", "req-2"));

        state.apply(asked("req-3", "tool-unknown"));
        assert.deepEqual(waits(), ["", "", "answer"]);
    });

    it("permission.requested and permission.completed → ignored: no wait, the tool's record stays running", () => {
        const state = run([
            prompt(),
            started("call-1", "agent-1"),
            toolStart("tool-1", "agent-1", "bash", { command: "make test" }),
            toolStart("tool-2", null, "bash", { command: "ls" }),
        ]);
        const before = state.snapshot();
        const result = { kind: "approved" };
        const events = [
            ev("permission.requested", { requestId: "req-1", permissionRequest: { kind: "shell" } }, from("agent-1")),
            ev("permission.requested", { requestId: "req-2", toolCallId: "tool-2" }),
            ev("permission.completed", { requestId: "req-1", toolCallId: "tool-1", result }, from("agent-1")),
            ev("permission.completed", { requestId: "req-2", toolCallId: "tool-2", result }),
        ];
        for (const event of events) assert.equal(state.apply(event), false, event.type);
        assert.deepEqual(state.snapshot(), before);
    });

    it("ownerAgentId, permissionRequest.toolCallId and resolvedByHook on a request → not read", () => {
        const state = run([started("call-a", "agent-a"), started("call-b", "agent-b"), askUser("tool-a", "agent-a")]);
        const stray = { ownerAgentId: "agent-a", permissionRequest: { toolCallId: "tool-a" } };
        state.apply(requested("elicitation", "req-1", stray));
        assert.deepEqual([waitOf(state, "call-a"), mainWait(state)], ["", "answer"]);
        assert.equal(recordStatus(state, "tool-a"), "running");

        assert.equal(state.apply(question("req-2", { resolvedByHook: true }, "agent-b")), true);
        assert.equal(waitOf(state, "call-b"), "answer");
    });

    it("the request's toolCallId has a running activity record → its status becomes waiting; running again after completed; seq never changes", () => {
        const state = run([prompt(), askUser("tool-1")]);
        const record = () => state.snapshot().log.find((entry) => entry.id === "tool-1");
        const { seq } = record();
        assert.equal(record().status, "running");

        state.apply(asked("req-1", "tool-1"));
        assert.deepEqual([record().status, record().seq], ["waiting", seq]);
        assert.equal(state.snapshot().main.tools[0].status, "running"); // waiting is not a tool status

        state.apply(answered("elicitation", "req-1"));
        assert.deepEqual([record().status, record().seq], ["running", seq]);
        assert.equal(state.snapshot().log.length, 1);
    });

    it("two requests hang on the same tool call and one is answered → the record is still waiting; running only after the second one too", () => {
        const state = run([
            prompt(),
            askUser("tool-1"),
            question("req-1", { toolCallId: "tool-1" }),
            question("req-2", { toolCallId: "tool-1" }),
        ]);
        state.apply(answered("user_input", "req-1"));
        assert.equal(recordStatus(state, "tool-1"), "waiting");
        state.apply(answered("user_input", "req-2"));
        assert.equal(recordStatus(state, "tool-1"), "running");
    });

    it("the request's owner is a sub-agent that already ended → not recorded; no ended sub-agent in the snapshot carries a wait", () => {
        const state = run([
            prompt(),
            started("call-1", "agent-1"),
            completed("call-1", "agent-1"),
            askUser("tool-late", "agent-1"),
        ]);
        assert.equal(state.apply(asked("req-1", "tool-late")), false);
        assert.equal(state.apply(question("req-2", {}, "agent-1")), false);
        assert.equal(state.apply(plan("req-3", "agent-1")), false);
        assert.deepEqual(state.snapshot().agents.map((agent) => [agent.status, agent.wait]), [["done", ""]]);
        assert.equal(mainWait(state), ""); // a late request does not fall through to main either
        assert.equal(recordStatus(state, "tool-late"), "running");
    });

    it("a placeholder sub-agent holds a wait, then is merged into an agent that already ended → the wait is dropped", () => {
        const state = run([
            completed("call-1"), // known by its spawn call only
            askUser("tool-1", AGENT),
            asked("req-1", "tool-1"),
        ]);
        const view = () => state.snapshot().agents.map((agent) => [agent.id, agent.status, agent.wait]);
        assert.deepEqual(view(), [["a2", "running", "answer"], ["a1", "done", ""]]);
        assert.equal(recordStatus(state, "tool-1"), "waiting");

        state.apply(started("call-1", AGENT));
        assert.deepEqual(view(), [["a1", "done", ""]]);
        assert.equal(recordStatus(state, "tool-1"), "running");
        assert.equal(state.apply(answered("elicitation", "req-1")), false); // gone, not just hidden
    });

    it("the tool finishes before the request's completed → the record has the tool's final status; the later completed does not turn it back to running", () => {
        const state = run([prompt(), askUser("tool-1"), asked("req-1", "tool-1")]);
        assert.equal(recordStatus(state, "tool-1"), "waiting");
        state.apply(toolFail("tool-1", null, "dismissed"));
        assert.equal(recordStatus(state, "tool-1"), "failed");
        assert.equal(state.apply(answered("elicitation", "req-1")), true);
        assert.equal(recordStatus(state, "tool-1"), "failed");
        assert.equal(mainWait(state), "");
    });

    it("one owner, two requests: approval first, answer second → wait is approval; answer after the first completed; empty after the second", () => {
        const state = run([
            prompt(),
            started("call-1", "agent-1"),
            plan("req-1", "agent-1"),
            question("req-2", {}, "agent-1"),
        ]);
        assert.equal(waitOf(state, "call-1"), "approval");
        state.apply(answered("exit_plan_mode", "req-1"));
        assert.equal(waitOf(state, "call-1"), "answer");
        state.apply(answered("user_input", "req-2"));
        assert.equal(waitOf(state, "call-1"), "");
    });

    it("a completed without a matching request; the same requestId requested twice → both ignored, no throw", () => {
        const state = run([prompt()]);
        assert.equal(state.apply(answered("exit_plan_mode", "req-unknown")), false);
        assert.equal(state.apply(answered("user_input", "req-unknown")), false);

        assert.equal(state.apply(plan("req-1")), true);
        assert.equal(state.apply(question("req-1", {}, "agent-1")), false);
        assert.equal(mainWait(state), "approval");
        assert.equal(state.snapshot().agents.length, 0);
        state.apply(answered("exit_plan_mode", "req-1"));
        assert.equal(mainWait(state), "");
    });

    it("a sub-agent receives subagent.completed while waiting → wait empty", () => {
        const state = run([prompt(), started("call-1", "agent-1"), askUser("tool-1", "agent-1")]);
        state.apply(asked("req-1", "tool-1"));
        assert.equal(waitOf(state, "call-1"), "answer");
        state.apply(completed("call-1", "agent-1"));
        assert.deepEqual([agentByCall(state, "call-1").status, waitOf(state, "call-1")], ["done", ""]);
        assert.equal(recordStatus(state, "tool-1"), "cancelled"); // the call itself never finished
        assert.equal(state.apply(answered("elicitation", "req-1")), false);
    });

    it("main is waiting and: a new turn starts; root assistant.idle; session.idle; root abort → main.wait cleared in all four", () => {
        for (const clear of [prompt, idle, sessionIdle, abort]) {
            const state = run([
                prompt(),
                started("call-1", "agent-1"),
                askUser("tool-1"),
                asked("req-1", "tool-1"),
                plan("req-2"),
                question("req-3", {}, "agent-1"),
            ]);
            assert.equal(mainWait(state), "answer");
            const event = clear();
            assert.equal(state.apply(event), true, event.type);
            assert.equal(mainWait(state), "", event.type);
            // Only the abort ends the call that was waiting.
            assert.equal(recordStatus(state, "tool-1"), clear === abort ? "cancelled" : "running", event.type);
            assert.equal(waitOf(state, "call-1"), "answer", event.type); // a sub-agent's wait is its own
        }
    });

    it("an idle main that only loses a wait → apply reports the change", () => {
        const state = run([prompt(), idle(), question("req-1")]);
        assert.equal(mainWait(state), "answer");
        assert.equal(state.apply(sessionIdle()), true);
        assert.equal(mainWait(state), "");
    });

    it("a placeholder sub-agent holds a wait, then is merged → the wait is on the surviving agent", () => {
        const state = run([
            started("call-1"), // known by its spawn call only
            askUser("tool-1", AGENT),
            asked("req-1", "tool-1"),
        ]);
        const view = () => state.snapshot().agents.map((agent) => [agent.id, agent.status, agent.wait]);
        assert.deepEqual(view(), [["a1", "running", ""], ["a2", "running", "answer"]]);

        state.apply(turnStart({ parentToolCallId: "call-1" }, AGENT));
        assert.deepEqual(view(), [["a1", "running", "answer"]]);
        assert.equal(recordStatus(state, "tool-1"), "waiting");
        state.apply(answered("elicitation", "req-1"));
        assert.deepEqual(view(), [["a1", "running", ""]]);
    });

    // A line of the sample that carries "expect" says what the snapshot shows once that event is
    // applied: under wait, the wait of main and of sub-agents by name; under log, the status of tool
    // records by toolCallId.
    it("replay waiting.jsonl → the wait at every step matches the sample's annotation", () => {
        const state = createState();
        const checked = [];
        for (const { expect, ...event } of sample("waiting.jsonl")) {
            const before = state.snapshot();
            const changed = state.apply(event);
            const { main, agents, log } = state.snapshot();
            if (event.type === "permission.completed") {
                assert.equal(changed, false, event.id);
                assert.deepEqual(state.snapshot(), before, event.id);
            }
            if (!expect) continue;
            const waits = new Map([["main", main.wait], ...agents.map((agent) => [agent.name, agent.wait])]);
            const records = new Map(log.filter(({ kind }) => kind === "tool").map(({ id, status }) => [id, status]));
            const shown = (keys, values) => Object.fromEntries(Object.keys(keys).map((key) => [key, values.get(key)]));
            const actual = { wait: shown(expect.wait, waits), log: shown(expect.log, records) };
            assert.deepEqual(actual, expect, `after ${event.type} ${event.id}`);
            checked.push(event.type);
        }
        const kinds = [
            "exit_plan_mode.requested", "exit_plan_mode.completed", "elicitation.requested", "elicitation.completed",
            "permission.completed", "abort",
        ];
        for (const type of kinds) assert.ok(checked.includes(type), `no annotated ${type}`);
        assert.equal(checked.length, 19);

        // The sample keeps no question, plan or file content: a summary is what the kept arguments give.
        const summaries = new Map(state.snapshot().log.map((entry) => [entry.tool, entry.summary]));
        assert.deepEqual(
            ["ask_user", "exit_plan_mode", "task", "edit"].map((tool) => summaries.get(tool)),
            ["", "", "Run python print command", "/tmp/lab/work/a.txt"],
        );
    });

    it("a sentinel string in the request bodies (question, plan, form) → not found in the encoded snapshot", () => {
        const SENTINEL = "ZX-SENTINEL-93417";
        const planBody = {
            summary: SENTINEL, planContent: `# Plan\n${SENTINEL}`, actions: [SENTINEL], recommendedAction: SENTINEL,
        };
        const form = {
            message: SENTINEL, elicitationSource: SENTINEL, url: `https://x.test/${SENTINEL}`,
            requestedSchema: { title: SENTINEL },
        };
        const state = run([
            prompt({ content: `prompt ${SENTINEL}` }),
            started("call-1", "agent-1"),
            toolStart("tool-1", "agent-1", "bash", { command: "make test" }),
            requested("exit_plan_mode", "req-1", planBody),
            requested("user_input", "req-2", { question: SENTINEL, choices: [SENTINEL] }, "agent-1"),
            requested("elicitation", "req-3", form),
        ]);
        const snapshot = state.snapshot();
        assert.deepEqual([snapshot.main.wait, snapshot.agents[0].wait], ["approval", "answer"]);
        assert.ok(!encodeSnapshot(snapshot).includes(SENTINEL));
        // The command a tool was started with is its summary; that is not a leak.
        assert.equal(snapshot.agents[0].tools[0].summary, "make test");

        const body = { field: SENTINEL };
        const reply = { answer: SENTINEL, feedback: SENTINEL, content: body, selectedAction: SENTINEL };
        ["exit_plan_mode", "user_input", "elicitation"].forEach((kind, i) => {
            assert.equal(state.apply(ev(`${kind}.completed`, { requestId: `req-${i + 1}`, ...reply })), true);
        });
        assert.ok(!encodeSnapshot(state.snapshot()).includes(SENTINEL));
    });
});

describe("model", () => {
    const modelOf = (events, call = "call-1") => agentByCall(run(events), call).model;

    it("subagent.started carries model → agents[].model is that", () => {
        assert.equal(modelOf([started("call-1", "agent-1", { model: "gemini-4-neon" })]), "gemini-4-neon");
    });

    it("started has no model, subagent.completed carries one → filled in at the end", () => {
        const state = run([started("call-1", "agent-1")]);
        assert.equal(agentByCall(state, "call-1").model, "");
        state.apply(completed("call-1", "agent-1", { model: "gemini-4-neon" }));
        assert.equal(agentByCall(state, "call-1").model, "gemini-4-neon");

        const viaFailed = [started("call-1", "agent-1"), failed("call-1", "agent-1", "boom", { model: "gpt-6.2-sol" })];
        assert.equal(modelOf(viaFailed), "gpt-6.2-sol");
    });

    it("subagent.completed arrives first with model A, the late started carries model B → still A, status still done", () => {
        const [a, b] = [{ model: "model-a" }, { model: "model-b" }];
        const agent = agentByCall(run([completed("call-1", "agent-1", a), started("call-1", "agent-1", b)]), "call-1");
        assert.deepEqual([agent.model, agent.status], ["model-a", "done"]);

        assert.equal(modelOf([started("call-1", "agent-1", a), completed("call-1", "agent-1", b)]), "model-a");
    });

    it("no model anywhere; a 300-character model name → empty string; at most 64 bytes", () => {
        assert.equal(modelOf([started("call-1", "agent-1"), completed("call-1", "agent-1")]), "");

        const [ascii, han] = ["m".repeat(300), "模".repeat(300)];
        const long = run([started("call-1", "agent-1", { model: ascii }), turnStart({ model: han })]);
        assert.equal(agentByCall(long, "call-1").model, "m".repeat(64));
        assert.equal(long.snapshot().main.model, "模".repeat(21));
    });
});

describe("leftover running agents", () => {
    const events = () => [
        prompt(),
        started("call-a", "agent-a"),
        started("call-b", "agent-b"),
        toolStart("tool-a", "agent-a", "bash", { command: "ls" }),
        ev("elicitation.requested", { requestId: "req-1", toolCallId: "tool-a" }),
        prompt(),
        idle(),
    ];

    it("cancelLeftoversOnIdle on, session.idle with two sub-agents running → both cancelled, reportedTurn is the current turn, a cancelled record each", () => {
        const state = run(events(), { cancelLeftoversOnIdle: true });
        const before = state.snapshot();
        // assistant.idle cancels nothing.
        assert.deepEqual(before.agents.map((agent) => agent.status), ["running", "running"]);

        const end = sessionIdle();
        assert.equal(state.apply(end), true);
        const { agents, log, turn } = state.snapshot();
        assert.equal(turn, 2);
        for (const agent of agents) {
            assert.deepEqual([agent.status, agent.reportedTurn, agent.wait], ["cancelled", 2, ""]);
            assert.equal(agent.endedAt, end.timestamp);
            assert.equal(agent.durationMs, ms(end) - Date.parse(agent.startedAt));
        }
        const [tool] = agentByCall(state, "call-a").tools;
        assert.deepEqual([tool.id, tool.status, tool.endedAt], ["tool-a", "cancelled", end.timestamp]);
        assert.deepEqual(
            log.slice(before.log.length).map((entry) => [entry.actor, entry.kind, entry.status, entry.t]),
            agents.map((agent) => [agent.id, "agent", "cancelled", end.timestamp]),
        );
    });

    it("a leftover cancelled at session.idle whose subagent.completed arrives after all → the event corrects that end; still one kind: agent record", () => {
        const state = run([...events(), sessionIdle()], { cancelLeftoversOnIdle: true });
        const event = completed("call-a", "agent-a", { durationMs: 9400 });
        assert.equal(state.apply(event), true);
        const agent = agentByCall(state, "call-a");
        assert.deepEqual([agent.status, agent.durationMs, agent.endedAt], ["done", 9400, event.timestamp]);
        assert.deepEqual(
            state.snapshot().log.filter((entry) => entry.kind === "agent").map((entry) => [entry.actor, entry.status]),
            [["a1", "done"], ["a2", "cancelled"]],
        );
        assert.equal(state.apply(completed("call-a", "agent-a", { cancelled: true })), false);
    });

    it("the same input with the default setting → both still running", () => {
        const { agents, log } = run([...events(), sessionIdle()]).snapshot();
        assert.deepEqual(agents.map((agent) => [agent.status, agent.reportedTurn]), [["running", 0], ["running", 0]]);
        assert.equal(agents[0].wait, "answer");
        assert.ok(log.every((entry) => entry.status !== "cancelled"));
    });
});

describe("running again", () => {
    const CALL = "call-1";
    const AGENT = "agent-1";
    const cancelled = (toolCallId, agentId) => completed(toolCallId, agentId, { cancelled: true });
    const nextTurn = () => turnStart({ parentToolCallId: CALL }, AGENT);
    const message = (toolNames) => {
        const toolRequests = toolNames.map((name, i) => ({ toolCallId: `asked-${i}`, name }));
        return ev("assistant.message", { turnId: "0", toolRequests }, from(AGENT));
    };
    const turnEnd = () => ev("assistant.turn_end", { turnId: "0", parentToolCallId: CALL }, from(AGENT));
    // One finished run with one tool call, then a new turn of the main agent.
    const firstRun = (end = completed) => [
        prompt(),
        started(CALL, AGENT),
        toolStart("tool-1", AGENT),
        toolEnd("tool-1", AGENT),
        message([]),
        end(CALL, AGENT),
        prompt(),
    ];
    const view = (state) => agentByCall(state, CALL);

    it("a finished sub-agent receives its own assistant.turn_start → running again: startedAt is that event's; endedAt, durationMs and error cleared; reportedTurn 0; toolCount and spawnTurn kept", () => {
        for (const end of [completed, failed, cancelled]) {
            const state = run(firstRun(end));
            const before = view(state);
            // Without an envelope agentId it is not the agent's own.
            assert.equal(state.apply(turnStart({ parentToolCallId: CALL })), false);
            assert.deepEqual(view(state), before);

            const again = nextTurn();
            assert.equal(state.apply(again), true);
            const agent = view(state);
            assert.deepEqual(
                [agent.status, agent.startedAt, agent.endedAt, agent.durationMs, agent.error, agent.reportedTurn],
                ["running", again.timestamp, "", 0, "", 0],
            );
            assert.deepEqual([agent.id, agent.toolCount, agent.spawnTurn], [before.id, 1, 1]);
            assert.deepEqual(agent.tools, before.tools);
            assert.equal(state.snapshot().agents.length, 1);
        }
    });

    it("its turn ends after a message that asked for tools → still running; after one that asked for none → done: this run's duration, reportedTurn the current turn, one more kind: agent record", () => {
        const state = run(firstRun());
        const again = nextTurn();
        state.apply(again);
        const work = [message(["bash"]), toolStart("tool-2", AGENT), toolEnd("tool-2", AGENT)];
        for (const event of work) state.apply(event);
        assert.equal(state.apply(turnEnd()), false);
        assert.equal(state.apply(nextTurn()), false);
        state.apply(message([]));
        assert.equal(view(state).status, "running"); // the message alone ends nothing

        const end = turnEnd();
        assert.equal(state.apply(end), true);
        const agent = view(state);
        assert.deepEqual(
            [agent.status, agent.startedAt, agent.endedAt, agent.durationMs, agent.reportedTurn, agent.toolCount],
            ["done", again.timestamp, end.timestamp, 7000, 2, 2],
        );
        const records = state.snapshot().log.filter((entry) => entry.kind === "agent");
        assert.deepEqual(records.map((entry) => [entry.status, entry.summary]), [
            ["done", "0:04 · 1 tool"],
            ["done", "0:07 · 2 tools"],
        ]);
        assert.equal(records[1].t, end.timestamp);
    });

    it("a turn_end before any message of this run → does not end it", () => {
        const state = run([...firstRun(), nextTurn()]);
        assert.equal(state.apply(turnEnd()), false);
        assert.equal(view(state).status, "running");
    });

    it("assistant.message → apply returns false, whoever it is from; an unknown agentId gets no placeholder", () => {
        const state = run([...firstRun(), nextTurn()]);
        const before = state.snapshot();
        for (const extra of [undefined, from(AGENT), from("agent-unknown")]) {
            for (const toolRequests of [[], [{ toolCallId: "asked-0", name: "view" }], undefined]) {
                assert.equal(state.apply(ev("assistant.message", { turnId: "0", toolRequests }, extra)), false);
            }
        }
        assert.deepEqual(state.snapshot(), before);
    });

    it("the first run is not ended by a turn_end, whatever its last message asked for", () => {
        const state = run([prompt(), started(CALL, AGENT), nextTurn(), message([])]);
        assert.equal(state.apply(turnEnd()), false);
        assert.equal(view(state).status, "running");
    });

    it("session.idle while a resumed sub-agent is still running → it ends: done, or cancelled when aborted is true; its running tool is cancelled; one in its first run stays running", () => {
        for (const [data, status] of [[{}, "done"], [{ aborted: true }, "cancelled"]]) {
            const state = run([...firstRun(), started("call-2", "agent-2")]);
            const again = nextTurn();
            for (const event of [again, message(["bash"]), toolStart("tool-2", AGENT)]) state.apply(event);

            const end = ev("session.idle", data);
            assert.equal(state.apply(end), true);
            const agent = view(state);
            assert.deepEqual(
                [agent.status, agent.endedAt, agent.durationMs, agent.reportedTurn],
                [status, end.timestamp, ms(end) - ms(again), 2],
            );
            const tools = agent.tools.map((tool) => [tool.id, tool.status]);
            assert.deepEqual(tools, [["tool-1", "ok"], ["tool-2", "cancelled"]]);
            assert.equal(agentByCall(state, "call-2").status, "running");
            const last = state.snapshot().log.at(-1);
            assert.deepEqual([last.kind, last.actor, last.status], ["agent", agent.id, status]);
        }
    });

    it("subagent.completed or subagent.failed during a re-run → handled as for any running agent; a turn_end after it changes nothing", () => {
        for (const [end, status] of [[completed, "done"], [failed, "failed"], [cancelled, "cancelled"]]) {
            const state = run([...firstRun(), nextTurn()]);
            const event = end(CALL, AGENT);
            assert.equal(state.apply(event), true);
            const agent = view(state);
            assert.deepEqual([agent.status, agent.endedAt, agent.reportedTurn], [status, event.timestamp, 2]);

            const before = state.snapshot();
            state.apply(message([]));
            assert.equal(state.apply(turnEnd()), false);
            assert.equal(state.apply(sessionIdle()), true); // main goes idle; the agent is not ended twice
            assert.deepEqual(state.snapshot().agents, before.agents);
            assert.deepEqual(state.snapshot().log, before.log);
        }
    });

    it("a sub-agent first seen through its own assistant.turn_start, no subagent.started → its turn_end after a message that asked for no tool ends it: done, reportedTurn the current turn, one kind: agent record", () => {
        const events = [prompt(), nextTurn(), message(["view"]), toolStart("tool-1", AGENT), toolEnd("tool-1", AGENT)];
        const [, begin] = events;
        const state = run(events);
        assert.equal(state.apply(turnEnd()), false);
        state.apply(nextTurn());
        state.apply(message([]));
        assert.equal(view(state).status, "running");

        const end = turnEnd();
        assert.equal(state.apply(end), true);
        const { agents, log } = state.snapshot();
        assert.equal(agents.length, 1);
        assert.deepEqual(
            [agents[0].status, agents[0].reportedTurn, agents[0].startedAt, agents[0].endedAt, agents[0].durationMs],
            ["done", 1, begin.timestamp, end.timestamp, 7000],
        );
        assert.deepEqual(agents[0].tools.map((tool) => [tool.id, tool.status]), [["tool-1", "ok"]]);
        const records = log.filter((entry) => entry.kind === "agent");
        assert.deepEqual(
            records.map((entry) => [entry.actor, entry.status, entry.summary, entry.t]),
            [[agents[0].id, "done", "0:07 · 1 tool", end.timestamp]],
        );
    });

    it("a sub-agent first seen through a tool.execution_start, with no turn_end that ends it → session.idle ends it: done, or cancelled when aborted is true; its running tool is cancelled", () => {
        for (const [data, status] of [[{}, "done"], [{ aborted: true }, "cancelled"]]) {
            const state = run([prompt(), toolStart("tool-1", AGENT, "bash", { command: "sleep 40" })]);
            assert.equal(state.apply(turnEnd()), false); // no message yet: nothing says the run is over

            const end = ev("session.idle", data);
            assert.equal(state.apply(end), true);
            const { agents, log } = state.snapshot();
            assert.equal(agents.length, 1);
            assert.deepEqual(
                [agents[0].status, agents[0].reportedTurn, agents[0].endedAt, agents[0].durationMs],
                [status, 1, end.timestamp, 2000],
            );
            const tools = agents[0].tools.map((tool) => [tool.id, tool.status, tool.endedAt]);
            assert.deepEqual(tools, [["tool-1", "cancelled", end.timestamp]]);
            const records = log.map((entry) => [entry.kind, entry.status]);
            assert.deepEqual(records, [["tool", "cancelled"], ["agent", status]]);
        }
    });

    it("a placeholder first, then its subagent.started → a first run after all: a turn_end after a message that asked for no tool does not end it, nor does session.idle; subagent.completed does", () => {
        const own = [toolStart("tool-1", AGENT), toolEnd("tool-1", AGENT)];
        const state = run([prompt(), ...own, started(CALL, AGENT), message([])]);
        assert.equal(state.apply(turnEnd()), false);
        state.apply(sessionIdle());
        assert.equal(view(state).status, "running");

        const end = completed(CALL, AGENT);
        assert.equal(state.apply(end), true);
        assert.equal(state.snapshot().agents.length, 1);
        assert.deepEqual([view(state).status, view(state).endedAt, view(state).toolCount], ["done", end.timestamp, 1]);
    });

    it("a placeholder merged with the agent its subagent.started created, whichever of the two is older → a first run: only subagent.completed ends it", () => {
        for (const placeholderFirst of [true, false]) {
            const begin = started(CALL); // no envelope agentId: known by its spawn call only
            const own = toolStart("tool-1", AGENT);
            const state = run([prompt(), ...(placeholderFirst ? [own, begin] : [begin, own])]);
            assert.equal(state.snapshot().agents.length, 2);

            state.apply(nextTurn()); // ties the two records together
            assert.equal(state.snapshot().agents.length, 1);
            state.apply(message([]));
            assert.equal(state.apply(turnEnd()), false, `placeholder first: ${placeholderFirst}`);
            state.apply(sessionIdle());
            assert.equal(view(state).status, "running", `placeholder first: ${placeholderFirst}`);

            assert.equal(state.apply(completed(CALL, AGENT)), true);
            assert.equal(view(state).status, "done");
        }
    });

    it("a placeholder known only by its spawn call, no envelope agentId → session.idle leaves it running", () => {
        const legacy = { toolCallId: "tool-1", toolName: "view", parentToolCallId: CALL };
        const state = run([prompt(), ev("tool.execution_start", legacy), sessionIdle()]);
        assert.deepEqual(state.snapshot().agents.map((agent) => [agent.call, agent.status]), [[CALL, "running"]]);
    });
});

describe("an inferred end and the subagent.* event that follows it", () => {
    const CALL = "call-1";
    const AGENT = "agent-1";
    const message = (toolNames) => {
        const toolRequests = toolNames.map((name, i) => ({ toolCallId: `asked-${i}`, name }));
        return ev("assistant.message", { turnId: "0", toolRequests }, from(AGENT));
    };
    const turnEnd = () => ev("assistant.turn_end", { turnId: "0" }, from(AGENT));
    // A sub-agent whose subagent.started was missed: first seen through its own events, one tool
    // call, and a last turn that asked for no tool. Its end is inferred from that turn's end.
    const unseenRun = () => [
        prompt(),
        turnStart({ parentToolCallId: CALL }, AGENT),
        toolStart("tool-1", AGENT),
        toolEnd("tool-1", AGENT),
        message([]),
        turnEnd(),
    ];
    const view = (state) => agentByCall(state, CALL);
    const agentRecords = (state) => state.snapshot().log.filter((entry) => entry.kind === "agent");

    it("inferred done from a turn_end, then its subagent.failed, or subagent.completed with cancelled: true → that end is corrected: status, error, reported duration, endedAt; blank name, type and model filled in; its one kind: agent record updated in place", () => {
        const ends = [
            [(data) => failed(CALL, AGENT, "quota exceeded\n  at line 3", data), "failed", "quota exceeded", "0:09 · quota exceeded"],
            [(data) => completed(CALL, AGENT, { cancelled: true, ...data }), "cancelled", "", "0:09 · 1 tool"],
        ];
        for (const [end, status, error, summary] of ends) {
            const state = run(unseenRun());
            const before = view(state);
            const [inferred] = agentRecords(state);
            assert.deepEqual([before.status, before.name, before.model], ["done", "agent-agent-", ""]);
            assert.deepEqual([inferred.status, inferred.summary], ["done", "0:04 · 1 tool"]);

            const event = end({ durationMs: 9400, model: "gpt-6-luna" });
            assert.equal(state.apply(event), true);
            const agent = view(state);
            assert.deepEqual(
                [agent.status, agent.error, agent.durationMs, agent.endedAt, agent.reportedTurn],
                [status, error, 9400, event.timestamp, 1],
            );
            assert.deepEqual([agent.name, agent.type, agent.model], ["Explore", "explore", "gpt-6-luna"]);
            assert.deepEqual([agent.id, agent.startedAt, agent.toolCount], [before.id, before.startedAt, 1]);
            assert.deepEqual(agentRecords(state), [{ ...inferred, name: "Explore", status, summary }]);
            assert.ok(state.snapshot().log.every((entry) => entry.name === "Explore"));
        }
    });

    it("inferred at session.idle, then its subagent.completed in the next turn → corrected the same way; reportedTurn stays that of the inferred end; no reported duration → up to the event", () => {
        const begin = toolStart("tool-1", AGENT, "bash", { command: "sleep 40" });
        const state = run([prompt(), begin, ev("session.idle", { aborted: true }), prompt()]);
        const [before] = state.snapshot().agents;
        assert.deepEqual([before.status, before.reportedTurn], ["cancelled", 1]);

        const event = completed(CALL, AGENT);
        assert.equal(state.apply(event), true);
        const { agents, log, turn } = state.snapshot();
        assert.deepEqual([agents.length, turn], [1, 2]);
        assert.deepEqual(
            [agents[0].status, agents[0].name, agents[0].endedAt, agents[0].durationMs, agents[0].reportedTurn],
            ["done", "Explore", event.timestamp, ms(event) - ms(begin), 1],
        );
        assert.deepEqual(log.map((entry) => [entry.kind, entry.name, entry.status, entry.summary]), [
            ["tool", "Explore", "cancelled", "sleep 40"],
            ["agent", "Explore", "done", "0:04 · 1 tool"],
        ]);
    });

    it("after the correction the end is authoritative: a second subagent.completed, a subagent.failed and a later inference change nothing", () => {
        const state = run([...unseenRun(), completed(CALL, AGENT, { cancelled: true })]);
        const before = state.snapshot();
        assert.equal(before.agents[0].status, "cancelled");
        assert.equal(state.apply(completed(CALL, AGENT)), false);
        assert.equal(state.apply(failed(CALL, AGENT)), false);
        state.apply(message([]));
        assert.equal(state.apply(turnEnd()), false);
        state.apply(sessionIdle());
        assert.deepEqual(state.snapshot().agents, before.agents);
        assert.deepEqual(state.snapshot().log, before.log);
    });

    it("the record of the inferred end was pushed out of the log → the correction appends one terminal record", () => {
        const state = run([...unseenRun(), ...range(200).map((i) => toolStart(`main-${i}`))]);
        const before = state.snapshot().log;
        assert.equal(agentRecords(state).length, 0);

        const event = failed(CALL, AGENT, "boom", { durationMs: 9400 });
        assert.equal(state.apply(event), true);
        const { log } = state.snapshot();
        assert.equal(log.length, 200);
        assert.deepEqual(log[199], {
            seq: before[199].seq + 1, t: event.timestamp, actor: "a1", name: "Explore", kind: "agent", tool: "",
            summary: "0:09 · boom", status: "failed", id: "",
        });
        assert.equal(agentRecords(state).length, 1);
    });

    it("the inferred end is on the record a merge absorbs → the subagent.completed that ties the two still corrects it", () => {
        const own = [toolStart("tool-1", AGENT), toolEnd("tool-1", AGENT), message([]), turnEnd()];
        const state = run([prompt(), started(CALL), ...own]);
        assert.deepEqual(state.snapshot().agents.map((agent) => [agent.id, agent.status]), [["a1", "running"], ["a2", "done"]]);

        assert.equal(state.apply(completed(CALL, AGENT, { cancelled: true, durationMs: 9400 })), true);
        const { agents } = state.snapshot();
        assert.deepEqual(agents.map((agent) => [agent.id, agent.status, agent.durationMs]), [["a1", "cancelled", 9400]]);
        assert.deepEqual(
            agentRecords(state).map((entry) => [entry.actor, entry.status, entry.summary]),
            [["a1", "cancelled", "0:09 · 1 tool"]],
        );
    });
});

describe("tools without a completion event", () => {
    const sleep = (toolCallId, agentId) => toolStart(toolCallId, agentId, "bash", { command: "sleep 40" });
    const cancelled = (toolCallId, agentId) => completed(toolCallId, agentId, { cancelled: true });
    const toolsOf = (owner) => owner.tools.map((tool) => [tool.id, tool.status, tool.endedAt]);

    it("a sub-agent completes, fails, is cancelled while one of its tools is running → that tool is cancelled, endedAt is the end event's; its record changes in place", () => {
        for (const end of [completed, failed, cancelled]) {
            const [ok, bad] = [toolEnd("tool-ok", "agent-1"), toolFail("tool-bad", "agent-1", "nope")];
            const state = run([
                prompt(),
                started("call-1", "agent-1"),
                toolStart("tool-ok", "agent-1"), ok,
                toolStart("tool-bad", "agent-1"), bad,
                sleep("tool-run", "agent-1"),
                sleep("tool-main"),
            ]);
            const event = end("call-1", "agent-1");
            assert.equal(state.apply(event), true);
            const { agents, main, log } = state.snapshot();
            assert.deepEqual(toolsOf(agents[0]), [
                ["tool-ok", "ok", ok.timestamp],
                ["tool-bad", "failed", bad.timestamp],
                ["tool-run", "cancelled", event.timestamp],
            ]);
            assert.deepEqual(toolsOf(main), [["tool-main", "running", ""]]); // not this agent's
            assert.deepEqual(log.map((entry) => [entry.kind, entry.id, entry.status]), [
                ["tool", "tool-ok", "ok"],
                ["tool", "tool-bad", "failed"],
                ["tool", "tool-run", "cancelled"],
                ["tool", "tool-main", "running"],
                ["agent", "", agents[0].status],
            ]);
        }
    });

    it("root abort → main's running tools are cancelled, endedAt is the abort's; an abort carrying an agentId cancels nothing", () => {
        const done = toolEnd("tool-done");
        const state = run([
            prompt(),
            spawn("call-1"),
            started("call-1", "agent-1"),
            sleep("tool-1", "agent-1"),
            toolStart("tool-done"), done,
        ]);
        assert.equal(state.apply(abort("agent-1")), false);
        const untouched = [["call-1", "running", ""], ["tool-done", "ok", done.timestamp]];
        assert.deepEqual(toolsOf(state.snapshot().main), untouched);

        const stop = abort();
        assert.equal(state.apply(stop), true);
        const { main, agents, log } = state.snapshot();
        assert.deepEqual(toolsOf(main), [["call-1", "cancelled", stop.timestamp], ["tool-done", "ok", done.timestamp]]);
        // The sub-agent's tool waits for the sub-agent's own end event.
        assert.deepEqual(toolsOf(agents[0]), [["tool-1", "running", ""]]);
        assert.deepEqual(log.map((entry) => [entry.id, entry.status]), [
            ["call-1", "cancelled"], ["tool-1", "running"], ["tool-done", "ok"],
        ]);
    });

    it("root abort while main is already idle and one of its tools is still running → apply reports the change", () => {
        const state = run([prompt(), sleep("tool-1"), idle()]);
        assert.equal(state.apply(abort()), true);
        assert.equal(state.snapshot().main.tools[0].status, "cancelled");
    });

    it("a tool.execution_complete that arrives after its call was cancelled → dropped", () => {
        const state = run([
            prompt(),
            started("call-1", "agent-1"),
            sleep("tool-1", "agent-1"),
            sleep("tool-2"),
            cancelled("call-1", "agent-1"),
            abort(),
        ]);
        const before = state.snapshot();
        assert.equal(state.apply(toolEnd("tool-1", "agent-1")), false);
        assert.equal(state.apply(toolFail("tool-2", null, "killed")), false);
        assert.deepEqual(state.snapshot(), before);
    });

    it("25 calls running at once when their owner stops (a cancelled sub-agent; main at a root abort) → the 5 that left the list are cancelled as well", () => {
        for (const agentId of ["agent-1", null]) {
            const state = run([
                prompt(),
                started("call-1", "agent-1"),
                ...range(25).map((i) => sleep(`tool-${i}`, agentId)),
            ]);
            const stop = agentId ? cancelled("call-1", agentId) : abort();
            assert.equal(state.apply(stop), true);
            const { main, agents, log, stats } = state.snapshot();
            assert.deepEqual(
                log.filter((entry) => entry.kind === "tool").map((entry) => [entry.id, entry.status]),
                range(25).map((i) => [`tool-${i}`, "cancelled"]),
            );
            assert.deepEqual(
                toolsOf(agentId ? agents[0] : main),
                range(20).map((i) => [`tool-${i + 5}`, "cancelled", stop.timestamp]),
            );
            assert.equal(stats.turnTools, 25);

            const before = state.snapshot();
            assert.equal(state.apply(toolEnd("tool-1", agentId)), false);
            assert.deepEqual(state.snapshot(), before);
        }
    });

    it("the running tool's start record was pushed out of the log → a cancelled record is appended, ahead of the agent's own", () => {
        const state = run([
            prompt(),
            started("call-1", "agent-1"),
            sleep("tool-slow", "agent-1"),
            ...range(200).map((i) => toolStart(`tool-${i}`)),
        ]);
        const before = state.snapshot().log;
        assert.ok(before.every((entry) => entry.id !== "tool-slow"));

        const end = cancelled("call-1", "agent-1");
        state.apply(end);
        const { log } = state.snapshot();
        assert.equal(log.length, 200);
        assert.deepEqual(log[198], {
            seq: before[199].seq + 1, t: end.timestamp, actor: "a1", name: "Explore", kind: "tool", tool: "bash",
            summary: "sleep 40", status: "cancelled", id: "tool-slow",
        });
        assert.deepEqual([log[199].kind, log[199].status, log[199].seq], ["agent", "cancelled", before[199].seq + 2]);
    });
});

describe("activity log", () => {
    it("a tool starts, then completes → one record, status goes from running to ok, seq unchanged; failed when it fails", () => {
        const begin = toolStart("tool-1", null, "grep", { pattern: "joinSession" });
        const state = run([prompt(), begin]);
        assert.deepEqual(state.snapshot().log, [{
            seq: 1, t: begin.timestamp, actor: "main", name: "main", kind: "tool", tool: "grep",
            summary: "joinSession", status: "running", id: "tool-1",
        }]);

        state.apply(toolEnd("tool-1"));
        const [done] = state.snapshot().log;
        assert.equal(state.snapshot().log.length, 1);
        assert.deepEqual([done.seq, done.status, done.t], [1, "ok", begin.timestamp]);

        state.apply(toolStart("tool-2"));
        state.apply(toolFail("tool-2", null, "nope"));
        assert.deepEqual(state.snapshot().log.map((entry) => [entry.seq, entry.status]), [[1, "ok"], [2, "failed"]]);
    });

    it("a tool starts, 200 other records follow, then it fails → one more record at the end, failed, t is the completion time", () => {
        const slow = toolStart("tool-slow", "agent-1", "bash", { command: "make test" });
        const others = range(200).map((i) => toolStart(`tool-${i}`));
        const state = run([prompt(), started("call-1", "agent-1"), slow, ...others]);
        const before = state.snapshot().log;
        assert.equal(before.length, 200);
        assert.ok(before.every((entry) => entry.id !== "tool-slow"));

        const end = toolFail("tool-slow", "agent-1", "exit 2");
        state.apply(end);
        const { log } = state.snapshot();
        assert.equal(log.length, 200);
        assert.deepEqual(log[199], {
            seq: before[199].seq + 1, t: end.timestamp, actor: "a1", name: "Explore", kind: "tool", tool: "bash",
            summary: "make test", status: "failed", id: "tool-slow",
        });
    });

    it("a sub-agent completes, fails, is cancelled → a kind: agent record each; summary: duration · tool count, duration · first error line, duration · tool count", () => {
        const begin = [
            started("call-a", "agent-a", { agentDisplayName: "docs-outline" }),
            started("call-b", "agent-b", { agentDisplayName: "lint-check" }),
            started("call-c", "agent-c", { agentDisplayName: "long-runner" }),
            ...["a", "a", "a", "b", "b", "c"].map((id, i) => toolStart(`tool-${i}`, `agent-${id}`)),
        ];
        const ends = [
            completed("call-a", "agent-a", { durationMs: 12_000 }),
            failed("call-b", "agent-b", "lint exploded\n  at line 3", { durationMs: 8_400 }),
            completed("call-c", "agent-c", { durationMs: 3_723_000, cancelled: true }),
        ];
        const record = (i, actor, name, summary, status) =>
            ({ seq: 7 + i, t: ends[i].timestamp, actor, name, kind: "agent", tool: "", summary, status, id: "" });
        assert.deepEqual(run([...begin, ...ends]).snapshot().log.slice(6), [
            record(0, "a1", "docs-outline", "0:12 · 3 tools", "done"),
            record(1, "a2", "lint-check", "0:08 · lint exploded", "failed"),
            record(2, "a3", "long-runner", "1:02:03 · 1 tool", "cancelled"),
        ]);
    });

    it("250 tool calls → only the latest 200 are kept, seq strictly increasing", () => {
        const { log } = run([prompt(), ...range(250).map((i) => toolStart(`tool-${i}`))]).snapshot();
        assert.equal(log.length, 200);
        assert.deepEqual([log[0].id, log[199].id], ["tool-51", "tool-250"]);
        assert.deepEqual(log.map((entry) => entry.seq), range(200).map((i) => i + 50));
    });

    it("a hidden tool → no record, not counted in turnTools", (t) => {
        assert.equal(HIDDEN_TOOLS.size, 0);
        HIDDEN_TOOLS.add("report_intent");
        t.after(() => HIDDEN_TOOLS.delete("report_intent"));

        const hidden = toolStart("tool-1", null, "report_intent", { intent: "Exploring" });
        const state = run([prompt(), hidden, toolStart("tool-2")]);
        assert.deepEqual(state.snapshot().log.map((entry) => entry.id), ["tool-2"]);
        assert.equal(state.snapshot().stats.turnTools, 1);

        for (const i of range(200)) state.apply(toolStart(`filler-${i}`, "agent-1"));
        assert.equal(state.apply(toolEnd("tool-1")), true);
        const { log, stats, main } = state.snapshot();
        assert.equal(stats.turnTools, 201);
        assert.ok(log.every((entry) => entry.tool !== "report_intent"));
        assert.equal(log[199].id, "filler-200"); // its completion adds no record either
        // It is still a tool call of its owner.
        assert.deepEqual(main.tools.map((tool) => [tool.id, tool.status]), [["tool-1", "ok"], ["tool-2", "running"]]);
    });

    it("a read_agent start without data.model (the CLI's own call) → dropped entirely, its completion too; with data.model → recorded as any tool", () => {
        const args = { agent_id: "agent-1", since_turn: 0 };
        const readAgent = (toolCallId, data) =>
            ev("tool.execution_start", { toolCallId, toolName: "read_agent", arguments: args, ...data });
        const state = run([prompt(), started("call-1", "agent-1"), completed("call-1", "agent-1")]);
        const before = state.snapshot();
        assert.equal(state.apply(readAgent("f6cb407c-02c2")), false);
        assert.equal(state.apply(toolEnd("f6cb407c-02c2")), false);
        assert.deepEqual(state.snapshot(), before);

        assert.equal(state.apply(readAgent("tool-1", { model: "claude-fable-5.2" })), true);
        assert.equal(state.apply(toolEnd("tool-1")), true);
        const { main, log, stats } = state.snapshot();
        assert.deepEqual(main.tools.map((tool) => [tool.id, tool.name, tool.status]), [["tool-1", "read_agent", "ok"]]);
        assert.deepEqual(log.slice(before.log.length).map((entry) => [entry.id, entry.status]), [["tool-1", "ok"]]);
        assert.equal(stats.turnTools, 1);
        assert.equal(HIDDEN_TOOLS.size, 0);
    });

    it("assistant.intent → written to main.intent", () => {
        const state = run([prompt(), started("call-1", "agent-1")]);
        assert.equal(state.apply(intent("Auditing the extension")), true);
        assert.equal(state.snapshot().main.intent, "Auditing the extension");
        state.apply(intent("A sub-agent's own intent", "agent-1"));
        assert.equal(state.snapshot().main.intent, "Auditing the extension");
    });
});

describe("summaries and byte budgets", () => {
    const bytes = (string) => Buffer.byteLength(string, "utf8");

    it("several candidate fields at once → taken in the order of 7.4", () => {
        const order = [
            "command", "path", "file_path", "pattern", "query", "url", "description", "prompt", "message", "name",
        ];
        const args = Object.fromEntries(order.map((field) => [field, `value of ${field}`]).reverse());
        for (const field of order) {
            assert.equal(summarizeArgs("any", { arguments: args }), `value of ${field}`);
            delete args[field];
        }
        assert.equal(summarizeArgs("any", { arguments: { other: "x" } }), "");
        assert.equal(summarizeArgs("any", { arguments: { command: 5, path: ["a"], pattern: "TODO" } }), "TODO");
    });

    it("the task tool carries both description and prompt → the description is the summary", () => {
        const args = { name: "agent-a", description: "Read a.txt, search TODO", prompt: "Work in /tmp/lab/work." };
        assert.equal(summarizeArgs("task", { arguments: args }), "Read a.txt, search TODO");
        const state = run([spawn("call-1", null, args)]);
        assert.equal(state.snapshot().main.tools[0].summary, "Read a.txt, search TODO");
        assert.equal(state.snapshot().log[0].summary, "Read a.txt, search TODO");
    });

    it("a long command with newlines and runs of spaces → whitespace collapsed, cut to 120 bytes", () => {
        const command = `  cd /repo &&\n\t make   test \r\n ${"x".repeat(300)}`;
        const summary = summarizeArgs("bash", { arguments: { command } });
        assert.equal(summary, `cd /repo && make test ${"x".repeat(98)}`);
        assert.equal(bytes(summary), 120);

        // 2 + 39 × 3 = 119 bytes: one more character would not fit.
        const wide = summarizeArgs("bash", { arguments: { command: `a ${"命令".repeat(100)}` } });
        assert.equal(wide, `a ${"命令".repeat(19)}命`);
    });

    it("shellToolInfo.displayCommand is present → it is preferred", () => {
        const args = { command: "bash -lc 'make test'", description: "Run tests" };
        const data = { arguments: args, shellToolInfo: { displayCommand: "make   test", possiblePaths: [] } };
        assert.equal(summarizeArgs("bash", data), "make test");
        const noDisplay = { arguments: args, shellToolInfo: { possiblePaths: [] } };
        assert.equal(summarizeArgs("bash", noDisplay), "bash -lc 'make test'");

        const state = run([ev("tool.execution_start", { toolCallId: "tool-1", toolName: "bash", ...data })]);
        assert.equal(state.snapshot().main.tools[0].summary, "make test");
    });

    it("summarizeArgs on malformed data → empty string, no throw", () => {
        const odd = [
            undefined, null, "text", 7, [], {}, { arguments: null }, { arguments: "x" },
            { arguments: [{ command: "x" }] }, { shellToolInfo: "x" }, { shellToolInfo: { displayCommand: 5 } },
        ];
        for (const data of odd) assert.equal(summarizeArgs("bash", data), "");
    });

    it("name, desc and error of 300 Chinese characters → at most 64, 200, 200 bytes, still valid UTF-8", () => {
        const han = "名称摘要错误".repeat(50);
        const emoji = `a${"😀".repeat(300)}`; // 4-byte characters that do not line up with the limits
        for (const long of [han, emoji]) {
            const state = run([
                prompt(),
                turnStart({ model: long }),
                intent(long),
                spawn("call-1", null, { name: long, description: long }),
                started("call-1", "agent-1", { agentType: long, executionMode: long, model: long }),
                started("call-2", "agent-2", { agentName: long, agentDisplayName: long, agentDescription: long }),
                toolStart("tool-1", "agent-1", long, { command: long }),
                toolFail("tool-1", "agent-1", long),
                failed("call-1", "agent-1", long),
                sessionError(long),
            ]);
            const snapshot = state.snapshot();
            const [second, first] = snapshot.agents;
            const [tool] = first.tools;
            const record = snapshot.log.find((entry) => entry.id === "tool-1");
            const ended = snapshot.log.find((entry) => entry.kind === "agent");
            // Each of these was cut: it ends within one character of its limit.
            const limits = [
                [64, first.name, second.name, first.type, second.type, first.mode, first.model, snapshot.main.model],
                [64, tool.name, record.name, record.tool, ended.name],
                [120, tool.summary, snapshot.main.tools[0].summary, record.summary, ended.summary],
                [200, first.desc, second.desc, first.error, tool.error, snapshot.main.error, snapshot.main.intent],
            ];
            for (const [limit, ...strings] of limits) {
                for (const string of strings) {
                    assert.ok(bytes(string) <= limit && bytes(string) > limit - 4, `${limit}: ${bytes(string)} bytes`);
                    assert.ok(long.startsWith(string) || string.startsWith("0:0"), string);
                }
            }
            // Nothing else in the snapshot is longer than the largest budget, and no character was split.
            const strings = [];
            JSON.stringify(snapshot, (key, value) => (typeof value === "string" && strings.push(value), value));
            assert.ok(strings.length > 60);
            assert.ok(strings.every((string) => bytes(string) <= 200 && string.isWellFormed()));
            assert.deepEqual(JSON.parse(encodeSnapshot(snapshot)), snapshot);
        }
    });
});

describe("snapshot", () => {
    const TASK = { name: "explore-auth", description: "Trace how joinSession wires hooks", prompt: "Look" };
    const events = () => [
        prompt(),
        turnStart({ model: "claude-fable-5.2" }),
        intent("Auditing the extension"),
        spawn("toolu_01", null, TASK),
        started("toolu_01", "agent-1", { agentType: "explore", executionMode: "background", model: "gemini-4-neon" }),
        toolStart("toolu_02", "agent-1", "grep", { pattern: "joinSession" }),
    ];

    it("has exactly the fields of 7.5, without the transport fields", () => {
        const list = events();
        const [submit, , , task, begin, grep] = list.map((event) => event.timestamp);
        const snapshot = run(list).snapshot();
        const tool = (id, name, summary, startedAt) =>
            ({ id, name, summary, status: "running", startedAt, endedAt: "", error: "" });
        const record = (seq, t, actor, name, toolName, summary, id) =>
            ({ seq, t, actor, name, kind: "tool", tool: toolName, summary, status: "running", id });
        assert.deepEqual(snapshot, {
            turn: 1,
            stats: { turnTools: 2 },
            main: {
                status: "working", since: submit, intent: "Auditing the extension", error: "",
                model: "claude-fable-5.2", wait: "", tools: [tool("toolu_01", "task", TASK.description, task)],
            },
            agents: [{
                id: "a1", call: "toolu_01", spawnTurn: 1, reportedTurn: 0, name: "explore-auth", type: "explore",
                desc: "Trace how joinSession wires hooks", mode: "background", model: "gemini-4-neon", wait: "",
                status: "running", startedAt: begin, endedAt: "", durationMs: 0, error: "", depth: 0, parent: "",
                toolCount: 1, tools: [tool("toolu_02", "grep", "joinSession", grep)],
            }],
            log: [
                record(1, task, "main", "main", "task", TASK.description, "toolu_01"),
                record(2, grep, "a1", "explore-auth", "grep", "joinSession", "toolu_02"),
            ],
        });
        assert.deepEqual(Object.keys(snapshot), ["turn", "stats", "main", "agents", "log"]);
    });

    it("two snapshots of an unchanged state are deep-equal and share nothing with the state", () => {
        const state = run(events());
        const first = state.snapshot();
        const second = state.snapshot();
        const copy = structuredClone(first);
        assert.deepEqual(first, second);
        assert.notEqual(first, second);

        // Changing a snapshot changes neither the state nor another snapshot.
        first.main.tools[0].status = "tampered";
        first.main.tools.push({ id: "extra" });
        first.agents[0].tools[0].status = "tampered";
        first.agents[0].tools.push({ id: "extra" });
        first.agents.length = 0;
        first.log[0].status = "tampered";
        first.log.length = 0;
        first.stats.turnTools = 99;
        assert.deepEqual(second, copy);
        assert.deepEqual(state.snapshot(), copy);

        // An earlier snapshot does not follow the state either.
        for (const event of [toolEnd("toolu_01"), toolEnd("toolu_02", "agent-1"), completed("toolu_01", "agent-1")]) {
            assert.equal(state.apply(event), true);
        }
        assert.deepEqual(second, copy);
    });

    it("an empty state", () => {
        assert.deepEqual(createState().snapshot(), {
            turn: 0,
            stats: { turnTools: 0 },
            main: { status: "idle", since: "", intent: "", error: "", model: "", wait: "", tools: [] },
            agents: [],
            log: [],
        });
    });
});

describe("encoding", () => {
    // What the wiring sends: the transport fields plus the state's snapshot.
    function busy() {
        const state = run([prompt(), started("call-a", "agent-a"), started("call-b", "agent-b")]);
        for (const i of range(3)) {
            state.apply(toolStart(`main-${i}`));
            state.apply(toolStart(`a-${i}`, "agent-a"));
        }
        return { v: 1, seq: 7, session: "61bd9722", theme: "gta6", ...state.snapshot() };
    }

    it("encodeSnapshot of an ordinary snapshot → one line of valid JSON, no truncated", () => {
        const snapshot = busy();
        const line = encodeSnapshot(snapshot);
        assert.equal(typeof line, "string");
        assert.ok(!line.includes("\n"));
        assert.deepEqual(JSON.parse(line), snapshot);
        assert.ok(!("truncated" in JSON.parse(line)));
    });

    it("encodeSnapshot with a very small limit → every tools array has at most 1 entry, truncated is true", () => {
        const snapshot = busy();
        const line = encodeSnapshot(snapshot, 64);
        assert.ok(!line.includes("\n"));
        const decoded = JSON.parse(line);
        assert.equal(decoded.truncated, true);
        assert.deepEqual(decoded.main.tools.map((tool) => tool.id), ["main-3"]); // the latest one
        assert.deepEqual(decoded.agents.map((agent) => agent.tools.map((tool) => tool.id)), [["a-3"], []]);
        assert.deepEqual(decoded.agents.map((agent) => agent.toolCount), [3, 0]);

        // Everything but the tools is as it was, and the input is not modified.
        const withoutTools = ({ truncated, ...rest }) => ({
            ...rest,
            main: { ...rest.main, tools: [] },
            agents: rest.agents.map((agent) => ({ ...agent, tools: [] })),
        });
        assert.deepEqual(withoutTools(decoded), withoutTools(snapshot));
        assert.equal(snapshot.main.tools.length, 3);
        assert.ok(!("truncated" in snapshot));
    });

    it("the limit is in bytes, not characters", () => {
        const snapshot = { ...busy(), theme: "主题".repeat(50) }; // 100 characters, 300 bytes
        const chars = JSON.stringify(snapshot).length;
        assert.ok(!("truncated" in JSON.parse(encodeSnapshot(snapshot, chars + 200))));
        assert.equal(JSON.parse(encodeSnapshot(snapshot, chars + 199)).truncated, true);
    });
});

describe("real samples", () => {
    it("replay fleet-two-agents.jsonl → agents, final statuses and tool owners match the capture and its tasks.json", () => {
        const events = sample("fleet-two-agents.jsonl");
        const record = new URL("../testdata/fleet-two-agents.tasks.json", import.meta.url);
        const { tasks } = JSON.parse(readFileSync(record, "utf8"));
        const { agents, main, log, stats } = run(events).snapshot();
        assert.equal(main.model, "claude-fable-5.2");

        // No placeholder is left: each agent is one of the tasks, under its own name.
        const listed = tasks.filter((task) => task.type === "agent");
        assert.deepEqual(
            agents.map((agent) => [agent.call, agent.name, agent.type, agent.mode]).sort(),
            listed.map((task) => [task.toolCallId, task.displayName, task.agentType, task.executionMode]).sort(),
        );

        const ends = events.filter((event) => event.type === "subagent.completed" || event.type === "subagent.failed");
        const outcome = ({ type, data }) =>
            type === "subagent.failed" ? "failed" : data.cancelled ? "cancelled" : "done";
        assert.deepEqual(
            agents.map((agent) => [agent.call, agent.status]).sort(),
            ends.map((event) => [event.data.toolCallId, outcome(event)]).sort(),
        );
        assert.ok(agents.every((agent) => agent.toolCount >= 1 && agent.tools.length >= 1));

        const owned = agents.flatMap((agent) => agent.tools.map((tool) => ({ ...tool, owner: agent.name })));
        const missing = owned.filter((tool) => tool.summary.endsWith("missing.txt"));
        assert.deepEqual(
            missing.map((tool) => [tool.owner, tool.name, tool.status, tool.error]),
            [["agent-b", "view", "failed", "Path does not exist"]],
        );

        const theirs = events.filter((event) => event.type === "tool.execution_start" && event.agentId);
        assert.equal(theirs.length, 6);
        assert.deepEqual(owned.map((tool) => tool.id).sort(), theirs.map((event) => event.data.toolCallId).sort());
        assert.ok(theirs.every((event) => main.tools.every((tool) => tool.id !== event.data.toolCallId)));

        // The two read_agent calls the CLI issued itself are not there; a task call shows its description.
        assert.deepEqual(
            main.tools.map((tool) => [tool.name, tool.summary, tool.status]),
            [["task", "Read a.txt, search TODO", "ok"], ["task", "Read b.txt, missing.txt", "ok"]],
        );
        assert.ok(log.every((entry) => entry.tool !== "read_agent"));
        assert.equal(stats.turnTools, 8);
    });

    it("replay fleet-two-agents.jsonl from line 9 on, both subagent.started missed → the end inferred from each agent's last turn_end is corrected by its subagent.completed: real name, model, reported duration, one kind: agent record", () => {
        const events = sample("fleet-two-agents.jsonl").slice(8);
        assert.ok(events.every((event) => event.type !== "subagent.started"));
        const ends = events.filter((event) => event.type === "subagent.completed");
        assert.deepEqual(ends.map((event) => event.data.durationMs), [5027, 5148]);

        const state = createState();
        for (const event of events) {
            if (event === ends[0]) {
                // Inferred two milliseconds earlier, from the turn_end right before it.
                const [inferred] = state.snapshot().agents.filter((agent) => agent.status === "done");
                assert.deepEqual([inferred.name, inferred.model, inferred.durationMs], ["agent-67b4db", "", 4979]);
            }
            state.apply(event);
        }
        const { agents, log } = state.snapshot();
        assert.deepEqual(
            agents.map((agent) => [agent.name, agent.type, agent.model, agent.status, agent.durationMs, agent.endedAt]),
            ends.map(({ data, timestamp }) => [data.agentDisplayName, "explore", "gpt-6-luna", "done", data.durationMs, timestamp]),
        );
        assert.deepEqual(agents.map((agent) => agent.name), ["agent-a", "agent-b"]);
        assert.deepEqual(
            log.filter((entry) => entry.kind === "agent").map((entry) => [entry.name, entry.status, entry.summary]),
            [["agent-a", "done", "0:05 · 3 tools"], ["agent-b", "done", "0:05 · 3 tools"]],
        );
        assert.ok(log.every((entry) => entry.name === "agent-a" || entry.name === "agent-b"));
    });

    it("replay fleet-followup.jsonl (write_agent to an idle sub-agent) → it runs again without a subagent.started and ends on its last turn_end", () => {
        const events = sample("fleet-followup.jsonl");
        const [{ agentId }] = events.filter((event) => event.type === "subagent.started");
        const own = new Set(["assistant.turn_start", "assistant.turn_end", "subagent.completed"]);
        const state = createState();
        const steps = [];
        for (const event of events) {
            state.apply(event);
            if (event.agentId !== agentId || !own.has(event.type)) continue;
            steps.push({ event, agent: state.snapshot().agents[0] });
        }
        assert.deepEqual(
            steps.map(({ event, agent }) => [event.type, agent.status, agent.reportedTurn, agent.toolCount]),
            [
                ["assistant.turn_start", "running", 0, 0],
                ["assistant.turn_end", "running", 0, 3],
                ["assistant.turn_start", "running", 0, 3],
                ["assistant.turn_end", "running", 0, 3], // its message asked for no tool, but this is the first run
                ["subagent.completed", "done", 1, 3],
                ["assistant.turn_start", "running", 0, 3], // asked again, in the main agent's second turn
                ["assistant.turn_end", "running", 0, 4], // the turn's message asked for bash
                ["assistant.turn_start", "running", 0, 4],
                ["assistant.turn_end", "done", 2, 4],
            ],
        );

        const [resumed, ended] = [steps[5], steps[8]];
        assert.deepEqual(
            [resumed.agent.startedAt, resumed.agent.endedAt, resumed.agent.durationMs, resumed.agent.spawnTurn],
            [resumed.event.timestamp, "", 0, 1],
        );
        assert.deepEqual(
            [ended.agent.startedAt, ended.agent.endedAt, ended.agent.durationMs],
            [resumed.event.timestamp, ended.event.timestamp, 3615],
        );

        const { agents, main, log, turn } = state.snapshot();
        assert.equal(turn, 2);
        assert.deepEqual(agents.map((agent) => [agent.id, agent.name, agent.status]), [["a1", "agent-a", "done"]]);
        assert.deepEqual(
            log.filter((entry) => entry.kind === "agent").map((entry) => [entry.name, entry.status, entry.summary]),
            [["agent-a", "done", "0:05 · 3 tools"], ["agent-a", "done", "0:03 · 4 tools"]],
        );
        // read_agent is the model's own call here: it is recorded. The sample keeps no follow-up message.
        assert.deepEqual(main.tools.map((tool) => [tool.name, tool.summary, tool.status]), [
            ["task", "Read a.txt, search TODO", "ok"], ["write_agent", "", "ok"], ["read_agent", "", "ok"],
        ]);
    });

    it("replay fleet-nested.jsonl → the nested sub-agent's parent is the outer one, by its spawn call and by data.parentId alone; its permission.completed changes nothing", () => {
        const events = sample("fleet-nested.jsonl");
        const [outerStart, nestedStart] = events.filter((event) => event.type === "subagent.started");
        assert.equal(nestedStart.data.parentId, outerStart.agentId);
        const family = (state) =>
            state.snapshot().agents.map((agent) => [agent.name, agent.parent, agent.depth, agent.mode]);

        const state = createState();
        for (const event of events) {
            const before = state.snapshot();
            const changed = state.apply(event);
            if (event === nestedStart) {
                // Both are running: the child comes right after its parent.
                const running = [["outer-relay", "", 0, "background"], ["count-lines", "a1", 1, "sync"]];
                assert.deepEqual(family(state), running);
            }
            if (event.type === "permission.completed") {
                assert.equal(event.agentId, nestedStart.agentId);
                assert.equal(changed, false);
                assert.deepEqual(state.snapshot(), before);
                assert.deepEqual([before.main.wait, ...before.agents.map((agent) => agent.wait)], ["", "", ""]);
                assert.equal(before.log.find((entry) => entry.id === event.data.toolCallId).status, "running");
            }
        }
        const { agents, main } = state.snapshot();
        const tools = (owner) => owner.tools.map((tool) => [tool.name, tool.status]);
        assert.deepEqual(agents.map((agent) => [agent.name, agent.status, agent.parent, tools(agent)]), [
            ["count-lines", "done", "a1", [["view", "ok"], ["bash", "ok"]]],
            ["outer-relay", "done", "", [["task", "ok"]]],
        ]);
        assert.deepEqual(main.tools.map((tool) => [tool.name, tool.summary, tool.status]), [
            ["task", "Relay nested line count", "ok"],
        ]);

        // Without the nested task call's start event only data.parentId names the parent: the same one.
        const spawnCall = nestedStart.data.toolCallId;
        const isSpawn = (event) => event.type === "tool.execution_start" && event.data.toolCallId === spawnCall;
        const rest = events.filter((event) => !isSpawn(event));
        assert.equal(rest.length, events.length - 1);
        assert.deepEqual(family(run(rest)), [["count-lines", "a1", 1, "sync"], ["outer-relay", "", 0, "background"]]);
    });

    it("replay fleet-cancelled.jsonl (ctrl+c) → the cancelled sub-agents' running tools and main's task call cut by the abort end as cancelled; nothing is left running", () => {
        const events = sample("fleet-cancelled.jsonl");
        const ended = new Map(
            events
                .filter((event) => event.type === "subagent.completed")
                .map((event) => [event.data.agentDisplayName, event.timestamp]),
        );
        const stop = events.find((event) => event.type === "abort" && !event.agentId);
        const { main, agents, log } = run(events).snapshot();

        // None of the three bash calls, and not the task call of the sync agent, got a completion event.
        const tools = (owner) => owner.tools.map((tool) => [tool.name, tool.status, tool.endedAt]);
        assert.deepEqual(
            agents.map((agent) => [agent.name, agent.status, tools(agent)]),
            ["sleeper-3", "sleeper-4", "sleeper-sync"].map((name) => [
                name, "cancelled", [["bash", "cancelled", ended.get(name)]],
            ]),
        );
        assert.deepEqual(main.tools.map((tool) => [tool.name, tool.summary, tool.status]), [
            ["task", "Run sleep 40", "ok"],
            ["task", "Run sleep 40", "ok"],
            ["task", "Run sleep 40 sync", "cancelled"],
        ]);
        assert.equal(main.tools[2].endedAt, stop.timestamp);
        assert.equal(main.status, "idle");
        assert.deepEqual(log.map((entry) => [entry.name, entry.kind, entry.tool, entry.status]), [
            ["main", "tool", "task", "ok"],
            ["main", "tool", "task", "ok"],
            ["sleeper-3", "tool", "bash", "cancelled"],
            ["sleeper-4", "tool", "bash", "cancelled"],
            ["sleeper-3", "agent", "", "cancelled"],
            ["sleeper-4", "agent", "", "cancelled"],
            ["main", "tool", "task", "cancelled"],
            ["sleeper-sync", "tool", "bash", "cancelled"],
            ["sleeper-sync", "agent", "", "cancelled"],
        ]);
    });
});
