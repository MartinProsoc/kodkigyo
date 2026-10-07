import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

mkdirSync("public", { recursive: true });
copyFileSync("index.html", "public/index.html");
copyFileSync("og.jpg", "public/og.jpg");
copyFileSync("apple-touch-icon.png", "public/apple-touch-icon.png");
copyFileSync("favicon.ico", "public/favicon.ico");
copyFileSync("favicon.svg", "public/favicon.svg");
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
writeFileSync("src/rules.gen.js", `const DATA = ${content[1].trim()};
function createRules() {
${parts.join("\n")}
  return {
    use(s) { state = s; },
    get state() { return state; },
    fresh, normalize, runAction, publicStats, RuleError, weekKey, today, dayKey, START_GEMS,
  };
}
export const RULES = createRules();
`);
console.log("public/ kész, src/rules.gen.js kész (" + parts.length + " szabályrész)");
