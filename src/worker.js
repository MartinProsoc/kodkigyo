// Kódkígyó szerver: Cloudflare Worker + D1.
// A /api/* kéréseket ez kezeli, minden mást a statikus fájlok (public/) szolgálnak ki.

const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const SKINS = ["classic", "gold", "night", "coral", "ice"];
// Tekla kiegészítői és helyük (ugyanaz, mint az appban az ACCS): helyenként legfeljebb egy lehet rajta.
const ACCS = { bowtie: "neck", cap: "head", glasses: "face", shades: "face", headphones: "head", wizard: "head", crown: "head" };
function cleanAcc(v) {
  const out = [], slots = new Set();
  for (const id of String(v || "").split(",").slice(0, 6)) {
    if (ACCS[id] && !slots.has(ACCS[id])) { out.push(id); slots.add(ACCS[id]); }
  }
  return out.join(",");
}
const LEAGUE_MAX = 9;
const MAX_BODY = 300000;
const DAY = 86400000;
const WEEKLY_CAP = 5000;
const GROUP_SIZE = 30;
const LEAGUE_REWARDS = [20, 10, 5]; // az 1–3. helyért járó drágakő (ugyanennyi az appban)
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

// Az üzemeltető fiókja(i) (wrangler.jsonc: vars.ADMIN_IDS). Nekik az app tesztpanelt mutat, és csak ők
// használhatják a moderálás végpontjait (/api/admin/...): jelentések, keresés, átnevezés, törlés.
const isAdmin = (env, id) => String(env.ADMIN_IDS || "").split(",").map((s) => s.trim()).includes(id);

// Nyilvános profil: ennyit lát egy játékosról a barátja vagy az osztálytársa.
function publicProfile(p, weekXp, wk) {
  return {
    id: p.id, nick: p.nick, xp: p.xp, streak: p.streak, bestStreak: p.best_streak, lastDay: p.last_day || "",
    league: p.league, lessons: p.lessons, ach: p.ach, skin: p.skin, acc: p.acc || "", joined: dayKey(p.created_at), weekKey: wk, weekXp: weekXp || 0,
  };
}

// Cloudflare Turnstile robotszűrő a fiók létrehozásához. Csak akkor kapcsol be, ha a nyilvános
// kulcs (vars.TURNSTILE_SITEKEY) és a titkos kulcs (TURNSTILE_SECRET titok) is be van állítva.
const captchaOn = (env) => Boolean(env.TURNSTILE_SITEKEY && env.TURNSTILE_SECRET);
async function checkCaptcha(env, token, ip) {
  if (typeof token !== "string" || !token || token.length > 2048) throw new HttpError(400, "Előbb várd meg a robotszűrő ellenőrzését!");
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  if (ip !== "local") form.append("remoteip", ip);
  let ok = false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    ok = Boolean((await r.json()).success);
  } catch (e) {
    throw new HttpError(503, "A robotszűrő most nem érhető el. Próbáld újra kicsit később!");
  }
  if (!ok) throw new HttpError(400, "A robotszűrő ellenőrzése nem sikerült. Próbáld újra!");
}

