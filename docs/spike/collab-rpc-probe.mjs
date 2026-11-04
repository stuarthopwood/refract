// OMP /collab over rpc-ui probe (#1638).
//
// Question: can a Session driven by `omp --mode rpc-ui` host OMP `/collab`, and what
// do the frames look like? Findings are in docs/spike/collab-rpc-spike.md.
//
// ISOLATION: brand-new profile (pinion-probe-collab) with an unreachable keyless fake
// model, scratch cwd and session dir, credential-shaped env vars stripped. The room it
// opens is an empty session on the real default relay; no model prompt is ever sent
// (a guest prompt, if exercised, goes to the unreachable fake model).
//
// SECRETS: join links carry the room id and key. This script keeps them in memory only,
// never writes raw frames to disk, and prints every URL redacted.
//
// Run:  node docs/spike/collab-rpc-probe.mjs
// Env:  PINION_OMP  omp executable (default "omp" from PATH)
//       PINION_RPC_MODE  rpc-ui (default, what Refract spawns) or rpc

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const OMP = process.env.PINION_OMP || "omp";
const MODE = process.env.PINION_RPC_MODE || "rpc-ui";
const PROFILE = "pinion-probe-collab";
const CONFIG_DIR_NAME = process.env.PI_CONFIG_DIR || ".omp";
const ROOT = path.join(os.tmpdir(), "pinion-probe-collab", new Date().toISOString().replace(/[:.]/g, "-"));
const T0 = Date.now();
const ts = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;

fs.mkdirSync(path.join(ROOT, "wt"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "sessions"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "wt", "README.md"), "collab probe scratch worktree\n");

const secrets = new Set();

// Replaces every URL with scheme://host/<redacted>, remembers the secret parts so that
// any other string containing them is scrubbed too.
function redact(text) {
  let out = String(text).replace(/\b(https?|wss?|omp):\/\/[^\s"')\]]+/g, (m) => {
    const u = m.split("#");
    const frag = u[1];
    const pathPart = u[0].replace(/^[a-z]+:\/\/[^/]*/, "");
    for (const s of [frag, ...pathPart.split("/")]) if (s && s.length >= 16) secrets.add(s);
    const origin = m.match(/^[a-z]+:\/\/[^/\s]*/)[0];
    return `${origin}/<redacted path=${pathPart.length}c${frag ? ` fragment=${frag.length}c` : ""}>`;
  });
  for (const s of secrets) out = out.split(s).join("<secret>");
  return out;
}
const show = (v) => redact(typeof v === "string" ? v : JSON.stringify(v));

function sanitizedEnv() {
  const pat = /API_KEY|OAUTH|TOKEN|SECRET|CREDENTIAL|PASSWORD|_PAT\b|AUTH|_KEY\b/i;
  const out = { ...process.env };
  for (const k of Object.keys(out)) if (pat.test(k)) delete out[k];
  return out;
}

// Keyless unreachable fake model: lets the process reach `ready` with no credentials.
function seedProfile(extraConfig) {
  const agentDir = path.join(os.homedir(), CONFIG_DIR_NAME, "profiles", PROFILE, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "models.yml"),
    [
      "providers:",
      "  probe-fake:",
      "    baseUrl: http://127.0.0.1:1",
      "    auth: none",
      "    api: openai-completions",
      "    models:",
      "      - id: probe-fake-model",
      "        name: Probe Fake Model",
      "        api: openai-completions",
      "        contextWindow: 8000",
      "        maxTokens: 1000",
      "",
    ].join("\n"),
  );
  const cfg = path.join(agentDir, "config.yml");
  if (extraConfig) fs.writeFileSync(cfg, extraConfig);
  else if (fs.existsSync(cfg)) fs.writeFileSync(cfg, "");
}

