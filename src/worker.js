// Kódkígyó szerver: Cloudflare Worker + D1.
// A /api/* kéréseket ez kezeli, minden mást a statikus fájlok (public/) szolgálnak ki.

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const SKINS = ["classic", "gold", "night", "coral", "ice"];
const LEAGUE_MAX = 9;
const MAX_BODY = 300000;
const DAY = 86400000;
const WEEKLY_CAP = 5000;
const REPORT_REASONS = ["nick", "other"];
// Durva szavak a becenevekhez (ékezet nélkül, kisbetűvel; a számokat betűvé alakítva is ellenőrizzük).
const BAD_WORDS = ["fasz", "geci", "kurva", "picsa", "pina", "buzi", "ribanc", "kocsog", "bazd", "baszd", "fuck", "shit", "bitch", "cunt", "nigg", "hitler", "porn"];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

// ---------- Segédfüggvények ----------
function randomCode(n) {
  let s = "";
  while (s.length < n) {
    const buf = new Uint8Array(n * 2);
    crypto.getRandomValues(buf);
    for (const b of buf) if (b < 248 && s.length < n) s += CODE_CHARS[b % 31];
  }
  return s;
}
async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const int = (v, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0; };
const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// A hetek magyar idő szerint hétfőn kezdődnek, ugyanúgy, mint az appban.
const bpDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit" });
function dayKey(ms) { return bpDate.format(new Date(ms)); }
function addDays(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function weekKey(ms) {
  const key = dayKey(ms);
  const [y, m, d] = key.split("-").map(Number);
  const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(key, -wd);
}

function flatten(text) {
  const leet = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", "@": "a", $: "s" };
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[0134578@$]/g, (c) => leet[c]).replace(/[^a-z]/g, "");
}
function cleanName(raw, min, max, what) {
  const name = String(raw == null ? "" : raw).normalize("NFC").replace(/\s+/g, " ").trim();
  if (name.length < min || name.length > max) throw new HttpError(400, `A ${what} ${min}–${max} karakter legyen.`);
  if (!/^[\p{L}\p{N} ._-]+$/u.test(name)) throw new HttpError(400, `A ${what} csak betűt, számot, szóközt, pontot, kötőjelet és aláhúzást tartalmazhat.`);
  const flat = flatten(name);
  if (BAD_WORDS.some((w) => flat.includes(w))) throw new HttpError(400, `Ezt a ${what === "becenév" ? "becenevet" : "nevet"} nem használhatod. Válassz másikat!`);
  return name;
}

async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Túl nagy kérés.");
  if (!text) return {};
  let body;
  try { body = JSON.parse(text); } catch { throw new HttpError(400, "Hibás kérés."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Hibás kérés.");
  return body;
}

async function rateLimit(env, key, max, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT count, reset_at FROM rate WHERE key = ?").bind(key).first();
  if (!row || row.reset_at < now) {
    await env.DB.prepare("INSERT OR REPLACE INTO rate (key, count, reset_at) VALUES (?, 1, ?)").bind(key, now + windowMs).run();
    return;
  }
  if (row.count >= max) throw new HttpError(429, "Túl sok próbálkozás. Próbáld újra kicsit később.");
  await env.DB.prepare("UPDATE rate SET count = count + 1 WHERE key = ?").bind(key).run();
}

async function authenticate(req, env) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer ([A-Z0-9]{8})\.([A-Z0-9]{16})$/);
  if (!m) throw new HttpError(401, "Ehhez be kell jelentkezned.");
  const p = await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(m[1]).first();
  if (!p || !safeEqual(p.secret_hash, await sha256(m[2]))) throw new HttpError(401, "Érvénytelen belépőkód.");
  return p;
}

// Nyilvános profil: ennyit lát egy játékosról a barátja vagy az osztálytársa.
function publicProfile(p, weekXp, wk) {
  return {
    id: p.id, nick: p.nick, xp: p.xp, streak: p.streak, bestStreak: p.best_streak, lastDay: p.last_day || "",
    league: p.league, lessons: p.lessons, ach: p.ach, skin: p.skin, joined: dayKey(p.created_at), weekKey: wk, weekXp: weekXp || 0,
  };
}