// ---------- Végpontok ----------
async function register(req, env) {
  const body = await readJson(req);
  const nick = cleanName(body.nick, 2, 20, "becenév");
  const ip = req.headers.get("cf-connecting-ip") || "local";
  if (captchaOn(env)) await checkCaptcha(env, body.captcha, ip);
  // Egy iskola minden gépe gyakran ugyanazon az IP-címen van, ezért egy egész évfolyamnyi regisztrációt engedünk óránként.
  await rateLimit(env, "reg:" + (await sha256("kodkigyo:" + ip)).slice(0, 24), 150, 3600000);
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
  // Ha a múlt heti csoportját az óránkénti zárás még nem érte el, most lezárjuk, hogy friss legyen a ligája.
  const prev = await env.DB.prepare("SELECT grp FROM weekly WHERE player_id = ? AND week_key = ? AND grp IS NOT NULL").bind(p.id, addDays(wk, -7)).first();
  if (prev && (await closeGroup(env, prev.grp))) p = await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(p.id).first();
  const rows = (sql, ...args) => env.DB.prepare(sql).bind(...args).all().then((r) => r.results || []);
  const withWeek = "SELECT p.*, COALESCE(w.xp, 0) AS wxp FROM players p LEFT JOIN weekly w ON w.player_id = p.id AND w.week_key = ?1";
  const [following, followers, mine] = await Promise.all([
    rows(withWeek + " JOIN follows f ON f.followee = p.id WHERE f.follower = ?2 LIMIT 200", wk, p.id),
    rows(withWeek + " JOIN follows f ON f.follower = p.id WHERE f.followee = ?2 LIMIT 500", wk, p.id),
    env.DB.prepare("SELECT xp, grp, league FROM weekly WHERE player_id = ? AND week_key = ?").bind(p.id, wk).first(),
  ]);
  let league = { tier: p.league, grouped: false, members: [] };
  if (mine && mine.grp) {
    const members = await rows("SELECT p.*, w.xp AS wxp FROM weekly w JOIN players p ON p.id = w.player_id WHERE w.grp = ?1 LIMIT 40", mine.grp);
    league = { tier: mine.league, grouped: true, members: members.map((m) => publicProfile(m, m.wxp, wk)) };
  }
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
  const admin = isAdmin(env, p.id);
  // Az üzemeltető látja, hány jelentett játékos vár moderálásra.
  const reported = admin ? (await env.DB.prepare("SELECT COUNT(DISTINCT target) AS n FROM reports").first()).n : undefined;
  return json({
    week: wk,
    me: { ...publicProfile(p, mine ? mine.xp : 0, wk), code: p.code, classId: p.class_id, lastResult, admin, reported },
    following: following.map((r) => publicProfile(r, r.wxp, wk)),
    followers: followers.map((r) => publicProfile(r, r.wxp, wk)),
    class: cls,
    league,
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
    if (typeof s.acc === "string") { sets.push("acc = ?"); binds.push(cleanAcc(s.acc)); }
    // A ligát mindig a szerver dönti el a heti zárásnál, az app által küldött értéket nem vesszük át.
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
  const grouped = s && typeof s === "object" ? await ensureGroup(env, p.id, weekKey(now)) : false;
  return json({ ok: true, grouped });
}

async function getProgress(p, env) {
  const row = await env.DB.prepare("SELECT data, updated_at FROM progress WHERE player_id = ?").bind(p.id).first();
  if (!row) return json({ data: null, updatedAt: 0 });
  let data = null;
  try { data = JSON.parse(row.data); } catch {}
  return json({ data, updatedAt: row.updated_at });
}
// Ugyanaz a szabály, mint az appban (remoteWins): a haladás törlése új korszakot kezd, az nyer;
// különben a több XP. Így egy másik eszköz kevesebb haladással nem írhatja felül a mentést.
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
function moreProgress(a, b) {
  if (num(a.epoch) !== num(b.epoch)) return num(a.epoch) > num(b.epoch);
  return num(a.xp) > num(b.xp);
}
async function putProgress(p, req, env) {
  const b = await readJson(req);
  if (!b.data || typeof b.data !== "object") throw new HttpError(400, "Hibás mentés.");
  const text = JSON.stringify(b.data);
  if (text.length > 250000) throw new HttpError(413, "Túl nagy mentés.");
  const row = await env.DB.prepare("SELECT data, updated_at FROM progress WHERE player_id = ?").bind(p.id).first();
  if (row) {
    let cur = null;
    try { cur = JSON.parse(row.data); } catch {}
    if (cur && moreProgress(cur, b.data)) {
      return json({ error: "A szerveren több haladás van egy másik eszközödről.", conflict: true, data: cur, updatedAt: row.updated_at }, 409);
    }
  }
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
    // Kód nélkül csak ligatársat (ezen a héten egy csoportban), osztálytársat, vagy azt követheted vissza, aki már követ téged.
    if (!target) throw new HttpError(404, "Nincs ilyen játékos.");
    const classmate = p.class_id && target.class_id === p.class_id;
    const followsMe = await env.DB.prepare("SELECT 1 AS x FROM follows WHERE follower = ? AND followee = ?").bind(target.id, p.id).first();
    const sameGroup = await env.DB.prepare(
      "SELECT 1 AS x FROM weekly a JOIN weekly b ON b.grp = a.grp AND b.week_key = a.week_key WHERE a.player_id = ? AND b.player_id = ? AND a.week_key = ? AND a.grp IS NOT NULL")
      .bind(p.id, target.id, weekKey(Date.now())).first();
    if (!classmate && !followsMe && !sameGroup) throw new HttpError(403, "Kód nélkül csak a ligatársaidat, az osztálytársaidat vagy a követőidet követheted.");
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
    // A még futó heti csoportjában felszabadul a helye.
    env.DB.prepare("UPDATE league_groups SET size = size - 1 WHERE done_at IS NULL AND size > 0 AND id IN (SELECT grp FROM weekly WHERE player_id = ? AND grp IS NOT NULL)").bind(p.id),
    env.DB.prepare("DELETE FROM follows WHERE follower = ?1 OR followee = ?1").bind(p.id),
    env.DB.prepare("DELETE FROM weekly WHERE player_id = ?").bind(p.id),
    env.DB.prepare("DELETE FROM progress WHERE player_id = ?").bind(p.id),
    env.DB.prepare("DELETE FROM reports WHERE reporter = ?1 OR target = ?1").bind(p.id),
    env.DB.prepare("DELETE FROM players WHERE id = ?").bind(p.id),
  ]);
}

