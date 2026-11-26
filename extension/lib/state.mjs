// Folds Copilot session events into the state the pane shows. Pure logic: no I/O and no clock,
// every time is taken from the event's own timestamp.

const SPAWN_TOOLS = new Set(["task"]);
export const HIDDEN_TOOLS = new Set(); // purely internal tool calls: kept out of the log and of turnTools

const MAX_SEEN = 2000;
const MAX_LOG = 200;
const MAX_TURN_AGENTS = 500; // agents that ended in the current turn are kept up to this safety limit
const CROWD = 50; // a snapshot with more agents than this carries only the latest CROWD_TOOLS tools of each
const CROWD_TOOLS = 5;
const NAME_BYTES = 64;
const TEXT_BYTES = 200;
const SUMMARY_BYTES = 120;
// description goes before prompt: the task tool carries both, and its description is the one-line one.
const SUMMARY_FIELDS = [
    "command", "path", "file_path", "pattern", "query", "url", "description", "prompt", "message", "name",
];
const ENDED = new Set(["done", "failed", "cancelled"]);

const text = (value) => (typeof value === "string" ? value : "");
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const pick = (...values) => values.map((value) => text(value).trim()).find(Boolean) ?? "";
const oneLine = (value) => text(value).replace(/\s+/g, " ").trim();
const firstLine = (value) => text(value).trim().split("\n", 1)[0].trimEnd();
const earlier = (a, b) => (a && (!b || a <= b) ? a : b);
// Timestamps are ISO 8601 strings in UTC, so comparing them as strings orders them by time.
const byTime = (field) => (a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0);

// Cuts to at most `max` UTF-8 bytes without splitting a character.
function clip(value, max) {
    const string = text(value);
    let bytes = 0;
    let end = 0;
    for (const char of string) {
        const code = char.codePointAt(0);
        bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
        if (bytes > max) return string.slice(0, end);
        end += char.length;
    }
    return string;
}

function elapsed(from, to) {
    const ms = Date.parse(to) - Date.parse(from);
    return ms > 0 ? ms : 0;
}

// m:ss below one hour, h:mm:ss from there on: the format the pane uses.
function clock(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const pad = (n) => String(n).padStart(2, "0");
    return seconds < 3600
        ? `${minutes}:${pad(seconds % 60)}`
        : `${Math.floor(seconds / 3600)}:${pad(minutes % 60)}:${pad(seconds % 60)}`;
}

export function isUserSubmission(event) {
    return (
        event?.type === "user.message" &&
        !event.agentId &&
        isObject(event.data) &&
        !event.data.source &&
        event.data.isAutopilotContinuation !== true
    );
}

export function startsTurn(event) {
    return isUserSubmission(event) && event.data.delivery !== "steering" && event.checkpoint !== true;
}

// A shell tool is recognised by its shellToolInfo, so toolName is not needed to tell.
export function summarizeArgs(toolName, data) {
    const args = data?.arguments;
    let summary = text(data?.shellToolInfo?.displayCommand);
    if (!summary && isObject(args)) {
        const field = SUMMARY_FIELDS.find((name) => typeof args[name] === "string");
        summary = field ? args[field] : "";
    }
    return clip(oneLine(summary), SUMMARY_BYTES);
}

// One line of JSON, without a trailing newline. A line over the limit is encoded again with only the
// latest tool of main and of every agent, and marked as truncated.
export function encodeSnapshot(snapshot, maxBytes = 3 * 1024 * 1024) {
    const line = JSON.stringify(snapshot);
    if (Buffer.byteLength(line, "utf8") <= maxBytes) return line;
    const latest = (owner) => ({ ...owner, tools: (owner?.tools ?? []).slice(-1) });
    return JSON.stringify({
        ...snapshot,
        main: latest(snapshot.main),
        agents: (snapshot.agents ?? []).map(latest),
        truncated: true,
    });
}

