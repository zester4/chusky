import { readFileSync } from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { DaytonaEngine } from "../src/lib/daytona/engine.js";
import { initStore } from "../src/store.js";

const hero = "C:/Users/mseyy/.codex/generated_images/01a10477-7a93-7653-b90c-c023f0d536ff/exec-c70d4e76-fcc4-41ea-9ce1-153cac04a9b9.png";
const guardian = "C:/Users/mseyy/.codex/generated_images/01a10477-7a93-7653-b90c-c023f0d536ff/exec-0622657e-c3de-458b-8f1b-c17401a38e72.png";
const relic = "C:/Users/mseyy/.codex/generated_images/01a10477-7a93-7653-b90c-c023f0d536ff/exec-3720050c-0415-4ac2-a05a-c8aefe29fc09.png";

const appSource = String.raw`import { useEffect, useState } from "react";
type Point = { x: number; y: number; collected?: boolean };
const initialShards: Point[] = [{ x: 18, y: 26 }, { x: 72, y: 32 }, { x: 31, y: 72 }];
const start = { x: 12, y: 78 };
function distance(a: Point, b: Point) { return Math.hypot(a.x - b.x, a.y - b.y); }
function App() {
  const [player, setPlayer] = useState(start);
  const [shards, setShards] = useState(initialShards);
  const [won, setWon] = useState(false);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === "r") { setPlayer(start); setShards(initialShards); setWon(false); return; }
      const moves: Record<string, Point> = { arrowup: { x: 0, y: -4 }, w: { x: 0, y: -4 }, arrowdown: { x: 0, y: 4 }, s: { x: 0, y: 4 }, arrowleft: { x: -4, y: 0 }, a: { x: -4, y: 0 }, arrowright: { x: 4, y: 0 }, d: { x: 4, y: 0 } };
      const move = moves[key];
      if (!move || won) return;
      event.preventDefault();
      setPlayer((current) => {
        const next = { x: Math.max(7, Math.min(93, current.x + move.x)), y: Math.max(10, Math.min(90, current.y + move.y)) };
        setShards((currentShards) => {
          const updated = currentShards.map((shard) => distance(next, shard) < 7 ? { ...shard, collected: true } : shard);
          if (updated.every((shard) => shard.collected) && distance(next, { x: 84, y: 18 }) < 13) setWon(true);
          return updated;
        });
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [won]);
  const collected = shards.filter((shard) => shard.collected).length;
  return <main className="game-shell"><header><a className="brand" href="#game"><span>A</span> ASHFALL</a><div className="objective">OBJECTIVE <b>{won ? "THE GATE IS OPEN" : collected === shards.length ? "REACH THE RELIC" : "COLLECT THE SHARDS"}</b></div><button className="reset" onClick={() => { setPlayer(start); setShards(initialShards); setWon(false); }}>RESET [R]</button></header><section className="game" id="game"><div className="game-bg" /><div className="vignette" /><div className="game-title"><span>FIELD RECORD / 001</span><h1>Beyond the<br /><i>last fire.</i></h1><p>{won ? "The mountain has answered." : "Move through the storm. Find what the ice remembers."}</p></div><div className="arena" tabIndex={0} aria-label="Playable Ashfall arena. Use WASD or arrow keys to move.">{shards.map((shard, index) => !shard.collected && <span className="shard" key={index} style={{ left: shard.x + "%", top: shard.y + "%" }} aria-label="Rune shard" />)}<span className="relic" style={{ left: "84%", top: "18%" }}><img src="/relic.png" alt="The amber relic" /></span><span className={pulse ? "player pulse" : "player"} style={{ left: player.x + "%", top: player.y + "%" }}><img src="/guardian.png" alt="The Ashfall guardian" /></span><div className="storm" /><div className="gate" style={{ left: "84%", top: "18%" }} /></div><div className="hud"><div><span>SHARDS</span><strong>{collected} / {shards.length}</strong></div><div className="meter"><span style={{ width: (collected / shards.length * 100) + "%" }} /></div><button onClick={() => { setPulse(true); setTimeout(() => setPulse(false), 350); }}>PULSE [SPACE]</button></div>{won && <div className="win"><span>TRANSMISSION RECEIVED</span><h2>The frost<br /><i>remembers.</i></h2><p>You found the first path through.</p><button onClick={() => { setPlayer(start); setShards(initialShards); setWon(false); }}>PLAY AGAIN</button></div>}</section><footer><span>WASD / ARROWS TO MOVE</span><span>COLLECT 3 SHARDS, THEN REACH THE RELIC</span><span>BUILT IN DAYTONA</span></footer></main>;
}
export default App;
`;

