// ============================================================
// pi-persona — extension entry point
// ============================================================
import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { MoodEngine } from "../src/mood-engine.js";
import {
  restorePersistentState,
} from "../src/persistence.js";
import { applyGlobalMoodEvent, refreshGlobalMood } from "../src/global-mood.js";
import { loadSoul } from "../src/soul-loader.js";
import { getFooterStatusText, tickAndGetFooterText } from "../src/footer.js";
import { registerPersonaCommands } from "../src/commands.js";
import {
  createRepeatedErrorState,
  detectExplicitUserFeedback,
  detectFromBashResult,
  detectFromUserMessage,
  detectImplicitAcceptance,
  detectRepeatedErrors,
  resetErrorStreak,
  detectLateNight,
} from "../src/triggers.js";
import {
  DEFAULT_EMOTION_CONFIG,
  nearestEmotion,
} from "../src/types.js";
import type { EmotionChange, EmotionalEvent } from "../src/types.js";
import type { RepeatedErrorState } from "../src/triggers.js";

interface PersonaRuntimeState {
  engine: MoodEngine | null;
  lastLateNightTrigger: number;
  repeatedErrors: RepeatedErrorState;
  pendingImplicitAcceptance: boolean;
  currentAgentHadNegativeEvent: boolean;
}

const LATE_NIGHT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

export default function personaExtension(pi: ExtensionAPI) {
  const state: PersonaRuntimeState = {
    engine: null,
    lastLateNightTrigger: 0,
    repeatedErrors: createRepeatedErrorState(),
    pendingImplicitAcceptance: false,
    currentAgentHadNegativeEvent: false,
  };

  registerAllHooks(pi, state);
  registerPersonaCommands(pi, () => state.engine, (engine) => {
    state.engine = engine;
  });

  pi.on("session_start", async (_event, ctx) => {
    const persistent = restorePersistentState();

    const soulDef = loadSoul({
      onWarning: (message) => {
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
      },
    });
    if (!soulDef) {
      if (ctx.hasUI) ctx.ui.setStatus("soul-mood", "");
      state.engine = null;
      resetRuntimeState(state);
      return;
    }

    state.engine = new MoodEngine(soulDef, persistent, DEFAULT_EMOTION_CONFIG);
    resetRuntimeState(state);

    // Restore emotion coordinates from persisted state (including time decay)
    state.engine.restoreState(
      persistent.lastAngle,
      persistent.lastIntensity,
      persistent.lastInteraction,
    );

    // Apply natural decay against the freshest on-disk state inside the global lock and write
    // it back, so concurrent processes cannot overwrite each other with stale snapshots.
    await refreshGlobalMood(state.engine, true);

    if (ctx.hasUI) {
      ctx.ui.setStatus("soul-mood", getFooterStatusText(state.engine));
    }

  });

  pi.on("session_shutdown", async () => {
    if (state.engine) {
      await refreshGlobalMood(state.engine, true);
    }
    state.engine = null;
    resetRuntimeState(state);
  });
}

// ==============================================================
// Hooks
// ==============================================================