class Omp {
  constructor(label) {
    this.label = label;
    this.frames = [];
    this.buf = "";
    this.n = 0;
    this.chunks = new Map();
    const sd = path.join(ROOT, "sessions", label);
    fs.mkdirSync(sd, { recursive: true });
    this.child = spawn(
      OMP,
      [
        "--mode", MODE, "--approval-mode=always-ask", "--profile", PROFILE, "--session-dir", sd,
        "--model", "probe-fake/probe-fake-model", "--no-extensions", "--no-skills", "--no-rules",
        "--no-context-files", "--no-lsp", "--no-title",
      ],
      { cwd: path.join(ROOT, "wt"), stdio: "pipe", windowsHide: true, env: sanitizedEnv() },
    );
    this.exited = new Promise((r) => this.child.on("exit", (c) => r(c)));
    this.child.stdout.on("data", (d) => this.#data(d));
    this.child.stderr.on("data", (d) => { this.stderr = (this.stderr ?? "") + d; });
  }
  #data(d) {
    this.buf += d.toString("utf8");
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let f;
      try { f = JSON.parse(line); } catch { continue; }
      if (f.type === "rpc_chunk") {
        let c = this.chunks.get(f.chunkId);
        if (!c) this.chunks.set(f.chunkId, (c = { parts: new Array(f.count), got: 0 }));
        c.parts[f.index] = Buffer.from(f.data, "base64");
        if (++c.got === f.count) {
          this.chunks.delete(f.chunkId);
          try { f = JSON.parse(Buffer.concat(c.parts).toString("utf8")); } catch { continue; }
        } else continue;
      }
      f.__t = Date.now();
      this.frames.push(f);
      if (f.type === "extension_ui_request") {
        this.write({ type: "extension_ui_response", id: f.id, cancelled: true });
      }
    }
  }
  write(o) { this.child.stdin.write(JSON.stringify(o) + "\n"); }
  async wait(pred, ms, from = 0) {
    const end = Date.now() + ms;
    for (;;) {
      const f = this.frames.slice(from).find(pred);
      if (f) return f;
      if (Date.now() > end) return null;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  // Sends one command and returns every frame that arrived in the next `observeMs`.
  async request(cmd, observeMs = 4000) {
    const id = `${this.label}-${++this.n}`;
    const mark = this.frames.length;
    this.write({ id, ...cmd });
    await this.wait((f) => f.type === "response" && f.id === id, 30000, mark);
    await new Promise((r) => setTimeout(r, observeMs));
    return { id, frames: this.frames.slice(mark) };
  }
  async ready() {
    const r = await this.wait((f) => f.type === "ready", 120000);
    if (!r) throw new Error(`no ready frame: ${this.stderr ?? ""}`);
    if (r.supportedProtocolVersions?.includes(2)) await this.request({ type: "negotiate_protocol", protocolVersion: 2 }, 100);
    return r;
  }
  kill() {
    try { execFileSync("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ }
  }
}

// Prints a compact, redacted view of the frames one prompt produced.
function summarise(title, { id, frames }) {
  console.log(`\n--- ${title}`);
  for (const f of frames) {
    if (f.type === "response" && f.id === id) {
      console.log(`  response success=${f.success} data=${show(f.data ?? f.error)}`);
    } else {
      const { __t, ...rest } = f;
      console.log(`  ${rest.type}: ${show(rest).slice(0, 700)}`);
    }
  }
  if (frames.length === 0) console.log("  (no frames)");
}

// Hosts in the local collab registry (metadata only; `collab list` never prints links).
function registryHosts() {
  try {
    const out = execFileSync(OMP, ["collab", "list", "--json"], { encoding: "utf8", env: sanitizedEnv() });
    return JSON.parse(out).hosts ?? [];
  } catch (e) {
    return { error: String(e.message).slice(0, 200) };
  }
}
const hostCount = (h) => (Array.isArray(h) ? h.length : JSON.stringify(h));

// One prompt, then abort so the fake model's retry loop cannot block the next prompt.
async function promptThenSettle(o, title, message) {
  const r = await o.request({ type: "prompt", message }, 1500);
  summarise(`${ts()} prompt ${title}`, r);
  await o.request({ type: "abort" }, 300);
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const s = await o.request({ type: "get_state" }, 50);
    if (s.frames.find((f) => f.id === s.id)?.data?.isSettled) return;
    await new Promise((x) => setTimeout(x, 500));
  }
}

async function start(label, config) {
  seedProfile(config);
  const o = new Omp(label);
  const ready = await o.ready();
  await o.request({ type: "set_auto_retry", enabled: false }, 50);
  const st = await o.request({ type: "get_state" }, 50);
  const model = st.frames.find((f) => f.id === st.id)?.data?.model;
  if (model?.provider !== "probe-fake") throw new Error(`ABORT: not the isolated profile (${JSON.stringify(model)})`);
  return { o, ready };
}

async function main() {
  console.log(`omp ${execFileSync(OMP, ["--version"], { encoding: "utf8" }).trim()} | profile ${PROFILE} | scratch ${ROOT}`);
  console.log(`registry hosts before: ${hostCount(registryHosts())}`);

  console.log("\n=== Phase A: collab.autoStart=off, drive /collab as RPC prompts");
  let a;
  try {
    a = await start("a", "");
    console.log(`${ts()} ready: ${show({ ...a.ready, __t: undefined })}`);
    const cmds = await a.o.request({ type: "get_available_commands" }, 50);
    const list = cmds.frames.find((f) => f.id === cmds.id)?.data?.commands ?? [];
    console.log(`get_available_commands: ${list.length} commands; collab/join/leave advertised: ${JSON.stringify(list.filter((c) => /^(collab|join|leave)$/.test(c.name)).map((c) => c.name))}`);
    for (const [title, message] of [
      ["/collab status", "/collab status"],
      ["/collab view", "/collab view"],
      ["/collab (control)", "/collab"],
      ["/collab stop", "/collab stop"],
    ]) {
      await promptThenSettle(a.o, title, message);
      const mine = registryHosts();
      console.log(`  registry hosts owned by pid ${a.o.child.pid}: ${Array.isArray(mine) ? mine.filter((h) => h.pid === a.o.child.pid).length : hostCount(mine)}`);
    }
  } finally {
    a?.o.kill();
    if (a) await Promise.race([a.o.exited, new Promise((r) => setTimeout(r, 10000))]);
  }

  console.log("\n=== Phase B: collab.autoStart=view in the profile config, rpc-ui, no /collab prompt");
  let b;
  try {
    b = await start("b", "collab:\n  autoStart: view\n");
    await new Promise((r) => setTimeout(r, 8000));
    const mine = registryHosts();
    console.log(`${ts()} registry hosts owned by pid ${b.o.child.pid}: ${Array.isArray(mine) ? mine.filter((h) => h.pid === b.o.child.pid).length : hostCount(mine)}`);
    const frames = b.o.frames.filter((f) => /collab|notice/i.test(JSON.stringify(f)) && f.type !== "response");
    console.log(`frames mentioning collab: ${frames.length}`);
  } finally {
    b?.o.kill();
    if (b) await Promise.race([b.o.exited, new Promise((r) => setTimeout(r, 10000))]);
    seedProfile("");
  }
  console.log(`\n${ts()} children killed; registry hosts after: ${hostCount(registryHosts())}`);
}

main().catch((e) => { console.error(redact(e.stack || e.message)); process.exit(1); });