const cssSource = String.raw`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&family=Playfair+Display:ital,wght@500;600&display=swap');
:root{font-family:'DM Sans',sans-serif;color:#e9e4dc;background:#080a0d}*{box-sizing:border-box}body{margin:0;min-width:320px;background:#080a0d}button{font:inherit;color:inherit;cursor:pointer}.game-shell{min-height:100vh;background:#080a0d}header,footer{height:70px;display:flex;align-items:center;justify-content:space-between;padding:0 clamp(18px,5vw,64px);font:10px ui-monospace,monospace;letter-spacing:.13em}header{border-bottom:1px solid #ffffff22}.brand{display:flex;align-items:center;gap:10px;color:#fff;text-decoration:none;font-weight:700}.brand span{display:grid;place-items:center;width:26px;height:26px;border:1px solid #fff;border-radius:50%;font:italic 16px 'Playfair Display',serif}.objective{color:#89939c}.objective b{color:#e9814c;margin-left:7px}.reset{border:0;background:transparent;color:#89939c;font:10px ui-monospace,monospace;letter-spacing:.12em}.reset:hover{color:#e9814c}.game{position:relative;min-height:calc(100vh - 140px);overflow:hidden}.game-bg{position:absolute;inset:0;background:url('/hero.png') center/cover;filter:brightness(.42) saturate(.8);animation:drift 18s ease-in-out infinite alternate}.vignette{position:absolute;inset:0;background:radial-gradient(circle at 52% 45%,transparent 10%,#080a0d55 55%,#080a0dee 100%),linear-gradient(0deg,#080a0d 0%,transparent 28%,#080a0d66 100%)}.game-title{position:absolute;z-index:2;left:clamp(18px,7vw,90px);top:clamp(30px,8vw,85px)}.game-title span{color:#a9c9d2;font:9px ui-monospace,monospace;letter-spacing:.17em}.game-title h1{font:500 clamp(46px,6.8vw,92px)/.86 'Playfair Display',serif;letter-spacing:-.08em;margin:18px 0}.game-title h1 i,.win h2 i{color:#e9814c;font-weight:500}.game-title p{max-width:300px;color:#d3d2cb;font-size:13px;line-height:1.5}.arena{position:absolute;inset:0;z-index:1;outline:none}.player,.relic{position:absolute;display:block;transform:translate(-50%,-50%);transition:left .18s ease,top .18s ease}.player{width:72px;height:105px;z-index:4;filter:drop-shadow(0 12px 12px #000)}.player img{width:100%;height:100%;object-fit:contain;object-position:top;mix-blend-mode:screen}.player:after{content:"";position:absolute;left:14px;right:14px;bottom:4px;height:9px;border-radius:50%;background:#e9814c88;filter:blur(6px);animation:glow 1.5s ease-in-out infinite}.player.pulse:before{content:"";position:absolute;inset:-35px;border:2px solid #e9814c;opacity:0;animation:shock .35s ease-out}.shard{position:absolute;z-index:3;width:15px;height:25px;transform:translate(-50%,-50%) rotate(45deg);background:linear-gradient(135deg,#f7d77b,#e9814c 45%,#6bbed4);box-shadow:0 0 13px 5px #f3b25299;animation:shard 1.7s ease-in-out infinite}.shard:after{content:"";position:absolute;inset:4px;background:#fff4c8aa}.relic{width:55px;height:85px;z-index:3;filter:drop-shadow(0 0 24px #e9814c99);animation:float 4s ease-in-out infinite}.relic img{width:100%;height:100%;object-fit:contain;mix-blend-mode:screen}.gate{position:absolute;z-index:2;width:125px;height:125px;transform:translate(-50%,-50%);border:1px solid #e9814c77;border-radius:50%;box-shadow:0 0 45px #e9814c44,inset 0 0 35px #e9814c33;animation:gate 2.6s ease-in-out infinite}.storm{position:absolute;left:54%;top:60%;width:240px;height:150px;border:1px solid #86b7c844;border-radius:50%;transform:rotate(-24deg);box-shadow:0 0 55px #86b7c822;opacity:.8}.hud{position:absolute;z-index:5;left:clamp(18px,7vw,90px);right:clamp(18px,7vw,90px);bottom:31px;display:flex;align-items:center;gap:22px}.hud div:first-child{display:flex;flex-direction:column;gap:5px;font:9px ui-monospace,monospace;letter-spacing:.12em}.hud strong{font-size:16px;letter-spacing:0;color:#fff}.meter{width:180px;height:4px;background:#ffffff33}.meter span{display:block;height:100%;background:#e9814c;transition:width .3s ease}.hud button,.win button{border:1px solid #ffffff55;background:#0c1014cc;padding:10px 13px;font:10px ui-monospace,monospace;letter-spacing:.08em}.hud button:hover,.win button:hover{border-color:#e9814c;color:#e9814c}.win{position:absolute;z-index:8;inset:0;display:grid;place-content:center;text-align:center;background:#080a0dbb;backdrop-filter:blur(7px)}.win>span{color:#8fd694;font:9px ui-monospace,monospace;letter-spacing:.17em}.win h2{font:500 clamp(54px,7vw,92px)/.86 'Playfair Display',serif;letter-spacing:-.08em;margin:20px 0}.win p{color:#aab0b2;margin:0 0 25px}.win button{justify-self:center}.game-shell footer{color:#89939c;gap:18px;border-top:1px solid #ffffff22}.game-shell footer span:first-child{color:#e9814c}@keyframes drift{from{transform:scale(1)}to{transform:scale(1.08) translateX(-1%)}}@keyframes float{0%,100%{transform:translate(-50%,-50%)}50%{transform:translate(-50%,-60%)}}@keyframes shard{0%,100%{scale:1;rotate:45deg}50%{scale:1.18;rotate:135deg}}@keyframes glow{50%{opacity:.45;scale:1.35}}@keyframes shock{to{inset:-90px;opacity:0;border-radius:50%}}@keyframes gate{50%{scale:1.1;opacity:.65}}@media(max-width:650px){header .objective{display:none}.game{min-height:calc(100vh - 140px)}.game-title h1{font-size:56px}.player{width:55px;height:80px}.relic{width:43px;height:65px}.hud{bottom:22px;gap:10px;flex-wrap:wrap}.hud .meter{width:110px}.game-shell footer{height:auto;min-height:70px;flex-wrap:wrap;padding-block:16px}.game-shell footer span:nth-child(2){display:none}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
`;