function registerAllHooks(pi: ExtensionAPI, state: PersonaRuntimeState): void {
  pi.on("agent_start", async () => {
    state.currentAgentHadNegativeEvent = false;
  });

  pi.on("tool_result", async (event, ctx) => {
    const engine = state.engine;
    if (!engine || event.toolName !== "bash") return;

    const input = event.input as { command?: string } | undefined;
    const command = input?.command ?? "";
    const details = event.details as { exitCode?: number } | undefined;
    const exitCode = details?.exitCode;
    const isError = event.isError || false;
    const hasFailed = isError || (exitCode !== undefined && exitCode !== 0);

    const repeatEvent = detectRepeatedErrors(command, hasFailed, DEFAULT_EMOTION_CONFIG, state.repeatedErrors);
    if (repeatEvent) {
      if (repeatEvent.valence === "negative") state.currentAgentHadNegativeEvent = true;
      await applyAndNotify(engine, repeatEvent, ctx);
      return;
    }

    const bashEvent = detectFromBashResult(
      exitCode,
      isError,
      command,
      DEFAULT_EMOTION_CONFIG,
    );
    if (bashEvent) {
      if (bashEvent.valence === "negative") state.currentAgentHadNegativeEvent = true;
      await applyAndNotify(engine, bashEvent, ctx);
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    const engine = state.engine;
    if (!engine) return;

    let sawUserMessage = false;
    let lastUserEvent: EmotionalEvent | null = null;

    for (const msg of event.messages) {
      if (msg.role === "user") {
        sawUserMessage = true;
        const content = extractUserText(msg.content);
        if (content) {
          const userEvent = detectFromUserMessage(
            content,
            DEFAULT_EMOTION_CONFIG,
            engine.soul.traits.agreeableness,
          );
          if (userEvent) lastUserEvent = userEvent;
        }
      }
    }

    // A single turn may contain several user messages (steering, follow-ups, …).
    // Only the last valid feedback event is applied, so repeated praise or corrections
    // do not stack intensity.
    if (lastUserEvent) {
      state.pendingImplicitAcceptance = false;
      await applyAndNotify(engine, lastUserEvent, ctx);
    } else if (sawUserMessage && !state.currentAgentHadNegativeEvent) {
      // Users rarely spend tokens on a separate "good job" message.
      // So if the previous turn had no clear failure and the next one raises new work rather
      // than a correction, treat that as implicit acceptance.
      state.pendingImplicitAcceptance = true;
    }

    // late_night means "the user is still interacting late at night", not "the agent finished
    // a turn late at night".
    // Fire it only when this turn actually contains a user message, so retries, follow-ups and
    // tool continuations do not pollute the mood.
    if (sawUserMessage) {
      const lateEvent = detectLateNight(
        DEFAULT_EMOTION_CONFIG,
        engine.soul.traits.extraversion,
      );
      if (lateEvent) {
        const now = Date.now();
        if (now - state.lastLateNightTrigger >= LATE_NIGHT_COOLDOWN_MS) {
          state.lastLateNightTrigger = now;
          await applyAndNotify(engine, lateEvent, ctx);
        }
      }
    }

    await refreshGlobalMood(engine, true);
    if (ctx.hasUI) ctx.ui.setStatus("soul-mood", getFooterStatusText(engine));
    resetErrorStreak(state.repeatedErrors);
  });

  pi.on("turn_end", async (_event, ctx) => {
    const engine = state.engine;
    if (!engine) return;
    if (ctx.hasUI) ctx.ui.setStatus("soul-mood", tickAndGetFooterText(engine));
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
    const soulDef = loadSoul();
    if (!soulDef) {
      state.engine = null;
      resetRuntimeState(state);
      if (ctx.hasUI) ctx.ui.setStatus("soul-mood", "");
      return;
    }

    let engine = state.engine;
    if (engine && state.pendingImplicitAcceptance) {
      const explicitUserEvent = detectExplicitUserFeedback(
        event.prompt,
        DEFAULT_EMOTION_CONFIG,
        engine.soul.traits.agreeableness,
      );
      if (explicitUserEvent) {
        state.pendingImplicitAcceptance = false;
      } else {
        state.pendingImplicitAcceptance = false;
        await applyAndNotify(
          engine,
          detectImplicitAcceptance(DEFAULT_EMOTION_CONFIG, engine.soul.traits.agreeableness),
          ctx,
        );
      }
    }

    if (!engine) {
      const persistent = restorePersistentState();
      engine = new MoodEngine(soulDef, persistent, DEFAULT_EMOTION_CONFIG);
      engine.restoreState(
        persistent.lastAngle,
        persistent.lastIntensity,
        persistent.lastInteraction,
      );
      state.engine = engine;
    } else {
      engine.soul = soulDef;
    }

    await refreshGlobalMood(engine, true);
    if (ctx.hasUI) ctx.ui.setStatus("soul-mood", getFooterStatusText(engine));

    const addition = engine.getSystemPromptAddition();
    return {
      systemPrompt: event.systemPrompt + "\n\n---\n\n" + addition + "\n\n---",
    };
  });
}

// ==============================================================
// Helpers
// ==============================================================

function resetRuntimeState(state: PersonaRuntimeState): void {
  state.lastLateNightTrigger = 0;
  resetErrorStreak(state.repeatedErrors);
  state.pendingImplicitAcceptance = false;
  state.currentAgentHadNegativeEvent = false;
}

function extractUserText(content: Extract<AgentEndEvent["messages"][number], { role: "user" }>["content"]): string {
  if (typeof content === "string") return content;

  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

async function applyAndNotify(
  engine: MoodEngine,
  event: EmotionalEvent,
  ctx: ExtensionContext,
): Promise<void> {
  const change: EmotionChange = await applyGlobalMoodEvent(engine, event);
  if (change.notify && ctx.hasUI && change.catchphrase) {
    const emo = nearestEmotion(change.newAngle);
    ctx.ui.notify(
      `${engine.soul.emoji} ${change.catchphrase}`,
      emo === "anger" || emo === "sadness" || emo === "fear" || emo === "disgust"
        ? "warning"
        : "info",
    );
  }
  if (ctx.hasUI) ctx.ui.setStatus("soul-mood", getFooterStatusText(engine));
}
