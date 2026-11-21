import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

// ───────── Ayarlar (Netlify > Environment variables ile değiştirilebilir) ─────────
const OWNER_NAME = process.env.OWNER_NAME || "RAYZx";
const OWNER_CODE = process.env.OWNER_CODE || "Bestx";
const SECRET =
  process.env.SECRET ||
  crypto.createHash("sha256").update("dvr|" + OWNER_CODE).digest("hex");

const ENV_API_KEY = process.env.GOOGLE_API_KEY || "";
const ENV_FILE_ID = process.env.DRIVE_FILE_ID || "";
const USAGE_KEY = process.env.USAGE_KEY || "";   // VPN sunucusunun gerçek trafik raporu için anahtar
const PANEL_TITLE = process.env.PANEL_TITLE || "RAYZ PANEL";

const DAY = 864e5;
const LINK = /^(ss|vmess|vless|trojan|hy2|hysteria2):\/\/\S+$/i;
const OWNER_KEY = "__owner__";
const DEFAULT_CONTACTS = [
  { label: "@rayz_vpns", url: "https://t.me/rayz_vpns" },
  { label: "@dovran_cik", url: "https://t.me/dovran_cik" },
];

// ───────── Depo ─────────
const store = () => getStore({ name: "dovran-panel", consistency: "strong" });
async function load() {
  const d = (await store().get("db", { type: "json" })) || {};
  d.users ??= {};
  d.subs ??= {};
  d.servers ??= [];
  d.deleted ??= {};
  d.settings ??= {};
  d.settings.contacts ??= DEFAULT_CONTACTS;
  return d;
}
const save = (d) => store().setJSON("db", d);

const saEmail = (db) => {
  try {
    return JSON.parse(db.settings.saJson).client_email || "";
  } catch {
    return "";
  }
};

// Kartta gösterilecek doğrudan www.googleapis.com linki için anahtar ve dosya ID'si
const directInfo = (db) => {
  const du = db.settings.driveUrl || "";
  const m = du.match(/\/d\/([\w-]{10,})/) || du.match(/[?&]id=([\w-]{10,})/);
  return {
    gKey: db.settings.apiKey || ENV_API_KEY,
    fileId: (m && m[1]) || db.settings.driveFileId || ENV_FILE_ID,
  };
};

// Google API (Service Account) ile erişim jetonu al
async function gToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", typ: "JWT" });
  const claim = enc({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  });
  const sig = crypto.createSign("RSA-SHA256").update(head + "." + claim).sign(sa.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: head + "." + claim + "." + sig,
    }),
    signal: AbortSignal.timeout(9000),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(d.error_description || d.error || "jeton alınamadı");
  return d.access_token;
}

// Google Drive API ile servers.txt oluştur / güncelle, herkese açık yap
async function driveApiSync(db) {
  const st = db.settings;
  const sa = JSON.parse(st.saJson);
  const H = { authorization: "Bearer " + (await gToken(sa)) };
  const content = db.servers.map((x) => x.link).join("\n");
  const m =
    (st.driveUrl || "").match(/\/d\/([\w-]{10,})/) || (st.driveUrl || "").match(/[?&]id=([\w-]{10,})/);
  let id = m ? m[1] : st.driveFileId || "";
  if (id) {
    const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
      method: "PATCH",
      headers: { ...H, "content-type": "text/plain; charset=utf-8" },
      body: content,
      signal: AbortSignal.timeout(9000),
    });
    if (r.ok) return id;
    const pd = await r.json().catch(() => ({}));
    throw new Error(
      `Dosyaya yazılamadı. Drive'da bu dosyayı ${sa.client_email} adresiyle EDİTÖR olarak paylaş, sonra tekrar bas.` +
        (pd?.error?.message ? ` (${pd.error.message})` : "")
    );
  }
  if (!id) {
    const b = "dvr" + rnd(8);
    const body =
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name: "servers.txt", mimeType: "text/plain" }) +
      `\r\n--${b}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${b}--`;
    const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST",
      headers: { ...H, "content-type": `multipart/related; boundary=${b}` },
      body,
      signal: AbortSignal.timeout(9000),
    });
    const d = await r.json();
    if (!d.id) {
      const msg = d.error?.message || "dosya oluşturulamadı";
      if (/storage quota/i.test(msg))
        throw new Error(
          `Drive dosya linki boş. Drive'da kendi hesabında boş bir servers.txt oluştur, ${sa.client_email} adresiyle EDİTÖR olarak paylaş ve linkini "Drive dosya linki" alanına yapıştırıp Kaydet'e bas.`
        );
      throw new Error(msg);
    }
    id = d.id;
    const pr = await fetch(`https://www.googleapis.com/drive/v3/files/${id}/permissions`, {
      method: "POST",
      headers: { ...H, "content-type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
      signal: AbortSignal.timeout(9000),
    });
    if (!pr.ok) throw new Error("dosya herkese açık yapılamadı");
  }
  return id;
}

