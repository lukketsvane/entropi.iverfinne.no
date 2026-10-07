# entropi

Eit kamera som måler uorden. På skjermen er det berre biletet: ingen tekst, ingen ramme. Kvar oppstilling er eit instrument for ei grovkorning av verda.

**https://entropi.iverfinne.no**

## Bruk på iPhone

1. Opne sida i Safari.
2. Del, så «Legg til på heimskjerm». Opne frå ikonet. Gje kameraet løyve.
3. **Hald to fingrar nede i omlag eitt sekund** for neste oppstilling. **Tre fingrar** gir førre. Skjermen blinkar og det tikkar når det tok.
4. **Hald ein finger nede oppe til venstre** (omlag eit halvt sekund): veljaren med alle oppsetta, ordna i ROM, TIDSLØP og DYNAMIKK. Trykk på eit for å gå dit. Ein prikk betyr at du ikkje har vore innom det enno.
5. **Trykk nede til høgre**: neste grovkorning i same oppstillinga (til dømes ei anna rutestorleik).
6. **Eitt trykk** gjer noko ulikt i kvar oppstilling (sjå tabellen). I nokre oppstillingar (Ekko, Bølgje, Spinn, Khronos) held ein fingeren nede og dreg.
7. Tidsoppstillingane vil ha telefonen i ro. Lene han mot noko, eller la det digitale stativet ta skjelven (sjå under).

Det finst ingen HUD og inga tekst. Tala kvar oppstilling reknar ut er framleis der (`window.__entropi.debug()`), og tabellen under seier kva dei måler.

## Oppstillingar

Rekkjefølgja er den same som når du held to fingrar nede.

