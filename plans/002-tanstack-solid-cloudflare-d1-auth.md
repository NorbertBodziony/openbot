# Plan 002: TanStack Start, Solid 2, Cloudflare Workers i D1

## Cel

Centralny serwer kont działa jako osobna aplikacja TanStack Start z Solid 2.
Cloudflare Workers hostuje aplikację. D1 przechowuje użytkowników, krótkie dane
logowania i sesje OpenBota.

## Kontrakt konta

- Unikalny adres email identyfikuje użytkownika dla hostów.
- API wysyła jednorazowy kod w formacie `XXXX-XXXX`.
- Kod używa 32 bezpiecznych znaków i ma około 40 bitów entropii.
- Kod jest ważny przez 10 minut i można go użyć tylko raz.
- D1 przechowuje tylko skrót kodu.
- API nie przyjmuje i nie zapisuje hasła OpenBota.
- API zapisuje tylko skrót tokenu sesji OpenBota.
- Electron zapisuje zaszyfrowany token sesji przez `safeStorage`.

## Limity

- Maksymalnie 5 nowych kodów dla emaila w ciągu 15 minut.
- Maksymalnie 20 nowych kodów dla IP w ciągu 15 minut.
- Co najmniej 60 sekund pomiędzy kodami dla tego samego emaila.
- Maksymalnie 5 błędnych prób dla jednego kodu.
- Maksymalnie 30 prób weryfikacji dla IP w ciągu 15 minut.

## Przepływ

1. Electron wysyła email do `POST /v1/auth/email/start`.
2. API zapisuje skrót kodu oraz limit czasu w D1.
3. Adapter wysyłki przekazuje kod do usługi email.
4. Użytkownik wpisuje kod w aplikacji.
5. Electron wywołuje `POST /v1/auth/email/verify`.
6. API zużywa kod i zwraca sesję OpenBota.

## Połączenie z whitelistą hosta

- Następny etap zmienia członka teamu na `centralUserId + email + role`.
- Host nie przechowuje hasła ani nickname członka.
- Centralne API wydaje krótki, podpisany ticket dla konkretnego hosta.
- Host sprawdza ticket i lokalną whitelistę email lub user ID.

## Polecenia

- `bun run api` uruchamia lokalny Worker i D1.
- `bun run dev` uruchamia klienta Electron.
- `bun run host` uruchamia osobny profil hosta.
- `bun run dev:all` uruchamia API, klienta i hosta.
- `bun run api:migrate:local` stosuje lokalne migracje D1.
- `bun run api:deploy` wdraża Worker po ustawieniu konfiguracji Cloudflare.
