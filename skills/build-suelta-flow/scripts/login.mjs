#!/usr/bin/env node
// Suelta login for coding agents. Obtains an API key for this machine without
// the user ever seeing it: the user clicks "Autorizar" in the Suelta web app
// and the key lands in a local credentials file (mode 0600).
//
//   node login.mjs            browser flow when a local browser is likely,
//                             device-code flow otherwise (auto-detected)
//   node login.mjs --device   force the device-code flow
//   node login.mjs --force    log in again even if a working session exists
//   node login.mjs --status   exit 0 = session works, 3 = none or rejected,
//                             4 = could not reach Suelta to check
//   node login.mjs --logout   delete the local credential
//
// Exit codes for a login run: 0 success, 1 failure (denied, expired, timeout,
// server or network error). Waits up to 10 minutes for the click.
// Env: SUELTA_API_URL (base URL override), SUELTA_CREDENTIALS_FILE,
// SUELTA_LOGIN_NO_BROWSER=1 (never try to open a browser → device flow).
// The key is never printed. Requires Node 18+ (global fetch).

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { hostname, userInfo, platform } from "node:os";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { credentialsPath, resolveApiKey, apiUrl, checkKey, clean } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const API = apiUrl();
const APP_ORIGINS = new Set(["https://app.getsuelta.com", new URL(API).origin]);
if (process.env.SUELTA_APP_URL) { try { APP_ORIGINS.add(new URL(process.env.SUELTA_APP_URL).origin); } catch {} }
const MAX_INTERVAL_MS = 30_000;
const PROGRESS_EVERY_MS = 30_000;
const out = (m) => process.stderr.write(m + "\n");

async function main() {
  if (args.has("--logout")) return logout();
  if (args.has("--status")) return status();

  const existing = await resolveApiKey();
  if (existing && !args.has("--force")) {
    const state = await checkKey(existing.key);
    if (state === "ok") {
      out(`Ya hay una sesión de Suelta en este equipo (${clean(existing.label)}). Usa --force para volver a entrar.`);
      return;
    }
    if (state === "unknown") fail(`No pude conectar con ${API} para verificar la sesión. Revisa tu conexión e inténtalo de nuevo.`);
    if (existing.source === "env") fail("SUELTA_API_KEY está definida pero Suelta la rechaza. Quita la variable o corrige su valor.");
    out("La credencial guardada ya no funciona; iniciando sesión de nuevo.");
  }

  const secret = randomBytes(32).toString("hex");
  const secretHash = createHash("sha256").update(secret).digest("hex");
  const deviceName = clean(`${safeUser()}@${hostname()}`, 80);
  const wake = makeLatch();

  let mode = localBrowserLikely() ? "browser" : "device";
  let server = null;
  let flow = null;
  let browserOpened = false;

  if (mode === "browser") {
    try {
      server = await startCallbackServer(wake.fire);
      const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      flow = await startFlow({ mode, redirect_uri: redirectUri, device_name: deviceName, secret_hash: secretHash });
    } catch {
      flow = null;
    }
    if (!flow) {
      server?.close();
      server = null;
      mode = "device";
    } else {
      browserOpened = await openBrowser(flow.verification_url);
    }
  }
  if (mode === "device") {
    flow = await startFlow({ mode, device_name: deviceName, secret_hash: secretHash });
    if (!flow) fail("No se pudo iniciar el login contra Suelta. Revisa tu conexión e inténtalo de nuevo.");
  }

  if (mode === "browser") {
    out(browserOpened
      ? "Se abrió tu navegador para autorizar Claude Code en Suelta. Haz clic en «Autorizar» y vuelve aquí."
      : "Intenté abrir tu navegador para autorizar Claude Code en Suelta.");
    out(`Si no lo ves, abre este enlace: ${flow.verification_url}`);
  } else {
    out(`Abre ${flow.verification_url} en cualquier navegador y escribe este código: ${flow.user_code}`);
  }

  const key = await waitForKey(flow, secret, wake);
  server?.close();

  const label = clean(key.label || `Claude Code · ${deviceName}`, 120);
  await writeCredentials({
    api_key: key.api_key,
    key_id: typeof key.key_id === "string" ? key.key_id : null,
    label,
    expires_at: typeof key.expires_at === "string" ? key.expires_at : null,
    api_url: API,
    created_at: new Date().toISOString(),
  });
  out(`Listo. Suelta quedó conectado en este equipo como "${label}".`);
  out("Puedes revocarlo cuando quieras en Settings → Llaves de API.");
}

