# entropi

Eit kamera som måler uorden. På skjermen er det berre ein søkjar.

**https://entropi.iverfinne.no**

## Bruk på iPhone

1. Opne sida i Safari.
2. Del, så «Legg til på heimskjerm». Opne frå ikonet. Gje kameraet løyve.
3. **Hald to fingrar nede i omlag eitt sekund** for å byte oppstilling. Ringen rundt sikta fyller seg medan du held.
4. **Eitt trykk** flyttar sonden (punktmålaren). I Blanding snur eit trykk tida.

Dette er HUD-en, frå referansebiletet:

| Plass | Tyding |
| --- | --- |
| øvst til venstre | kode for oppstillinga, med prikkar for kva nummer ho er |
| øvst til høgre | eining og tal for heile biletet |
| nede til venstre | batteriet: same tal som fyllgrad |
| nede til høgre | parametrane til grovkorninga, som blenda og lukkartida i ein vanleg søkjar |
| linjalen | målinga på sonden (i Blanding: tida) |
| sikta | sonden, flyttar seg dit du trykker |

## Oppstillingar

| Kode | Namn | Kva som vert målt | Eining |
| --- | --- | --- | --- |
| SØK | Søkjar | Shannon-entropien til lysnivåa i heile biletet, 64 nivå. Linjalen er ein vanleg lysmålar. | bit (maks 6) |
| ROM | Rom | Lokal entropi: histogram av 16 lysnivå i eit 9×9-vindauge rundt kvar piksel. Koter ved 1, 2 og 3 bit. | bit (maks 4) |
| TID | Tid | Kor mykje nytt som kjem inn: entropien til endringa frå førre bilete under ein fast støymodell, ½·log2(1 + (d/σ)²). Etterglød viser kvar. | bit per piksel |
| BLA | Blanding | Frys biletet og byter piksel parvis etter reversible reglar. 1-piksel-entropien H held seg fast, gjensidig informasjon I mellom nabopiksel fell mot null. Nytt trykk køyrer reglane baklengs. | bit |

### Om entropi

Entropi er ikkje ei eigenskap ved eit bilete, men ved eit bilete og ei **grovkorning**: kva ein vel å rekne som same tilstand. Kameraet ser berre makrotilstandar. Difor måler kvar oppstilling ein ulik, ærleg ting, og parametrane (vindauge, nivå, støymodell) står på skjermen. Endrar du dei, endrar du tala.

- **Rom** og **Søkjar** er rom-entropi, over ulike utsnitt.
- **Tid** er entropi i endring. Held du kameraet heilt i ro, går ho mot null.
- **Blanding** viser Boltzmanns poeng utan å jukse. Ingen piksel vert endra, berre flytta. Fininformasjonen er konstant (H endrar seg ikkje), og det som forsvinn er rekkjefølgja. Tidspilen kjem frå grovkorninga. Fordi kvart steg er ein involusjon som ein hash av stegnummeret vel, kan same regelen køyrast baklengs og gi attende biletet bit for bit. Ingenting vert lagra utanom stegnummeret.

Validering (headless Chromium, SwiftShader, same bilete mot numpy):

- Rom, kart: største avvik 0.0018 bit per piksel, snitt 1.3331 mot 1.3335 bit.
- Søkjar: 5.46 mot 5.47 bit. Blanding: H 3.50 mot 3.506 og I 2.38 mot 2.386 bit.
- Blanding baklengs: 178 av 178 steg gir identisk tilstand (hasj av heile biletet).
- Tid på stilleståande bilete: 0.00 bit.

## Teknikk

- SvelteKit 3 (Svelte 5, Vite 8), `adapter-vercel`. Ei einaste side, ferdigbygd, ingen server.
- All prosessering skjer på telefonen i **WebGL2** (A18 i 16e). Kamerabiletet vert lasta opp som tekstur, kvar oppstilling er nokre fragment-skuggarar på eit arbeidsbilete på ca. 296×640.
- Tilbakelesing av tal går asynkront (PBO og fence), så GPU-en aldri ventar på CPU-en.
- PWA: `manifest.webmanifest`, `sw.js` (nett først for HTML, cache for resten), oppstartsbilete for alle iPhone-storleikar, tryggingsmarginar for hakk og heimlinje, ingen rulling og ingen klyping, skjermen held seg på.
- Fonten er Michroma (OFL).

```
src/lib/engine/     gl.ts (WebGL2-hjelparar), camera.ts, engine.ts (lykkja), types.ts
src/lib/setups/     ei fil per oppstilling, index.ts er rekkjefølgja
src/lib/hud/        Hud.svelte (sikte, hjørne, linjal, batteri)
src/lib/gesture.ts  trykk og to-finger-hald
src/lib/haptics.ts  tikk på iOS (best effort)
scripts/make_icons.py   ikon og oppstartsbilete
```

### Ny oppstilling

Implementer `Setup` (`init`, `frame`, `draw`, `meters`, valfritt `tap`) i `src/lib/setups/`, og legg ho til i `src/lib/setups/index.ts`. Eit oppsett får `ctx` med kamerabiletet (`ctx.cur`, `ctx.prev`, luma i alfakanalen), sonden og `ctx.read()` for asynkron lesing. `MapMeter` gir snitt og punktmåling frå eit kart med mipmap.

### Utvikling

```sh
npm install
npm run dev        # kamera på telefon krev https: bruk ein tunnel (cloudflared, ngrok) eller ein Vercel-preview
npm run check
npm run build
```

Test utan kamera: `?src=/klipp.webm` byter kameraet ut med ein videofil. Chromium kan matast med `--use-file-for-fake-video-capture=klipp.y4m`.

`window.__entropi.debug()` gir fps, målarar og WebGL-eigenskapar.

## Prosessering på Shadow PC (ikkje bygd enno)

Tunge oppstillingar (modellar som treng 24 GB) kan ikkje køyre på telefonen. Planen er at ei oppstilling kan merkjast `remote`:

1. Appen opnar ein WebSocket til ein tunnel mot Shadow PC (til dømes `wss://shadow.example/entropi`).
2. Appen sender nedskalerte bilete (WebCodecs, H.264 eller JPEG) med stigande bilete-id, 10 til 15 per sekund.
3. Tenaren svarar med eit lite JSON-målepakke (`gauge`, `ruler`, `value`, `params`) og eit overlegg (WebP med alfa) for same id.
4. Oppstillinga teiknar kameraet lokalt i full fart og legg det siste overlegget oppå, så forsinkinga syner som etterslep i kartet og ikkje i søkjaren.

Same `Setup`-grensesnitt, så HUD, gestar og bytte er uendra.

## Kjende grenser

- Testa i desktop-Chromium med falskt kamera og programvare-WebGL. Ikkje enno på ein ekte iPhone.
- Haptikk på iOS er best effort (`<input switch>`-trikset) og kan stilltiegande utebli.
- iOS kan spørje om kameraløyve på nytt for kvar oppstart av heimskjerm-appen.
- Tid reknar ut frå endring mellom bilete: handhalde kamera og kameraet sin eigen støyfjerning påverkar talet.

## Deploy

Vercel, prosjekt `entropi-iverfinne-no`, domene `entropi.iverfinne.no`. Push til `main` bygger og rullar ut. `vercel.json` set `Permissions-Policy: camera=(self)` og hindrar cache på `sw.js`. Når ei ny utgåve er ute, lastar appen seg på nytt neste gong han kjem fram frå bakgrunnen.