// Server listesini Google Drive'a yazar: önce Google API (Service Account), yoksa Apps Script
async function syncDrive(db) {
  const st = db.settings;
  if (st.saJson) {
    try {
      const id = await driveApiSync(db);
      st.driveFileId = id;
      st.driveUrl = "https://drive.google.com/file/d/" + id + "/view";
      await save(db);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: "Google API: " + (e?.message || e) };
    }
  }
  if (!st.scriptUrl || !st.syncKey)
    return { ok: false, error: "Apps Script URL ve Sync Key gerekli" };
  try {
    const r = await fetch(st.scriptUrl, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        token: st.syncKey,
        id: (
          (st.driveUrl || "").match(/\/d\/([\w-]{10,})/) ||
          (st.driveUrl || "").match(/[?&]id=([\w-]{10,})/) || ["", st.driveFileId || ""]
        )[1],
        content: db.servers.map((x) => x.link).join("\n"),
      }),
      redirect: "follow",
      signal: AbortSignal.timeout(9000),
    });
    const d = await r.json();
    if (!d.id)
      return { ok: false, error: d.error === "forbidden" ? "Sync Key yanlış" : d.error || "Apps Script cevap vermedi" };
    st.driveFileId = d.id;
    st.driveUrl = d.url;
    await save(db);
    return { ok: true };
  } catch {
    return { ok: false, error: "Apps Script'e ulaşılamadı (yeni sürüm olarak yayınlandı mı?)" };
  }
}

// ───────── Yardımcılar ─────────
const J = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const E = (m, s = 400) => J({ error: m }, s);
const str = (v, min, max) => {
  v = String(v ?? "").trim();
  return v.length >= min && v.length <= max ? v : null;
};
const int = (v, min, max) => {
  v = Math.floor(Number(v));
  return Number.isFinite(v) && v >= min && v <= max ? v : null;
};
const hash = (x) => crypto.createHash("sha256").update(String(x)).digest();
const eq = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));
const rnd = (n) => crypto.randomBytes(n).toString("hex");
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const pick = (n) => {
  const b = crypto.randomBytes(n);
  return [...b].map((x) => ALPHA[x % ALPHA.length]).join("");
};
const genCode = () => pick(8);

