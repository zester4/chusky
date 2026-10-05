import test from "node:test";
import assert from "node:assert/strict";
import { transformSync } from "esbuild";
import { chuckTools } from "../src/agentTools.js";
import { buildAppTemplateFiles, resolveAppDesign } from "../src/lib/daytona/appTemplates.js";

const archetypes = ["saas-dashboard", "fintech-dashboard", "hr-dashboard", "waitlist", "portfolio", "business-site"] as const;
const styles = ["harbor", "ledger", "grove", "editorial", "signal", "nocturne"] as const;

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
    assert.match(files["src/App.tsx"], new RegExp(`composition-${archetype}`));
    assert.match(files["src/App.tsx"], /data-state-contract="loading empty error success responsive reduced-motion"/);
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

test("nocturne provides an opt-in editorial landing style without changing dashboard composition", () => {
  const appTool = chuckTools.find((tool) => tool.function.name === "CHUCK_DAYTONA_APP");
  assert.ok(appTool);
  assert.ok((appTool.function.parameters.properties.style as { enum: readonly string[] }).enum.includes("nocturne"));

  const landing = buildAppTemplateFiles("vite-react", "business-site", "nocturne", "studio-site");
  assert.match(landing["src/App.tsx"], /className="app business-site composition-business-site style-nocturne editorial-landing"/);
  assert.match(landing["src/index.css"], /--color-canvas:#0e0c08/);
  assert.match(landing["src/index.css"], /--color-primary:#f0c34e/);
  assert.match(landing["src/index.css"], /--shadow:none/);
  assert.match(landing["src/index.css"], /\.editorial-landing \.overline/);
  assert.match(landing["src/index.css"], /font-style:italic/);
  assert.match(landing["src/index.css"], /prefers-reduced-motion/);

  const dashboard = buildAppTemplateFiles("vite-react", "saas-dashboard", "nocturne", "studio-dashboard");
  assert.match(dashboard["src/App.tsx"], /className="app saas-dashboard composition-saas-dashboard style-nocturne"/);
  assert.doesNotMatch(dashboard["src/App.tsx"], /editorial-landing/);
  assert.match(dashboard["src/App.tsx"], /dashboard-nav/);
});

test("scaffold briefs replace generic opening copy and visible technical ids", () => {
  const files = buildAppTemplateFiles("vite-react", "business-site", "grove", "greenroom", {
    projectName: "Greenroom Studio",
    brief: "A calm client workspace for independent interior teams to align on materials, approvals, and next steps.",
    audience: "INTERIOR TEAMS",
    primaryAction: "Start a project",
  });
  assert.match(files["src/App.tsx"], /Greenroom Studio/);
  assert.match(files["src/App.tsx"], /A calm client workspace for independent interior teams/);
  assert.match(files["src/App.tsx"], /INTERIOR TEAMS/);
  assert.match(files["src/App.tsx"], /Start a project/);
  assert.doesNotMatch(files["src/App.tsx"], /Spaces that feel like you/);
});

test("design inputs reject unsupported values instead of silently selecting a look", () => {
  assert.throws(() => resolveAppDesign("linkedin" as never, "auto"), /archetype/i);
  assert.throws(() => resolveAppDesign("portfolio", "violet" as never), /style/i);
});
