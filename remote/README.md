# OpenBot Remote

Ten katalog zawiera własny control plane dla połączeń WebRTC. Remote API przekazuje tylko SDP i ICE.
Pliki, czaty, komendy i obraz nie przechodzą przez Remote API ani Cloudflare.

## Przepływ

1. Aplikacja loguje użytkownika przez Cloudflare API.
2. Cloudflare D1 sprawdza członkostwo i tworzy logiczną sesję.
3. Cloudflare podpisuje krótki ticket ES256. Ticket wskazuje host, użytkownika, rolę, wersję protokołu i `authEpoch`.
4. Klient i host otwierają `WSS /v1/signal`. Signal sprawdza ticket lokalnie przez JWKS.
5. Signal przekazuje SDP i ICE oraz wydaje `resume token` i czasowe dane coturn.
6. Chromium tworzy WebRTC. Team API używa kanałów `rpc`, `events` i `files`.
7. ICE wybiera bezpośrednie `p2p` lub `relay` przez ten coturn. Cloudflare nie jest ścieżką danych.

Signal nie ma bazy. Nie zapisuje tokenów, SDP, ICE, nazw plików ani treści wiadomości. Dane pokoju
i obecności istnieją tylko w pamięci procesu.

## Wymagania produkcyjne

- Linux z Docker Engine i Docker Compose.
- Stały publiczny adres IPv4.
- Rekordy `signal.openbot.run` i `turn.openbot.run` w trybie DNS only.
- Otwarte porty TCP 443, TCP/UDP 3478, TCP 5349 i UDP 49152-65535.
- Token Cloudflare ograniczony do edycji DNS dla strefy `openbot.run`.

Rekordy `signal.openbot.run` i `turn.openbot.run` muszą mieć tryb **DNS only**. Nie włączaj proxy
Cloudflare dla tych rekordów. `api.openbot.run` pozostaje Workerem Cloudflare.

Jeżeli masz już reverse proxy na porcie `443`, ustaw `REMOTE_SIGNAL_BIND_ADDRESS=127.0.0.1`,
`REMOTE_SIGNAL_PUBLIC_PORT=8081`, `REMOTE_SIGNAL_PORT=8081` i `REMOTE_TLS_DISABLED=true`. Reverse proxy
musi zakończyć TLS i przekazać WebSocket do `http://127.0.0.1:8081`. Ustaw też
`REMOTE_TRUST_PROXY=true`, aby limity IP używały adresu klienta z `X-Forwarded-For`.

Konfiguracja w `nginx/signal.openbot.run.conf` używa certyfikatu z wolumenu ACME. Zainstaluj też
`openbot-remote-nginx-reload.path` i `openbot-remote-nginx-reload.service` w `/etc/systemd/system/`.
Jednostka przeładuje Nginx po odnowieniu certyfikatu:

```sh
sudo cp remote/nginx/openbot-remote-nginx-reload.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now openbot-remote-nginx-reload.path
```

Sekrety produkcyjne są zapisane w śledzonym pliku `.env.production` jako zaszyfrowane wartości Dotenvx.
Prywatny klucz deszyfrujący znajduje się tylko w ignorowanym pliku `remote/.env.keys`. Nie przekazuj
zaszyfrowanego pliku bezpośrednio przez `docker compose --env-file`, ponieważ Compose nie odszyfruje wartości.
Skrypty `remote:*` uruchamiają Compose przez Dotenvx i odszyfrowują wartości tylko w pamięci procesu.
Opcja `--overload` zapobiega zastąpieniu odszyfrowanych wartości przez puste zmienne środowiska hosta.
Na serwerze ze starszym systemowym Node użyj `remote/bin/dotenvx`. Ten wrapper uruchamia przypięty pakiet
Dotenvx przez Bun.

Sprawdź środowisko i uruchom usługi:

```sh
bun run remote:env:validate
bun run remote:up
bun run remote:check
```

Aktualizacja Signal może zamknąć WebSocket. Aktywne WebRTC pozostaje połączone. `remote:update` przełącza
coturn w drain i czeka na zakończenie alokacji. Jedna instancja coturn nie chroni przed awarią maszyny.
Wymuszony restart coturn kończy aktywne sesje relay. Klient wykona ICE restart i wznowi transfer pliku
od ostatniego potwierdzonego offsetu po powrocie usługi.
