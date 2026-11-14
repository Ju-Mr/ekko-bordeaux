/* Relais Ekko pour la prise de rendez-vous
   Site (ekko-bordeaux.fr)  ->  ce Worker  ->  fonction Deluge "ekko_rdv" dans Zoho CRM
   Secret à créer dans Cloudflare : ZOHO_URL (adresse complète de la fonction, clé d'API comprise). */

const CFG = {
  tz: "Europe/Paris",
  days: [1, 2, 3, 4, 5],                          // 1 = lundi … 5 = vendredi
  windows: [["09:00", "12:30"], ["14:00", "18:00"]], // plages d'ouverture
  step: 30,            // un créneau proposé toutes les 30 min
  buffer: 10,          // minutes de marge autour des réunions existantes
  minNoticeH: 12,      // délai minimum avant un rendez-vous
  maxDays: 45,         // fenêtre de réservation
  durations: [20, 30],
  origins: ["https://ekko-bordeaux.fr", "https://www.ekko-bordeaux.fr"],
};

const fmt = (tz) => new Intl.DateTimeFormat("en-CA", {
  timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const F = fmt(CFG.tz);
function parts(ms) {
  const o = {}; for (const p of F.formatToParts(new Date(ms))) o[p.type] = p.value; return o;
}
function offsetMs(ms) { // décalage du fuseau à cet instant
  const p = parts(ms);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
function localToUtc(y, m, d, hh, mm) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  return guess - offsetMs(guess - offsetMs(guess));
}
function isoLocal(ms) {
  const p = parts(ms), off = Math.round(offsetMs(ms) / 60000);
  const s = off < 0 ? "-" : "+", a = Math.abs(off);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${s}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
const hm = (s) => s.split(":").map(Number);

export function buildSlots(dateStr, dur, busy, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m || !CFG.durations.includes(dur)) return [];
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const wd = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  if (!CFG.days.includes(wd)) return [];
  const out = [], buf = CFG.buffer * 60000, min = now + CFG.minNoticeH * 3600000, max = now + CFG.maxDays * 86400000;
  for (const [a, b] of CFG.windows) {
    const [ah, am] = hm(a), [bh, bm] = hm(b);
    const end = localToUtc(y, mo, d, bh, bm);
    for (let t = localToUtc(y, mo, d, ah, am); t + dur * 60000 <= end; t += CFG.step * 60000) {
      const e = t + dur * 60000;
      if (t < min || t > max) continue;
      if (busy.some((x) => t < x.end + buf && e > x.start - buf)) continue;
      const iso = isoLocal(t);
      out.push({ t: iso.slice(11, 16), iso });
    }
  }
  return out;
}

async function zoho(env, payload) {
  const r = await fetch(env.ZOHO_URL, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  let j = await r.json();
  if (j && j.details && typeof j.details.output === "string") { try { j = JSON.parse(j.details.output); } catch (_) {} }
  if (!r.ok) throw new Error("zoho " + r.status);
  return j;
}
async function busyFor(env, dateStr) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const from = localToUtc(y, mo, d, 0, 0), to = from + 86400000;
  const j = await zoho(env, { action: "busy", from: isoLocal(from), to: isoLocal(to) });
  return (j.busy || []).map((x) => ({ start: Date.parse(x.start), end: Date.parse(x.end) })).filter((x) => x.start && x.end);
}

const clean = (v, n) => String(v || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const allowed = CFG.origins.concat(env.EXTRA_ORIGIN ? [env.EXTRA_ORIGIN] : []);
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "content-type", Vary: "Origin",
    };
    const send = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (origin && !allowed.includes(origin)) return send({ error: "origin" }, 403);
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/slots") {
        const date = url.searchParams.get("date") || "", dur = +url.searchParams.get("d");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !CFG.durations.includes(dur)) return send({ error: "params" }, 400);
        return send({ slots: buildSlots(date, dur, await busyFor(env, date)) });
      }
      if (req.method === "POST" && url.pathname === "/book") {
        const b = await req.json();
        if (b.hp) return send({ ok: true });                       // piège anti-robots
        const dur = +b.d, iso = clean(b.iso, 30), email = clean(b.email, 100), nom = clean(b.nom, 80);
        if (!nom || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !CFG.durations.includes(dur) || !/^\d{4}-\d{2}-\d{2}T/.test(iso)) return send({ error: "params" }, 400);
        const date = iso.slice(0, 10), ok = buildSlots(date, dur, await busyFor(env, date)).some((s) => s.iso === iso);
        if (!ok) return send({ error: "pris" }, 409);
        const start = Date.parse(iso);
        await zoho(env, {
          action: "create", start: isoLocal(start), end: isoLocal(start + dur * 60000), duree: dur,
          nom, prenom: clean(b.prenom, 40), email, tel: clean(b.tel, 30), message: clean(b.message, 1500),
        });
        return send({ ok: true });
      }
      return send({ error: "not found" }, 404);
    } catch (e) {
      return send({ error: "serveur" }, 502);
    }
  },
};
