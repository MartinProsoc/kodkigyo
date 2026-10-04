// Előkészíti a public/ mappát: az appot index.html-ként, mellé a biztonsági fejléceket.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";

mkdirSync("public", { recursive: true });
copyFileSync("index.html", "public/index.html");
writeFileSync("public/_headers", `/*
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src data:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=()
`);
console.log("public/ kész");
