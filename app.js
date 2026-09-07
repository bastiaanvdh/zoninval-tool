"use strict";
/**
 * Zoninval Tool -- volledig client-side.
 * Alle geodata komt rechtstreeks uit de browser van PDOK (Locatieserver, BAG-WFS,
 * BRK-WFS) en 3D BAG; geometrie via Turf.js, zonnestand via SunCalc. Geen backend
 * nodig, dus te hosten als statische site (GitHub Pages).
 */

const PDOK_LOCATIESERVER = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";
const PDOK_SUGGEST = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/suggest";
const PDOK_BAG_WFS = "https://service.pdok.nl/lv/bag/wfs/v2_0";
const PDOK_BRK_WFS = "https://service.pdok.nl/kadaster/kadastralekaart/wfs/v5_0";
const BAG3D_API = "https://api.3dbag.nl/collections/pand/items";

const MAX_SCHADUWLENGTE_M = 200; // praktische cap tegen absurd lange schaduwen bij lage zonnestand
const MIN_ELEVATIE_GRADEN = 1.0; // onder deze hoek is de schaduwberekening niet zinvol
const TUIN_PROXY_STRAAL_M = 12; // ring rond het pand als er geen kadastraal perceel gevonden wordt

// ---------------------------------------------------------------------------
// Geodata ophalen bij PDOK / 3D BAG
// ---------------------------------------------------------------------------

