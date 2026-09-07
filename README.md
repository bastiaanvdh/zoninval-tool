# Zoninval Tool

Vul een adres in en zie hoeveel schaduw omliggende panden gedurende de dag
werpen op dat adres — en hoe dat verandert per seizoen. Handig als je een huis
overweegt te kopen en wil weten hoe zonnig (of donker) de tuin daadwerkelijk is.

**Live demo:** https://bastiaanvdh.github.io/zoninval-tool/

## Hoe het werkt

Alles draait volledig in de browser, er is geen backend of server nodig:

- **Adres → coördinaten**: [PDOK Locatieserver](https://www.pdok.nl/introductie/-/article/pdok-locatieserver)
- **Pand-voetprinten**: [BAG WFS](https://www.pdok.nl/introductie/-/article/basisregistratie-adressen-en-gebouwen-ba-1) (Kadaster)
- **Pandhoogtes**: [3D BAG](https://3dbag.nl/)
- **Kadastraal perceel** ("tuin" = perceel minus pandvoetprint): [BRK (Kadastrale kaart) WFS](https://www.pdok.nl/introductie/-/article/kadastrale-kaart)
- **Zonnestand**: [SunCalc](https://github.com/mourner/suncalc)
- **Geometrie** (schaduwpolygonen, overlap-berekening): [Turf.js](https://turfjs.org/)
- **Kaart**: [Leaflet](https://leafletjs.com/) + OpenStreetMap

Voor elk pand binnen 100m van het adres wordt op basis van hoogte, zonshoogte
en zonsazimuth een schaduwpolygoon berekend (voetprint + naar de tegenovergestelde
kant van de zon verschoven kopie, convex hull van beide). Het percentage
"beschaduwd" is het aandeel van de tuin dat op dat moment onder een schaduw ligt.

## Beperkingen (bewuste scope-keuzes voor v1)

- Alleen gebouwen tellen mee, geen bomen of schuttingen.
- Als er geen kadastraal perceel gevonden wordt (bijv. bij een
  verzamelgebouw/appartementencomplex) valt de tool terug op een ring van 12m
  rond het pand als benadering van de tuin.
- De schaduwvorm (convex hull van voetprint + verschoven kopie) is een goede
  benadering voor redelijk rechthoekige panden; bij sterk onregelmatige panden
  een lichte overschatting.

## Zelf draaien

Geen build-stap nodig — het is gewoon statische HTML/JS:

```
git clone https://github.com/bastiaanvdh/zoninval-tool.git
cd zoninval-tool
python -m http.server 8000
```

En open `http://localhost:8000`. (Rechtstreeks openen via `file://` kan issues
geven met sommige browsers; een lokale server voorkomt dat.)

## Licentie

MIT — zie [LICENSE](LICENSE).
