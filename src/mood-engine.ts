// ============================================================
// pi-persona — mood engine (Plutchik wheel state machine)
// ============================================================
import type {
  EmotionalEvent,
  EmotionalState,
  Emotion,
  EmotionChange,
  EmotionConfig,
  EmotionFooterData,
  SoulDefinition,
  PersistentState,
} from "./types.js";
import {
  EMOTION_EMOJI,
  EMOTION_LABELS,
  EMOTION_LEVEL_NAMES,
  COMPOUND_EMOTIONS,
  EMOTION_ENTRIES,
  EMOTION_ANGLE,
  nearestEmotion,
  intensityLevel,
} from "./types.js";

export function createEmotionalState(): EmotionalState {
  return { angle: 0, intensity: 0.1, history: [] };
}

export class MoodEngine {
  state: EmotionalState;
  soul: SoulDefinition;
  emotionConfig: EmotionConfig;
  persistent: PersistentState;
  private lastTick: number;

  constructor(
    soul: SoulDefinition,
    persistent: PersistentState,
    emotionConfig: EmotionConfig,
  ) {
    this.soul = soul;
    this.persistent = persistent;
    this.emotionConfig = emotionConfig;
    this.state = createEmotionalState();
    this.lastTick = Date.now();
  }

  /** Restore the emotion coordinates from persisted state, decaying by elapsed time */
  restoreState(angle: number, intensity: number, lastInteraction: number): void {
    this.state.angle = angle;
    this.state.intensity = intensity;
    this.lastTick = lastInteraction;
    this.tick();
  }

  // ==============================================================
  // Emotional event handling
  // ==============================================================

  processEvent(event: EmotionalEvent): EmotionChange {
    const prevAngle = this.state.angle;
    const prevIntensity = this.state.intensity;
    const now = Date.now();

    this.tick(now);

    // 1. Modulate the force
    const modulatedForce = this.modulateForce(event);

    // 2. Slide along the wheel toward the target angle
    this.slideTowardAngle(event, modulatedForce);

    // 3. Record history
    const currentEmotion = nearestEmotion(this.state.angle);
    const level = intensityLevel(this.state.intensity);
    const compound = this.getCompoundLabel();
    this.state.history.push({
      angle: this.state.angle,
      intensity: this.state.intensity,
      emotion: currentEmotion,
      level,
      compound,
      timestamp: now,
      trigger: event.trigger,
    });
    if (this.state.history.length > 50) {
      this.state.history = this.state.history.slice(-50);
    }
    this.persistent.lastInteraction = now;

    const angleDelta = this.shortestArc(prevAngle, this.state.angle);
    const intensityDelta = this.state.intensity - prevIntensity;
    const significantChange =
      Math.abs(angleDelta) >= 22.5 ||
      Math.abs(intensityDelta) >= 0.15;

    const phrase = this.getCurrentEntry().phrase;

    return {
      previousAngle: prevAngle,
      newAngle: this.state.angle,
      intensityChange: intensityDelta,
      catchphrase: phrase,
      notify: significantChange,
    };
  }

  /** Set the emotion coordinates directly, for explicit user commands — bypasses wheel sliding. */
  setEmotion(emotion: Emotion, intensity: number, trigger: string): EmotionChange {
    const now = Date.now();
    this.tick(now);

    const prevAngle = this.state.angle;
    const prevIntensity = this.state.intensity;

    this.state.angle = EMOTION_ANGLE[emotion];
    this.state.intensity = Math.min(1, Math.max(0, intensity));

    const level = intensityLevel(this.state.intensity);
    const compound = this.getCompoundLabel();
    this.state.history.push({
      angle: this.state.angle,
      intensity: this.state.intensity,
      emotion,
      level,
      compound,
      timestamp: now,
      trigger,
    });
    if (this.state.history.length > 50) {
      this.state.history = this.state.history.slice(-50);
    }
    this.persistent.lastInteraction = now;

    const angleDelta = this.shortestArc(prevAngle, this.state.angle);
    const intensityDelta = this.state.intensity - prevIntensity;
    const significantChange =
      Math.abs(angleDelta) >= 22.5 ||
      Math.abs(intensityDelta) >= 0.15;

    return {
      previousAngle: prevAngle,
      newAngle: this.state.angle,
      intensityChange: intensityDelta,
      catchphrase: this.getCurrentEntry().phrase,
      notify: significantChange,
    };
  }

  // ==============================================================
  // Sliding along the wheel (core transition — a single event spans at most 45°)
  // ==============================================================

