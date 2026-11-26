// Development helper: turns the raw events captured by test/e2e/recorder into a test sample.
// Usage: node hack/sanitize-events.mjs <rec.jsonl> [--since <ISO time>] [--until <ISO time>] > sample.jsonl
// Only the event types and fields the extension reads survive; prompts, results and request bodies do not.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const MAX_STRING = 200;
const WAIT_FIELDS = [
    "requestId", "toolCallId", "ownerAgentId", "resolvedByHook",
    "result", "approved", "selectedAction", "action", "elicitationSource",
];
const WAIT_TYPES = ["permission", "exit_plan_mode", "user_input", "elicitation"].flatMap((name) => [
    `${name}.requested`,
    `${name}.completed`,
]);
const FIELDS = {
    "user.message": ["source", "isAutopilotContinuation", "delivery", "turnId", "parentAgentTaskId"],
    "assistant.turn_start": ["turnId", "parentToolCallId", "model"],
    "assistant.turn_end": ["turnId", "parentToolCallId"],
    "assistant.message": ["turnId", "toolRequests", "model"],
    "assistant.intent": ["intent"],
    "tool.execution_start": ["toolCallId", "toolName", "arguments", "toolTitle", "turnId", "model", "mcpServerName", "shellToolInfo"],
    "tool.execution_complete": ["toolCallId", "success", "error", "turnId"],
    "subagent.started": [
        "toolCallId", "agentName", "agentDisplayName", "agentDescription", "agentType", "executionMode", "model", "parentId",
    ],
    "subagent.completed": ["toolCallId", "agentName", "agentDisplayName", "durationMs", "totalToolCalls", "cancelled", "model"],
    "subagent.failed": ["toolCallId", "agentName", "agentDisplayName", "durationMs", "totalToolCalls", "cancelled", "model", "error"],
    "assistant.idle": ["aborted"],
    "session.idle": ["aborted"],
    "session.error": ["message", "errorType"],
    abort: ["reason"],
    "system.notification": ["kind"],
    ...Object.fromEntries(WAIT_TYPES.map((type) => [type, WAIT_FIELDS])),
};
const NESTED = {
    shellToolInfo: ["displayCommand"],
    error: ["message", "code"],
    kind: ["type", "agentId", "agentType", "status"],
    result: ["kind"],
};
// Of a tool's arguments only these are kept, and only as strings: what a summary can show, the
// spawn tool's agent_type and mode, the agent_id of read_agent and write_agent.
const ARGUMENTS = new Set([
    "command", "path", "file_path", "pattern", "query", "url", "description", "name", "agent_type", "mode", "agent_id",
]);

const home = homedir();

function pick(source, keys) {
    return Object.fromEntries(keys.filter((key) => source?.[key] !== undefined).map((key) => [key, source[key]]));
}

function pickArguments(args) {
    const kept = ([key, value]) => ARGUMENTS.has(key) && typeof value === "string";
    return Object.fromEntries(Object.entries(args ?? {}).filter(kept));
}

function scrub(value) {
    if (typeof value === "string") {
        const text = value.split(home).join("~");
        return text.length > MAX_STRING ? text.slice(0, MAX_STRING) : text;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
    return value;
}

export function sanitize(event) {
    const keys = FIELDS[event?.type];
    if (!keys) return null;
    const data = pick(event.data, keys);
    for (const [key, inner] of Object.entries(NESTED)) {
        if (data[key] && typeof data[key] === "object") data[key] = pick(data[key], inner);
    }
    if (data.arguments !== undefined) data.arguments = pickArguments(data.arguments);
    // of a tool request only which tool it is; the arguments are in the tool's own start event
    if (Array.isArray(data.toolRequests)) data.toolRequests = data.toolRequests.map((request) => pick(request, ["toolCallId", "name"]));
    const nested = event.data?.permissionRequest?.toolCallId;
    if (event.type === "permission.requested" && nested !== undefined) data.permissionRequest = { toolCallId: nested };
    return { ...pick(event, ["id", "timestamp", "type", "agentId", "ephemeral", "checkpoint"]), data: scrub(data) };
}

function main(argv) {
    const [file, ...rest] = argv;
    const option = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : "");
    if (!file) {
        process.stderr.write("usage: node hack/sanitize-events.mjs <rec.jsonl> [--since <ISO time>] [--until <ISO time>]\n");
        process.exit(2);
    }
    const since = option("--since");
    const until = option("--until");
    for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let record;
        try {
            record = JSON.parse(line);
        } catch {
            continue;
        }
        if (record.kind !== "event" || (since && record.t < since) || (until && record.t > until)) continue;
        const event = sanitize(record.event);
        if (event) process.stdout.write(`${JSON.stringify(event)}\n`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
