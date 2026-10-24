import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
function luminance(hex: string): number {
  const rgb = hex.replace("#", "").match(/../g)!.map((value) => parseInt(value, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string): number { const one = luminance(a); const two = luminance(b); return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05); }
test("read/muted announcement text meets 4.5:1 on normal and hovered desktop surfaces", async () => {
  const css = await readFile(new URL("../../index.css", import.meta.url), "utf8");
  for (const [index, theme] of ["light", "dark"].entries()) {
    const body = index ? css.match(/  \.dark \{([\s\S]*?)\n  \}/)![1] : css.match(/  :root \{([\s\S]*?)\n  \}/)![1];
    const value = (property: string) => body.match(new RegExp(`--${property}: (#[0-9a-f]{6})`))![1];
    const scoped = [...css.matchAll(/--announcement-muted:\s*(#[0-9a-f]{6})/g)][index]?.[1];
    const text = scoped ?? value("text-muted");
    for (const background of [value("surface"), value("surface-hover"), value("surface-elevated")]) assert.ok(contrast(text, background) >= 4.5, `${theme}: ${text} on ${background}: ${contrast(text, background).toFixed(2)}:1`);
  }
});