export function createState({ maxAgents = 50, maxTools = 20, cancelLeftoversOnIdle = false } = {}) {
    // key, name and toolCount let main stand wherever an agent can own tools and log records.
    // unlisted: the calls that were trimmed off tools while still running, kept until they end.
    const main = {
        key: "main", name: "main", status: "idle", since: "", intent: "", error: "", model: "",
        toolCount: 0, tools: [], unlisted: new Set(),
    };
    const agents = new Map(); // internal key (a1, a2, …) → Agent. The key is the only official identity
    const byAgentId = new Map(); // alias: agentId → key
    const bySpawnCall = new Map(); // alias: toolCallId of the spawning tool call → key
    const toolOwner = new Map(); // toolCallId → { owner: "main" or a key, tool }
    const spawnArgs = new Map(); // toolCallId of a spawn tool call → { name, desc }, until its agent exists
    const waits = new Map(); // requestId → { owner, kind, toolCallId }: unanswered requests, in arrival order
    const seen = new Set(); // ids of the latest MAX_SEEN handled events
    const log = [];
    let turn = 0;
    let turnTools = 0;
    let logSeq = 0;
    let lastKey = 0;
    let rev = 0; // counts identity changes: agents created or merged, aliases learned

    const holder = (key) => (key === "main" ? main : agents.get(key));

    const resolveAgent = (agentId) => agents.get(byAgentId.get(agentId));

    const toolRecord = (toolCallId) => log.find((entry) => entry.kind === "tool" && entry.id === toolCallId);

    function addLog(owner, t, kind, status, summary, tool = "", id = "") {
        log.push({ seq: ++logSeq, t, actor: owner.key, name: owner.name, kind, tool, summary, status, id });
        if (log.length > MAX_LOG) log.shift();
    }

    // The record of a tool call that has not finished shows whether the call still waits for the user.
    function refreshWaiting(toolCallId) {
        const record = toolRecord(toolCallId);
        if (record?.status !== "running" && record?.status !== "waiting") return;
        const pending = [...waits.values()].some((wait) => wait.toolCallId === toolCallId);
        record.status = pending ? "waiting" : "running";
    }

    function dropWaits(ownerKey) {
        let dropped = false;
        for (const [requestId, wait] of waits) {
            if (wait.owner !== ownerKey) continue;
            waits.delete(requestId);
            refreshWaiting(wait.toolCallId);
            dropped = true;
        }
        return dropped;
    }

    // An empty name makes (or leaves) the agent a placeholder that is named after its id.
    function setName(agent, name) {
        agent.placeholder = !name;
        agent.name = clip(name || `agent-${(agent.agentId || agent.key).slice(0, 6)}`, NAME_BYTES);
        for (const entry of log) if (entry.actor === agent.key) entry.name = agent.name;
    }

    // own: first seen under its agentId, through an event of its own. Without a subagent.started
    // such an agent cannot be told from one that runs again, so it starts out as a resumed run.
    function newAgent(at, own) {
        const agent = {
            key: `a${++lastKey}`, agentId: "", spawnCallId: "", name: "", placeholder: true, type: "", desc: "",
            mode: "", model: "", intent: "", status: "running", spawnTurn: turn, reportedTurn: 0, startedAt: at,
            endedAt: "", durationMs: 0, error: "", depth: 0, parent: "", toolCount: 0, tools: [],
            unlisted: new Set(), resumed: own, askedForTools: own, inferred: false,
        };
        agents.set(agent.key, agent);
        rev += 1;
        return agent;
    }

    function forgetTool(id) {
        toolOwner.delete(id);
        spawnArgs.delete(id);
    }

    // Over the cap, the earliest finished call goes first. toolCount keeps the total. The list is
    // display history: a call that still runs only leaves the list, so that its end can be recorded.
    function trimTools(owner) {
        while (owner.tools.length > maxTools) {
            const finished = owner.tools.findIndex((tool) => tool.status !== "running");
            const [tool] = owner.tools.splice(Math.max(finished, 0), 1);
            if (tool.status === "running") owner.unlisted.add(tool);
            else forgetTool(tool.id);
        }
    }

    // Its children keep their parent value; the pane shows no parent name for a key it cannot find.
    function removeAgent(agent) {
        agents.delete(agent.key);
        for (const tool of [...agent.tools, ...agent.unlisted]) forgetTool(tool.id);
        for (const index of [byAgentId, bySpawnCall]) {
            for (const [alias, key] of index) if (key === agent.key) index.delete(alias);
        }
        dropWaits(agent.key);
    }

    // Running agents and those that ended in the current turn stay. Of those that ended earlier,
    // the maxAgents latest stay.
    function prune() {
        const ended = [...agents.values()].filter((agent) => ENDED.has(agent.status)).sort(byTime("endedAt"));
        const current = ended.filter((agent) => agent.reportedTurn === turn);
        const older = ended.filter((agent) => agent.reportedTurn !== turn);
        const surplus = [
            ...older.slice(0, Math.max(0, older.length - maxAgents)),
            ...current.slice(0, Math.max(0, current.length - MAX_TURN_AGENTS)),
        ];
        for (const agent of surplus) removeAgent(agent);
    }

    function setDepth(agent, depth) {
        agent.depth = depth;
        for (const child of agents.values()) if (child.parent === agent.key) setDepth(child, depth + 1);
    }

    function setParent(agent, parentKey) {
        for (let up = parentKey; up; up = agents.get(up)?.parent) {
            if (up === agent.key) return setParent(agent, ""); // malformed input: the link would close a cycle
        }
        agent.parent = parentKey;
        setDepth(agent, parentKey ? (agents.get(parentKey)?.depth ?? 0) + 1 : 0);
    }

    // What the spawning tool call says about an agent: name and description (the call's arguments,
    // the first choice for both) and parent (the call's owner; none when that is the main agent).
    function adoptSpawn(agent) {
        const args = spawnArgs.get(agent.spawnCallId);
        if (args) {
            spawnArgs.delete(agent.spawnCallId);
            if (args.name) setName(agent, args.name);
            if (args.desc) agent.desc = args.desc;
        }
        const spawner = toolOwner.get(agent.spawnCallId);
        if (spawner) setParent(agent, spawner.owner === "main" ? "" : spawner.owner);
    }

    // Two records turned out to be the same agent. The one created first survives.
    function merge(a, b) {
        const [keep, drop] = Number(a.key.slice(1)) < Number(b.key.slice(1)) ? [a, b] : [b, a];
        agents.delete(drop.key);
        rev += 1;

        for (const field of ["agentId", "spawnCallId", "type", "desc", "mode", "model", "intent"]) {
            keep[field] ||= drop[field];
        }
        keep.resumed &&= drop.resumed; // a side that is a confirmed first run settles it
        keep.startedAt = earlier(keep.startedAt, drop.startedAt);
        keep.toolCount += drop.toolCount;
        keep.tools = [...keep.tools, ...drop.tools].sort(byTime("startedAt"));
        for (const tool of drop.unlisted) keep.unlisted.add(tool);
        if (!ENDED.has(keep.status) && ENDED.has(drop.status)) {
            // an ended side wins, and stays the kind of end it was
            const end = ["status", "endedAt", "durationMs", "error", "reportedTurn", "inferred"];
            for (const field of end) keep[field] = drop[field];
        }

        for (const index of [byAgentId, bySpawnCall]) {
            for (const [alias, key] of index) if (key === drop.key) index.set(alias, keep.key);
        }
        for (const entry of toolOwner.values()) if (entry.owner === drop.key) entry.owner = keep.key;
        for (const wait of waits.values()) if (wait.owner === drop.key) wait.owner = keep.key;
        for (const entry of log) if (entry.actor === drop.key) entry.actor = keep.key;
        // A real name beats a placeholder. This also renames the log records just taken over.
        setName(keep, keep.placeholder ? (drop.placeholder ? "" : drop.name) : keep.name);

        // keep.parent is cleared first: with it gone, re-pointing the children cannot close a cycle.
        const parent = [keep.parent, drop.parent].find((key) => key && key !== keep.key && key !== drop.key) ?? "";
        keep.parent = "";
        for (const other of agents.values()) if (other.parent === drop.key) other.parent = keep.key;
        setParent(keep, parent);

        trimTools(keep);
        if (ENDED.has(keep.status)) dropWaits(keep.key);
        return keep;
    }

    // The agent known under either alias; a placeholder is created when there is none. Aliases that
    // lead to two different agents mean these are one and the same: they are merged.
    function identify(agentId, callId, at) {
        const first = agents.get(byAgentId.get(agentId));
        const second = agents.get(bySpawnCall.get(callId));
        const known = first && second && first !== second ? merge(first, second) : first ?? second;
        const agent = known ?? newAgent(at, agentId !== "");
        if (agentId && !first) {
            byAgentId.set(agentId, agent.key);
            agent.agentId ||= agentId;
            rev += 1;
        }
        if (callId && !second) {
            bySpawnCall.set(callId, agent.key);
            rev += 1;
            if (!agent.spawnCallId) {
                agent.spawnCallId = callId;
                adoptSpawn(agent);
            }
        }
        if (agent.placeholder) setName(agent, "");
        return agent;
    }

    // Attribution: an envelope agentId means that sub-agent; else data.parentToolCallId means the
    // sub-agent spawned by that call; else the main agent.
    function ownerOf(event, data, at) {
        const agentId = text(event.agentId);
        if (agentId) return identify(agentId, "", at);
        const callId = text(data.parentToolCallId);
        return callId ? identify("", callId, at) : main;
    }

    // First value wins: only what is still blank is filled, so a late or repeated event changes
    // nothing that is already shown.
    function fillBlanks(agent, data) {
        if (agent.placeholder) setName(agent, pick(data.agentDisplayName, data.agentName));
        agent.desc ||= clip(pick(data.agentDescription), TEXT_BYTES);
        agent.type ||= clip(pick(data.agentType, data.agentName), NAME_BYTES);
        agent.mode ||= clip(pick(data.executionMode), NAME_BYTES);
        agent.model ||= clip(pick(data.model), NAME_BYTES);
    }

    function endTool(owner, tool, status, at, error) {
        tool.status = status;
        tool.endedAt = at;
        tool.error = clip(firstLine(error), TEXT_BYTES);
        if (owner.unlisted.delete(tool)) forgetTool(tool.id);
        if (HIDDEN_TOOLS.has(tool.name)) return;
        // The start record may have been pushed out of the log by now; the end is still shown.
        const record = toolRecord(tool.id);
        if (record) record.status = status;
        else addLog(owner, at, "tool", status, tool.summary, tool.name, tool.id);
    }

    // An interrupted tool gets no completion event: what still runs when its owner stops ends here.
    function cancelTools(owner, at) {
        const running = [...owner.unlisted, ...owner.tools.filter((tool) => tool.status === "running")];
        for (const tool of running) endTool(owner, tool, "cancelled", at);
        return running.length > 0;
    }

    // An agent that already ended gets here only with the subagent.* event of an end that was
    // inferred. The event corrects that end and is not counted as another one: reportedTurn stays,
    // and the end's log record is updated in place.
    function finish(agent, status, at, durationMs, error) {
        const reported = Number.isFinite(durationMs) && durationMs >= 0;
        const correction = ENDED.has(agent.status);
        agent.status = status;
        agent.endedAt = at;
        agent.durationMs = reported ? Math.round(durationMs) : elapsed(agent.startedAt, at);
        agent.error = clip(firstLine(error), TEXT_BYTES);
        if (!correction) agent.reportedTurn = turn;
        agent.resumed = false;
        agent.inferred = false;
        dropWaits(agent.key);
        cancelTools(agent, at);
        const detail = agent.error || `${agent.toolCount} ${agent.toolCount === 1 ? "tool" : "tools"}`;
        const summary = clip(`${clock(agent.durationMs)} · ${detail}`, SUMMARY_BYTES);
        // The record of the inferred end may have been pushed out of the log by now.
        const record = correction && log.findLast((entry) => entry.kind === "agent" && entry.actor === agent.key);
        if (record) Object.assign(record, { status, summary });
        else addLog(agent, at, "agent", status, summary);
    }

    // An end that no subagent.* event reported. When that event follows after all, it corrects this end.
    function inferEnd(agent, status, at) {
        finish(agent, status, at);
        agent.inferred = true;
    }

    function onUserMessage(event, data, at) {
        if (event.agentId) return false;
        if (startsTurn(event)) {
            // apply() has already moved to the new turn
            Object.assign(main, { status: "working", since: at, intent: "", error: "" });
            dropWaits("main");
            prune();
            return true;
        }
        if (main.status !== "idle") return false;
        Object.assign(main, { status: "working", since: at });
        return true;
    }

    // A sub-agent that ended stays around, and the main agent can ask it again. No subagent.started
    // follows then, only the agent's own turns. Until a message of this run says otherwise, the run
    // counts as going on.
    function resume(agent, at) {
        Object.assign(agent, {
            status: "running", startedAt: at, endedAt: "", durationMs: 0, error: "", reportedTurn: 0,
            resumed: true, askedForTools: true,
        });
    }

    function onTurnStart(event, data, at) {
        const agentId = text(event.agentId);
        const callId = text(data.parentToolCallId);
        if (agentId || callId) {
            // a sub-agent's: ties its two ids together, and starts the next run of one that had ended
            const ended = ENDED.has(resolveAgent(agentId)?.status);
            const agent = identify(agentId, callId, at);
            if (ended) resume(agent, at);
            return ended;
        }
        const model = clip(data.model, NAME_BYTES) || main.model;
        if (main.status === "working" && model === main.model) return false;
        if (main.status !== "working") Object.assign(main, { status: "working", since: at, error: "" });
        main.model = model;
        return true;
    }

    // The main agent's turn_start carries no model in practice; its messages and tool calls do.
    function noteMainModel(data) {
        const model = clip(data.model, NAME_BYTES);
        if (!model || model === main.model) return false;
        main.model = model;
        return true;
    }

    function onMessage(event, data) {
        if (!event.agentId) return noteMainModel(data);
        const agent = resolveAgent(text(event.agentId));
        if (agent) agent.askedForTools = Array.isArray(data.toolRequests) && data.toolRequests.length > 0;
        return false;
    }

    // The agent loop goes on only while the model asks for tools, so a turn whose message asked for
    // none is the last one. A first run is ended by its subagent.* event instead.
    function onTurnEnd(event, data, at) {
        const agent = resolveAgent(text(event.agentId));
        if (!agent?.resumed || agent.askedForTools) return false;
        inferEnd(agent, "done", at);
        prune();
        return true;
    }

    function onIntent(event, data, at) {
        if (typeof data.intent !== "string") return false;
        const owner = ownerOf(event, data, at);
        const intent = clip(data.intent, TEXT_BYTES);
        if (owner.intent === intent) return false;
        owner.intent = intent;
        return true;
    }

    function onToolStart(event, data, at) {
        const id = text(data.toolCallId);
        if (!id || toolOwner.has(id)) return false;
        const name = text(data.toolName);
        // Not the model's call: the CLI itself fetches the result of a background agent that ended.
        if (name === "read_agent" && !data.model) return false;
        const owner = ownerOf(event, data, at);
        if (owner === main) noteMainModel(data);
        const tool = {
            id, name: clip(name, NAME_BYTES), summary: summarizeArgs(name, data), status: "running",
            startedAt: at, endedAt: "", error: "",
        };
        owner.tools.push(tool);
        owner.toolCount += 1;
        toolOwner.set(id, { owner: owner.key, tool });
        trimTools(owner);
        if (SPAWN_TOOLS.has(name) && isObject(data.arguments)) {
            const args = {
                name: clip(pick(data.arguments.name), NAME_BYTES),
                desc: clip(pick(data.arguments.description), TEXT_BYTES),
            };
            if (args.name || args.desc) spawnArgs.set(id, args);
        }
        // This call spawned an agent that is already known: its subagent.started came first.
        const spawned = agents.get(bySpawnCall.get(id));
        if (spawned?.spawnCallId === id) adoptSpawn(spawned);
        if (!HIDDEN_TOOLS.has(name)) {
            turnTools += 1;
            addLog(owner, at, "tool", tool.status, tool.summary, tool.name, id);
        }
        return true;
    }

    function onToolComplete(event, data, at) {
        const entry = toolOwner.get(data.toolCallId);
        if (!entry || entry.tool.status !== "running") return false;
        endTool(holder(entry.owner), entry.tool, data.success ? "ok" : "failed", at, data.error?.message);
        return true;
    }

    function onSubagentStarted(event, data, at) {
        const agentId = text(event.agentId);
        const callId = text(data.toolCallId);
        if (!agentId && !callId) return false;
        const agent = identify(agentId, callId, at);
        agent.resumed = false; // a first run for sure: only its subagent.* event ends it
        fillBlanks(agent, data);
        // An agent that already ended keeps its status and times.
        if (!ENDED.has(agent.status)) agent.startedAt = earlier(agent.startedAt, at);
        // Fallback when the spawn call's owner is not known: the parent named by the event.
        if (!agent.parent && !toolOwner.has(agent.spawnCallId)) {
            const parent = resolveAgent(text(data.parentId));
            if (parent) setParent(agent, parent.key);
        }
        return true;
    }

    // subagent.completed and subagent.failed. Without an earlier subagent.started the agent is created here.
    function onSubagentEnded(event, data, at) {
        const agentId = text(event.agentId);
        const callId = text(data.toolCallId);
        if (!agentId && !callId) return false;
        const agent = identify(agentId, callId, at);
        if (ENDED.has(agent.status) && !agent.inferred) return false; // an inferred end is corrected below
        fillBlanks(agent, data);
        const failed = event.type === "subagent.failed";
        const status = failed ? "failed" : data.cancelled ? "cancelled" : "done";
        finish(agent, status, at, data.durationMs, failed ? data.error : "");
        prune();
        return true;
    }

    // The main loop stopped. An error stays visible until the next turn or the next root turn_start.
    function onIdle(event, data, at) {
        const dropped = dropWaits("main");
        if (main.status !== "working") return dropped;
        Object.assign(main, { status: "idle", since: at });
        return true;
    }

    function onAbort(event, data, at) {
        const cancelled = cancelTools(main, at);
        return onIdle(event, data, at) || cancelled;
    }

    // All background work has ended as well. A resumed agent that still runs has no end event to
    // wait for; any other agent still marked running missed its own.
    function onSessionIdle(event, data, at) {
        let changed = onIdle(event, data, at);
        for (const agent of agents.values()) {
            if (ENDED.has(agent.status)) continue;
            if (agent.resumed) inferEnd(agent, data.aborted === true ? "cancelled" : "done", at);
            else if (cancelLeftoversOnIdle) inferEnd(agent, "cancelled", at);
            else continue;
            changed = true;
        }
        prune();
        return changed;
    }

    // Who waits: the owner of the tool call the request belongs to, else the envelope's agent, else
    // main. A request without a toolCallId (one an MCP server makes) just skips that step. What is
    // asked (question, plan, form) is never read.
    function onRequested(kind, event, data, at) {
        const requestId = text(data.requestId);
        if (!requestId || waits.has(requestId)) return false;
        const toolCallId = text(data.toolCallId);
        const agentId = text(event.agentId);
        const owner = holder(toolOwner.get(toolCallId)?.owner) ?? (agentId ? identify(agentId, "", at) : main);
        if (ENDED.has(owner.status)) return false; // a late request of an agent that already ended
        waits.set(requestId, { owner: owner.key, kind, toolCallId });
        refreshWaiting(toolCallId);
        return true;
    }

    function onAnswered(event, data) {
        const wait = waits.get(data.requestId);
        if (!wait) return false;
        waits.delete(data.requestId);
        refreshWaiting(wait.toolCallId);
        return true;
    }

    function onSessionError(event, data, at) {
        Object.assign(main, { status: "error", error: clip(firstLine(data.message), TEXT_BYTES), since: at });
        return true;
    }

    // With an envelope agentId these events are a sub-agent's and say nothing about main.
    const rootOnly = (handler) => (event, data, at) => (event.agentId ? false : handler(event, data, at));
    const requested = (kind) => (event, data, at) => onRequested(kind, event, data, at);

    // Each handler returns whether it changed anything. Types that are not listed are ignored: among
    // them permission.completed, whose request event never reaches an extension.
    const handlers = {
        __proto__: null,
        "user.message": onUserMessage,
        "assistant.turn_start": onTurnStart,
        "assistant.message": onMessage,
        "assistant.turn_end": onTurnEnd,
        "assistant.intent": onIntent,
        "tool.execution_start": onToolStart,
        "tool.execution_complete": onToolComplete,
        "subagent.started": onSubagentStarted,
        "subagent.completed": onSubagentEnded,
        "subagent.failed": onSubagentEnded,
        "assistant.idle": rootOnly(onIdle),
        "session.idle": onSessionIdle,
        abort: rootOnly(onAbort),
        "session.error": rootOnly(onSessionError),
        "exit_plan_mode.requested": requested("approval"),
        "user_input.requested": requested("answer"),
        "elicitation.requested": requested("answer"),
        "exit_plan_mode.completed": onAnswered,
        "user_input.completed": onAnswered,
        "elicitation.completed": onAnswered,
    };

    function apply(event) {
        const handler = isObject(event) && typeof event.type === "string" ? handlers[event.type] : undefined;
        if (!handler || !isObject(event.data)) return false;
        if (event.id !== undefined && event.id !== null) {
            if (seen.has(event.id)) return false;
            seen.add(event.id);
            if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
        }
        if (event.checkpoint === true) return false; // a replayed record: history is not back-filled
        // The turn moves first, so that an error further down cannot lose it.
        if (startsTurn(event)) {
            turn += 1;
            turnTools = 0;
        }
        const before = rev;
        const changed = handler(event, event.data, text(event.timestamp));
        return changed || rev !== before;
    }

    // Display order. Running agents first, as a pre-order walk of the parent/child tree: roots by start
    // time, each child right after its parent, siblings by start time. A child whose parent is not
    // running counts as a root. Ended agents follow, by end time.
    function ordered() {
        const all = [...agents.values()];
        const running = all.filter((agent) => !ENDED.has(agent.status)).sort(byTime("startedAt"));
        const children = new Map(running.map((agent) => [agent.key, []]));
        const roots = [];
        for (const agent of running) (children.get(agent.parent) ?? roots).push(agent);
        const walk = (list) => list.flatMap((agent) => [agent, ...walk(children.get(agent.key))]);
        return [...walk(roots), ...all.filter((agent) => ENDED.has(agent.status)).sort(byTime("endedAt"))];
    }

    const toolView = ({ id, name, summary, status, startedAt, endedAt, error }) =>
        ({ id, name, summary, status, startedAt, endedAt, error });

    function snapshot() {
        const list = ordered();
        const toolLimit = list.length > CROWD ? CROWD_TOOLS : maxTools;
        const waiting = new Map(); // owner → kind of its earliest unanswered request
        for (const wait of waits.values()) if (!waiting.has(wait.owner)) waiting.set(wait.owner, wait.kind);
        return {
            turn,
            stats: { turnTools },
            main: {
                status: main.status, since: main.since, intent: main.intent, error: main.error, model: main.model,
                wait: waiting.get(main.key) ?? "", tools: main.tools.map(toolView),
            },
            agents: list.map((agent) => ({
                id: agent.key, call: agent.spawnCallId, spawnTurn: agent.spawnTurn, reportedTurn: agent.reportedTurn,
                name: agent.name, type: agent.type, desc: agent.desc, mode: agent.mode, model: agent.model,
                wait: waiting.get(agent.key) ?? "", status: agent.status, startedAt: agent.startedAt,
                endedAt: agent.endedAt, durationMs: agent.durationMs, error: agent.error, depth: agent.depth,
                parent: agent.parent, toolCount: agent.toolCount, tools: agent.tools.slice(-toolLimit).map(toolView),
            })),
            log: log.map((entry) => ({ ...entry })),
        };
    }

    return { apply, snapshot, turn: () => turn };
}
