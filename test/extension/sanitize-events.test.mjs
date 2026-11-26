import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { describe, it } from "node:test";

import { sanitize } from "../../hack/sanitize-events.mjs";

// Stands for anything that must not reach a sample: a prompt, a question, a form, a file's content.
const SECRET = "ZX-SECRET-58213";
const ENVELOPE = { id: "ev-1", timestamp: "2026-11-25T04:52:13.093Z", parentId: "ev-0" };

const toolStart = (args) => ({
    ...ENVELOPE,
    type: "tool.execution_start",
    data: { toolCallId: "tool-1", toolName: "task", arguments: args, turnId: "0", model: "claude-fable-5.2" },
});
const argumentsOf = (args) => sanitize(toolStart(args)).data.arguments;

describe("tool arguments", () => {
    const KEPT = {
        command: "make test", path: "a.txt", file_path: "b.txt", pattern: "TODO", query: "select 1",
        url: "https://x.test/page", description: "Read a.txt", name: "agent-a", agent_type: "explore",
        mode: "background", agent_id: "agent-1",
    };

    it("only the allow-listed keys survive, in the order they came; prompt, message, form and file contents are gone", () => {
        const dropped = {
            prompt: SECRET, message: SECRET, requestedSchema: { title: SECRET, properties: { action: { title: SECRET } } },
            file_text: SECRET, old_str: SECRET, new_str: SECRET, summary: SECRET, recommendedAction: SECRET,
            paths: [SECRET], output_mode: "content", since_turn: 0, wait: true, timeout: 30,
        };
        const event = sanitize(toolStart({ prompt: SECRET, ...KEPT, ...dropped }));
        assert.deepEqual(event.data.arguments, KEPT);
        assert.deepEqual(Object.keys(event.data.arguments), Object.keys(KEPT));
        assert.ok(!JSON.stringify(event).includes(SECRET));
    });

    it("an allow-listed key whose value is an object, an array, a number, a boolean or null → dropped", () => {
        const args = {
            command: { run: SECRET }, path: [SECRET], file_path: [{ path: SECRET }], query: 7, description: true,
            name: null, url: "https://x.test/page",
        };
        assert.deepEqual(argumentsOf(args), { url: "https://x.test/page" });
    });

    it("arguments that are a string, an array or null → an empty object; an event without arguments gets none", () => {
        for (const args of [SECRET, [SECRET], [{ command: SECRET }], null]) assert.deepEqual(argumentsOf(args), {});
        assert.ok(!("arguments" in sanitize(toolStart(undefined)).data));
    });

    it("what is kept still has the home directory replaced and is cut to 200 characters", () => {
        const args = { command: `cat ${homedir()}/notes.txt`, path: `${homedir()}/${"x".repeat(300)}` };
        assert.deepEqual(argumentsOf(args), { command: "cat ~/notes.txt", path: `~/${"x".repeat(198)}` });
    });
});

describe("a second pass", () => {
    const WAIT = { requestId: "req-1", toolCallId: "tool-1", result: { kind: "approved" }, question: SECRET };
    const raw = [
        toolStart({ name: "agent-a", description: "Read a.txt", prompt: SECRET, command: `ls ${homedir()}`, path: "y".repeat(300) }),
        { ...ENVELOPE, type: "user.message", data: { content: SECRET, delivery: "idle", turnId: "0" } },
        {
            ...ENVELOPE, type: "assistant.message", agentId: "agent-1",
            data: { turnId: "0", content: SECRET, toolRequests: [{ toolCallId: "tool-1", name: "view", arguments: { path: SECRET } }] },
        },
        {
            ...ENVELOPE, type: "tool.execution_complete",
            data: { toolCallId: "tool-1", success: false, error: { message: "Path does not exist", code: "failure" }, result: { content: SECRET } },
        },
        { ...ENVELOPE, type: "permission.completed", ephemeral: true, agentId: "agent-1", data: WAIT },
        { ...ENVELOPE, type: "permission.requested", ephemeral: true, data: { ...WAIT, permissionRequest: { toolCallId: "tool-1", intention: SECRET } } },
    ];

    it("an already sanitized event comes out unchanged, key order included", () => {
        for (const event of raw) {
            const once = sanitize(event);
            assert.ok(!JSON.stringify(once).includes(SECRET), event.type);
            assert.equal(JSON.stringify(sanitize(once)), JSON.stringify(once), event.type);
        }
    });

    // The captured samples went through the sanitizer; many-agents.jsonl is generated and is not one of them.
    it("every line of the captured samples under test/testdata is already sanitized", () => {
        const samples = ["fleet-two-agents", "fleet-followup", "fleet-nested", "fleet-cancelled", "waiting"];
        for (const name of samples) {
            const lines = readFileSync(new URL(`../testdata/${name}.jsonl`, import.meta.url), "utf8").split("\n").filter(Boolean);
            lines.forEach((line, i) => {
                const { expect, ...event } = JSON.parse(line); // expect: the annotation of waiting.jsonl
                assert.deepEqual(sanitize(event), event, `${name}.jsonl line ${i + 1}`);
            });
        }
    });
});

describe("wait events", () => {
    const KINDS = ["permission", "exit_plan_mode", "user_input", "elicitation"];
    const documented = {
        requestId: "req-1", toolCallId: "tool-1", ownerAgentId: "agent-1", resolvedByHook: false,
        result: { kind: "approved" }, approved: true, selectedAction: "interactive", action: "accept",
        elicitationSource: "fp-elicit",
    };
    const body = {
        ...documented,
        result: { kind: "approved", feedback: SECRET },
        question: SECRET, choices: [SECRET], answer: SECRET, message: SECRET, requestedSchema: { title: SECRET },
        content: { field: SECRET }, summary: SECRET, planContent: SECRET, actions: [SECRET], feedback: SECRET,
        permissionRequest: { toolCallId: "tool-1", kind: "shell", fullCommandText: SECRET, intention: SECRET },
    };

    it("requested and completed of the four kinds → only the documented fields; the question, the plan, the form and the answer are gone", () => {
        for (const type of KINDS.flatMap((kind) => [`${kind}.requested`, `${kind}.completed`])) {
            const event = sanitize({ ...ENVELOPE, type, ephemeral: true, agentId: "agent-1", data: body });
            // Of a permission request, the tool call it is about is kept as well.
            const nested = type === "permission.requested" ? { permissionRequest: { toolCallId: "tool-1" } } : {};
            assert.deepEqual(event, {
                id: "ev-1", timestamp: ENVELOPE.timestamp, type, agentId: "agent-1", ephemeral: true,
                data: { ...documented, ...nested },
            }, type);
        }
    });
});

describe("event types", () => {
    it("a type the extension does not read, an event without a type, no event at all → null", () => {
        const unknown = ["session.start", "assistant.message_delta", "assistant.reasoning", "tool.execution_progress", "hook.start"];
        for (const type of unknown) assert.equal(sanitize({ ...ENVELOPE, type, data: { content: SECRET } }), null, type);
        for (const event of [{ ...ENVELOPE, data: {} }, {}, null, undefined]) assert.equal(sanitize(event), null);
    });
});