// Returns the flow object, or null when the server refused this mode.
async function startFlow(fields) {
  const r = await postJson("/api/cli/auth/start", { client: "claude-code", ...fields });
  if (r.status < 200 || r.status >= 300) return null;
  const f = r.body;
  if (!f || typeof f !== "object" || typeof f.flow_id !== "string" || typeof f.verification_url !== "string") {
    fail("Respuesta inesperada de Suelta al iniciar el login.");
  }
  let origin;
  try { origin = new URL(f.verification_url).origin; } catch { origin = ""; }
  if (!APP_ORIGINS.has(origin) || !f.verification_url.startsWith("https://") && !f.verification_url.startsWith(API)) {
    fail("Suelta devolvió una URL de autorización que no reconozco; login cancelado.");
  }
  f.verification_url = clean(f.verification_url, 500);
  if (fields.mode === "device") {
    if (typeof f.user_code !== "string" || !/^[A-Z0-9-]{4,16}$/i.test(f.user_code)) {
      fail("Respuesta inesperada de Suelta: falta el código de dispositivo.");
    }
    f.user_code = clean(f.user_code, 16);
  }
  return f;
}

async function waitForKey(flow, secret, wake) {
  const secs = Math.min(600, Math.max(30, Number(flow.expires_in) || 600));
  const deadline = Date.now() + secs * 1000;
  let interval = Math.min(MAX_INTERVAL_MS, Math.max(1, Number(flow.interval) || 3) * 1000);
  let lastProgress = Date.now();
  let limitWarned = false;

  while (Date.now() < deadline) {
    const r = await postJson("/api/cli/auth/token", { flow_id: flow.flow_id, secret });
    const body = r.body && typeof r.body === "object" ? r.body : {};
    const ok2xx = r.status >= 200 && r.status < 300;
    if (ok2xx && typeof body.api_key === "string" && body.api_key) return body;
    const code = typeof body.error === "string" ? body.error : "";
    if (ok2xx) {
      fail("Suelta respondió sin una llave válida. Vuelve a intentar el login.");
    } else if (r.status === 428 || code === "authorization_pending") {
      // keep waiting
    } else if (r.status === 409 || code === "cli_key_limit") {
      if (!limitWarned) {
        out("Tienes 10 equipos conectados a Suelta. Revoca alguno en Configuración → Llaves de API; en cuanto lo hagas, sigo aquí y termino solo.");
        limitWarned = true;
      }
    } else if (code === "rate_limited") {
      const retry = Number(r.retryAfter);
      interval = Math.min(60_000, Math.max(interval, (retry > 0 ? retry : 10) * 1000));
    } else if (r.status === 429 || code === "slow_down") {
      interval = Math.min(MAX_INTERVAL_MS, interval + 2000);
    } else if (code === "consumed") {
      fail("Esta autorización ya fue usada. Vuelve a correr el login.");
    } else if (r.status === 410 || code === "expired") {
      fail("La autorización expiró. Vuelve a correr el login.");
    } else if (r.status === 403 || code === "denied") {
      fail("La autorización fue rechazada en la web de Suelta.");
    } else {
      // Never print the body here: it could carry the key.
      fail(`Error inesperado de Suelta (${r.status}${code ? ", " + clean(code, 40) : ""}). Vuelve a intentar el login.`);
    }
    if (Date.now() - lastProgress >= PROGRESS_EVERY_MS) {
      out("Esperando la autorización en el navegador…");
      lastProgress = Date.now();
    }
    await wake.sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
  fail("Se agotó el tiempo esperando la autorización. Vuelve a correr el login.");
}

// One-shot latch: the first callback hit wakes the poller early (even if it
// arrives before the poller starts sleeping); later hits are ignored, so a
// flood of /callback requests cannot bypass the poll interval.
function makeLatch() {
  let fired = false;
  let pending = false;
  let resolveSleep = null;
  return {
    fire() {
      if (fired) return;
      fired = true;
      pending = true;
      resolveSleep?.();
    },
    sleep(ms) {
      if (pending) { pending = false; return Promise.resolve(); }
      return new Promise((resolve) => {
        const t = setTimeout(done, ms);
        function done() { clearTimeout(t); resolveSleep = null; pending = false; resolve(); }
        resolveSleep = done;
      });
    },
  };
}

function startCallbackServer(onHit) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
      // The web app owns every screen the user sees; this endpoint is only a
      // wake-up ping (fetch no-cors from the "Listo" page), so answer empty.
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      onHit();
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// Heuristic: is there a browser on THIS machine that the user will see?
function localBrowserLikely() {
  if (args.has("--device")) return false;
  if (process.env.SUELTA_LOGIN_NO_BROWSER === "1") return false;
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT) return false;
  if (process.env.CI || process.env.CODESPACES || process.env.REMOTE_CONTAINERS) return false;
  if (platform() === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  return true;
}

// The URL never goes through a shell: rundll32 on Windows (cmd.exe would
// re-parse & | ^), open on macOS, xdg-open elsewhere.
function openBrowser(url) {
  return new Promise((resolve) => {
    const [cmd, cmdArgs] =
      platform() === "darwin" ? ["open", [url]] :
      platform() === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] :
      ["xdg-open", [url]];
    try {
      const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
      let settled = false;
      const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
      child.on("error", () => settle(false));
      child.on("spawn", () => child.unref());
      child.on("exit", (code) => settle(code === 0));
      setTimeout(() => settle(true), 1500);
    } catch {
      resolve(false);
    }
  });
}

