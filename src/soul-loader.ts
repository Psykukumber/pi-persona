// ============================================================
// pi-persona — soul loader
// Customisation: ~/.pi/agent/IDENTIFY.md (metadata) + ~/.pi/agent/SOUL.md (prose body)
//                + ~/.pi/agent/USER.md (optional user-maintained preferences and context)
// Only the user-level ~/.pi/agent/ is read; with no SOUL.md there, no soul is loaded or injected.
// ============================================================
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import matter from "gray-matter";
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

function userHomeDir(): string {
  return process.env.HOME || os.homedir();
}

function userIdentifyFile(): string {
  return path.join(userHomeDir(), ".pi", "agent", "IDENTIFY.md");
}

function userSoulFile(): string {
  return path.join(userHomeDir(), ".pi", "agent", "SOUL.md");
}

function userProfileFile(): string {
  return path.join(userHomeDir(), ".pi", "agent", "USER.md");
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
    const parsed = matter(raw);
    const fm: Record<string, any> = parsed.data as Record<string, any>;
    // Numeric field conversion. Invalid values no longer silently become 0.5 — they warn
    // and fall back to DEFAULT_TRAITS.
    for (const key of NUMERIC_KEYS) {
      const value = fm[key];
      if (value === undefined) continue;

      const n = typeof value === "number" ? value : Number(value);
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
    return {};
  }
}

/**
 * Read the body of a .md file (skipping the --- frontmatter --- block) using gray-matter
 */
function readMdBody(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return matter(raw).content.trim() || null;
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
    name: metadata.name ?? "Soul",
    emoji: metadata.emoji ?? "󰊠",
    description: metadata.description ?? "User-defined soul",
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