async function geocodeAdres(adres) {
  const url = `${PDOK_LOCATIESERVER}?q=${encodeURIComponent(adres)}&fq=type:adres&rows=1`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Kon adres niet vinden: HTTP ${resp.status}`);
  const json = await resp.json();
  const docs = json.response.docs;
  if (!docs.length) throw new Error(`Geen resultaat voor adres: ${adres}`);
  const doc = docs[0];
  const [lon, lat] = doc.centroide_ll.replace("POINT(", "").replace(")", "").split(" ").map(Number);
  return { weergavenaam: doc.weergavenaam, lon, lat };
}

async function adresSuggesties(deel) {
  if (deel.trim().length < 3) return [];
  const url = `${PDOK_SUGGEST}?q=${encodeURIComponent(deel)}&fq=type:adres&rows=6`;
  const resp = await fetch(url);
  if (!resp.ok) return [];
  const json = await resp.json();
  return (json.response.docs || []).map((d) => d.weergavenaam);
}

// PDOK's WFS verwacht voor srsName=EPSG:4326 de bbox in (lat,lon,lat,lon) --
// dus NIET in de lon,lat-volgorde die GeoJSON zelf gebruikt. Geverifieerd tegen
// de live service: lon,lat-volgorde levert stilzwijgend 0 resultaten op.
function bboxLatLon(lat, lon, straalM) {
  const cirkel = turf.buffer(turf.point([lon, lat]), straalM, { units: "meters" });
  const [minLon, minLat, maxLon, maxLat] = turf.bbox(cirkel);
  return `${minLat},${minLon},${maxLat},${maxLon},EPSG:4326`;
}

async function pandenInBuurt(lat, lon, straalM = 100) {
  const url = `${PDOK_BAG_WFS}?service=WFS&version=2.0.0&request=GetFeature&typeName=bag:pand&outputFormat=json&srsName=EPSG:4326&bbox=${bboxLatLon(lat, lon, straalM)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Kon panden niet ophalen bij de BAG");
  return resp.json();
}

function vindDoelpand(pandenGeojson, lat, lon) {
  const punt = turf.point([lon, lat]);
  for (const feat of pandenGeojson.features || []) {
    if (turf.booleanPointInPolygon(punt, feat)) return feat;
  }
  return null;
}

async function perceelOpPunt(lat, lon, margeM = 10) {
  const url = `${PDOK_BRK_WFS}?service=WFS&version=2.0.0&request=GetFeature&typeName=kadastralekaart:Perceel&outputFormat=json&srsName=EPSG:4326&bbox=${bboxLatLon(lat, lon, margeM)}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("Kon perceel niet ophalen bij het Kadaster");
  const geojson = await resp.json();
  const punt = turf.point([lon, lat]);
  for (const feat of geojson.features || []) {
    if (turf.booleanPointInPolygon(punt, feat)) return feat;
  }
  return null;
}

async function hoogteVoorPand(bagId) {
  const resp = await fetch(`${BAG3D_API}/NL.IMBAG.Pand.${bagId}`);
  if (!resp.ok) throw new Error("3D BAG request mislukt");
  const data = await resp.json();
  const cityObjects = data.CityObjects || (data.feature && data.feature.CityObjects);
  if (!cityObjects) throw new Error("Geen CityObjects gevonden in 3D BAG response");
  const obj = Object.values(cityObjects)[0];
  const attrs = obj.attributes || {};

  const dakMax = attrs.b3_h_dak_max;
  const maaiveld = attrs.b3_h_maaiveld;
  if (dakMax != null && maaiveld != null) return Math.max(dakMax - maaiveld, 2.5);

  const nok = attrs.b3_h_nok;
  if (nok != null && maaiveld != null) return Math.max(nok - maaiveld, 2.5);

  throw new Error(`Geen bruikbare hoogte-attributen voor pand ${bagId}`);
}

// Haalt de hoogte van meerdere panden gelijktijdig op (concurrency-gelimiteerde pool,
// het JS-equivalent van een Python ThreadPoolExecutor) en rapporteert live voortgang.
async function hoogtesVoorPandenMetVoortgang(bagIds, onVoortgang, maxWerkers = 12) {
  const resultaat = {};
  const totaal = bagIds.length;
  let klaar = 0;
  let volgende = 0;

  async function werker() {
    while (volgende < bagIds.length) {
      const bagId = bagIds[volgende++];
      try {
        resultaat[bagId] = await hoogteVoorPand(bagId);
      } catch (e) {
        resultaat[bagId] = 10.0; // fallback als de 3D BAG geen bruikbare hoogte teruggeeft
      }
      klaar += 1;
      onVoortgang(klaar, totaal);
    }
  }

  const werkers = Array.from({ length: Math.min(maxWerkers, bagIds.length) }, werker);
  await Promise.all(werkers);
  return resultaat;
}

// ---------------------------------------------------------------------------
// Zonnestand en schaduwgeometrie
// ---------------------------------------------------------------------------

function zonnestand(lat, lon, dateObj) {
  const pos = SunCalc.getPosition(dateObj, lat, lon);
  const elevatieGraden = (pos.altitude * 180) / Math.PI;
  // SunCalc: azimuth = 0 bij zuid, oplopend richting west. Omzetten naar het
  // gangbare kompas-azimuth (0 = noord, oplopend met de klok mee via oost).
  const azimuthGraden = ((pos.azimuth * 180) / Math.PI + 180 + 360) % 360;
  return { elevatieGraden, azimuthGraden };
}

function schaduwPolygoon(pandFeature, hoogte, elevatieGraden, azimuthGraden) {
  if (elevatieGraden <= MIN_ELEVATIE_GRADEN) return null;
  const lengte = Math.min(hoogte / Math.tan((elevatieGraden * Math.PI) / 180), MAX_SCHADUWLENGTE_M);
  const schaduwRichting = (azimuthGraden + 180) % 360;
  const verschoven = turf.transformTranslate(pandFeature, lengte, schaduwRichting, { units: "meters" });
  return turf.convex(turf.featureCollection([pandFeature, verschoven]));
}

// Rekent een lokale wandklok-tijd in Europe/Amsterdam om naar het juiste UTC-moment
// (houdt automatisch rekening met zomer-/wintertijd).
function amsterdamNaarUTC(jaar, maand, dag, uur, minuut) {
  const naiefUTC = Date.UTC(jaar, maand - 1, dag, uur, minuut);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Amsterdam", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const delen = dtf.formatToParts(new Date(naiefUTC)).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const uurNum = delen.hour === "24" ? 0 : Number(delen.hour);
  const alsAmsterdam = Date.UTC(
    Number(delen.year), Number(delen.month) - 1, Number(delen.day),
    uurNum, Number(delen.minute), Number(delen.second)
  );
  const offsetMs = alsAmsterdam - naiefUTC;
  return new Date(naiefUTC - offsetMs);
}

// ---------------------------------------------------------------------------
// Orkestratie: adres -> geodata (gecachet) -> schaduwberekening per tijdstip
// ---------------------------------------------------------------------------

const locatieCache = {};

async function locatiedataOphalen(adres, onVoortgang) {
  const sleutel = adres.trim().toLowerCase();
  if (locatieCache[sleutel]) {
    onVoortgang(90, "Gegevens uit cache");
    return locatieCache[sleutel];
  }

  onVoortgang(5, "Adres opzoeken...");
  const loc = await geocodeAdres(adres);

  onVoortgang(15, "Panden ophalen bij de BAG...");
  const panden = await pandenInBuurt(loc.lat, loc.lon);

  const doelpandFeat = vindDoelpand(panden, loc.lat, loc.lon);
  if (!doelpandFeat) {
    const fout = new Error("Geen pand gevonden op dit adres binnen de zoekstraal");
    fout.status = 404;
    throw fout;
  }

  const bagIds = panden.features.map((f) => f.properties.identificatie);
  onVoortgang(20, `Hoogtes ophalen bij de 3D BAG (0/${bagIds.length})...`);
  const hoogtes = await hoogtesVoorPandenMetVoortgang(bagIds, (klaar, totaal) => {
    const pct = 20 + Math.floor((55 * klaar) / Math.max(totaal, 1));
    onVoortgang(pct, `Hoogtes ophalen bij de 3D BAG (${klaar}/${totaal})...`);
  });

  const gebouwen = panden.features.map((f) => ({
    feature: f,
    hoogte: hoogtes[f.properties.identificatie],
  }));

  onVoortgang(80, "Perceelgrens opzoeken bij het Kadaster...");
  let perceelFeat = null;
  try {
    perceelFeat = await perceelOpPunt(loc.lat, loc.lon);
  } catch (e) {
    perceelFeat = null; // BRK niet bereikbaar o.i.d. -> fallback op ring-proxy hieronder
  }

  onVoortgang(92, "Tuin en pand samenvoegen...");
  const doelgebied = perceelFeat
    ? turf.difference(perceelFeat, doelpandFeat)
    : turf.difference(turf.buffer(doelpandFeat, TUIN_PROXY_STRAAL_M, { units: "meters" }), doelpandFeat);

  const resultaat = { loc, gebouwen, doelpandFeat, perceelFeat, doelgebied };
  locatieCache[sleutel] = resultaat;
  onVoortgang(95, "Zonnestand en schaduwen berekenen...");
  return resultaat;
}

function bouwSchaduwResultaat(d, datumStr) {
  const { loc, gebouwen, doelpandFeat, perceelFeat, doelgebied } = d;
  const [jaar, maand, dag] = datumStr.split("-").map(Number);

  const tijdstippen = [];
  for (let minuten = 6 * 60; minuten <= 22 * 60; minuten += 20) {
    const uur = Math.floor(minuten / 60);
    const min = minuten % 60;
    const tijdstip = amsterdamNaarUTC(jaar, maand, dag, uur, min);
    const { elevatieGraden, azimuthGraden } = zonnestand(loc.lat, loc.lon, tijdstip);

    if (elevatieGraden <= 1) continue;

    const schaduwen = [];
    for (const g of gebouwen) {
      const poly = schaduwPolygoon(g.feature, g.hoogte, elevatieGraden, azimuthGraden);
      if (poly) schaduwen.push(poly);
    }

    let percentage = 0;
    const doelgebiedOpp = doelgebied ? turf.area(doelgebied) : 0;
    if (schaduwen.length && doelgebiedOpp > 0) {
      let combinatie = schaduwen[0];
      for (let i = 1; i < schaduwen.length; i++) {
        try {
          combinatie = turf.union(combinatie, schaduwen[i]);
        } catch (e) {
          // een enkele ongeldige/gedegenereerde polygon mag de rest niet blokkeren
        }
      }
      let overlap = null;
      try {
        overlap = turf.intersect(doelgebied, combinatie);
      } catch (e) {
        overlap = null;
      }
      if (overlap) percentage = (turf.area(overlap) / doelgebiedOpp) * 100;
    }

    tijdstippen.push({
      tijd: `${String(uur).padStart(2, "0")}:${String(min).padStart(2, "0")}`,
      elevatie: Math.round(elevatieGraden * 10) / 10,
      azimuth: Math.round(azimuthGraden * 10) / 10,
      schaduw_geojson: turf.featureCollection(schaduwen),
      percentage_beschaduwd: Math.round(percentage * 10) / 10,
    });
  }

  return {
    adres: loc.weergavenaam,
    doelpand_geojson: doelpandFeat.geometry,
    perceel_geojson: perceelFeat ? perceelFeat.geometry : null,
    gebouwen_geojson: turf.featureCollection(gebouwen.map((g) => g.feature)),
    tijdstippen,
  };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const paneelEl = document.getElementById("paneel");
function zetKaartMarge() {
  document.getElementById("kaart").style.top = paneelEl.offsetHeight + "px";
}
window.addEventListener("resize", zetKaartMarge);

const map = L.map("kaart").setView([52.09, 5.12], 8);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20, attribution: "&copy; OpenStreetMap-bijdragers",
}).addTo(map);
zetKaartMarge();
setTimeout(() => map.invalidateSize(), 0);

let schaduwLaag = null, gebouwenLaag = null, doelpandLaag = null, perceelLaag = null, data = null;

document.getElementById("datum").valueAsDate = new Date();

const SEIZOENEN = ["winter", "lente", "zomer", "herfst"];

function seizoenVoorDatum(datumStr) {
  if (!datumStr) return null;
  const maand = parseInt(datumStr.split("-")[1], 10);
  if (maand === 12 || maand <= 2) return SEIZOENEN[0];
  if (maand <= 5) return SEIZOENEN[1];
  if (maand <= 8) return SEIZOENEN[2];
  return SEIZOENEN[3];
}

function werkSeizoenLabelBij() {
  const datumEl = document.getElementById("datum");
  const label = document.getElementById("seizoenLabel");
  label.textContent = seizoenVoorDatum(datumEl.value) || "";

  document.querySelectorAll(".pill").forEach((knop) => {
    const maand = parseInt(knop.dataset.maand, 10);
    const dag = parseInt(knop.dataset.dag, 10);
    const [, m, d] = (datumEl.value || "").split("-").map(Number);
    knop.classList.toggle("actief", m === maand && d === dag);
  });
  zetKaartMarge();
}

document.getElementById("datum").addEventListener("change", werkSeizoenLabelBij);
werkSeizoenLabelBij();

document.querySelectorAll(".pill").forEach((knop) => {
  knop.addEventListener("click", () => {
    const datumEl = document.getElementById("datum");
    const huidigJaar = (datumEl.value || new Date().toISOString().slice(0, 10)).split("-")[0];
    const maand = knop.dataset.maand.padStart(2, "0");
    const dag = knop.dataset.dag.padStart(2, "0");
    datumEl.value = `${huidigJaar}-${maand}-${dag}`;
    werkSeizoenLabelBij();
    if (adresEl.value.trim()) zoek();
  });
});

// --- Adres-suggesties (typeahead) ---
const adresEl = document.getElementById("adres");
const suggestiesEl = document.getElementById("suggesties");
let suggestieTimer = null;
let suggestieItems = [];
let gemarkeerdIndex = -1;

function sluitSuggesties() {
  suggestiesEl.classList.remove("open");
  suggestiesEl.innerHTML = "";
  suggestieItems = [];
  gemarkeerdIndex = -1;
}

function toonSuggesties(items) {
  suggestieItems = items;
  gemarkeerdIndex = -1;
  if (!items.length) { sluitSuggesties(); return; }
  suggestiesEl.innerHTML = items.map((naam) => `<div>${naam}</div>`).join("");
  suggestiesEl.classList.add("open");
  Array.from(suggestiesEl.children).forEach((el, i) => {
    // mousedown voorkomt alleen dat de input z'n focus/blur-afhandeling de dropdown
    // wegwerkt vóórdat de klik is verwerkt; de daadwerkelijke selectie gebeurt pas op
    // 'click' zodat de dropdown niet al verdwenen is als de browser de klik hit-test.
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", () => kiesSuggestie(i));
  });
}

function kiesSuggestie(i) {
  adresEl.value = suggestieItems[i];
  sluitSuggesties();
  zoek();
}

adresEl.addEventListener("input", () => {
  clearTimeout(suggestieTimer);
  const q = adresEl.value.trim();
  if (q.length < 3) { sluitSuggesties(); return; }
  suggestieTimer = setTimeout(async () => {
    const items = await adresSuggesties(q);
    toonSuggesties(items);
  }, 250);
});

adresEl.addEventListener("keydown", (e) => {
  if (suggestieItems.length && suggestiesEl.classList.contains("open")) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      gemarkeerdIndex = Math.min(gemarkeerdIndex + 1, suggestieItems.length - 1);
      markeerSuggestie();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      gemarkeerdIndex = Math.max(gemarkeerdIndex - 1, 0);
      markeerSuggestie();
      return;
    }
    if (e.key === "Enter" && gemarkeerdIndex >= 0) {
      e.preventDefault();
      kiesSuggestie(gemarkeerdIndex);
      return;
    }
    if (e.key === "Escape") { sluitSuggesties(); return; }
  }
  if (e.key === "Enter") { sluitSuggesties(); zoek(); }
});

function markeerSuggestie() {
  Array.from(suggestiesEl.children).forEach((el, i) => {
    el.classList.toggle("gemarkeerd", i === gemarkeerdIndex);
  });
}

document.addEventListener("click", (e) => {
  if (e.target !== adresEl) sluitSuggesties();
});

// --- Zoeken uitvoeren ---

let huidigeZoekopdracht = 0;

async function zoek() {
  const adres = adresEl.value.trim();
  const datum = document.getElementById("datum").value;
  const foutEl = document.getElementById("fout");
  const zoekknop = document.getElementById("zoekknop");
  const voortgangWrap = document.getElementById("voortgangWrap");
  const voortgangTekst = document.getElementById("voortgangTekst");
  const voortgangBalk = document.getElementById("voortgangBalk");
  foutEl.textContent = "";
  if (!adres) { foutEl.textContent = "Vul eerst een adres in."; return; }

  const dezeZoekopdracht = ++huidigeZoekopdracht;

  document.getElementById("tijdWeergave").classList.add("verborgen");
  document.getElementById("info").textContent = "";
  voortgangBalk.style.width = "0%";
  voortgangTekst.textContent = "Bezig met ophalen...";
  voortgangWrap.classList.remove("verborgen");
  zoekknop.disabled = true;

  try {
    const d = await locatiedataOphalen(adres, (pct, tekst) => {
      if (dezeZoekopdracht !== huidigeZoekopdracht) return; // gebruiker is intussen opnieuw gaan zoeken
      voortgangTekst.textContent = `${tekst} — ${pct}%`;
      voortgangBalk.style.width = `${pct}%`;
    });
    if (dezeZoekopdracht !== huidigeZoekopdracht) return;

    data = bouwSchaduwResultaat(d, datum);
    voortgangWrap.classList.add("verborgen");
    verwerkResultaat();
  } catch (e) {
    if (dezeZoekopdracht !== huidigeZoekopdracht) return;
    foutEl.textContent = e.status ? `Fout (${e.status}): ${e.message}` : `Fout: ${e.message}`;
    voortgangWrap.classList.add("verborgen");
  } finally {
    if (dezeZoekopdracht === huidigeZoekopdracht) zoekknop.disabled = false;
  }
}

function verwerkResultaat() {
  if (gebouwenLaag) map.removeLayer(gebouwenLaag);
  if (doelpandLaag) map.removeLayer(doelpandLaag);
  if (perceelLaag) map.removeLayer(perceelLaag);
  if (schaduwLaag) map.removeLayer(schaduwLaag);

  gebouwenLaag = L.geoJSON(data.gebouwen_geojson, { style: { color: "#888", weight: 1, fillOpacity: 0.08 } }).addTo(map);
  doelpandLaag = L.geoJSON(data.doelpand_geojson, { style: { color: "#FF4B12", weight: 2, fillOpacity: 0.15 } }).addTo(map);
  perceelLaag = data.perceel_geojson
    ? L.geoJSON(data.perceel_geojson, { style: { color: "#157F4B", weight: 2, dashArray: "4 3", fillOpacity: 0 } }).addTo(map)
    : null;
  map.fitBounds((perceelLaag || doelpandLaag).getBounds().pad(0.4), { maxZoom: 19 });

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(data.tijdstippen.length - 1, 0);
  slider.disabled = data.tijdstippen.length === 0;

  if (data.tijdstippen.length === 0) {
    document.getElementById("fout").textContent = "Geen tijdstippen met zon boven de horizon gevonden voor deze datum.";
    return;
  }

  slider.value = Math.floor(data.tijdstippen.length / 2);
  toonTijdstip(slider.value);
}

function kleurVoorPercentage(pct) {
  if (pct < 25) return "var(--good)";
  if (pct < 60) return "var(--warn)";
  return "var(--bad)";
}

function toonTijdstip(index) {
  if (!data || !data.tijdstippen.length) return;
  const t = data.tijdstippen[index];
  if (schaduwLaag) map.removeLayer(schaduwLaag);
  schaduwLaag = L.geoJSON(t.schaduw_geojson, {
    style: { color: "#000", weight: 0, fillColor: "#000", fillOpacity: 0.35 },
  }).addTo(map);

  document.getElementById("info").textContent = data.perceel_geojson
    ? `${data.adres} — tuin = kadastraal perceel (groen gestippeld) minus het pand`
    : `${data.adres} — geen kadastraal perceel gevonden, benadering met een ring van 12m rond het pand`;

  const tijdWeergave = document.getElementById("tijdWeergave");
  tijdWeergave.classList.remove("verborgen");
  document.getElementById("tijdGroot").textContent = t.tijd;
  document.getElementById("zonInfo").textContent = `${t.elevatie}°`;
  document.getElementById("zonGauge").style.width = `${Math.min((t.elevatie / 90) * 100, 100)}%`;
  const badge = document.getElementById("percentageBadge");
  badge.textContent = `${t.percentage_beschaduwd}% beschaduwd`;
  badge.style.background = kleurVoorPercentage(t.percentage_beschaduwd);
  zetKaartMarge();
}

document.getElementById("zoekknop").addEventListener("click", zoek);
document.getElementById("slider").addEventListener("input", (e) => toonTijdstip(e.target.value));