// token: base64url(payload).hmac
function sign(p) {
  const body = Buffer.from(JSON.stringify(p)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
function verify(t) {
  if (!t || !t.includes(".")) return null;
  const [body, sig] = t.split(".");
  const exp = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig),
    b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

// kaba kuvvet koruması (instance başına)
const fails = new Map();
const limited = (ip) => {
  const f = fails.get(ip);
  return f && f.n >= 8 && Date.now() - f.t < 6e5;
};
const failed = (ip) => {
  const f = fails.get(ip);
  if (!f || Date.now() - f.t > 6e5) fails.set(ip, { n: 1, t: Date.now() });
  else f.n++;
};

const codesUsed = (db, key) => Object.values(db.subs).filter((s) => s.owner === key).length;

function account(db, tok) {
  const p = verify(tok);
  if (!p) return null;
  if (p.o) return { key: OWNER_KEY, name: OWNER_NAME, role: "owner" };
  const u = db.users[p.u];
  if (!u || u.disabled) return null;
  if (u.expiresAt && u.expiresAt < Date.now()) return null;
  if (!u.devices.some((d) => d.id === p.d)) return null;
  return { key: u.key, name: u.name, role: u.role, u };
}

function meOut(acc, db) {
  if (acc.role === "owner") return { name: OWNER_NAME, role: "owner" };
  const u = acc.u;
  return {
    name: u.name,
    role: u.role,
    code: u.code,
    expiresAt: u.expiresAt,
    deviceLimit: u.deviceLimit,
    devices: u.devices.length,
    codeLimit: u.codeLimit,
    codesUsed: codesUsed(db, u.key),
  };
}

function userOut(u, db) {
  return {
    key: u.key,
    name: u.name,
    code: u.code,
    role: u.role,
    createdAt: u.createdAt,
    expiresAt: u.expiresAt,
    deviceLimit: u.deviceLimit,
    devices: u.devices.length,
    codeLimit: u.codeLimit,
    codesUsed: codesUsed(db, u.key),
    disabled: !!u.disabled,
  };
}

function srvInfo(link) {
  let proto = link.split("://")[0].toLowerCase();
  if (proto === "hysteria2") proto = "hy2";
  let name = "";
  if (proto === "vmess") {
    try {
      name = JSON.parse(Buffer.from(link.slice(8), "base64").toString()).ps || "";
    } catch {}
  } else {
    const i = link.indexOf("#");
    if (i > -1) {
      try {
        name = decodeURIComponent(link.slice(i + 1));
      } catch {
        name = link.slice(i + 1);
      }
    }
  }
  return { proto, name: (name || proto.toUpperCase() + " server").slice(0, 60) };
}

function cleanContacts(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const c of arr.slice(0, 8)) {
    let label = String(c?.label || "").trim().slice(0, 40);
    let url = String(c?.url || "").trim().slice(0, 200);
    if (!label && !url) continue;
    if (!url && label.startsWith("@")) url = "https://t.me/" + label.slice(1);
    if (url.startsWith("@")) url = "https://t.me/" + url.slice(1);
    if (!/^https?:\/\/\S+$/i.test(url)) return null;
    out.push({ label: label || url, url });
  }
  return out;
}

// ───────── Giriş ─────────
async function doLogin(req, db, b) {
  const ip = req.headers.get("x-nf-client-connection-ip") || "x";
  if (limited(ip)) return E("Çok fazla deneme. 10 dakika bekle.", 429);
  const dev = str(b.device, 6, 100);
  if (!dev) return E("Cihaz kimliği yok");
  const name = String(b.name || "").trim();
  const code = String(b.code || "").trim();
  if (name.toLowerCase() === OWNER_NAME.toLowerCase()) {
    if (!eq(code, OWNER_CODE)) {
      failed(ip);
      return E("Ad veya kod yanlış", 401);
    }
    return J({
      token: sign({ o: 1, exp: Date.now() + 30 * DAY }),
      me: { name: OWNER_NAME, role: "owner" },
    });
  }
  const user = db.users[name.toLowerCase()];
  if (!user || !eq(user.code, code)) {
    failed(ip);
    return E("Ad veya kod yanlış", 401);
  }

  if (user.disabled) return E("Hesap kapatılmış", 403);
  if (user.expiresAt && user.expiresAt < Date.now()) return E("Hesabın süresi dolmuş", 403);

  if (!user.devices.some((d) => d.id === dev)) {
    if (user.devices.length >= user.deviceLimit)
      return E(`📶Device Limited📶 (${user.devices.length}/${user.deviceLimit})`, 403);
    user.devices.push({
      id: dev,
      at: Date.now(),
      ua: (req.headers.get("user-agent") || "").slice(0, 80),
    });
    await save(db);
  }
  const exp = Math.min(Date.now() + 30 * DAY, user.expiresAt || Infinity);
  const acc = { key: user.key, name: user.name, role: user.role, u: user };
  return J({ token: sign({ u: user.key, d: dev, exp }), me: meOut(acc, db) });
}


// ───────── Google APIs: her abonelik için Drive dosyası (www.googleapis.com/drive/v3/files/ID?alt=media&key=...) ─────────
const GBYTES = 1073741824;
const b64s = (t) => Buffer.from(String(t)).toString("base64");
const msgLink = (m) => `vless://00000000-0000-0000-0000-000000000000@127.0.0.1:1?type=tcp&security=none#${encodeURIComponent(m)}`;
const sha = (t) => crypto.createHash("sha1").update(String(t)).digest("hex");
const leftText = (ms) => {
  if (ms <= 0) return "0-Minut";
  if (ms >= DAY) return Math.ceil(ms / DAY) + "-Gün";
  const h = Math.floor(ms / 36e5);
  if (h >= 1) return h + "-Sagat";
  return Math.max(1, Math.floor((ms % 36e5) / 6e4)) + "-Minut";
};
// Service Account: Netlify env SA_JSON (tüm JSON) ya da FB_EMAIL + FB_KEY, yoksa Ayarlar'daki saJson
const getSa = (db) => {
  try { if (process.env.SA_JSON) return JSON.parse(process.env.SA_JSON); } catch {}
  const em = process.env.GOOGLE_CLIENT_EMAIL || process.env.FB_EMAIL, pk = process.env.GOOGLE_PRIVATE_KEY || process.env.FB_KEY;
  if (em && pk) return { client_email: em, private_key: pk.replace(/\\n/g, "\n") };
  try { return db.settings.saJson ? JSON.parse(db.settings.saJson) : null; } catch { return null; }
};
const gUrl = (db, id) => {
  const k = db.settings.apiKey || ENV_API_KEY;
  return k && id ? `https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${encodeURIComponent(k)}` : "";
};
const gidOf = async (id) => (await store().get("gid:" + id, { type: "json" }))?.id || "";

// Abonelik içeriği: adı, kalan gün, GB (gerçek trafik), serverlar. Gün/GB dolunca uyarı mesajına döner.
function subParts(db, s, use, now = Date.now()) {
  const total = s.gb > 0 ? Math.round(s.gb * GBYTES) : 0;
  const usedGb = Math.max(0, Number(use?.usedGb) || 0);
  const used = Math.round(usedGb * GBYTES);
  const ms = s.expiresAt - now;
  const dead = ms <= 0, full = total > 0 && used >= total;
  const lines = [`🚀${leftText(ms)} Galdy🚀`, `📶User:${s.name}📶`];
  const rt = Math.round(usedGb * 100) / 100;
  lines.push(s.gb > 0 ? `⚡Real Traffic: ${rt} / ${s.gb} GB⚡` : `⚡Real Traffic: ${rt} GB⚡`);
  if (s.desc) lines.push(s.desc);
  let announce = lines.join("\n"), links;
  if (dead) { announce = `🩸Möhleti geçdi🩸\n📶User:${s.name}📶`; links = [msgLink("Expired 📶")]; }
  else if (full) { announce = `🩸GB doldy🩸\n📶User:${s.name}📶`; links = [msgLink("GB Limited 📶")]; }
  else links = [msgLink(`Salam, hoş geldiňiz: ${s.name}👤`), ...db.servers.map((x) => x.link)];
  const h = {
    "profile-title": "base64:" + b64s(PANEL_TITLE),
    "profile-update-interval": "1",
    "subscription-userinfo": `upload=0; download=${Math.min(used, total || used)}; total=${total}; expire=${Math.floor(s.expiresAt / 1000)}`,
    announce: "base64:" + b64s(announce),
  };
  const c = db.settings.contacts?.[0];
  if (c?.url) h["support-url"] = c.url;
  return { h, links };
}
// Google dosyasında HTTP başlığı olmadığı için başlıklar "#anahtar: değer" satırları olarak başa yazılır
const subText = (h, links) => Object.entries(h).map(([k, v]) => `#${k}: ${v}`).join("\n") + "\n" + links.join("\n") + "\n";
const deletedParts = () => ({
  h: { "profile-title": "base64:" + b64s(PANEL_TITLE), "profile-update-interval": "1", announce: "base64:" + b64s("Deleted Subs🩸") },
  links: [msgLink("Deleted Subs🩸")],
});

async function saPut(sa, id, body, oldId) {
  const H = { authorization: "Bearer " + (await gToken(sa)) };
  if (oldId) {
    const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${oldId}?uploadType=media`, { method: "PATCH", headers: { ...H, "content-type": "text/plain; charset=utf-8" }, body, signal: AbortSignal.timeout(9000) });
    if (r.ok) return oldId;
    if (r.status !== 404) throw new Error("Drive " + r.status + ": " + (await r.text()).slice(0, 120));
  }
  const b = "dvr" + rnd(8);
  const payload = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: id + ".txt", mimeType: "text/plain" })}\r\n--${b}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}\r\n--${b}--`;
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", { method: "POST", headers: { ...H, "content-type": `multipart/related; boundary=${b}` }, body: payload, signal: AbortSignal.timeout(9000) });
  const d = await r.json().catch(() => ({}));
  if (!d.id) throw new Error(d.error?.message || "dosya oluşturulamadı");
  const pr = await fetch(`https://www.googleapis.com/drive/v3/files/${d.id}/permissions`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ role: "reader", type: "anyone" }), signal: AbortSignal.timeout(9000) });
  if (!pr.ok) throw new Error("dosya herkese açık yapılamadı");
  return d.id;
}
async function gasPut(st, oldId, body) {
  const r = await fetch(st.scriptUrl, { method: "POST", headers: { "content-type": "text/plain;charset=utf-8" }, body: JSON.stringify({ token: st.syncKey, id: oldId || "", content: body }), redirect: "follow", signal: AbortSignal.timeout(15000) });
  const d = await r.json().catch(() => null);
  if (!d?.id) throw new Error(d?.error === "forbidden" ? "Sync Key yanlış" : d?.error || "Apps Script cevap vermedi");
  return d.id;
}
const driveReady = (db) => !!getSa(db) || !!(db.settings.scriptUrl && db.settings.syncKey);
async function drivePutSub(db, id, body, oldId) {
  const sa = getSa(db), st = db.settings, hasGas = !!(st.scriptUrl && st.syncKey);
  if (sa) {
    try { return await saPut(sa, id, body, oldId); } catch (e) { if (!hasGas) throw e; }   // Service Account kota hatası verirse Apps Script yedeği
  }
  if (hasGas) return gasPut(st, oldId, body);
  throw new Error("Google Drive ayarı yok (Netlify: GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY ya da SA_JSON; Ayarlar'da Apps Script)");
}
async function googleSub(db, s) {
  const use = await store().get("use:" + s.id, { type: "json" });
  const { h, links } = subParts(db, s, use);
  const text = subText(h, links);
  const gid = await drivePutSub(db, s.id, text, await gidOf(s.id));
  await Promise.all([store().setJSON("gid:" + s.id, { id: gid }), store().setJSON("gh:" + s.id, { h: sha(text) })]);
  return gid;
}
// Silinen abonelik: Google dosyası silinmez, içeriği "Deleted Subs🩸" olur
async function googleDeleted(db, id) {
  const gid = await gidOf(id);
  if (!gid || !driveReady(db)) return;
  const { h, links } = deletedParts();
  const text = subText(h, links);
  await drivePutSub(db, id, text, gid);
  await store().setJSON("gh:" + id, { h: sha(text) });
}
// Değişen / yeni / günü azalan abonelik dosyalarını yeniler (gsched.mjs, /api/cron ve server değişince çağrılır)
export async function refreshAll(max = 20) {
  const db = await load();
  if (!driveReady(db)) return { google: 0, waiting: 0, gerr: "Google Drive ayarı yok" };
  const subs = Object.values(db.subs);
  let google = 0, waiting = 0, gerr = "";
  for (let i = 0; i < subs.length; i += 20) {
    const part = await Promise.all(subs.slice(i, i + 20).map(async (s) => {
      const [g, gh, use] = await Promise.all([store().get("gid:" + s.id, { type: "json" }), store().get("gh:" + s.id, { type: "json" }), store().get("use:" + s.id, { type: "json" })]);
      const { h, links } = subParts(db, s, use);
      const text = subText(h, links), hh = sha(text);
      return !g?.id || gh?.h !== hh ? { s, text, hh, old: g?.id || "" } : null;
    }));
    const todo = part.filter(Boolean);
    for (let k = 0; k < todo.length; k += 10) {
      const grp = todo.slice(k, k + 10);
      if (gerr || google >= max) { waiting += grp.length; continue; }
      await Promise.all(grp.map(async (w) => {
        try {
          const gid = await drivePutSub(db, w.s.id, w.text, w.old);
          await Promise.all([store().setJSON("gid:" + w.s.id, { id: gid }), store().setJSON("gh:" + w.s.id, { h: w.hh })]);
          google++;
        } catch (e) { gerr = String(e?.message || e); waiting++; }
      }));
    }
  }
  // Silinen kodlar: Google dosyası hâlâ eski içerikteyse "Deleted Subs🩸" yap
  const dp = deletedParts(), dtext = subText(dp.h, dp.links), dh = sha(dtext);
  const delIds = Object.entries(db.deleted).filter(([, t]) => Date.now() - Number(t) < 7 * DAY).map(([id]) => id);
  for (let i = 0; i < delIds.length; i += 20) {
    const part = await Promise.all(delIds.slice(i, i + 20).map(async (id) => {
      const [g, gh] = await Promise.all([store().get("gid:" + id, { type: "json" }), store().get("gh:" + id, { type: "json" })]);
      return g?.id && gh?.h !== dh ? { id, old: g.id } : null;
    }));
    const todo = part.filter(Boolean);
    for (let k = 0; k < todo.length; k += 10) {
      const grp = todo.slice(k, k + 10);
      if (gerr || google >= max) { waiting += grp.length; continue; }
      await Promise.all(grp.map(async (w) => {
        try {
          await drivePutSub(db, w.id, dtext, w.old);
          await store().setJSON("gh:" + w.id, { h: dh });
          google++;
        } catch (e) { gerr = String(e?.message || e); waiting++; }
      }));
    }
  }
  return { google, waiting, gerr };
}
// /sub/<id>: Netlify üzerinden abonelik cevabı (başlıklar gerçek HTTP başlığı)
async function subServe(req) {
  const PLAIN = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
  let id = "";
  try { id = decodeURIComponent(new URL(req.url).pathname.replace(/^\/sub\//, "").replace(/\/$/, "")); } catch {}
  if (!/^[\w-]{6,}$/.test(id)) return new Response("Sub bulunamadı", { status: 404, headers: PLAIN });
  const db = await load();
  const s = db.subs[id];
  if (!s) {
    if (!db.deleted[id]) return new Response("Sub bulunamadı", { status: 404, headers: PLAIN });
    const d = deletedParts();
    return new Response(d.links.join("\n") + "\n", { headers: { ...PLAIN, ...d.h } });
  }
  const use = await store().get("use:" + id, { type: "json" });
  const { h, links } = subParts(db, s, use);
  return new Response(links.join("\n") + "\n", { headers: { ...PLAIN, ...h } });
}

// ───────── Router ─────────
async function route(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "").replace(/\/+$/, "") || "/";
  const m = req.method;
  const seg = path.split("/").filter(Boolean);
  const r = seg[0];
  let b = {};
  if (m !== "GET" && m !== "DELETE") {
    try {
      b = (await req.json()) || {};
    } catch {}
  }
  const db = await load();

  if (r === "public") return J({ contacts: db.settings.contacts });
  if (r === "login" && m === "POST") return doLogin(req, db, b);

  // Gerçek trafik: VPN sunucusu { key: USAGE_KEY, items: [{ id: "abonelik-id", usedGb: 3.2 }] } gönderir
  if (r === "usage" && m === "POST") {
    const k = String(b.key || req.headers.get("x-usage-key") || "");
    if (!USAGE_KEY || !eq(k, USAGE_KEY)) return E("Yetkisiz", 401);
    let n = 0;
    for (const it of (Array.isArray(b.items) ? b.items : []).slice(0, 500)) {
      const id = String(it?.id || it?.token || ""), gb = Number(it?.usedGb);
      if (!db.subs[id] || !Number.isFinite(gb) || gb < 0) continue;
      await store().setJSON("use:" + id, { usedGb: gb, at: Date.now() });
      n++;
    }
    return J({ ok: true, n });
  }
  // dış zamanlayıcı için: /api/cron?key=CRON_KEY
  if (r === "cron") {
    const key = process.env.CRON_KEY || USAGE_KEY;
    if (!key || !eq(url.searchParams.get("key") || "", key)) return E("bad", 401);
    return J({ ok: true, ...(await refreshAll(12)) });
  }

  const acc = account(db, (req.headers.get("authorization") || "").replace(/^Bearer /, ""));
  if (!acc) return E("Giriş gerekli", 401);
  const owner = acc.role === "owner";

  if (r === "me") return J({ me: meOut(acc, db) });

  // ── Ayarlar
  if (r === "settings") {
    if (m === "GET") {
      const out = { contacts: db.settings.contacts, ...directInfo(db) };
      if (owner) {
        out.driveUrl = db.settings.driveUrl || "";
        out.scriptUrl = db.settings.scriptUrl || "";
        out.syncKey = db.settings.syncKey || "";
        out.apiKey = db.settings.apiKey || "";
        out.saEmail = saEmail(db);
      }
      return J(out);
    }
    if (m === "PUT") {
      if (!owner) return E("Sadece owner", 403);
      if (b.contacts !== undefined) {
        const c = cleanContacts(b.contacts);
        if (!c) return E("İletişim linki geçersiz (https://... olmalı)");
        db.settings.contacts = c;
      }
      if (b.driveUrl !== undefined) {
        const d = String(b.driveUrl).trim().slice(0, 300);
        if (d && !/^https:\/\/(drive|docs)\.google\.com\//.test(d))
          return E("Geçerli bir Google Drive linki gir");
        db.settings.driveUrl = d;
      }
      if (b.scriptUrl !== undefined) {
        const s = String(b.scriptUrl).trim().slice(0, 300);
        if (s && !/^https:\/\/script\.google\.com\//.test(s))
          return E("Apps Script linki script.google.com ile başlamalı");
        db.settings.scriptUrl = s;
      }
      if (b.syncKey !== undefined) db.settings.syncKey = String(b.syncKey).trim().slice(0, 200);
      if (b.apiKey !== undefined) db.settings.apiKey = String(b.apiKey).trim().slice(0, 200);
      if (b.saJson !== undefined) {
        const raw = String(b.saJson).trim();
        if (!raw) db.settings.saJson = "";
        else {
          let j;
          try {
            j = JSON.parse(raw);
          } catch {
            return E("Service Account JSON geçersiz (dosyanın tamamını yapıştır)");
          }
          if (!j.client_email || !j.private_key) return E("JSON içinde client_email / private_key yok");
          db.settings.saJson = raw;
        }
      }
      await save(db);
      return J({
        contacts: db.settings.contacts,
        ...directInfo(db),
        driveUrl: db.settings.driveUrl || "",
        scriptUrl: db.settings.scriptUrl || "",
        syncKey: db.settings.syncKey || "",
        apiKey: db.settings.apiKey || "",
        saEmail: saEmail(db),
      });
    }
  }

  // ── Aboneliklerin Google dosyalarını yenile (owner): server değişince kalanlar için tekrar tekrar çağrılır
  if (r === "refresh" && m === "POST") {
    if (!owner) return E("Sadece owner", 403);
    return J({ ok: true, ...(await refreshAll(30)) });
  }

  // ── Drive senkron (owner)
  if (r === "sync" && m === "POST") {
    if (!owner) return E("Sadece owner", 403);
    const res = await syncDrive(db);
    if (!res.ok) return E(res.error);
    return J({ driveUrl: db.settings.driveUrl });
  }

  // ── Server listesi (ekleme sadece owner)
  if (r === "servers") {
    if (m === "GET")
      return J({
        servers: db.servers.map((s) => ({
          id: s.id,
          name: s.name,
          proto: s.proto,
          ...(owner ? { link: s.link } : {}),
        })),
      });
    if (!owner) return E("Sadece owner server ekleyebilir", 403);
    if (m === "POST") {
      const lines = String(b.links || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      let added = 0,
        bad = 0;
      for (const l of lines) {
        if (!LINK.test(l)) {
          bad++;
          continue;
        }
        if (db.servers.some((s) => s.link === l)) continue;
        if (db.servers.length >= 300) return E("En fazla 300 server");
        db.servers.push({ id: rnd(4), link: l, ...srvInfo(l) });
        added++;
      }
      if (!added && bad) return E("Geçerli link yok (ss, vmess, vless, trojan, hy2)");
      await save(db);
      const sync = await syncDrive(db);
      let gs = null;
      try { gs = await refreshAll(30); } catch {}
      return J({ added, bad, sync, gs });
    }
    if (m === "DELETE" && seg[1]) {
      db.servers = db.servers.filter((s) => s.id !== seg[1]);
      await save(db);
      const sync = await syncDrive(db);
      let gs = null;
      try { gs = await refreshAll(30); } catch {}
      return J({ ok: 1, sync, gs });
    }
  }

  // ── Kullanıcılar (owner)
  if (r === "users") {
    if (!owner) return E("Sadece owner", 403);
    if (m === "GET")
      return J({ users: Object.values(db.users).map((u) => userOut(u, db)) });

    if (m === "POST") {
      const name = String(b.name || "").trim();
      if (!/^[A-Za-z0-9_.\-]{3,24}$/.test(name)) return E("Ad 3-24 karakter (harf, rakam, _ . -)");
      const key = name.toLowerCase();
      if (key === OWNER_NAME.toLowerCase() || db.users[key]) return E("Bu ad zaten var");
      const code = b.code ? str(b.code, 4, 32) : genCode();
      if (!code) return E("Kod 4-32 karakter olmalı");
      const role = b.role === "admin" ? "admin" : "user";
      const days = int(b.days ?? 0, 0, 3650);
      const deviceLimit = int(b.deviceLimit ?? 3, 1, 100);
      const codeLimit = int(b.codeLimit ?? 3, 0, 1000);
      if (days === null || deviceLimit === null || codeLimit === null) return E("Limit değerleri geçersiz");
      const u = {
        key,
        name,
        code,
        role,
        createdAt: Date.now(),
        expiresAt: days ? Date.now() + days * DAY : null,
        deviceLimit,
        codeLimit,
        devices: [],
        disabled: false,
      };
      db.users[key] = u;
      await save(db);
      return J({ user: userOut(u, db) });
    }

    const u = db.users[(seg[1] || "").toLowerCase()];
    if (!u) return E("Kullanıcı yok", 404);

    if (m === "PATCH") {
      if (b.unlimited) u.expiresAt = null;
      else if (b.addDays !== undefined && b.addDays !== null && b.addDays !== "") {
        const d = int(b.addDays, 1, 3650);
        if (!d) return E("Gün 1-3650");
        u.expiresAt = Math.max(Date.now(), u.expiresAt || Date.now()) + d * DAY;
      }
      if (b.deviceLimit !== undefined) {
        const v = int(b.deviceLimit, 1, 100);
        if (v === null) return E("Cihaz limiti 1-100");
        u.deviceLimit = v;
      }
      if (b.codeLimit !== undefined) {
        const v = int(b.codeLimit, 0, 1000);
        if (v === null) return E("Kod limiti 0-1000");
        u.codeLimit = v;
      }
      if (b.newCode) {
        const c = str(b.newCode, 4, 32);
        if (!c) return E("Kod 4-32 karakter");
        u.code = c;
      }
      if (b.disabled !== undefined) u.disabled = !!b.disabled;
      if (b.resetDevices) u.devices = [];
      await save(db);
      return J({ user: userOut(u, db) });
    }
    if (m === "DELETE") {
      try { for (const x of Object.values(db.subs).filter((x) => x.owner === u.key).slice(0, 30)) await googleDeleted(db, x.id); } catch {}
      delete db.users[u.key];
      for (const [id, s] of Object.entries(db.subs))
        if (s.owner === u.key) {
          db.deleted[id] = Date.now();
          delete db.subs[id];
        }
      await save(db);
      let gs = null;
      try { gs = await refreshAll(30); } catch {}
      return J({ ok: 1, gs });
    }
  }

  // ── Abonelikler
  if (r === "subs") {
    if (m === "GET") {
      const all = Object.values(db.subs)
        .filter((s) => acc.role !== "user" || s.owner === acc.key)
        .sort((a, c) => c.createdAt - a.createdAt);
      const out = await Promise.all(all.map(async (s) => {
        const [g, u] = await Promise.all([store().get("gid:" + s.id, { type: "json" }), store().get("use:" + s.id, { type: "json" })]);
        return { ...s, gurl: g?.id ? gUrl(db, g.id) : "", usedGb: u?.usedGb || 0 };
      }));
      return J({ subs: out });
    }
    if (m === "POST") {
      const name = str(b.name, 1, 32);
      if (!name) return E("Kodun adı gerekli (1-32 karakter)");
      const days = int(b.days, 1, 3650);
      if (!days) return E("Gün 1-3650 olmalı");
      const gb = int(b.gb ?? 0, 0, 100000);
      if (gb === null) return E("GB geçersiz");
      const desc = String(b.desc || "").trim().slice(0, 120);
      let ownerKey = acc.key,
        ownerName = acc.name;

      if (owner && b.forUser) {
        const t = db.users[String(b.forUser).toLowerCase()];
        if (!t) return E("Kullanıcı yok", 404);
        ownerKey = t.key;
        ownerName = t.name;
      } else if (!owner) {
        const used = codesUsed(db, acc.key);
        if (used >= acc.u.codeLimit) return E(`Kod limitin doldu (${used}/${acc.u.codeLimit})`, 403);
        if (acc.u.expiresAt && Date.now() + days * DAY > acc.u.expiresAt) {
          const left = Math.max(0, Math.ceil((acc.u.expiresAt - Date.now()) / DAY));
          return E(`Hesap süreni aşan kod yapamazsın (kalan ${left} gün)`, 403);
        }
      }

      let driveUrl = "";
      if (owner && b.driveUrl) {
        driveUrl = String(b.driveUrl).trim().slice(0, 300);
        if (!/^https:\/\/(drive|docs)\.google\.com\//.test(driveUrl))
          return E("Geçerli bir Google Drive linki gir");
      }

      // Drive dosyası henüz yoksa panel kendisi oluşturur
      let sync = null;
      if (!db.settings.driveUrl && (db.settings.saJson || (db.settings.scriptUrl && db.settings.syncKey)))
        sync = await syncDrive(db);

      const id = rnd(12);
      db.subs[id] = {
        id,
        name,
        desc,
        days,
        gb,
        createdAt: Date.now(),
        expiresAt: Date.now() + days * DAY,
        owner: ownerKey,
        ownerName,
        by: acc.name,
        driveUrl,
      };
      await save(db);
      let gerr = "", gurl = "";
      try { gurl = gUrl(db, await googleSub(db, db.subs[id])); } catch (e) { gerr = String(e?.message || e); }
      return J({ sub: { ...db.subs[id], gurl, usedGb: 0 }, sync, gerr });
    }
    if (m === "DELETE" && seg[1]) {
      const s = db.subs[seg[1]];
      if (!s) return E("Bulunamadı", 404);
      if (!owner && s.owner !== acc.key) return E("Yetkin yok", 403);
      let gerr = "";
      try { await googleDeleted(db, s.id); } catch (e) { gerr = String(e?.message || e); }
      db.deleted[s.id] = Date.now();
      delete db.subs[s.id];
      await save(db);
      let gs = null;
      if (gerr) { try { gs = await refreshAll(30); } catch {} }
      return J({ ok: 1, gerr, gs });
    }
  }

  return E("Bulunamadı", 404);
}

export default async (req) => {
  try {
    if (new URL(req.url).pathname.startsWith("/sub/")) return await subServe(req);
    return await route(req);
  } catch (e) {
    return E("Server hatası: " + (e?.message || e), 500);
  }
};

export const config = { path: ["/api/*", "/sub/*"] };
