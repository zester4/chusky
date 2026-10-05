import { randomInt, randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { DaytonaEngine } from "../src/lib/daytona/engine.js";
import { initStore } from "../src/store.js";

const appSource = String.raw`import { useEffect, useState } from "react";

const features = [
  { number: "01", eyebrow: "BUILD", title: "A computer with a memory.", body: "Give your agent a real workspace to shape: files, dependencies, terminals, and durable projects that stay ready for the next move." },
  { number: "02", eyebrow: "SEE", title: "Work you can watch.", body: "From a live desktop to a signed app preview, Chusky makes progress legible. You see the work, the evidence, and the moment it is ready." },
  { number: "03", eyebrow: "MOVE", title: "From intent to artifact.", body: "A clear brief becomes a working app, a polished file, or a verified handoff—without losing the thread between thought and execution." },
];

function App() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const nodes = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) entry.target.classList.add("is-visible");
    }), { threshold: 0.16 });
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  return <main className="page" id="top">
    <header className="site-header">
      <a className="wordmark" href="#top"><span className="mark">C</span><span>chusky</span></a>
      <nav><a href="#how">How it works</a><a href="#features">Capabilities</a><a className="header-cta" href="#try">Open the computer <span>↗</span></a></nav>
    </header>

    <section className="hero" data-reveal>
      <div className="hero-copy">
        <div className="kicker"><span className="live-dot" /> DAYTONA RUNTIME · PRIVATE BY DEFAULT</div>
        <h1>Your agent,<br /><em>with a place</em><br />to work.</h1>
        <p className="hero-lede">Chusky gives your agent a real computer for the work that needs one—building, running, inspecting, and handing back something you can use.</p>
        <div className="hero-actions"><a className="button button-primary" href="#try">See the workspace <span>↓</span></a><a className="text-link" href="#how">Follow the loop <span>↘</span></a></div>
      </div>
      <div className="hero-stage" aria-label="Animated preview of a Chusky Daytona computer workspace">
        <div className="orbit orbit-a" /><div className="orbit orbit-b" /><div className="sun" />
        <div className="floating-note note-a">agent / online<br /><b>ready to make</b></div>
        <div className="floating-note note-b">LIVE PREVIEW<br /><b>port 5173 ↗</b></div>
        <div className="computer-window">
          <div className="window-bar"><span className="window-dots"><i /><i /><i /></span><span className="window-title">chusky · private workspace</span><span className="window-lock">⌁ encrypted</span></div>
          <div className="window-body"><aside><span className="side-label">WORKSPACE</span><span className="side-item active">◈ Overview</span><span className="side-item">⌘ Projects</span><span className="side-item">◌ Activity</span><span className="side-item">↗ Previews</span></aside><div className="workspace-main"><div className="workspace-top"><div><span className="mini-label">TUESDAY · 09:41</span><h2>Make something<br /><em>worth opening.</em></h2></div><span className="status-chip"><i /> working</span></div><div className="terminal"><div className="terminal-head"><span>AGENT / BUILD LOG</span><span>● LIVE</span></div><p><b>$</b> chusky build --preview</p><p className="muted-line">↳ reading the brief</p><p className="muted-line">↳ shaping the interface</p><p className="bright-line">↳ preview ready <span>100%</span></p></div><div className="progress"><span /></div></div></div>
        </div>
      </div>
    </section>

    <section className="manifest" id="how" data-reveal><div className="section-label">A DIFFERENT KIND OF TOOL</div><p>Not a chat window pretending to be a computer. A computer that knows how to work with you.</p><span className="manifest-mark">✳</span></section>

    <section className="features" id="features" data-reveal><div className="section-intro"><span className="section-label">THE CAPABILITY STACK</span><h2>Make the distance<br /><em>between idea and done</em><br />feel smaller.</h2></div><div className="feature-list">{features.map((feature, index) => <button className={active === index ? "feature active" : "feature"} key={feature.number} onClick={() => setActive(index)}><span className="feature-number">{feature.number}</span><span className="feature-copy"><span className="section-label">{feature.eyebrow}</span><strong>{feature.title}</strong><span>{feature.body}</span></span><span className="feature-arrow">{active === index ? "↘" : "↗"}</span></button>)}</div></section>

    <section className="quote" data-reveal><span className="quote-mark">“</span><blockquote>The best agent is not the one that talks the most. It is the one that leaves you with something real.</blockquote><div className="quote-byline"><span className="avatar">J</span><span>Jev / Chusky runtime<br /><small>Mission control, with a desk</small></span></div></section>

    <section className="final-cta" id="try" data-reveal><div><span className="section-label">THE WORKSPACE IS OPEN</span><h2>Give the next idea<br /><em>somewhere to go.</em></h2></div><a className="button button-dark" href="#top">Start with Chusky <span>↗</span></a></section>
    <footer><span>CHUSKY · AGENT COMPUTER</span><span>DAYTONA / 2026</span><a href="#top">Back to top ↑</a></footer>
  </main>;
}

export default App;
`;

const cssSource = String.raw`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,500;0,600;0,700;1,500;1,600;1,700&display=swap');
:root{font-family:'DM Sans',sans-serif;color:#272522;background:#f5f0e8;font-synthesis:none;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased;--paper:#f5f0e8;--white:#fffdf9;--ink:#272522;--muted:#77736d;--red:#c34f36;--gold:#e7bb73;--line:#e6ded2;--shadow:0 24px 70px rgba(39,37,34,.14)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;min-width:320px;background:var(--paper)}a{color:inherit;text-decoration:none}button{font:inherit;color:inherit}::selection{background:var(--gold);color:var(--ink)}.page{max-width:1480px;margin:auto;padding:28px clamp(20px,5vw,76px) 54px;overflow:hidden}.site-header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding-bottom:18px}.wordmark{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:700;letter-spacing:-.05em}.mark{display:grid;place-items:center;width:29px;height:29px;border-radius:9px;background:var(--ink);color:var(--paper);font-family:'Playfair Display',serif;font-size:18px;font-style:italic}.site-header nav{display:flex;align-items:center;gap:27px;color:var(--muted);font-size:12px}.site-header nav a{transition:color .2s ease}.site-header nav a:hover{color:var(--red)}.header-cta{color:var(--ink)!important;font-weight:600}.header-cta span{color:var(--red);font-size:16px}.hero{display:grid;grid-template-columns:.92fr 1.08fr;gap:clamp(30px,6vw,100px);align-items:center;min-height:690px;padding:60px 0 90px}.kicker,.section-label,.mini-label{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;font-weight:600;letter-spacing:.15em;text-transform:uppercase;color:var(--muted)}.kicker{display:flex;align-items:center;gap:9px}.live-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--red);box-shadow:0 0 0 5px rgba(195,79,54,.1);animation:pulse 2s ease-in-out infinite}.hero h1{font:500 clamp(57px,7vw,106px)/.9 'Playfair Display',serif;letter-spacing:-.065em;margin:27px 0 25px}.hero h1 em,.section-intro h2 em,.final-cta h2 em{color:var(--red);font-weight:500}.hero-lede{max-width:465px;color:var(--muted);font-size:16px;line-height:1.65}.hero-actions{display:flex;align-items:center;gap:23px;margin-top:31px}.button{display:inline-flex;align-items:center;justify-content:center;gap:19px;min-height:45px;padding:0 18px;border-radius:999px;font-size:12px;font-weight:700;transition:transform .22s ease,box-shadow .22s ease,background .22s ease}.button:hover{transform:translateY(-3px);box-shadow:0 12px 25px rgba(39,37,34,.12)}.button-primary{background:var(--red);color:#fff}.button-dark{background:var(--ink);color:var(--paper);padding-inline:22px}.text-link{font-size:12px;font-weight:600}.text-link span{color:var(--red);font-size:18px;margin-left:6px}.hero-stage{position:relative;min-height:520px;display:grid;place-items:center;isolation:isolate}.sun{position:absolute;width:260px;height:260px;border-radius:50%;background:var(--gold);opacity:.82;filter:blur(.2px);animation:float 7s ease-in-out infinite}.orbit{position:absolute;border:1px solid rgba(195,79,54,.24);border-radius:50%;transform:rotate(-21deg);animation:spin 28s linear infinite}.orbit-a{width:91%;height:45%;}.orbit-b{width:72%;height:70%;transform:rotate(63deg);animation-direction:reverse;animation-duration:36s}.computer-window{position:relative;width:min(100%,630px);border:1px solid rgba(39,37,34,.13);border-radius:16px;background:var(--white);box-shadow:var(--shadow);transform:rotate(-3deg);animation:windowIn 1.1s cubic-bezier(.2,.8,.2,1) both;overflow:hidden}.window-bar{height:42px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 15px;color:var(--muted);font:9px ui-monospace,monospace;letter-spacing:.06em}.window-dots{display:flex;gap:5px}.window-dots i{width:7px;height:7px;border-radius:50%;background:var(--line)}.window-dots i:first-child{background:#e79b83}.window-lock{color:#73906d}.window-body{display:grid;grid-template-columns:142px 1fr;min-height:310px}.window-body aside{padding:21px 13px;border-right:1px solid var(--line);background:#faf6f0}.side-label{display:block;margin:0 9px 14px;color:var(--muted);font:8px ui-monospace,monospace;letter-spacing:.14em}.side-item{display:block;padding:10px 9px;border-radius:7px;color:var(--muted);font-size:10px;margin:3px 0}.side-item.active{background:rgba(195,79,54,.1);color:var(--red);font-weight:700}.workspace-main{padding:29px 26px}.workspace-top{display:flex;justify-content:space-between;gap:12px}.workspace-top h2{font:500 30px/.98 'Playfair Display',serif;letter-spacing:-.055em;margin:10px 0 28px}.workspace-top h2 em{color:var(--red)}.status-chip{align-self:flex-start;border:1px solid #d8e6d4;border-radius:999px;padding:6px 9px;color:#62815e;font:9px ui-monospace,monospace}.status-chip i{display:inline-block;width:5px;height:5px;margin-right:5px;border-radius:50%;background:#6caa65;animation:pulse 1.8s infinite}.terminal{background:var(--ink);border-radius:9px;color:#f5f0e8;padding:15px 16px;font:11px/1.7 ui-monospace,SFMono-Regular,monospace;box-shadow:0 13px 24px rgba(39,37,34,.14)}.terminal-head{display:flex;justify-content:space-between;color:#a99e91;font-size:8px;letter-spacing:.12em;margin-bottom:15px}.terminal-head span:last-child{color:#8fd694}.terminal p{margin:5px 0}.terminal b{color:var(--gold)}.muted-line{color:#a99e91}.bright-line{color:#d5efca}.bright-line span{float:right;color:#8fd694}.progress{height:3px;margin-top:16px;background:#eee6dc;overflow:hidden}.progress span{display:block;width:78%;height:100%;background:var(--red);animation:progress 2.8s ease-in-out infinite alternate}.floating-note{position:absolute;z-index:2;padding:11px 13px;background:var(--white);border:1px solid var(--line);box-shadow:0 12px 25px rgba(39,37,34,.08);font:9px/1.4 ui-monospace,monospace;letter-spacing:.08em;color:var(--muted);animation:float 6s ease-in-out infinite}.floating-note b{font:600 12px 'DM Sans',sans-serif;color:var(--ink);letter-spacing:-.02em}.note-a{top:11%;left:2%;transform:rotate(-8deg)}.note-b{right:0;bottom:12%;transform:rotate(6deg);animation-delay:-2s}.manifest{position:relative;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:42px 20% 48px 0}.manifest p{font:500 clamp(31px,4.4vw,61px)/1.05 'Playfair Display',serif;letter-spacing:-.055em;max-width:760px;margin:14px 0 0}.manifest-mark{position:absolute;right:4%;top:50%;font-size:72px;color:var(--red);animation:spin 24s linear infinite}.features{display:grid;grid-template-columns:.85fr 1.15fr;gap:clamp(35px,8vw,120px);padding:118px 0}.section-intro h2{font:500 clamp(40px,5vw,71px)/.98 'Playfair Display',serif;letter-spacing:-.06em;margin:25px 0}.feature-list{border-top:1px solid var(--line)}.feature{width:100%;display:grid;grid-template-columns:43px 1fr 25px;gap:16px;text-align:left;border:0;border-bottom:1px solid var(--line);background:transparent;padding:27px 0;cursor:pointer;transition:padding .3s ease}.feature:hover,.feature.active{padding-left:10px}.feature-number{font:11px ui-monospace,monospace;color:var(--red)}.feature-copy{display:flex;flex-direction:column;gap:8px}.feature-copy strong{font:500 24px 'Playfair Display',serif;letter-spacing:-.035em}.feature-copy>span:last-child{max-width:460px;color:var(--muted);font-size:12px;line-height:1.6}.feature-arrow{font-size:22px;color:var(--red);transition:transform .3s ease}.feature.active .feature-arrow{transform:rotate(-45deg)}.quote{max-width:850px;margin:0 auto;padding:75px 0 125px;text-align:center}.quote-mark{display:block;color:var(--red);font:100px/.5 'Playfair Display',serif;height:53px}.quote blockquote{font:500 clamp(29px,4vw,52px)/1.08 'Playfair Display',serif;letter-spacing:-.05em;margin:0}.quote-byline{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:29px;color:var(--muted);font:10px/1.4 ui-monospace,monospace;text-align:left}.quote-byline small{font:10px 'DM Sans',sans-serif}.avatar{display:grid;place-items:center;width:29px;height:29px;border-radius:50%;background:var(--gold);color:var(--ink);font:700 12px 'Playfair Display',serif}.final-cta{display:flex;justify-content:space-between;align-items:end;gap:25px;border-top:1px solid var(--line);padding:63px 0 71px}.final-cta h2{font:500 clamp(45px,6vw,82px)/.94 'Playfair Display',serif;letter-spacing:-.065em;margin:19px 0 0}footer{display:flex;justify-content:space-between;border-top:1px solid var(--line);padding-top:19px;color:var(--muted);font:9px ui-monospace,monospace;letter-spacing:.1em}footer a{color:var(--ink)}[data-reveal]{opacity:0;transform:translateY(28px);transition:opacity .8s ease,transform .8s cubic-bezier(.2,.8,.2,1)}[data-reveal].is-visible{opacity:1;transform:none}@keyframes windowIn{from{opacity:0;transform:translateY(26px) rotate(-7deg)}to{opacity:1;transform:rotate(-3deg)}}@keyframes float{0%,100%{translate:0 0}50%{translate:0 -13px}}@keyframes spin{to{rotate:360deg}}@keyframes pulse{0%,100%{opacity:.55;scale:1}50%{opacity:1;scale:1.18}}@keyframes progress{from{width:62%}to{width:94%}}@media(max-width:860px){.site-header nav a:not(.header-cta){display:none}.hero{grid-template-columns:1fr;padding:55px 0 72px}.hero-stage{min-height:470px}.features{grid-template-columns:1fr;padding:85px 0}.manifest{padding-right:12%}.final-cta{align-items:start;flex-direction:column}}@media(max-width:580px){.page{padding-inline:18px}.hero h1{font-size:61px}.hero-stage{min-height:385px;transform:scale(.92);transform-origin:center}.window-body{grid-template-columns:1fr}.window-body aside{display:none}.workspace-main{padding:22px 18px}.floating-note{font-size:8px}.note-a{left:-3%}.note-b{right:-5%}.manifest{padding:38px 0}.manifest p{font-size:34px}.manifest-mark{font-size:48px;right:2%;top:23%}.feature-copy strong{font-size:21px}.final-cta h2{font-size:55px}footer{gap:15px;flex-wrap:wrap}footer span:nth-child(2){display:none}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important;transition-duration:.01ms!important}}
`;

async function main(): Promise<void> {
  if (process.env.DAYTONA_LIVE_TEST !== "1") throw new Error("Refusing live Daytona work. Re-run with DAYTONA_LIVE_TEST=1.");
  if (!config.daytonaApiKey) throw new Error("DAYTONA_API_KEY is required.");
  await initStore({ memoryOnly: true });
  const userId = 910_000_000 + randomInt(89_999_999);
  const engine = new DaytonaEngine();
  const appId = `chusky-editorial-${randomUUID().slice(0, 8)}`;
  let created = false;
  let workspaceId = "";
  try {
    const workspace = await engine.workspace(userId, "create") as { id?: string };
    created = true;
    workspaceId = String(workspace.id ?? "");
    const scaffold = await engine.app(userId, { action: "scaffold", id: appId, framework: "vite-react", archetype: "waitlist", style: "editorial" }) as { status?: string };
    if (scaffold.status !== "scaffolded") throw new Error("Editorial scaffold failed.");
    await engine.writeFile(userId, `workspace/apps/${appId}/src/App.tsx`, appSource);
    await engine.writeFile(userId, `workspace/apps/${appId}/src/index.css`, cssSource);
    await engine.writeFile(userId, `workspace/apps/${appId}/index.html`, `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><meta name="theme-color" content="#f5f0e8"/><meta name="description" content="Chusky gives your agent a real computer for the work that needs one."/><title>Chusky · Agent Computer</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`);
    const started = await engine.app(userId, { action: "start", id: appId, expiresInSeconds: 3600 }) as { url?: string; previewUrl?: string; status?: string; verification?: { status?: string; visual?: unknown } };
    const url = String(started.url ?? started.previewUrl ?? "").trim();
    if (!/^https:\/\//i.test(url) || started.status !== "running" || started.verification?.status !== "passed") throw new Error("Editorial app did not start with passing verification.");
    const response = await fetch(url, { redirect: "follow" });
    const html = await response.text();
    if (!response.ok || !html.includes("Chusky")) throw new Error(`Preview fetch failed: HTTP ${response.status}`);
    console.log(JSON.stringify({ status: "passed", template: "waitlist + editorial", appId, workspaceId, url, httpStatus: response.status, htmlBytes: html.length, retained: true }));
  } catch (error) {
    if (created) await engine.workspace(userId, "delete").catch(() => undefined);
    throw error;
  }
}

void main();
