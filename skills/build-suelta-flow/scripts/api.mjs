#!/usr/bin/env node
// Call the Suelta API with the credential obtained by login.mjs.
//
//   node api.mjs GET  /flows
//   node api.mjs POST /flows --data '{"name":"..."}'
//   node api.mjs PUT  /flows/abc/draft --data @payload.json
//   echo '{...}' | node api.mjs POST /flows/abc/test-chat --data -
//
// Paths are relative to /api/me unless they start with /api. Prints the
// response body to stdout (pretty JSON when possible) and "HTTP <status>" to
// stderr. Exit code: 0 for 2xx, 1 for any other status or a usage/network
// error, 2 when there is no credential (run login.mjs). --data is only valid
// with POST/PUT/PATCH/DELETE. The key itself is never printed.

import { promises as fs } from "node:fs";
import { apiUrl, resolveApiKey } from "./lib.mjs";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const argv = process.argv.slice(2);
const method = (argv[0] || "").toUpperCase();
const path = argv[1];

if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) || !path || path.startsWith("-")) {
  usage("usage: node api.mjs <GET|POST|PUT|PATCH|DELETE> <path> [--data <json>|@file|-]");
}
if (argv.indexOf("--data") !== argv.lastIndexOf("--data")) usage("--data given more than once");

let data;
const di = argv.indexOf("--data");
if (di !== -1) {
  if (method === "GET") usage("--data cannot be used with GET");
  const v = argv[di + 1];
  if (v === undefined) usage("--data needs a value");
  if (v === "-") {
    if (process.stdin.isTTY) usage("--data - requires piped stdin");
    data = await readStdin();
  } else if (v.startsWith("@")) {
    try { data = await fs.readFile(v.slice(1), "utf8"); }
    catch (e) { usage(`cannot read ${v.slice(1)}: ${e.message}`); }
  } else {
    data = v;
  }
  if (Buffer.byteLength(data, "utf8") > MAX_BODY_BYTES) usage("--data is larger than 5 MB");
  try { JSON.parse(data); } catch { usage("--data is not valid JSON"); }
}

const cred = await resolveApiKey();
if (!cred) {
  await writeOut(JSON.stringify({ error: "not_logged_in", fix: "run: node scripts/login.mjs" }) + "\n");
  process.exit(2);
}

const url = apiUrl() + (path.startsWith("/api/") ? path : "/api/me" + (path.startsWith("/") ? path : "/" + path));
let res;
try {
  res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${cred.key}`,
      Accept: "application/json",
      ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: data,
  });
} catch (e) {
  process.stderr.write(`network error calling ${url}: ${e.message}\n`);
  process.exit(1);
}

const raw = await res.text();
process.stderr.write(`HTTP ${res.status}\n`);
let printed;
try { printed = JSON.stringify(JSON.parse(raw), null, 2) + "\n"; }
catch { printed = raw + (raw.endsWith("\n") ? "" : "\n"); }
await writeOut(printed);
process.exit(res.ok ? 0 : 1);

function writeOut(s) {
  return new Promise((resolve) => process.stdout.write(s, () => resolve()));
}

function usage(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    let gotData = false;
    const guard = setTimeout(() => {
      if (!gotData) usage("--data - requires piped stdin (nothing arrived in 3s)");
    }, 3000);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      gotData = true;
      buf += c;
      if (buf.length > MAX_BODY_BYTES) usage("stdin body is larger than 5 MB");
    });
    process.stdin.on("end", () => { clearTimeout(guard); resolve(buf); });
    process.stdin.on("error", (e) => { clearTimeout(guard); reject(e); });
  });
}