| Kode | Namn | Kva ho gjer | Trykk | Måler |
| --- | --- | --- | --- | --- |
| KAT | Katten | Arnolds kattekart. Eit bilete vert teke og blanda til snø av ei fast omstokking av pikslane (x += y, så y += x, på ein torus). Det er ei omstokking, så ingenting går tapt, og etter nøyaktig 96 steg (3 s) er kvar piksel tilbake. Poincaré-attkomst. | nytt bilete | Boltzmann-entropi per 8×8-rute, bit per piksel. Stig frå ca. 1 til 2,6 og fell tilbake. |
| DEM | Demon | Ein demon sorterer pikslane etter lys, innanfor celler, medan du filmar (odd-even transposition sort på ein permutasjon som vert halden ved like). Berre histogrammet i cella er att. | startar demonen på nytt | S = log2(W)/N, W = N!/Πn_k!, bit per piksel |
| HEN | Hending | Hendingskamera (DVS). Kvar piksel tiger til log-lyset har endra seg med terskelen, så sender han ON eller OFF. Stille bilete gir ingen meldingar. | sonde | bitrate i kb/s, mot 45 500 for vanleg video |
| MAR | Marey | Stroboskop. Alt som rører seg vert stempla fast som stillbilete, og lerretet bleiknar. Marey 1882 med tolv bilete i sekundet: berre konturen, kvit strek på svart plate. | nullstill rommet | Shannon-entropi av sporet over 8×8-ruter: kor mange bit det tek å seie kvar rørsla har vore |
| SKA | Sakte lukkar | Lukkaren er ei line som sveipar over biletet på nokre sekund. Kvar rad er frå sitt eige augneblink: ein bil mot linja vert pressa saman, med linja vert strekt. Slit-scan. | flyttar sentrum (radar) | alder på biletet under sonden, sekund |
| TIM | Khronos | Kameraet hugsar to sekund. Trykk og hald: ei lomme i tida under fingeren går bakover. Etter Cassinelli og Ishikawa. | trykk og hald | kor langt attende, sekund |
| FRG | Tidsfarge | Fargen er tida sidan noko rørte seg: kvitt er nett no, via gult og raudt til blått. Ei hand som sveipar legg att eit spor. | sonde | del piksel som har rørt seg, og alder på sonden |
| VAN | Vane | Kvar piksel lærer kva som er normalt (snitt og varians) og viser berre det som er overraskande, i bit. Det som blir verande vert vant til og forsvinn: Troxler-fading i eit kamera. | sonde | gjennomsnittleg overrasking, bit per piksel |
| LAN | Open Shutter | Lang eksponering: eit glidande snitt over 5 s, 30 s eller alt, eller lysspor med maks. Det som rører seg forsvinn, det som står stille vert att. | startar eksponeringa på nytt | bit mellom biletet no og snittet |
| PUL | Puls | Eulerian video magnification: eit båndpass i tid per piksel, gonga opp og lagt på biletet. Pulsen vert ei fargebølgje i huda. Band: puls, pust, skjelving og eit signalkart. Frekvensen under sonden går gjennom ein Fourier-sum. | flyttar sonden | slag eller drag per minutt. Målaren er 1 minus spektral entropi: ein rein rytme er låg entropi |
| SØK | Søkjar | Rein søkjar. Shannon-entropien til lysnivåa i heile biletet, 64 nivå. Linjalen er ein lysmålar på sonden. | sonde | bit (maks 6) |
| ROM | Rom | Lokal entropi: histogram av 16 lysnivå i eit 9×9-vindauge rundt kvar piksel. | sonde | bit (maks 4) |
| TID | Tid | Kor mykje nytt som kjem inn: entropien til endringa frå førre bilete under ein fast støymodell, ½·log2(1 + (d/σ)²). Etterglød viser kvar. | sonde | bit per piksel |
| BLA | Blanding | Frys biletet og byter piksel parvis etter reversible reglar. 1-piksel-entropien held seg fast, gjensidig informasjon mellom naboar fell mot null. Nytt trykk køyrer reglane baklengs. | snur tida | bit |
| PIL | Tidspil | Der tida ser ut til å gå éi veg: tidsasymmetrien γ = E[d³]/E[d²]^1.5 til endringane per piksel. Varmt: rask opp, sakte ned. Kaldt: omvendt. Mørkt: ingen pil. | sonde | bit (proxy) |
| FLY | Flyt | Optisk flyt: kvar piksel får ein fartsvektor. Lucas-Kanade på ein pyramide med fem nivå (mipmap av lysstyrken, frå grovt til fint, førre bilete vridd med flyten så langt), 7×7-vindauge, 2×2-likning per piksel. Fire visingar: FARGE (retning er farge, fart er lys), BLEKK (fargeblekk som følgjer rørsla), PILER, RELATIV (kamerarørsla trekt frå). | grovkorning | retningsentropi: histogram over åtte retningar for dei som rører seg, H = −Σ p·log2 p, 0 til 3 bit. Alle same veg gir 0, rot gir 3 |
| EKK | Ekko | Video-tilbakekopling: kvart bilete er det førre, litt zooma og vridd, lagt inn att i seg sjølv. Kameraet slepp inn anten som Droste-ramme, eller berre det som rører seg. Fire visingar: DROSTE, TUNNEL, VIRVEL, SPEIL (kaleidoskop). Ei slik løkke har ingen fast tilstand: ein liten skilnad vert forsterka for kvart rundt. | midten av løkka (trykk og hald) | kor langt løkka har vandra frå kameraet, ½·log2(1 + z²) bit per piksel |
| BØL | Bølgje | Ei dam ut frå bølgjelikninga, rekna eksakt tidsreversibelt. Det som rører seg i biletet dyttar på vatnet. Trykk: tida går baklengs, kvar dytting vert trekt frå att i omvend rekkjefølgje, og dammen vert flat att (Loschmidt). | snur tida | Boltzmann-entropi S = log2(tal på 8×8-ruter som er i bruk) |
| SPI | Spinn | Potts-modell (Ising med fire retningar) på kameraet. Lys er varme: mørkt fryser til flekkar som veks (domenevekst), lyst vert støy. Metropolis med sjakkbrett-oppdatering, Tc = 1/ln(1 + √q). | kvelv alt, trykk og hald gir ein varm tupp | blokkentropi over 8×8-ruter |

Grovkorningar ein kan bla gjennom ved å trykke på parametrane:

| Oppstilling | Presets |
| --- | --- |
| KAT | FIN 192×384 (96 steg), GROV 64×128 (96 steg), SKARP 256×512 (384 steg, to per bilete), AUGE: snittet over små ruter, det eit auge utan lupe ser |
| DEM | rad med 64 piksel, heile rada, rad med 16, kolonne med 64, rad med 4 lysnivå |
| HEN | terskel 18 %, 10 %, 35 %, 5 % |
| MAR | TETT (6 per sekund), MAREY (12 per sekund, kontur), GLAS (3 per sekund), HALE (kvart bilete, kort minne) |
| SKA | line nedover på 3 s, radar på 4 s, mot høgre på 2 s, nedover på 1 s |
| TIM | LOMME, STOR, RING (snudd), BAND, SPOLE |
| FRG | horisont 3 s, ring ein gong i sekundet, 20 s, 3 s med grov terskel |
| VAN | tidskonstant 1 s, 0,3 s, 4 s, 16 s |
| LAN | 5 s, 30 s, alt sidan start, MAKS (lysspor) |
| PUL | PULS (0,8 til 3 Hz), PUST (0,1 til 0,7 Hz), SKJELV (4 til 12 Hz), SIGNAL (puls som raudt og blått) |
| SØK | 64, 16, 4 og 256 lysnivå |
| ROM | 9×9 med 16 nivå, 5×5 med 16, 9×9 med 4, 13×13 med 16 |
| TID | støygolv σ = 3, 6, 12 og 1.5 gråtrinn |
| PIL | vindauge 30 bilete og 4×4 piksel, 8, 120, og 16×16 piksel |
| FLY | FARGE, BLEKK, PILER, RELATIV |
| EKK | DROSTE, TUNNEL, VIRVEL, SPEIL |

### Om entropi

Entropi er ikkje ei eigenskap ved eit bilete, men ved eit bilete og ei **grovkorning**: kva ein vel å rekne som same tilstand. Kameraet ser berre makrotilstandar. Difor måler kvar oppstilling ein ulik, ærleg ting, og parametrane (celle, vindauge, nivå, terskel, støymodell) står på skjermen. Endrar du dei, endrar du tala.

- **Katten** og **Demon** er to sider av same sak. Katten blandar reversibelt: ingen piksel vert kasta, og etter 96 steg er alt heime. Over midtvegs ser biletet ut som snø, og entropien per rute er høg, men snøen er ei perfekt omstokking. Entropien gjekk opp fordi ruta er grov, og ned igjen fordi ingenting vart borte. Demonen sorterer: han kastar rekkjefølgja, og det kostar.
- **Hending**, **Vane** og **Tid** måler endring. Hending sender berre meldingar når lyset skiftar (delta-modulasjon), Vane lærer kva som er vanleg per piksel og viser overrasking, Tid er entropien til endringa mellom to bilete.
- **Tidsfarge**, **Marey**, **Sakte lukkar**, **Khronos** og **Open Shutter** er alle grovkorningar i tid: kor lenge ein hugsar, kor ofte ein stemplar, om ein tek snitt eller maks. Same film, ulike makrotilstandar.
- **Puls** er ei grovkorning i frekvens. Eit smalt band tek ut det som svingar sakte og kastar resten. Målaren er Shannon-entropien til spekteret: ein rytme er låg, støy er flat.
- **Tidspil** spør om kva veg. Endringa d = x(t) − x(t−1) skifter forteikn når tida snur. Er fordelinga av d symmetrisk, kunne filmen like gjerne gått baklengs, og γ er null. Er ho skeiv, er det ei pil. Ein tynn stav som passerer er symmetrisk og kansellerer i eit langt nok vindauge, medan ei flamme (rask opp, sakte ned) ikkje gjer det.
- **Rom** og **Søkjar** er rom-entropi, over ulike utsnitt. **Blanding** er ei eldre, handstyrt utgåve av Katten: Boltzmanns poeng utan å jukse, med reglar som kan køyrast baklengs.

Tidspil i bit: for ein liten γ er KL-avstanden mellom fordelinga av d og den speglte ≈ γ²/3 nat (Edgeworth). Vi viser log2(1 + (γ² − 6/n)/3), der 6/n er forventa γ² av ren støy med n effektive prøver, og vi krev tre til seks standardavvik før noko vert vist. Det er ein proxy, ikkje entropiproduksjon.

### Validering

Alt er testa i headless Chromium med programvare-WebGL (SwiftShader), utan ekte iPhone. Testane går steg for steg: videoen står stille, `performance.now` følgjer videoklokka, kvart bilete vert henta med seek og køyrt gjennom `engine.process()`, og lerretet vert lese rett etter teikninga. Same film gir same bilete kvar gong.

Same bilete mot numpy:

