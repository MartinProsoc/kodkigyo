// Előkészíti a public/ mappát: az appot index.html-ként, mellé a biztonsági fejléceket.
// A játék szabályait (az index.html /*RULES>*/ … /*<RULES*/ részeit) és a tananyagot a szervernek is kimásolja
// (src/rules.gen.js), így a szerver pontosan ugyanazokkal a szabályokkal számol, mint az app.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

mkdirSync("public", { recursive: true });
copyFileSync("index.html", "public/index.html");
// Link-előnézet (Messenger, Discord, WhatsApp…) és az iPhone kezdőképernyő-ikonja.
copyFileSync("og.jpg", "public/og.jpg");
copyFileSync("apple-touch-icon.png", "public/apple-touch-icon.png");
// Egyetlen külső forrás a Cloudflare Turnstile robotszűrője (fiók létrehozásakor); ehhez kell a
// challenges.cloudflare.com, és hogy a böngésző elküldje neki az oldal címét (strict-origin).
const TS = "https://challenges.cloudflare.com";
writeFileSync("public/_headers", `/*
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' ${TS}; frame-src ${TS}; style-src 'self' 'unsafe-inline'; font-src data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
`);

const html = readFileSync("index.html", "utf8");
const content = html.match(/<script id="content" type="application\/json">([\s\S]*?)<\/script>/);
const parts = [...html.matchAll(/\/\*RULES>\*\/([\s\S]*?)\/\*<RULES\*\//g)].map((m) => m[1]);
if (!content || parts.length < 5) throw new Error("Nem találom a szabályokat vagy a tananyagot az index.html-ben.");
writeFileSync("src/rules.gen.js", `// GENERÁLT FÁJL (scripts/prepare.mjs), ne szerkeszd: a forrás az index.html RULES részei és a tananyag.
const DATA = ${content[1].trim()};
function createRules() {
${parts.join("\n")}
  return {
    // Egy kérésen belül szinkron használjuk: use(állapot), runAction(…), majd state. Közben nincs await,
    // így az egyszerre futó kérések nem keverednek össze.
    use(s) { state = s; },
    get state() { return state; },
    fresh, normalize, runAction, publicStats, RuleError, weekKey, today, dayKey, START_GEMS,
  };
}
export const RULES = createRules();
`);
console.log("public/ kész, src/rules.gen.js kész (" + parts.length + " szabályrész)");
