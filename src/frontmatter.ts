import { parseDocument } from "yaml";

/** Split YAML frontmatter without interpreting the prose or executing language tags. */
export function splitFrontmatter(raw: string): { yaml: string; content: string } {
  const opening = /^(?:\uFEFF)?---(?:ya?ml)?[\t ]*\r?\n/.exec(raw);
  if (!opening) return { yaml: "", content: raw };

  const rest = raw.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) throw new Error("Unterminated YAML frontmatter");

  return {
    yaml: rest.slice(0, closing.index),
    content: rest.slice(closing.index + closing[0].length),
  };
}

/** Accept only a mapping, with bounded alias expansion and no executable YAML types. */
export function parseFrontmatter(raw: string): Record<string, unknown> {
  const { yaml } = splitFrontmatter(raw);
  const document = parseDocument(yaml, { schema: "core", uniqueKeys: true });
  if (document.errors.length || document.warnings.length) {
    throw new Error("Invalid or unsupported YAML frontmatter");
  }
  const data: unknown = document.toJS({ maxAliasCount: 50 });
  if (data == null) return Object.create(null);
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error("YAML frontmatter must be a mapping");
  }
  // Never let inherited object properties become persona metadata.
  return Object.assign(Object.create(null), data);
}
