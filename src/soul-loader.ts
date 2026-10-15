// ============================================================
// pi-persona — soul loader
// Customisation: <agentDir>/IDENTIFY.md (metadata) + <agentDir>/SOUL.md (prose body)
//                + <agentDir>/USER.md (optional user-maintained preferences and context)
// getAgentDir() follows PI_CODING_AGENT_DIR, falling back to ~/.pi/agent.
// With no SOUL.md in that directory, no soul is loaded or injected.
// ============================================================
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter, splitFrontmatter } from "./frontmatter.js";
import type { SoulDefinition, SoulTraits } from "./types.js";
import { DEFAULT_TRAITS } from "./types.js";

export type SoulWarningSink = (message: string) => void;

export interface LoadSoulOptions {
  onWarning?: SoulWarningSink;
}

type FileStamp =
  | { exists: true; mtimeMs: number; size: number }
  | { exists: false };

interface SoulCacheStamp {
  soul: FileStamp;
  identify: FileStamp;
  userProfile: FileStamp;
}

// ==============================================================
// File paths
// ==============================================================

function userIdentifyFile(): string {
  return path.join(getAgentDir(), "IDENTIFY.md");
}

function userSoulFile(): string {
  return path.join(getAgentDir(), "SOUL.md");
}

function userProfileFile(): string {
  return path.join(getAgentDir(), "USER.md");
}

function getFileStamp(filePath: string): FileStamp {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { exists: false };

    return {
      exists: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch {
    return { exists: false };
  }
}

function getSoulCacheStamp(): SoulCacheStamp {
  return {
    soul: getFileStamp(userSoulFile()),
    identify: getFileStamp(userIdentifyFile()),
    userProfile: getFileStamp(userProfileFile()),
  };
}

function sameFileStamp(a: FileStamp, b: FileStamp): boolean {
  if (a.exists !== b.exists) return false;
  if (!a.exists || !b.exists) return true;

  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function sameSoulCacheStamp(a: SoulCacheStamp | undefined, b: SoulCacheStamp): boolean {
  if (!a) return false;

  return (
    sameFileStamp(a.soul, b.soul) &&
    sameFileStamp(a.identify, b.identify) &&
    sameFileStamp(a.userProfile, b.userProfile)
  );
}

// ==============================================================
// Frontmatter parsing (shared by IDENTIFY.md and SOUL.md)
// ==============================================================

const NUMERIC_KEYS = [
  "openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism",
  "formality", "tsundere", "sarcasm",
];

function parseMdFrontmatter(raw: string, onWarning?: SoulWarningSink): Record<string, any> {
  try {
    const fm = parseFrontmatter(raw);
    // Numeric field conversion. Invalid values no longer silently become 0.5 — they warn
    // and fall back to DEFAULT_TRAITS.
    for (const key of NUMERIC_KEYS) {
      const value = fm[key];
      if (value === undefined) continue;

      const n = typeof value === "number" ? value
        : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        onWarning?.(
          `[pi-persona] IDENTIFY.md field ${key} must be a number between 0 and 1; ${JSON.stringify(value)} is invalid, using the default.`,
        );
        delete fm[key];
        continue;
      }

      fm[key] = n;
    }
    return fm;
  } catch {
    onWarning?.("[pi-persona] IDENTIFY.md has invalid YAML frontmatter; using default metadata.");
    return {};
  }
}

/**
 * Read the body of a .md file without interpreting its YAML frontmatter
 */
function readMdBody(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return splitFrontmatter(raw).content.trim() || null;
  } catch {
    return null;
  }
}

// ==============================================================
// Traits construction (DRY)
// ==============================================================

function buildTraits(fm: Record<string, any>): SoulTraits {
  return {
    openness: fm.openness ?? DEFAULT_TRAITS.openness,
    conscientiousness: fm.conscientiousness ?? DEFAULT_TRAITS.conscientiousness,
    extraversion: fm.extraversion ?? DEFAULT_TRAITS.extraversion,
    agreeableness: fm.agreeableness ?? DEFAULT_TRAITS.agreeableness,
    neuroticism: fm.neuroticism ?? DEFAULT_TRAITS.neuroticism,
    formality: fm.formality ?? DEFAULT_TRAITS.formality,
    tsundere: fm.tsundere ?? DEFAULT_TRAITS.tsundere,
    sarcasm: fm.sarcasm ?? DEFAULT_TRAITS.sarcasm,
  };
}

// ==============================================================
// Build a SoulDefinition from the user-level IDENTIFY.md + SOUL.md + USER.md
// ============================================================== 

function buildSoul(
  metadata: Record<string, any>,
  systemPrompt: string,
  userProfile?: string,
): SoulDefinition {
  return {
    name: typeof metadata.name === "string" ? metadata.name : "Soul",
    emoji: typeof metadata.emoji === "string" ? metadata.emoji : "󰊠",
    description: typeof metadata.description === "string" ? metadata.description : "User-defined soul",
    traits: buildTraits(metadata),
    systemPrompt,
    ...(userProfile ? { userProfile } : {}),
  };
}

// ==============================================================
// Cache and public API
// ==============================================================

let cachedSoul: SoulDefinition | null | undefined = undefined;
let cachedWarnings: string[] = [];
let cachedStamp: SoulCacheStamp | undefined = undefined;

/** Clear the soul cache; called by /persona reload */
export function invalidateSoulCache(): void {
  cachedSoul = undefined;
  cachedWarnings = [];
  cachedStamp = undefined;
}

/**
 * Load the single active soul.
 *
 * Reads ~/.pi/agent/SOUL.md only:
 * - if SOUL.md is missing or its body is empty, no soul is loaded
 * - if IDENTIFY.md exists, its frontmatter is used as metadata
 * - if IDENTIFY.md is missing, default metadata is used
 * - if USER.md exists with a non-empty body, it is injected as optional user context
 *
 * The id field in IDENTIFY.md is ignored; the current implementation no longer needs a unique id.
 */
export function loadSoul(options: LoadSoulOptions = {}): SoulDefinition | null {
  const currentStamp = getSoulCacheStamp();

  if (cachedSoul !== undefined && sameSoulCacheStamp(cachedStamp, currentStamp)) {
    for (const warning of cachedWarnings) options.onWarning?.(warning);
    return cachedSoul;
  }

  const warnings: string[] = [];
  const onWarning = (message: string) => {
    warnings.push(message);
    options.onWarning?.(message);
  };

  const soulPath = userSoulFile();
  const systemPrompt = readMdBody(soulPath);
  if (!systemPrompt) {
    cachedWarnings = warnings;
    cachedSoul = null;
    cachedStamp = currentStamp;
    return null;
  }

  let metadata: Record<string, any> = {};
  try {
    const identifyRaw = fs.readFileSync(userIdentifyFile(), "utf-8");
    metadata = parseMdFrontmatter(identifyRaw, onWarning);
  } catch {
    metadata = {};
  }

  const userProfile = readMdBody(userProfileFile()) ?? undefined;

  cachedWarnings = warnings;
  cachedSoul = buildSoul(metadata, systemPrompt, userProfile);
  cachedStamp = currentStamp;
  return cachedSoul;
}
