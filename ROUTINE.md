# Ablauf der täglichen Analyse

Anleitung für den automatischen Lauf. Die Watchlist steht im Auftrag der Routine, nicht hier.

## Grundregeln

- **Nie Klartext ins Repo.** Kursdaten und Analyse liegen nur unter `/tmp/aktien/`. Ins Repo kommen ausschließlich `reports/<datum>.enc` und `reports/index.json`.
- **Keine Kauf- oder Verkaufsempfehlungen, keine Kursprognosen.** Erlaubt: Einordnung, was eine Nachricht bedeutet, wie der Markt in ähnlichen Fällen reagiert hat, Chancen und Risiken.
- **Nichts erfinden.** Jede Nachricht und jede Analystenstimme braucht eine echte URL aus der Websuche. Zahlen, die nicht aus `raw.json` oder einer gefundenen Quelle stammen, weglassen.
- **Sprache:** Deutsch, klar, kurz. Der Leser hat morgens wenig Zeit und liest auf dem Handy.
- **Keine Gedankenstriche** (weder `—` noch `–` als Satzzeichen). Stattdessen Punkt, Komma, Doppelpunkt oder Klammern. Bereiche mit normalem Bindestrich: `73-76 Mrd. $`. Keine Floskeln wie „nahtlos“, „revolutionär“.
- **Sparsam suchen:** etwa 20-30 Websuchen insgesamt. Pro Aktie 1-2 Suchen nach den letzten 1-3 Tagen; ausführlicher nur, wenn etwas Wichtiges passiert ist.

## Schritte

1. Datum festlegen: `TZ=Europe/Berlin date +%F`.
2. **Marktlage recherchieren:** Was hat die Börsen am Vortag und über Nacht bewegt (USA, Europa, Asien)? Wichtige Termine der nächsten Tage (Notenbank, Inflationsdaten).
3. **Zwei Zusatz-Aktien wählen** (nicht aus der Watchlist):
   - konkreter Anlass in den letzten 1-3 Tagen: Quartalszahlen mit Überraschung, Prognoseänderung, Hoch- und Herabstufung, großer Auftrag, Übernahme;
   - Börsenwert über 10 Mrd. $, an US- oder deutscher Börse handelbar (Yahoo-Ticker, deutsche Werte mit `.DE`);
   - möglichst aus unterschiedlichen Branchen; keine Penny Stocks, keine reinen Meme-Bewegungen.
4. **Kursdaten holen:**
   ```bash
   mkdir -p /tmp/aktien
   node scripts/fetch-data.mjs --watchlist "<aus dem Auftrag>" --picks TICKER1,TICKER2 --out /tmp/aktien/raw.json
   ```
   Schlägt ein Zusatz-Ticker fehl, einen anderen wählen. Fehlen Kennzahlen (kein Crumb), trotzdem weitermachen.
5. **Pro Aktie recherchieren:** Nachrichten der letzten Tage, Analysten-Aktionen (Hoch- und Herabstufung, Kursziele), anstehende Termine. `raw.json` liefert Kurs, Veränderungen, KGV, RSI, Abstand zu den Durchschnitten, Analysten-Konsens und Kursziel. Nutze diese Zahlen in der Einordnung.
6. **`/tmp/aktien/analysis.json` schreiben** (Format unten).
7. **Bauen und prüfen:**
   ```bash
   node scripts/build-report.mjs --raw /tmp/aktien/raw.json --analysis /tmp/aktien/analysis.json
   ```
   Meldet das Skript Fehler: beheben und erneut ausführen.
8. **Veröffentlichen:** `git status` darf nur `reports/` zeigen. Dann
   ```bash
   git add reports/ && git commit -m "Update <datum>" && git push origin HEAD:main
   ```
   Commit-Nachricht neutral halten (keine Ticker, keine Inhalte).

## Format von analysis.json

```json
{
  "date": "JJJJ-MM-TT",
  "market": {
    "headline": "Eine Schlagzeile, max. 10 Wörter, z. B. „Demokraten gewinnen den Kongress. Big Tech feiert, Chipwerte fallen.“",
    "summary": "3-5 Sätze: Was hat den Markt bewegt und was heißt das für Tech/Europa?",
    "drivers": ["2-4 Stichpunkte, je ein Satz"]
  },
  "calendar": [{ "date": "JJJJ-MM-TT", "label": "US-Inflationsdaten (CPI)" }],
  "stocks": {
    "TICKER": {
      "short_name": "nur bei Zusatz-Aktien: kurzer Name",
      "signal": "sehr_positiv | positiv | gemischt | neutral | negativ | sehr_negativ",
      "signal_reason": "Ein Satz (max. 160 Zeichen), warum genau diese Stufe",
      "headline": "Eine Zeile: das Wichtigste heute",
      "meaning": "4-5 Sätze: Was ist passiert, was bedeutet es für die Aktie, wie ordnen Kennzahlen/Kursziel es ein?",
      "pick_reason": "nur bei Zusatz-Aktien: 2 Sätze, warum sie heute auffällt",
      "news": [{ "title": "auf Deutsch", "source": "CNBC", "url": "https://…", "date": "JJJJ-MM-TT", "note": "1 Satz Bedeutung" }],
      "analysts": [{ "firm": "Goldman Sachs", "action": "Kursziel erhöht", "target": "230 → 258 €", "date": "JJJJ-MM-TT", "url": "https://…" }],
      "chances": ["genau 3 konkrete Punkte"],
      "risks": ["genau 3 konkrete Punkte"],
      "events": [{ "date": "JJJJ-MM-TT", "label": "Quartalszahlen" }]
    }
  }
}
```

- `signal` beschreibt die **Nachrichtenlage**, keine Empfehlung. Die Stufen sollen die Aktien untereinander vergleichbar machen, also bewusst abstufen:
  - **sehr_positiv:** klarer, starker Anlass in den letzten Tagen, z. B. Zahlen deutlich über Erwartung *und* angehobene Prognose, mehrere Hochstufungen, großer Auftrag. Höchstens 1-2 Aktien pro Tag, an vielen Tagen keine.
  - **positiv:** überwiegend gute Nachrichten oder freundlicher Trend ohne großen Einzelanlass.
  - **gemischt:** gute und schlechte Nachrichten halten sich die Waage.
  - **neutral:** kaum Neuigkeiten, nichts Wesentliches passiert.
  - **negativ:** überwiegend schlechte Nachrichten oder schwacher Trend.
  - **sehr_negativ:** klarer, starker negativer Anlass, z. B. Prognosesenkung, mehrere Herabstufungen, Ermittlungen, Kurssturz mit Begründung. Ebenfalls selten.
  - Eine reine Tagesbewegung des Gesamtmarkts (alle steigen) ist kein Grund für „sehr“. Vergleiche die Aktien vor dem Festlegen miteinander.
- 3-4 Nachrichten pro Aktie, neueste zuerst. `analysts` darf leer sein, wenn es nichts Neues gibt.
- Ruhiger Tag ohne Neuigkeiten: kurz sagen, dass es nichts Wesentliches gab, und die Lage anhand der Kennzahlen einordnen.
