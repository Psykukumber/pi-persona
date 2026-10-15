import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import personaExtension from "../extensions/index.js";
import { invalidateSoulCache } from "./soul-loader.js";
import { restorePersistentState } from "./persistence.js";

test("custom-message runs do not consume pending implicit user acceptance", async () => {
  const originalHome = process.env.HOME;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const home = mkdtempSync(path.join(tmpdir(), "pi-persona-extension-"));
  try {
    process.env.HOME = home;
    delete process.env.PI_CODING_AGENT_DIR;
    invalidateSoulCache();
    const agentDir = path.join(home, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path.join(agentDir, "SOUL.md"), "Test soul");
    const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => Promise<any>) => handlers.set(name, handler),
      registerCommand: () => {},
    } as unknown as ExtensionAPI;
    personaExtension(pi);
    const ctx = { hasUI: false };
    await handlers.get("session_start")!({}, ctx);
    await handlers.get("agent_end")!({ messages: [{ role: "user", content: "Next task" }] }, ctx);
    const before = restorePersistentState().history.filter((entry) => entry.trigger === "implicit_acceptance").length;
    const result = await handlers.get("before_agent_start")!({
      messageType: "custom", message: { content: "Background task" }, systemPrompt: "System",
    }, ctx);
    assert.match(result.systemPrompt, /Test soul/);
    assert.equal(restorePersistentState().history.filter((entry) => entry.trigger === "implicit_acceptance").length, before);
    await handlers.get("before_agent_start")!({
      messageType: "user", prompt: "Another task", systemPrompt: "System",
    }, ctx);
    assert.equal(restorePersistentState().history.filter((entry) => entry.trigger === "implicit_acceptance").length, before + 1);
    await handlers.get("session_shutdown")!({}, ctx);
  } finally {
    invalidateSoulCache();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    rmSync(home, { recursive: true, force: true });
  }
});
