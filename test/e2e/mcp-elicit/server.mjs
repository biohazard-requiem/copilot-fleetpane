// Test-only MCP server (stdio, one JSON-RPC 2.0 message per line). Its single tool, fp_elicit, asks
// the client for one string through elicitation/create, so a real session produces an elicitation.
import { createInterface } from "node:readline";

const log = (text) => process.stderr.write(`fp-elicit: ${text}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const text = (value) => ({ content: [{ type: "text", text: value }] });

let canElicit = false;
let nextId = 1;
const waiting = new Map();

function elicit() {
    const id = `fp-elicit-${nextId++}`;
    send({
        id,
        method: "elicitation/create",
        params: {
            message: "FleetPane test: type any word",
            requestedSchema: {
                type: "object",
                properties: { word: { type: "string", description: "Any word" } },
                required: ["word"],
            },
        },
    });
    return new Promise((resolve) => waiting.set(id, resolve));
}

async function handle(message) {
    const { id, method, params } = message;
    if (method === undefined) {
        waiting.get(id)?.(message);
        waiting.delete(id);
        return;
    }
    if (id === undefined) return;
    if (method === "initialize") {
        canElicit = params?.capabilities?.elicitation !== undefined;
        log(`client elicitation capability: ${canElicit}`);
        send({
            id,
            result: {
                protocolVersion: params?.protocolVersion ?? "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "fp-elicit", version: "0.0.0" },
            },
        });
    } else if (method === "ping") {
        send({ id, result: {} });
    } else if (method === "tools/list") {
        send({
            id,
            result: {
                tools: [
                    {
                        name: "fp_elicit",
                        description: "Asks the user for one word through an MCP elicitation.",
                        inputSchema: { type: "object", properties: {} },
                    },
                ],
            },
        });
    } else if (method === "tools/call") {
        if (!canElicit) return send({ id, result: text("elicitation not supported by client") });
        const reply = await elicit();
        log(`elicitation reply: ${reply.error ? "error" : reply.result?.action}`);
        send({ id, result: text(reply.error ? `elicitation failed: ${reply.error.message}` : `elicitation ${reply.result?.action}`) });
    } else {
        send({ id, error: { code: -32601, message: `method not found: ${method}` } });
    }
}

createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        return log("ignored a line that is not JSON");
    }
    handle(message).catch((err) => log(String(err?.message ?? err)));
});