- Rom, kart: største avvik 0.0018 bit per piksel. Søkjar: 5.46 mot 5.47 bit. Blanding: H 3.50 mot 3.506 og I 2.38 mot 2.386 bit. Blanding baklengs: 178 av 178 steg gir identisk tilstand.
- Tid på stilleståande bilete: 0.00 bit.
- Tidspil: glidande d² og d³ mot numpy over 150 bilete, største relative avvik 0.15 %. Syntetisk film med sagtann sakte opp, sagtann rask opp, sinus, støy og stillstand gir −, +, 0, 0 og 0 bit.

Nytt:

- **Katten**: hasj av heile tilstanden på GPU-en ved steg 0 og ved steg P er identisk i alle tre oppløysingane (P = 96, 96 og 384). Ved P/2 er 58 % av pikslane alt på plass att, og biletet glimtar gjennom.
- **Puls**: syntetisk film (tapsfri VP9) med ei hud-ellipse som pulserer 1.17 Hz (70.2 slag/min, 0.7 gråtrinn i lysstyrke) og støy σ = 1.5. Målt: 70 slag/min, orden 0.92. Same film med ei brystkant som flyttar seg ±2 piksel med 0.27 Hz (16.2 drag/min): målt 16 per minutt. Dirring på 7.3 Hz vert synleg i SKJELV. Ikkje testa på ekte hud.
- **Marey**: syntetisk film med fast kamera, ei hand på ein åttetalsbane og ein sprettande ball: vifte av hender i TETT, rein kronofotografi i MAREY. Ein handhalden film (studio) gir kontur på alt, fordi heile biletet flyttar seg. Det er ein grense, ikkje ein feil: kameraet må stå i ro.
- Hending, Vane, Tidsfarge, Khronos, Sakte lukkar, Open Shutter og Demon er sett på ekte filmar (studio, kjøken, statue, stilleliv) og sjekka mot det dei skal gjere.

## Digitalt stativ

Dei ti oppstillingane med `still: true` får videoen gjennom eit stativ som køyrer heilt på GPU-en, utan CPU og utan tilbakelesing. Lucas-Kanade på ein gråtone-versjon i halv arbeidsoppløysing finn éi global forskyving mot ein referanse som flyt sakte etter (glidande snitt av dei stabiliserte bileta). Ei lysstyrkeforskyving i normallikningane gjer at skiftande eksponering ikkje dreg biletet, og robuste vekter gjer at det som dominerer (ofte bakgrunnen) styrer, ikkje ei hand som rører seg. Går forskyvinga over 12 % av breidda, startar stativet på nytt.

Målt på ein handhalden film (360×640, forskyving opp til 14 piksel): standardavviket i bakgrunnen går frå 4,2 til 0,7 piksel sideleis og frå 3,2 til 0,16 piksel opp og ned. Marey på same film gav dobbeltbilete av alle søyler utan stativ og skarp bakgrunn med.

## Teknikk

- SvelteKit 3 (Svelte 5, Vite 8), `adapter-vercel`. Ei einaste side, ferdigbygd, ingen server.
- All prosessering skjer på telefonen i **WebGL2** (A18 i 16e). Kamerabiletet vert lasta opp som tekstur, kvar oppstilling er nokre fragment-skuggarar på eit arbeidsbilete på ca. 296×640. Tilstand over tid ligg i flyttalsmål (F32 der tidskonstantane er lange).
- Tilbakelesing av tal går asynkront (PBO og fence), så GPU-en aldri ventar på CPU-en.
- PWA: `manifest.webmanifest`, `sw.js` (nett først for HTML, cache for resten), oppstartsbilete for alle iPhone-storleikar, tryggingsmarginar for hakk og heimlinje, ingen rulling og ingen klyping, skjermen held seg på.
- Fonten er Michroma (OFL).

```
src/lib/engine/     gl.ts (WebGL2-hjelparar), camera.ts, engine.ts (lykkja), stabilize.ts (digitalt stativ), types.ts
src/lib/setups/     ei fil per oppstilling, index.ts er rekkjefølgja
src/lib/hud/        Picker.svelte (veljaren, den einaste teksta i appen)
src/lib/gesture.ts  trykk, langt trykk, trykk og hald, to- og tre-finger-hald
src/lib/haptics.ts  tikk på iOS (best effort)
scripts/make_icons.py   ikon og oppstartsbilete
```

