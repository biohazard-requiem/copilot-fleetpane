import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const THRESHOLDS = [2, 6, 7, 8, 12, 60];

const T0 = Date.parse("2026-11-25T10:00:00.000Z");
const STEP_MS = 250;
const PARENT_INDEX = 1; // explore-auth spawns the single nested sub-agent
const CHILD_INDEX = 4; // trace-hook-wiring

const TYPES = ["explore", "task", "general-purpose"];
const MODELS = ["gemini-4-neon", "claude-opus-5.5", "gpt-6.2-astra"];

const FAILURES = new Map([
    [3, "exit 1: golangci-lint config not found"],
    [14, "ENOENT: missing fixture schema.json"],
    [27, "timeout after 30s waiting for mock server"],
    [41, "assertion failed: expected 45 rows, got 44"],
    [55, "EACCES: permission denied reading keyfile"],
]);

export const FAILED_COUNT = FAILURES.size;

const AGENT_NAMES = [
    "api-lint",
    "explore-auth",
    "review-tests",
    "文档链接核对",
    "trace-hook-wiring",
    "verify-distributed-cache-invalidation-paths",
    "bench-run",
    "types-check",
    "deps-audit",
    "配置兼容检查",
    "schema-diff",
    "audit-cross-platform-terminal-escape-sequences",
    "doc-sync",
    "changelog-check",
    "lint-fix",
    "net-check",
    "css-scan",
    "env-diff",
    "socket-probe",
    "theme-tokens",
    "reconcile-snapshot-truncation-boundary-cases",
    "pane-resize",
    "mouse-hitmap",
    "scroll-bounds",
    "布局宽度回归测试",
    "key-bindings",
    "ansi-clip",
    "mock-server-suite",
    "utf8-budget",
    "color-blend",
    "palm-mask",
    "compact-rows",
    "grid-layout",
    "status-bar",
    "activity-log",
    "wait-badges",
    "idle-cleanup",
    "turn-counter",
    "alias-merge",
    "cycle-guard",
    "stale-sweep",
    "snapshot-rows-check",
    "override-file",
    "config-parse",
    "inspect-concurrent-socket-rotation-edge-cases",
    "split-script",
    "tty-resolve",
    "signal-exit",
    "event-dedup",
    "arg-summary",
    "model-header",
    "error-banner",
    "cancel-flow",
    "queue-order",
    "steer-guard",
    "keyfile-audit",
    "depth-walk",
    "tool-trim",
    "frame-clock",
    "final-report",
];

const TOOL_SPECS = [
    { name: "view", args: (n) => ({ path: `extension/lib/module-${n}.mjs` }) },
    { name: "grep", args: (n) => ({ pattern: `handler_${n}`, path: "extension/" }) },
    {
        name: "bash",
        args: (n) => ({ command: `go test ./internal/pkg/mod${n} -count=1` }),
        shell: (n) => ({ displayCommand: `go test ./internal/pkg/mod${n} -count=1` }),
    },
    { name: "view", args: (n) => ({ path: `internal/pkg/ui/part_${n}.go` }) },
    { name: "grep", args: (n) => ({ pattern: `RenderStep${n}`, path: "internal/" }) },
    {
        name: "bash",
        args: (n) => ({ command: `node --check extension/lib/part-${n}.mjs` }),
        shell: (n) => ({ displayCommand: `node --check extension/lib/part-${n}.mjs` }),
    },
];

function buildFinishOrder(count) {
    // Coprime step (gcd(17, 60) === 1) yields a deterministic staggered permutation.
    const order = Array.from({ length: count }, (_, k) => (k * 17 + 5) % count);
    const childPos = order.indexOf(CHILD_INDEX);
    const parentPos = order.indexOf(PARENT_INDEX);
    if (childPos > parentPos) [order[childPos], order[parentPos]] = [order[parentPos], order[childPos]];
    return order;
}

