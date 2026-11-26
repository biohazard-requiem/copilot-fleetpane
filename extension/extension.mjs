import { joinSession } from "@microsoft/copilot-sdk/extension";
import { start } from "./lib/wire.mjs";

await start({ joinSession });
