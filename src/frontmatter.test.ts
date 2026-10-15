import assert from "node:assert/strict";
import test from "node:test";
import { parseFrontmatter, splitFrontmatter } from "./frontmatter.js";

test("frontmatter parses YAML metadata and preserves prose", () => {
  const raw = "---\nname: Susan\nopenness: 0.7\ndescription: |\n  First line\n  Second line\n---\n# Soul\n";
  assert.equal(parseFrontmatter(raw).name, "Susan");
  assert.equal(parseFrontmatter(raw).openness, 0.7);
  assert.equal(parseFrontmatter(raw).description, "First line\nSecond line\n");
  assert.equal(splitFrontmatter(raw).content, "# Soul\n");
});

test("frontmatter supports BOM, CRLF, explicit YAML and document end markers", () => {
  const raw = "\uFEFF---yaml\r\nname: Susan\r\n...\r\nBody";
  assert.equal(parseFrontmatter(raw).name, "Susan");
  assert.equal(splitFrontmatter(raw).content, "Body");
});

test("ordinary Markdown and horizontal rules are not stripped", () => {
  for (const raw of ["# Soul\n---\nBody", "ordinary prose", ""]) {
    assert.equal(splitFrontmatter(raw).content, raw);
    assert.equal(Object.keys(parseFrontmatter(raw)).length, 0);
  }
});

test("frontmatter requires a closed mapping and valid unique keys", () => {
  for (const raw of ["---\nname: Susan", "---\n- item\n---", "---\ntext\n---", "---\nname: [\n---", "---\nname: A\nname: B\n---"]) {
    assert.throws(() => parseFrontmatter(raw));
  }
});

test("frontmatter rejects executable tags and excessive alias expansion", () => {
  assert.throws(() => parseFrontmatter("---\nname: !!js/function 'function () { return 1; }'\n---"));
  let yaml = "a: &a [x, x, x, x, x, x, x, x, x, x]\n";
  for (const [key, previous] of [["b", "a"], ["c", "b"], ["d", "c"]]) {
    yaml += `${key}: &${key} [${Array(10).fill(`*${previous}`).join(", ")}]\n`;
  }
  assert.throws(() => parseFrontmatter(`---\n${yaml}---`));
});

test("frontmatter metadata has no inherited properties or prototype pollution", () => {
  const data = parseFrontmatter("---\n__proto__: { polluted: true }\nname: Susan\n---");
  assert.equal(Object.getPrototypeOf(data), null);
  assert.equal(data.constructor, undefined);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("body extraction does not parse malformed YAML", () => {
  assert.equal(splitFrontmatter("---\ninvalid: [\n---\nBody").content, "Body");
});