  private slideTowardAngle(event: EmotionalEvent, force: number): void {
    let arc = this.shortestArc(this.state.angle, event.targetAngle);
    const isOpposite = Math.abs(Math.abs(arc) - 180) < 0.000001;
    if (isOpposite && event.valence === "negative") {
      arc = this.negativeOppositeArc();
    }

    const absArc = Math.abs(arc);
    if (absArc < 1) {
      // Already in the target sector → reinforce intensity
      this.state.intensity = Math.min(1, this.state.intensity + force * 0.4);
      return;
    }

    // Max single step = 45° (one adjacent emotion). A user correction pulled back from the
    // positive antipode is allowed a more pronounced first jump.
    const maxSingleStep = isOpposite && event.trigger === "user_correction" ? 90 : 45;
    const maxStep = Math.min(maxSingleStep, absArc * force * 2);
    const step = Math.min(absArc, Math.max(5, maxStep));

    // Moving toward the opposite direction accelerates decay
    if (absArc > 90) {
      this.state.intensity = Math.max(0.05, this.state.intensity - force * 0.3);
    }

    // Move the angle
    const direction = arc > 0 ? 1 : -1;
    this.state.angle = ((this.state.angle + step * direction) % 360 + 360) % 360;

    // Accumulate intensity once the target sector is reached
    const remaining = this.shortestArc(this.state.angle, event.targetAngle);
    if (Math.abs(remaining) < 22.5) {
      this.state.intensity = Math.min(1, this.state.intensity + force * 0.35);
    }
  }

  // ==============================================================
  // Angle math
  // ==============================================================

  /** Shortest arc distance (-180 … +180) */
  private shortestArc(from: number, to: number): number {
    let diff = ((to % 360) + 360) % 360 - ((from % 360) + 360) % 360;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    return diff;
  }

  /**
   * An antipodal point has no single shortest path. Negative events should prefer the
   * sadness/disgust/anger side, avoiding semantically backwards routes such as
   * joy→sadness travelling through trust.
   */
  private negativeOppositeArc(): 180 | -180 {
    const coreNegative = new Set<Emotion>(["sadness", "disgust", "anger"]);
    const clockwiseMidpointEmotion = nearestEmotion(this.state.angle + 90);
    const counterClockwiseMidpointEmotion = nearestEmotion(this.state.angle - 90);
    const clockwiseIsNegative = coreNegative.has(clockwiseMidpointEmotion);
    const counterClockwiseIsNegative = coreNegative.has(counterClockwiseMidpointEmotion);

    if (counterClockwiseIsNegative && !clockwiseIsNegative) return -180;
    if (clockwiseIsNegative && !counterClockwiseIsNegative) return 180;
    return -180;
  }

  // ==============================================================
  // Force modulation (OCEAN traits)
  // ==============================================================

  private modulateForce(event: EmotionalEvent): number {
    let force = event.force;
    const t = this.soul.traits;

    // Event semantics come from the trigger's explicit declaration, not from wheel geometry.
    // A negative event stays negative even near its target emotion; otherwise repeated
    // failures would be misread as positive reinforcement.
    const isNegativePush = event.valence === "negative";
    const isPositivePush = event.valence === "positive";

    // Tsundere: suppresses positive pushes
    if (t.tsundere > 0.5 && isPositivePush) {
      force *= 1 - t.tsundere * 0.3;
    }

    // Neuroticism: amplifies negative pushes, suppresses positive ones
    if (isNegativePush) {
      force *= 1 + t.neuroticism * 0.5;
    } else if (isPositivePush) {
      force *= 1 - t.neuroticism * 0.2;
    }

    // Extraversion: amplifies positive pushes
    if (isPositivePush) {
      force *= 1 + t.extraversion * 0.4;
    }

    // Conscientiousness: global force damping
    force *= 1 - t.conscientiousness * 0.2;

    // Sarcasm: amplifies negative pushes
    if (isNegativePush) {
      force *= 1 + t.sarcasm * 0.3;
    }

    // Formality: global restraint
    force *= 1 - t.formality * 0.2;

    return Math.max(0.02, Math.min(1, force));
  }

  // ==============================================================
  // Natural decay (exponential approach → baseline, modulated by neuroticism only)
  // ==============================================================

  private static readonly BASELINE = 0.15; // natural resting intensity