### Ny oppstilling

Implementer `Setup` (`init`, `frame`, `draw`, `meters`, valfritt `tap`, `touch` og `cycle`) i `src/lib/setups/`, og legg ho til i `src/lib/setups/index.ts`. Eit oppsett får `ctx` med kamerabiletet (`ctx.cur`, `ctx.prev`, luma i alfakanalen), sonden og `ctx.read()` for asynkron lesing. `MapMeter` gir snitt og punktmåling frå eit kart med mipmap, med opptil tre kanalar. `info.group` (`rom`, `tid` eller `dyn`) set oppsettet i veljaren. `info.how` og `info.blurb` er dokumentasjon, dei vert ikkje viste. `info.press` ber om trykk og hald (`touch`). `info.still` seier at oppsettet reknar med eit kamera i ro, og då får det videoen gjennom det digitale stativet. `cycle` vert kalla når ein trykker nede til høgre. `Reducer` gir globale snitt av opptil 16 kanalar i éi lesing.

### Utvikling

```sh
npm install
npm run dev        # kamera på telefon krev https: bruk ein tunnel (cloudflared, ngrok) eller ein Vercel-preview
npm run check
npm run build
```

Test utan kamera: `?src=/klipp.webm` byter kameraet ut med ein videofil. Chromium kan matast med `--use-file-for-fake-video-capture=klipp.y4m`. Bruk tapsfri eller nesten tapsfri video (`-lossless 1 -g 1`) når signalet er under eit gråtrinn, elles et kodeken det opp.

`window.__entropi.debug()` gir fps, målarar og WebGL-eigenskapar. `window.__entropi.engine` gir tilgang til lykkja (`process`, `goId`, `cycle`, `tap`).

## Prosessering på Shadow PC (ikkje bygd enno)

Tunge oppstillingar (modellar som treng 24 GB) kan ikkje køyre på telefonen. Planen er at ei oppstilling kan merkjast `remote`:

1. Appen opnar ein WebSocket til ein tunnel mot Shadow PC (til dømes `wss://shadow.example/entropi`).
2. Appen sender nedskalerte bilete (WebCodecs, H.264 eller JPEG) med stigande bilete-id, 10 til 15 per sekund.
3. Tenaren svarar med eit lite JSON-målepakke (`gauge`, `ruler`, `value`, `params`) og eit overlegg (WebP med alfa) for same id.
4. Oppstillinga teiknar kameraet lokalt i full fart og legg det siste overlegget oppå, så forsinkinga syner som etterslep i kartet og ikkje i søkjaren.

Same `Setup`-grensesnitt, så gestar og bytte er uendra.

## Kjende grenser

- Testa i desktop-Chromium med falskt kamera og programvare-WebGL. Ikkje enno på ein ekte iPhone.
- Haptikk på iOS er best effort (`<input switch>`-trikset) og kan stilltiegande utebli.
- iOS kan spørje om kameraløyve på nytt for kvar oppstart av heimskjerm-appen.
- Marey, Open Shutter, Vane, Tidsfarge, Puls, Hending, Tid, Tidspil, Bølgje og Ekko reknar med eit kamera i ro. Det digitale stativet tek bort små rørsler (opp til ca. 12 % av breidda), men ikkje ei ekte panorering.
- Puls er berre prøvd på ein syntetisk film. Ekte hud gir svakare signal, kameraet sin eigen automatiske eksponering driv, og komprimering kan ete det.
- Tid og Tidspil reknar ut frå endring mellom bilete: handhalde kamera og kameraet sin eigen støyfjerning påverkar talet.
- Tidspil er ein irreversibilitets-test av tredje moment, ikkje entropiproduksjon.
- Rom med 13×13-vindauge er det tyngste oppsettet (169 prøver per piksel). Det er greitt på A18, men tregt i programvare-WebGL.

## Deploy

Vercel, SvelteKit-preset (`adapter-vercel`, ingen miljøvariablar), domene `entropi.iverfinne.no`. Push til `main` bygger og rullar ut. `vercel.json` set `Permissions-Policy: camera=(self)` og hindrar cache på `sw.js`. Når ei ny utgåve er ute, lastar appen seg på nytt neste gong han kjem fram frå bakgrunnen.