async function postJson(path, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    fail(`No pude conectar con ${API}: ${clean(e.message, 120)}`);
  }
  const raw = await res.text();
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  return { status: res.status, body: parsed, retryAfter: res.headers.get("retry-after") };
}

async function writeCredentials(data) {
  const file = credentialsPath();
  const dir = dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => {});
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try {
    await fs.chmod(file, 0o600);
  } catch {
    if (platform() !== "win32") out(`Aviso: no pude restringir los permisos de ${file}; revísalos manualmente.`);
  }
}

async function status() {
  const c = await resolveApiKey();
  if (!c) { out("No hay sesión de Suelta en este equipo."); process.exit(3); }
  const state = await checkKey(c.key);
  if (state === "ok") {
    const exp = c.expires_at ? Date.parse(c.expires_at) : NaN;
    const soon = Number.isFinite(exp) && exp - Date.now() < 14 * 86400_000;
    out(`Sesión activa: ${clean(c.label)} (${API})${soon ? " — la llave vence pronto; corre el login con --force para renovarla" : ""}`);
    process.exit(0);
  }
  if (state === "unknown") { out(`No pude conectar con ${API} para verificar la sesión.`); process.exit(4); }
  out(`Hay una credencial (${clean(c.label)}) pero Suelta la rechaza.`);
  process.exit(3);
}

async function logout() {
  await fs.rm(credentialsPath(), { force: true });
  out("Sesión local eliminada. La llave sigue en Settings → Llaves de API hasta que la revoques allí.");
}

function safeUser() {
  try { return userInfo().username; } catch { return "user"; }
}
function fail(msg) { out(msg); process.exit(1); }


main().catch((e) => fail(clean(e?.message ?? String(e), 200)));