// ---------- Moderálás (csak az üzemeltetőnek) ----------
function modRow(r) {
  return {
    id: r.id, nick: r.nick, code: r.code, xp: r.xp, joined: dayKey(r.created_at), seen: dayKey(r.updated_at),
    reports: r.cnt || 0, nickReports: r.nick_cnt || 0, reporters: r.reporters || 0, last: r.last ? dayKey(r.last) : "",
  };
}
const MOD_COLS = "p.*, COUNT(r.id) AS cnt, SUM(r.reason = 'nick') AS nick_cnt, COUNT(DISTINCT r.reporter) AS reporters, MAX(r.created_at) AS last";
async function adminReports(env) {
  const rows = (await env.DB.prepare(`SELECT ${MOD_COLS} FROM reports r JOIN players p ON p.id = r.target GROUP BY p.id ORDER BY reporters DESC, last DESC LIMIT 100`).all()).results || [];
  return json({ players: rows.map(modRow) });
}
async function adminFind(env, q) {
  const s = String(q || "").normalize("NFC").trim().slice(0, 30);
  if (s.length < 2) throw new HttpError(400, "Legalább 2 karaktert írj be.");
  const like = "%" + s.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  const rows = (await env.DB.prepare(`SELECT ${MOD_COLS} FROM players p LEFT JOIN reports r ON r.target = p.id
    WHERE p.id = ?1 OR p.code = ?1 OR p.nick LIKE ?2 ESCAPE '\\' GROUP BY p.id ORDER BY p.updated_at DESC LIMIT 30`).bind(s.toUpperCase(), like).all()).results || [];
  return json({ players: rows.map(modRow) });
}
async function adminAct(p, req, env) {
  const b = await readJson(req);
  const t = await env.DB.prepare("SELECT * FROM players WHERE id = ?").bind(String(b.id || "")).first();
  if (!t) throw new HttpError(404, "Nincs ilyen játékos.");
  if (b.action === "rename") {
    // Semleges, egyedi név a barátkóddal, hogy a ligában ne legyen sok egyforma.
    const nick = "Játékos " + t.code;
    await env.DB.batch([
      env.DB.prepare("UPDATE players SET nick = ? WHERE id = ?").bind(nick, t.id),
      env.DB.prepare("DELETE FROM reports WHERE target = ?").bind(t.id),
    ]);
    return json({ ok: true, nick });
  }
  if (b.action === "dismiss") {
    await env.DB.prepare("DELETE FROM reports WHERE target = ?").bind(t.id).run();
    return json({ ok: true });
  }
  if (b.action === "delete") {
    if (t.id === p.id) throw new HttpError(400, "A saját fiókodat a Beállításokban törölheted.");
    await deleteAccount(t, env);
    return json({ ok: true });
  }
  throw new HttpError(400, "Ismeretlen művelet.");
}

