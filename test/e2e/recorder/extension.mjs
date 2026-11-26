import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@microsoft/copilot-sdk/extension";
import { helperLoaded } from "./helper.mjs";

// 取证目录由环境变量给出，没有就不记录。文件里有原始事件，权限收紧
const outDir = process.env.FLEETPANE_LAB_OUT;
if (outDir) mkdirSync(outDir, { recursive: true, mode: 0o700 });
const file = outDir ? join(outDir, `rec.${process.pid}.jsonl`) : null;
const rec = (kind, payload = {}) => {
    if (!file) return;
    try {
        appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), kind, ...payload }) + "\n", { mode: 0o600 });
    } catch (err) {
        process.stderr.write(`fleetpane-recorder: ${err?.message ?? err}\n`);   // stderr 不是协议通道
    }
};

function ttyChain() {
    const chain = [];
    let pid = process.pid;
    for (let i = 0; i < 6 && pid > 1; i++) {
        try {
            const out = execFileSync("ps", ["-o", "ppid=,tty=,comm=", "-p", String(pid)], { encoding: "utf8" });
            const [ppid, tty, ...comm] = out.trim().split(/\s+/);
            chain.push({ pid, ppid: Number(ppid), tty, comm: comm.join(" ") });
            pid = Number(ppid);
        } catch {
            break;
        }
    }
    return chain;
}

rec("boot", {
    pid: process.pid,
    ppid: process.ppid,
    node: process.version,
    execPath: process.execPath,
    argv: process.argv,
    here: dirname(fileURLToPath(import.meta.url)),
    helperLoaded,
    termProgram: process.env.TERM_PROGRAM ?? null,
    debugEnv: process.env.FLEETPANE_DEBUG ?? null,
    ttyChain: ttyChain(),
});

let session;
session = await joinSession({
    // E1-l：选项里能不能提前登记事件回调。能的话，这里收到的事件不晚于下面 session.on 收到的
    onEvent: (event) => rec("early-event", { id: event.id, type: event.type }),
    hooks: {
        onUserPromptSubmitted: (input) => {
            rec("hook.prompt", {
                agentId: input.agentId ?? null,
                parentAgentId: input.parentAgentId ?? null,
                prompt: String(input.prompt).slice(0, 200),
            });
        },
        onSubagentStart: (input) => {
            rec("hook.subagentStart", { agentId: input.agentId ?? null, agentName: input.agentName });
        },
        onSubagentStop: (input) => {
            rec("hook.subagentStop", { agentId: input.agentId ?? null, agentName: input.agentName });
        },
        onSessionEnd: (input) => {
            rec("hook.sessionEnd", { reason: input.reason });
        },
    },
    commands: [
        {
            name: "fplab",
            description: "FleetPane lab probe",
            handler: async (ctx) => {
                rec("command", { command: ctx.command, args: ctx.args });
                if (String(ctx.args).trim() === "tasks") await tasks("manual");   // 明确发起并等到返回的一次查询
                await session.log(`fplab ok: ${ctx.args}`, { ephemeral: true });
            },
        },
    ],
});
rec("joined", {
    sessionId: session.sessionId,
    capabilities: session.capabilities ?? null,
    workspacePath: session.workspacePath ?? null,
});

// tasks.list() 的查询排成一队，一次只发一个。记录里 n 是发起的顺序，asked 是排队的时刻，t 是返回的时刻
const TASK_FIELDS = ["type", "id", "toolCallId", "displayName", "status", "executionMode", "agentType", "startedAt", "completedAt"];
const pickTask = (task) => Object.fromEntries(TASK_FIELDS.filter((k) => k in task).map((k) => [k, task[k]]));
let taskSeq = 0;
let taskQueue = Promise.resolve();
function tasks(why) {
    const n = ++taskSeq;
    const asked = new Date().toISOString();
    taskQueue = taskQueue.then(async () => {
        try {
            rec("tasks", { n, why, asked, tasks: (await session.rpc.tasks.list()).tasks.map(pickTask) });
        } catch (err) {
            rec("tasks.error", { n, why, asked, message: String(err?.message ?? err) });
        }
    });
    return taskQueue;
}

// E4-o: permission.requested is not bridged to extensions, so with FLEETPANE_LAB_PENDING=1 the pending
// permission prompts are polled instead (read-only RPC). Only changes are recorded, without request bodies.
if (process.env.FLEETPANE_LAB_PENDING === "1") {
    let last = "";
    const poll = async () => {
        try {
            const { items } = await session.rpc.permissions.pendingRequests();
            const seen = items.map((item) => ({
                requestId: item.requestId,
                kind: item.request?.kind ?? null,
                toolCallId: item.request?.toolCallId ?? null,
                keys: Object.keys(item.request ?? {}),
            }));
            const key = JSON.stringify(seen);
            if (key !== last) rec("pending", { items: seen });
            last = key;
        } catch (err) {
            const key = String(err?.message ?? err);
            if (key !== last) rec("pending.error", { message: key });
            last = key;
        }
    };
    setInterval(poll, 500).unref();
}

session.on((event) => {
    if (event.type.endsWith("_delta")) return;
    rec("event", { event });
    if (
        event.type === "session.background_tasks_changed" ||
        event.type === "system.notification" ||
        event.type === "session.idle" ||
        event.type.startsWith("subagent.")
    ) {
        void tasks(event.type);
    }
});

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
        rec("signal", { sig });
        process.exit(0);
    });
}
process.on("exit", (code) => rec("exit", { code }));
