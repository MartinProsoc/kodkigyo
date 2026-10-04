# Kódkígyó – telepítés és üzemeltetés

Az app (`index.html`) és a szerver (`src/worker.js`) egyetlen Cloudflare Workerként fut. A Worker kiszolgálja az oldalt, és az `/api/...` címeken kezeli a fiókokat, a barátokat és az osztályligát. Az adatok egy D1 adatbázisban vannak, az EU-ban. A kód a GitHubon van (`MartinProsoc/kodkigyo`), és a Cloudflare minden feltöltés után magától telepíti.

## 1. Első telepítés a gépedről

Minden parancsot ebben a mappában futtass (VS Code: Terminal › New Terminal).

1. Telepítsd a függőségeket:
   ```
   npm install
   ```
2. Jelentkezz be a Cloudflare-be. Megnyílik a böngésző, ott kattints az **Allow** gombra:
   ```
   npx wrangler login
   ```
3. Hozd létre az adatbázist az EU-ban. Ezt később nem lehet módosítani, ezért a `--jurisdiction=eu` kapcsoló fontos:
   ```
   npx wrangler d1 create kodkigyo --jurisdiction=eu
   ```
   A parancs kiír egy `database_id` értéket. Másold be a `wrangler.jsonc` fájlba a `00000000-…` helyére.
4. Hozd létre a táblákat:
   ```
   npm run db:remote
   ```
5. Töltsd fel az első verziót:
   ```
   npm run deploy
   ```
   Ezután a Kódkígyó a `https://kodkigyo.<fiókod>.workers.dev` címen érhető el.

## 2. Automatikus telepítés a GitHubról

1. A Cloudflare irányítópultján: **Workers & Pages** › **kodkigyo** › **Settings** › **Build** › **Connect**.
2. Válaszd a GitHubot, engedélyezd a Cloudflare GitHub-alkalmazását, majd válaszd ki a `MartinProsoc/kodkigyo` tárolót és a `main` ágat.
3. A build parancs maradjon üres, a deploy parancs pedig `npx wrangler deploy`. A `wrangler.jsonc` maga előkészíti a `public/` mappát.

Ettől kezdve minden `main` ágra feltöltött commit után a Cloudflare magától újratelepít. GitHub Desktopban ez a **Commit**, majd a **Push origin** gomb.

## 3. Saját domain (kodkigyo.hu, Rackhost)

1. Cloudflare irányítópult › **Add a domain** › `kodkigyo.hu` › **Free** csomag. A Cloudflare megad két névszervert, például `xxx.ns.cloudflare.com` és `yyy.ns.cloudflare.com`.
2. Rackhost ügyfélkapu › Domainek › `kodkigyo.hu` › **Névszerverek módosítása**. Írd be a Cloudflare két névszerverét a régiek helyére.
3. Várd meg, amíg a Cloudflare jelzi, hogy a domain aktív. Ez pár perctől néhány óráig tarthat.
4. A `wrangler.jsonc` végén vedd ki a megjegyzésből a `routes` sort, majd töltsd fel a GitHubra, vagy futtasd: `npm run deploy`.

## Frissítés

Ha a `index.html` vagy a `src/worker.js` változik, elég feltölteni a GitHubra. Ha új fájl kerül a `migrations/` mappába, előtte futtasd a gépedről: `npm run db:remote`.

## Helyi kipróbálás

```
npm run db:local
npm run dev
```
Utána nyisd meg: http://localhost:8787

## Moderálás

A jelentések listája:
```
npx wrangler d1 execute kodkigyo --remote --command "SELECT r.created_at, r.reason, p.id, p.nick FROM reports r JOIN players p ON p.id = r.target ORDER BY r.created_at DESC LIMIT 50"
```
Sértő becenév átnevezése (a `XXXXXXXX` helyére a játékos azonosítója kerül):
```
npx wrangler d1 execute kodkigyo --remote --command "UPDATE players SET nick = 'Kódkígyós játékos' WHERE id = 'XXXXXXXX'"
```

## Élesítés előtt

- Kész: az `index.html`-ben az `INFINITE_HEARTS` értéke `false`, így a szívek fogynak. Teszteléshez átmenetileg `true`-ra állíthatod, de így ne töltsd fel.
- Kész: a `LEGAL` beállításokban szerepel az üzemeltető neve (`operator`). A cím (`address`) elhagyható, amíg a Kódkígyó ingyenes és nem üzleti célú. Ha üzleti lesz (hirdetés, fizetős funkció), akkor kötelező; ilyenkor lakcím helyett postafiók vagy cégcím is megadható.
- A jogi szövegeket nézesd át jogásszal.

## Költségek

Az ingyenes Workers-csomag napi 100 000 kérést enged. A D1 napi 5 millió sorolvasást, 100 000 sorírást és összesen 5 GB tárhelyet ad. Egy iskolai méretű használathoz ez bőven elég. Ha kinőnéd, a fizetős csomag havi 5 dollártól indul.