export function generate() {
    const events = [];
    const pauses = [];
    let seq = 0;
    let prevId = null;

    function emit(type, data, extra = {}) {
        seq += 1;
        const id = `ev-${String(seq).padStart(4, "0")}`;
        const timestamp = new Date(T0 + (seq - 1) * STEP_MS).toISOString();
        const event = { id, timestamp, parentId: prevId, type, data, ...extra };
        prevId = id;
        events.push(event);
        return event;
    }

    const from = (agentId) => (agentId ? { agentId } : {});
    const thresholdSet = new Set(THRESHOLDS);

    // Turn 1 root events.
    emit("user.message", {
        content: "Run a 60-agent parallel audit across the workspace.",
        delivery: "idle",
    });
    emit("assistant.turn_start", { turnId: "0", model: "claude-fable-5.2" });
    emit("assistant.intent", { intent: "Delegating 60 parallel audit tasks" });

    const agents = AGENT_NAMES.map((name, i) => {
        const num = String(i + 1).padStart(2, "0");
        return {
            index: i,
            num,
            agentId: `agent-${num}`,
            spawnCallId: `call-spawn-${num}`,
            name,
            desc: `Inspect ${name} paths and verify invariants`,
            type: TYPES[i % TYPES.length],
            mode: i % 3 === 0 ? "sync" : "background",
            model: MODELS[i % MODELS.length],
            parentAgentId: i === CHILD_INDEX ? `agent-${String(PARENT_INDEX + 1).padStart(2, "0")}` : "",
            error: FAILURES.get(i) ?? "",
            startedAtMs: 0,
            runningToolId: "",
            toolCount: 0,
        };
    });

    // Phase 1: start all 60 sub-agents one by one, leaving one tool running on each.
    for (const agent of agents) {
        const n = agent.index + 1;
        const spawner = from(agent.parentAgentId);

        emit("tool.execution_start", {
            toolCallId: agent.spawnCallId,
            toolName: "task",
            arguments: {
                name: agent.name,
                description: agent.desc,
                agent_type: agent.type,
                mode: agent.mode,
            },
        }, spawner);
        if (agent.parentAgentId) agents[PARENT_INDEX].toolCount += 1;

        const startedEvent = emit("subagent.started", {
            toolCallId: agent.spawnCallId,
            agentName: agent.name,
            agentDisplayName: agent.name,
            agentDescription: agent.desc,
            agentType: agent.type,
            executionMode: agent.mode,
            model: agent.model,
            ...(agent.parentAgentId ? { parentId: agent.parentAgentId } : {}),
        }, from(agent.agentId));
        agent.startedAtMs = Date.parse(startedEvent.timestamp);

        const priorTools = (agent.index % 3) + 1;
        for (let t = 0; t < priorTools; t++) {
            const spec = TOOL_SPECS[(agent.index + t) % TOOL_SPECS.length];
            const toolCallId = `call-${agent.num}-${t + 1}`;
            emit("tool.execution_start", {
                toolCallId,
                toolName: spec.name,
                arguments: spec.args(n),
                ...(spec.shell ? { shellToolInfo: spec.shell(n) } : {}),
            }, from(agent.agentId));
            emit("tool.execution_complete", { toolCallId, success: true }, from(agent.agentId));
            agent.toolCount += 1;
        }

        const runSpec = TOOL_SPECS[(agent.index + priorTools) % TOOL_SPECS.length];
        agent.runningToolId = `call-${agent.num}-run`;
        emit("tool.execution_start", {
            toolCallId: agent.runningToolId,
            toolName: runSpec.name,
            arguments: runSpec.args(n),
            ...(runSpec.shell ? { shellToolInfo: runSpec.shell(n) } : {}),
        }, from(agent.agentId));
        agent.toolCount += 1;

        if (thresholdSet.has(n)) {
            pauses.push({ running: n, event: events.length });
        }
    }

    // Phase 2: finish all 60 sub-agents at staggered times.
    for (const idx of buildFinishOrder(agents.length)) {
        const agent = agents[idx];
        const failed = Boolean(agent.error);

        emit("tool.execution_complete", {
            toolCallId: agent.runningToolId,
            success: !failed,
            ...(failed ? { error: { message: agent.error } } : {}),
        }, from(agent.agentId));

        const endMs = T0 + seq * STEP_MS;
        const durationMs = endMs - agent.startedAtMs;
        if (failed) {
            emit("subagent.failed", {
                toolCallId: agent.spawnCallId,
                agentName: agent.name,
                agentDisplayName: agent.name,
                error: agent.error,
                durationMs,
                totalToolCalls: agent.toolCount,
                model: agent.model,
            }, from(agent.agentId));
        } else {
            emit("subagent.completed", {
                toolCallId: agent.spawnCallId,
                agentName: agent.name,
                agentDisplayName: agent.name,
                durationMs,
                totalToolCalls: agent.toolCount,
                model: agent.model,
            }, from(agent.agentId));
        }

        emit("tool.execution_complete", {
            toolCallId: agent.spawnCallId,
            success: !failed,
            ...(failed ? { error: { message: agent.error } } : {}),
        }, from(agent.parentAgentId));
    }

    emit("assistant.idle", {});
    emit("session.idle", {}, { ephemeral: true });

    return { events, pauses, failedCount: FAILED_COUNT };
}

export function formatJsonl(events) {
    return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const outPath = process.argv[2];
    const { events, pauses } = generate();
    const content = formatJsonl(events);
    if (outPath) fs.writeFileSync(outPath, content, "utf8");
    else process.stdout.write(content);
    for (const { running, event } of pauses) {
        process.stderr.write(`running=${running} at event ${event}\n`);
    }
}