async function main(): Promise<void> {
  if (process.env.DAYTONA_LIVE_TEST !== "1") throw new Error("Set DAYTONA_LIVE_TEST=1 for live playable preview creation.");
  if (!config.daytonaApiKey) throw new Error("DAYTONA_API_KEY is required.");
  await initStore({ memoryOnly: true });
  const engine = new DaytonaEngine();
  const userId = 940_000_000 + randomInt(59_999_999);
  const appId = `ashfall-play-${randomUUID().slice(0, 8)}`;
  let created = false;
  try {
    const workspace = await engine.workspace(userId, "create") as { id?: string };
    created = true;
    const scaffold = await engine.app(userId, { action: "scaffold", id: appId, framework: "vite-react", archetype: "portfolio", style: "nocturne" }) as { status?: string };
    if (scaffold.status !== "scaffolded") throw new Error("Playable Ashfall scaffold failed.");
    await engine.writeFile(userId, `workspace/apps/${appId}/src/App.tsx`, appSource);
    await engine.writeFile(userId, `workspace/apps/${appId}/src/index.css`, cssSource);
    await engine.writeFile(userId, `workspace/apps/${appId}/index.html`, `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><meta name="theme-color" content="#080a0d"/><title>Ashfall / Playable Field Record</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`);
    const sandbox = await engine.getOrCreateWorkspace(userId);
    await sandbox.fs.uploadFile(readFileSync(hero), `workspace/apps/${appId}/public/hero.png`);
    await sandbox.fs.uploadFile(readFileSync(guardian), `workspace/apps/${appId}/public/guardian.png`);
    await sandbox.fs.uploadFile(readFileSync(relic), `workspace/apps/${appId}/public/relic.png`);
    const started = await engine.app(userId, { action: "start", id: appId, expiresInSeconds: 3600 }) as { url?: string; previewUrl?: string; status?: string; verification?: { status?: string } };
    const url = String(started.url ?? started.previewUrl ?? "").trim();
    if (!/^https:\/\//i.test(url) || started.status !== "running" || started.verification?.status !== "passed") throw new Error("Playable Ashfall app did not start with passing verification.");
    const response = await fetch(url, { redirect: "follow" });
    const html = await response.text();
    const heroResponse = await fetch(new URL("hero.png", url));
    if (!response.ok || !html.includes("id=\"root\"") || !heroResponse.ok || heroResponse.headers.get("content-type")?.includes("image/png") !== true) throw new Error(`Playable preview fetch failed: HTTP ${response.status}`);
    console.log(JSON.stringify({ status: "passed", appId, workspaceId: workspace.id, url, httpStatus: response.status, controls: ["WASD", "arrow keys", "R", "space"], retained: true }));
  } catch (error) {
    if (created) await engine.workspace(userId, "delete").catch(() => undefined);
    throw error;
  }
}

void main();