// ---------- Online liga: heti csoportok és zárás ----------
// Ugyanez a szabály van az appban is (zones), a kettőnek egyeznie kell.
function zones(size, league) {
  const up = league < LEAGUE_MAX ? (size >= 15 ? 5 : Math.min(3, Math.max(1, size - 1))) : 0;
  const down = league > 0 && size >= 8 ? (size >= 15 ? 5 : 3) : 0;
  return { up, down };
}
// Az első heti XP-vel a játékos a ligája legkorábbi, még nem teli csoportjába kerül.
async function ensureGroup(env, playerId, wk) {
  const row = await env.DB.prepare("SELECT xp, grp FROM weekly WHERE player_id = ? AND week_key = ?").bind(playerId, wk).first();
  if (!row || row.xp <= 0) return false;
  if (row.grp) return true;
  // Előbb lezárjuk a múlt heti csoportját, hogy már a frissített ligájába kerüljön.
  const prev = await env.DB.prepare("SELECT grp FROM weekly WHERE player_id = ? AND week_key = ? AND grp IS NOT NULL").bind(playerId, addDays(wk, -7)).first();
  if (prev) await closeGroup(env, prev.grp);
  const me = await env.DB.prepare("SELECT league FROM players WHERE id = ?").bind(playerId).first();
  const league = me ? me.league : 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const open = await env.DB.prepare("SELECT id FROM league_groups WHERE week_key = ? AND league = ? AND size < ? ORDER BY created_at LIMIT 1").bind(wk, league, GROUP_SIZE).first();
    const gid = open ? open.id : randomCode(8);
    if (!open) await env.DB.prepare("INSERT INTO league_groups (id, week_key, league, size, created_at) VALUES (?, ?, ?, 0, ?)").bind(gid, wk, league, Date.now()).run();
    const took = await env.DB.prepare("UPDATE league_groups SET size = size + 1 WHERE id = ? AND size < ?").bind(gid, GROUP_SIZE).run();
    if (!took.meta.changes) continue;
    const set = await env.DB.prepare("UPDATE weekly SET grp = ?, league = ? WHERE player_id = ? AND week_key = ? AND grp IS NULL").bind(gid, league, playerId, wk).run();
    if (!set.meta.changes) await env.DB.prepare("UPDATE league_groups SET size = size - 1 WHERE id = ?").bind(gid).run();
    return true;
  }
  return false;
}
// Lezár egy véget ért heti csoportot: feljutás, kiesés, jutalom. Igaz, ha most zártuk le.
async function closeGroup(env, gid) {
  const g = await env.DB.prepare("SELECT * FROM league_groups WHERE id = ?").bind(gid).first();
  if (!g || g.done_at || g.week_key >= weekKey(Date.now())) return false;
  const rows = (await env.DB.prepare(
    "SELECT w.player_id AS id, w.xp FROM weekly w JOIN players p ON p.id = w.player_id WHERE w.grp = ? ORDER BY w.xp DESC, p.created_at ASC")
    .bind(gid).all()).results || [];
  const z = zones(rows.length, g.league);
  const stmts = [env.DB.prepare("UPDATE league_groups SET done_at = ? WHERE id = ?").bind(Date.now(), gid)];
  rows.forEach((r, i) => {
    const rank = i + 1;
    const res = rank <= z.up ? "up" : z.down && rank > rows.length - z.down ? "down" : "stay";
    const to = Math.max(0, Math.min(LEAGUE_MAX, g.league + (res === "up" ? 1 : res === "down" ? -1 : 0)));
    // Drágakő csak annak jár, aki legalább egy másik játékost megelőzött.
    const reward = rank < rows.length ? LEAGUE_REWARDS[rank - 1] || 0 : 0;
    const result = JSON.stringify({ week: g.week_key, rank, size: rows.length, res, from: g.league, to, reward });
    stmts.push(env.DB.prepare("UPDATE players SET league = ?, last_result = ? WHERE id = ?").bind(to, result, r.id));
  });
  await env.DB.batch(stmts);
  return true;
}

// ---------- Óránkénti feladatok: ligazárás és takarítás ----------
async function hourly(env) {
  const now = Date.now(), cur = weekKey(now);
  const open = (await env.DB.prepare("SELECT id FROM league_groups WHERE done_at IS NULL AND week_key < ? LIMIT 300").bind(cur).all()).results || [];
  for (const g of open) await closeGroup(env, g.id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM weekly WHERE week_key < ?").bind(addDays(cur, -56)),
    env.DB.prepare("DELETE FROM league_groups WHERE week_key < ?").bind(addDays(cur, -56)),
    env.DB.prepare("DELETE FROM class_weeks WHERE week_key < ?").bind(addDays(cur, -56)),
    env.DB.prepare("DELETE FROM rate WHERE reset_at < ?").bind(now),
    env.DB.prepare("DELETE FROM reports WHERE created_at < ?").bind(now - 90 * DAY),
  ]);
  // 12 hónapja inaktív fiókok, és a 30 napja nem használt, XP nélküli (csak kipróbált) fiókok törlése.
  const stale = (await env.DB.prepare("SELECT * FROM players WHERE updated_at < ?1 OR (xp = 0 AND updated_at < ?2) LIMIT 50")
    .bind(now - 365 * DAY, now - 30 * DAY).all()).results || [];
  for (const p of stale) await deleteAccount(p, env);
}

// ---------- Útválasztás ----------
async function api(req, env, url) {
  const path = url.pathname.slice(4); // "/api" levágva
  const method = req.method;
  if (method === "GET" && path === "/health") return json({ app: "kodkigyo", ok: true, captcha: captchaOn(env) ? env.TURNSTILE_SITEKEY : "" });
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
  if (path.startsWith("/admin/")) {
    if (!isAdmin(env, p.id)) throw new HttpError(403, "Ehhez nincs jogosultságod.");
    if (method === "GET" && path === "/admin/reports") return adminReports(env);
    if (method === "GET" && path === "/admin/find") return adminFind(env, url.searchParams.get("q"));
    if (method === "POST" && path === "/admin/player") return adminAct(p, req, env);
  }
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
