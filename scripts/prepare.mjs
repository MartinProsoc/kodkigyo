// Előkészíti a public/ mappát: az appot index.html-ként, mellé a biztonsági fejléceket.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";

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
console.log("public/ kész");
