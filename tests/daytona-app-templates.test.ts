import test from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { buildAppTemplateFiles, resolveAppDesign } from "../src/lib/daytona/appTemplates.js";

const archetypes = ["saas-dashboard", "fintech-dashboard", "hr-dashboard", "waitlist", "portfolio", "business-site"] as const;
const styles = ["harbor", "ledger", "grove", "editorial", "signal"] as const;

test("every app archetype resolves to an intentional non-purple design direction", () => {
  const expectedStyles = ["harbor", "ledger", "grove", "editorial", "signal", "grove"];
  archetypes.forEach((archetype, index) => {
    const design = resolveAppDesign(archetype, "auto");
    assert.equal(design.archetype, archetype);
    assert.equal(design.style, expectedStyles[index]);
    assert.ok(design.label.length > 0);
    assert.ok(design.fonts.heading.length > 0);
    assert.ok(design.fonts.body.length > 0);
    assert.doesNotMatch(design.colors.primary, /#(?:7c3aed|8b5cf6|a855f7)/i);
  });
});

test("all explicit design styles produce framework-ready, responsive starter files", () => {
  for (const archetype of archetypes) for (const style of styles) {
    const files = buildAppTemplateFiles("vite-react", archetype, style, "sample-app");
    assert.deepEqual(Object.keys(files).sort(), ["index.html", "src/App.tsx", "src/index.css"]);
    assert.match(files["src/App.tsx"], /export default function App/);
    assert.match(files["src/App.tsx"], new RegExp(`className="app ${archetype} `));
    assert.match(files["src/index.css"], /@media\s*\(max-width:\s*760px\)/);
    assert.match(files["src/index.css"], /--color-primary:/);
    assert.match(files["src/index.css"], /scrollbar-width:\s*thin/);
    assert.match(files["src/index.css"], /scroll-behavior:\s*smooth/);
    assert.match(files["src/index.css"], /prefers-reduced-motion/);
    assert.match(files["src/index.css"], /--control-height:\s*34px/);
    assert.match(files["src/App.tsx"], /SAMPLE CONTENT/);
    const ids = new Set([...files["src/App.tsx"].matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
    for (const [, target] of files["src/App.tsx"].matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(target), `${archetype} links to missing #${target}`);
    if (archetype.endsWith("dashboard")) {
      assert.match(files["src/App.tsx"], /dashboard-nav/);
      assert.match(files["src/App.tsx"], /dashboard-shell/);
    }
    assert.match(files["index.html"], /<title>sample-app<\/title>/);
    assert.doesNotThrow(() => transformSync(files["src/App.tsx"], { loader: "tsx", jsx: "automatic" }));
  }
});

test("Next.js templates use the same archetype and design tokens without replacing app behavior", () => {
  const files = buildAppTemplateFiles("nextjs", "fintech-dashboard", "ledger", "ledger-demo");
  assert.deepEqual(Object.keys(files).sort(), ["app/globals.css", "app/layout.tsx", "app/page.tsx"]);
  assert.match(files["app/page.tsx"], /className="app fintech-dashboard /);
  assert.match(files["app/globals.css"], /--color-primary:/);
  assert.match(files["app/layout.tsx"], /Ledger \/ forest ink and fresh green/);
  assert.doesNotThrow(() => transformSync(files["app/page.tsx"], { loader: "tsx", jsx: "automatic" }));
});

test("design inputs reject unsupported values instead of silently selecting a look", () => {
  assert.throws(() => resolveAppDesign("linkedin" as never, "auto"), /archetype/i);
  assert.throws(() => resolveAppDesign("portfolio", "violet" as never), /style/i);
});