// ---------- Végpontok ----------
async function register(req, env) {
  const body = await readJson(req);
  const nick = cleanName(body.nick, 2, 20, "becenév");
  const ip = req.headers.get("cf-connecting-ip") || "local";
  await rateLimit(env, "reg:" + (await sha256("kodkigyo:" + ip)).slice(0, 24), 20, 3600000);
  const secret = randomCode(16), hash = await sha256(secret), now = Date.now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = randomCode(8), code = randomCode(6);
    try {
      await env.DB.prepare("INSERT INTO players (id, secret_hash, nick, code, created_at, updated_at, stats_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, hash, nick, code, now, now, now).run();
      return json({ token: id + "." + secret, id, code, nick });
    } catch (e) {
      if (!/UNIQUE/i.test(String(e && e.message))) throw e;
    }
  }
  throw new HttpError(500, "Nem sikerült létrehozni a fiókot. Próbáld újra!");
}

async function social(p, env) {
  const wk = weekKey(Date.now());
  const rows = (sql, ...args) => env.DB.prepare(sql).bind(...args).all().then((r) => r.results || []);
  const withWeek = "SELECT p.*, COALESCE(w.xp, 0) AS wxp FROM players p LEFT JOIN weekly w ON w.player_id = p.id AND w.week_key = ?1";
  const [following, followers, mine] = await Promise.all([
    rows(withWeek + " JOIN follows f ON f.followee = p.id WHERE f.follower = ?2 LIMIT 200", wk, p.id),
    rows(withWeek + " JOIN follows f ON f.follower = p.id WHERE f.followee = ?2 LIMIT 500", wk, p.id),
    env.DB.prepare("SELECT xp FROM weekly WHERE player_id = ? AND week_key = ?").bind(p.id, wk).first(),
  ]);
  let cls = null;
  if (p.class_id) {
    const c = await env.DB.prepare("SELECT * FROM classes WHERE id = ?").bind(p.class_id).first();
    if (c) {
      const members = await rows(withWeek + " WHERE p.class_id = ?2 LIMIT 300", wk, c.id);
      cls = { id: c.id, name: c.name, code: c.code, ownerId: c.owner_id, members: members.map((m) => publicProfile(m, m.wxp, wk)) };
    }
  }
  let lastResult = null;
  try { lastResult = p.last_result ? JSON.parse(p.last_result) : null; } catch {}
  return json({
    week: wk,
    me: { ...publicProfile(p, mine ? mine.xp : 0, wk), code: p.code, classId: p.class_id, lastResult },
    following: following.map((r) => publicProfile(r, r.wxp, wk)),
    followers: followers.map((r) => publicProfile(r, r.wxp, wk)),
    class: cls,
  });
}

