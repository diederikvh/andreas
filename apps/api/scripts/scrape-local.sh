#!/bin/bash
# De scrapers die een browser nodig hebben draaien niet mee in de
# nachtelijke GitHub Action: het Fly-runtime-image heeft geen Playwright,
# en de scrapers draaien in-process in de API. Zie de matrix in
# .github/workflows/scrape-stager.yml — deze vijftien staan daar bewust
# niet in.
#
# Dagelijks via launchd: ~/Library/LaunchAgents/nl.wend.andreas.scrape.plist
# (09:00; launchd haalt een gemiste run in bij het wakker worden).
#
# Dagelijks en niet wekelijks omdat Paradiso's aankondigingen per mail
# eerder buiten waren dan in de app — met een weekschema liep dat tot
# zes dagen achter. Kost niets: de sweep draait lokaal en duurt ~12 min.
# Handmatig: ./scripts/scrape-local.sh          — alles
#            ./scripts/scrape-local.sh foam     — één, om te testen
#
# Volgorde: zwaarste eerst, zodat een timeout laat in de rit niet de
# grote venues raakt. Duurt in z'n geheel ~5 minuten.
#
# Paradiso, Melkweg en Muziekgebouw staan hier niet meer bij: die
# draaien sinds 12/13 sep mee in de nachtelijke GitHub Action, want ze
# hebben geen browser meer nodig. Dat scheelde de drie zwaarste.
set -uo pipefail

DEFAULT="ot301 thuishaven weticket radioradio
         qfactory bimhuis brakkegrond ontheroof ketelhuis thepulse athenaeum foam"

cd "$(dirname "$0")/.." || exit 1   # apps/api
echo "════ sweep gestart $(date '+%F %T') ════"

failed=()
for s in ${*:-$DEFAULT}; do
  start=$(date +%s)
  if out=$(pnpm -s scrape "$s" 2>&1); then
    # run-scraper print de totalen op de regel vóór de per-venue-regels.
    # De laatste JSON pakken geeft dus één venue: paradiso las als
    # `fetched: 1` (Doka) terwijl het er 430 waren over vier venues.
    echo "ok    $s  $(( $(date +%s) - start ))s  $(sed -n 's/.*done in [0-9]*ms: //p' <<<"$out")"
  else
    echo "FOUT  $s  $(( $(date +%s) - start ))s"
    echo "$out" | tail -5 | sed 's/^/      /'
    failed+=("$s")
  fi
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "════ ${#failed[@]} mislukt: ${failed[*]} ════"
  # Anders rot dit stil weg: een sweep die een maand faalt zie je pas
  # aan een lege agenda.
  osascript -e "display notification \"${failed[*]}\" with title \"Andreas: scrapers mislukt\"" 2>/dev/null
  exit 1
fi
echo "════ klaar $(date '+%F %T') — alles groen ════"
