// ============================================================
// pi-persona — footer mood display
// ============================================================
import type { MoodEngine } from "./mood-engine.js";

export function getFooterStatusText(engine: MoodEngine): string {
  const data = engine.getFooterData();
  return `󰊠 ${data.soulName}·${data.emotionLabel}`;
}

export function tickAndGetFooterText(engine: MoodEngine): string {
  engine.tick();
  return getFooterStatusText(engine);
}