async function putMe(p, req, env) {
  const b = await readJson(req);
  const now = Date.now();
  const sets = [], binds = [];
  if (b.nick != null) { sets.push("nick = ?"); binds.push(cleanName(b.nick, 2, 20, "becenév")); }
  const s = b.stats;
  if (s && typeof s === "object") {
    // Csalás elleni korlát: percenként legfeljebb 100 XP gyűlhet. Az első szinkronnál
    // a fiók előtt, offline gyűjtött XP-t is elfogadjuk.
    const allow = p.seeded ? Math.min(3000, Math.max(0, now - p.stats_at) / 60000 * 100) : 100000;
    const xp = Math.min(int(s.xp, 10000000), p.xp + Math.floor(allow));
    sets.push("xp = ?", "streak = ?", "best_streak = ?", "last_day = ?", "lessons = ?", "ach = ?", "skin = ?", "stats_at = ?", "seeded = 1");
    binds.push(Math.max(xp, 0), int(s.streak, 5000), int(s.bestStreak, 5000), isDay(s.lastDay) ? s.lastDay : p.last_day,
      int(s.lessons, 500), int(s.ach, 1000), SKINS.includes(s.skin) ? s.skin : "classic", now);
    // Osztály nélkül a liga a gépi ellenfelek elleni eredményből jön; osztályban a szerver dönt.
    if (!p.class_id && Number.isInteger(s.league)) { sets.push("league = ?"); binds.push(Math.max(0, Math.min(LEAGUE_MAX, s.league))); }
    const wk = weekKey(now), prev = addDays(wk, -7);
    const weeks = [];
    if (s.weekKey === wk || s.weekKey === prev) weeks.push([s.weekKey, int(s.weekXp, WEEKLY_CAP)]);
    if (s.prevWeek && typeof s.prevWeek === "object" && s.prevWeek.key === prev) weeks.push([prev, int(s.prevWeek.xp, WEEKLY_CAP)]);
    for (const [k, v] of weeks) {
      const cur = await env.DB.prepare("SELECT xp FROM weekly WHERE player_id = ? AND week_key = ?").bind(p.id, k).first();
      const had = cur ? cur.xp : 0;
      const next = Math.max(had, Math.min(v, had + Math.floor(allow)));
      if (next !== had) {
        await env.DB.prepare("INSERT INTO weekly (player_id, week_key, xp) VALUES (?1, ?2, ?3) ON CONFLICT (player_id, week_key) DO UPDATE SET xp = ?3")
          .bind(p.id, k, next).run();
      }
    }
  }
  sets.push("updated_at = ?");
  binds.push(now);
  await env.DB.prepare(`UPDATE players SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, p.id).run();
  return json({ ok: true });
}

async function getProgress(p, env) {
  const row = await env.DB.prepare("SELECT data, updated_at FROM progress WHERE player_id = ?").bind(p.id).first();
  if (!row) return json({ data: null, updatedAt: 0 });
  let data = null;
  try { data = JSON.parse(row.data); } catch {}
  return json({ data, updatedAt: row.updated_at });
}
async function putProgress(p, req, env) {
  const b = await readJson(req);
  if (!b.data || typeof b.data !== "object") throw new HttpError(400, "Hibás mentés.");
  const text = JSON.stringify(b.data);
  if (text.length > 250000) throw new HttpError(413, "Túl nagy mentés.");
  const at = int(b.updatedAt, 1e13) || Date.now();
  await env.DB.prepare("INSERT INTO progress (player_id, data, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (player_id) DO UPDATE SET data = ?2, updated_at = ?3")
    .bind(p.id, text, at).run();
  await env.DB.prepare("UPDATE players SET updated_at = ? WHERE id = ?").bind(Date.now(), p.id).run();
  return json({ ok: true });
}

async function follow(p, req, env) {
  const b = await readJson(req);
  await rateLimit(env, "follow:" + p.id, 60, 3600000);
  let target = null;
  if (b.code) {
    const code = String(b.code).toUpperCase().replace(/[^A-Z0-9]/g, "");
    target = await env.DB.prepare("SELECT id, nick, class_id FROM players WHERE code = ?").bind(code).first();
    if (!target) throw new HttpError(404, "Nincs ilyen kódú játékos. Ellenőrizd a kódot!");
  } else if (b.id) {
    target = await env.DB.prepare("SELECT id, nick, class_id FROM players WHERE id = ?").bind(String(b.id)).first();
    // Kód nélkül csak osztálytársat, vagy azt követheted vissza, aki már követ téged.
    const classmate = target && p.class_id && target.class_id === p.class_id;
    const followsMe = target && (await env.DB.prepare("SELECT 1 AS x FROM follows WHERE follower = ? AND followee = ?").bind(target.id, p.id).first());
    if (!classmate && !followsMe) throw new HttpError(403, "Kód nélkül csak osztálytársat vagy a követőidet követheted.");
  } else throw new HttpError(400, "Add meg a barátod kódját.");
  if (target.id === p.id) throw new HttpError(400, "Saját magadat nem követheted.");
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM follows WHERE follower = ?").bind(p.id).first();
  if (n.n >= 200) throw new HttpError(400, "Legfeljebb 200 játékost követhetsz.");
  await env.DB.prepare("INSERT OR IGNORE INTO follows (follower, followee, created_at) VALUES (?, ?, ?)").bind(p.id, target.id, Date.now()).run();
  return json({ ok: true, id: target.id, nick: target.nick });
}
async function unfollow(p, id, env) {
  await env.DB.prepare("DELETE FROM follows WHERE follower = ? AND followee = ?").bind(p.id, id).run();
  return json({ ok: true });
}

async function createClass(p, req, env) {
  const b = await readJson(req);
  const name = cleanName(b.name, 2, 40, "osztály neve");
  await rateLimit(env, "class:" + p.id, 10, DAY);
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = randomCode(8), code = randomCode(6);
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO classes (id, code, name, owner_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, code, name, p.id, Date.now()),
        env.DB.prepare("UPDATE players SET class_id = ? WHERE id = ?").bind(id, p.id),
      ]);
      await handOver(p, env, id);
      return json({ ok: true, id, code, name });
    } catch (e) {
      if (!/UNIQUE/i.test(String(e && e.message))) throw e;
    }
  }
  throw new HttpError(500, "Nem sikerült létrehozni az osztályt. Próbáld újra!");
}
async function joinClass(p, req, env) {
  const b = await readJson(req);
  await rateLimit(env, "join:" + p.id, 30, 3600000);
  const code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const c = await env.DB.prepare("SELECT * FROM classes WHERE code = ?").bind(code).first();
  if (!c) throw new HttpError(404, "Nincs ilyen kódú osztály. Kérd el újra a tanárodtól!");
  if (p.class_id === c.id) return json({ ok: true, id: c.id, name: c.name });
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE class_id = ?").bind(c.id).first();
  if (n.n >= 300) throw new HttpError(400, "Ez az osztály megtelt.");
  await env.DB.prepare("UPDATE players SET class_id = ? WHERE id = ?").bind(c.id, p.id).run();
  await handOver(p, env, c.id);
  return json({ ok: true, id: c.id, name: c.name });
}
// Ha valaki elhagy egy osztályt, amelyet ő hozott létre, a legrégebbi tag lesz a gazdája;
// ha nem maradt tag, az osztály törlődik.
async function handOver(p, env, keepId) {
  if (!p.class_id || p.class_id === keepId) return;
  const c = await env.DB.prepare("SELECT * FROM classes WHERE id = ?").bind(p.class_id).first();
  if (!c || c.owner_id !== p.id) return;
  const heir = await env.DB.prepare("SELECT id FROM players WHERE class_id = ? AND id != ? ORDER BY created_at LIMIT 1").bind(c.id, p.id).first();
  if (heir) await env.DB.prepare("UPDATE classes SET owner_id = ? WHERE id = ?").bind(heir.id, c.id).run();
  else await env.DB.batch([env.DB.prepare("DELETE FROM classes WHERE id = ?").bind(c.id), env.DB.prepare("DELETE FROM class_weeks WHERE class_id = ?").bind(c.id)]);
}
async function leaveClass(p, env) {
  if (!p.class_id) return json({ ok: true });
  await env.DB.prepare("UPDATE players SET class_id = NULL WHERE id = ?").bind(p.id).run();
  await handOver(p, env, null);
  return json({ ok: true });
}
async function kick(p, id, env) {
  const c = p.class_id && (await env.DB.prepare("SELECT * FROM classes WHERE id = ?").bind(p.class_id).first());
  if (!c || c.owner_id !== p.id) throw new HttpError(403, "Csak az osztály létrehozója távolíthat el tagot.");
  if (id === p.id) throw new HttpError(400, "Saját magadat a Kilépés gombbal veheted ki.");
  await env.DB.prepare("UPDATE players SET class_id = NULL WHERE id = ? AND class_id = ?").bind(id, c.id).run();
  return json({ ok: true });
}

async function report(p, req, env) {
  const b = await readJson(req);
  await rateLimit(env, "report:" + p.id, 20, DAY);
  const reason = REPORT_REASONS.includes(b.reason) ? b.reason : "other";
  const target = await env.DB.prepare("SELECT id FROM players WHERE id = ?").bind(String(b.id || "")).first();
  if (!target) throw new HttpError(404, "Nincs ilyen játékos.");
  await env.DB.prepare("INSERT INTO reports (reporter, target, reason, created_at) VALUES (?, ?, ?, ?)").bind(p.id, target.id, reason, Date.now()).run();
  return json({ ok: true });
}

async function deleteAccount(p, env) {
  await handOver(p, env, null);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM follows WHERE follower = ?1 OR followee = ?1").bind(p.id),
    env.DB.prepare("DELETE FROM weekly WHERE player_id = ?").bind(p.id),
    env.DB.prepare("DELETE FROM progress WHERE player_id = ?").bind(p.id),
    env.DB.prepare("DELETE FROM reports WHERE reporter = ?1 OR target = ?1").bind(p.id),
    env.DB.prepare("DELETE FROM players WHERE id = ?").bind(p.id),
  ]);
}

// ---------- Heti ligazárás és takarítás (óránként fut) ----------
function zones(size, league) {
  return { up: league < LEAGUE_MAX ? Math.min(3, Math.max(1, size - 1)) : 0, down: league > 0 && size >= 8 ? 3 : 0 };
}
async function closeClassWeek(env, classId, wk) {
  const rows = (await env.DB.prepare(
    "SELECT p.id, p.league, w.xp FROM players p JOIN weekly w ON w.player_id = p.id AND w.week_key = ? WHERE p.class_id = ? AND w.xp > 0 ORDER BY w.xp DESC, p.created_at ASC")
    .bind(wk, classId).all()).results || [];
  const stmts = rows.map((r, i) => {
    const rank = i + 1, z = zones(rows.length, r.league);
    const res = rank <= z.up ? "up" : z.down && rank > rows.length - z.down ? "down" : "stay";
    const to = Math.max(0, Math.min(LEAGUE_MAX, r.league + (res === "up" ? 1 : res === "down" ? -1 : 0)));
    const reward = rank === 1 ? 30 : rank === 2 ? 20 : rank === 3 ? 10 : 0;
    const result = JSON.stringify({ week: wk, rank, size: rows.length, res, from: r.league, to, reward });
    return env.DB.prepare("UPDATE players SET league = ?, last_result = ? WHERE id = ?").bind(to, result, r.id);
  });
  stmts.push(env.DB.prepare("INSERT OR IGNORE INTO class_weeks (class_id, week_key, done_at) VALUES (?, ?, ?)").bind(classId, wk, Date.now()));
  await env.DB.batch(stmts);
}
async function hourly(env) {
  const now = Date.now(), cur = weekKey(now);
  const pending = (await env.DB.prepare(
    `SELECT DISTINCT p.class_id AS c, w.week_key AS wk FROM weekly w JOIN players p ON p.id = w.player_id
     WHERE p.class_id IS NOT NULL AND w.week_key < ? AND w.xp > 0
     AND NOT EXISTS (SELECT 1 FROM class_weeks cw WHERE cw.class_id = p.class_id AND cw.week_key = w.week_key) LIMIT 100`)
    .bind(cur).all()).results || [];
  for (const r of pending) await closeClassWeek(env, r.c, r.wk);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM weekly WHERE week_key < ?").bind(addDays(cur, -56)),
    env.DB.prepare("DELETE FROM class_weeks WHERE week_key < ?").bind(addDays(cur, -56)),
    env.DB.prepare("DELETE FROM rate WHERE reset_at < ?").bind(now),
    env.DB.prepare("DELETE FROM reports WHERE created_at < ?").bind(now - 90 * DAY),
  ]);
  // 12 hónapja inaktív fiókok törlése.
  const stale = (await env.DB.prepare("SELECT * FROM players WHERE updated_at < ? LIMIT 50").bind(now - 365 * DAY).all()).results || [];
  for (const p of stale) await deleteAccount(p, env);
}

// ---------- Útválasztás ----------
async function api(req, env, url) {
  const path = url.pathname.slice(4); // "/api" levágva
  const method = req.method;
  if (method === "GET" && path === "/health") return json({ app: "kodkigyo", ok: true });
  if (method === "POST" && path === "/register") return register(req, env);
  const p = await authenticate(req, env);
  if (method === "GET" && path === "/social") return social(p, env);
  if (method === "PUT" && path === "/me") return putMe(p, req, env);
  if (method === "DELETE" && path === "/me") { await deleteAccount(p, env); return json({ ok: true }); }
  if (method === "GET" && path === "/progress") return getProgress(p, env);
  if (method === "PUT" && path === "/progress") return putProgress(p, req, env);
  if (method === "POST" && path === "/follow") return follow(p, req, env);
  let m = path.match(/^\/follow\/([A-Z0-9]{8})$/);
  if (method === "DELETE" && m) return unfollow(p, m[1], env);
  if (method === "POST" && path === "/class") return createClass(p, req, env);
  if (method === "POST" && path === "/class/join") return joinClass(p, req, env);
  if (method === "POST" && path === "/class/leave") return leaveClass(p, env);
  m = path.match(/^\/class\/members\/([A-Z0-9]{8})$/);
  if (method === "DELETE" && m) return kick(p, m[1], env);
  if (method === "POST" && path === "/report") return report(p, req, env);
  throw new HttpError(404, "Nincs ilyen végpont.");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Szerverhiba. Próbáld újra később!" }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(hourly(env));
  },
};