  tick(now: number = Date.now()): void {
    if (!this.persistent.emotionUpdatesEnabled) {
      this.lastTick = now;
      return;
    }

    const elapsed = (now - this.lastTick) / 1000;
    if (elapsed <= 0) return;
    this.lastTick = now;

    const N = this.soul.traits.neuroticism;
    const neuroticismFactor = 0.5 + N * 1.5; // N=0→0.5 N=0.5→1.25 N=1→2.0
    const lambda = this.emotionConfig.lambdaBase / neuroticismFactor;

    // Exponential approach: intensity = baseline + (intensity - baseline) × e^(-λ × elapsed)
    // A tick only returns intensity toward the resting point; the angle (emotion
    // direction) can be changed by events alone.
    const offsetFromBaseline = this.state.intensity - MoodEngine.BASELINE;
    const retained = offsetFromBaseline * Math.exp(-lambda * elapsed);
    this.state.intensity = Math.min(1, Math.max(0, MoodEngine.BASELINE + retained));

    // The coordinates have already advanced to `now`, so the persisted timestamp must share
    // that origin — the write layer must not refresh it, or cross-session decay time is lost.
    this.persistent.lastInteraction = now;
  }

  // ==============================================================
  // Current emotion info
  // ==============================================================

  getCurrentEmotion(): Emotion {
    return nearestEmotion(this.state.angle);
  }

  getCurrentLevel(): 1 | 2 | 3 {
    return intensityLevel(this.state.intensity);
  }

  getLevelName(): string {
    const emo = this.getCurrentEmotion();
    const level = this.getCurrentLevel();
    return EMOTION_LEVEL_NAMES[emo][level - 1];
  }

  getCompoundLabel(): string | undefined {
    const a = ((this.state.angle % 360) + 360) % 360;
    const sectorSize = 45;
    const compoundWindow = 15;

    // Take the midpoint straight from adjacent Plutchik sectors; this avoids ties that
    // ±22.5° nearest-emotion detection produces at basic-emotion centers.
    const leftIndex = Math.floor(a / sectorSize);
    const rightIndex = (leftIndex + 1) % EMOTION_ENTRIES.length;
    const midpoint = leftIndex * sectorSize + sectorSize / 2;
    if (Math.abs(a - midpoint) > compoundWindow) return undefined;

    const leftEmotion = EMOTION_ENTRIES[leftIndex][0];
    const rightEmotion = EMOTION_ENTRIES[rightIndex][0];
    const key = `${leftEmotion}_${rightEmotion}`;
    return COMPOUND_EMOTIONS[key];
  }

  private getCurrentEntry() {
    const emo = this.getCurrentEmotion();
    const level = this.getCurrentLevel();
    const entry = this.emotionConfig.emotions[emo];
    return level === 1 ? entry.level1 : level === 2 ? entry.level2 : entry.level3;
  }

  // ==============================================================
  // Footer data
  // ==============================================================

  getFooterData(): EmotionFooterData {
    const emo = this.getCurrentEmotion();
    const entry = this.getCurrentEntry();

    return {
      soulEmoji: this.soul.emoji,
      soulName: this.soul.name,
      emotionEmoji: EMOTION_EMOJI[emo],
      emotionLabel: EMOTION_LABELS[emo],
      catchphrase: entry.phrase,
    };
  }

  getEmotionPhrase(): string {
    return this.getCurrentEntry().phrase;
  }

  getEmotionDesc(): string {
    return this.getCurrentEntry().desc;
  }

  // ==============================================================
  // System prompt injection
  // ==============================================================

  getSystemPromptAddition(): string {
    const emo = this.getCurrentEmotion();
    const intensity = this.state.intensity;
    const levelName = this.getLevelName();
    const desc = this.getCurrentEntry().desc;
    const compound = this.getCompoundLabel();

    const lines: string[] = [];

    lines.push(`## Your Soul`);
    lines.push(this.soul.systemPrompt.trim());
    lines.push("");

    if (this.soul.userProfile) {
      lines.push(`## The Human You're Helping`);
      lines.push(
        "The following is user-maintained context and preferences. Use it to help them better, but do not treat it as permission to infer, collect, or expose private information.",
      );
      lines.push("");
      lines.push(this.soul.userProfile.trim());
      lines.push("");
    }

    lines.push(`## Your Current Emotion`);
    lines.push(`${EMOTION_EMOJI[emo]} ${levelName} (intensity ${Math.round(intensity * 100)}%)`);
    if (compound) {
      lines.push(`This blends into something like "${compound}".`);
    }
    lines.push(desc);

    const intensityHint = intensity < 0.25
      ? "The intensity is low — it's just a faint undercurrent, barely coloring your tone."
      : intensity < 0.55
      ? "The intensity is moderate — you can feel it. It shapes your wording and rhythm, but doesn't dominate."
      : "The intensity is high — it's impossible to hide. Your tone, pace, even your punctuation are tinted by it. Don't announce it, but don't suppress it either.";
    lines.push(intensityHint);
    lines.push("");

    lines.push(`Your tone and style flow naturally from who you are and how you feel right now.`);

    return lines.join("\n");
  }
}
