# Plany implementacji

Wygenerowano przez skill `improve` 2026-08-18. Wykonuj plany w podanej
kolejności. Przed rozpoczęciem przeczytaj cały plan, wykonaj sprawdzenie zmian
repozytorium i respektuj warunki `STOP`.

## Kolejność i stan

| Plan | Tytuł | Priorytet | Rozmiar | Zależności | Stan |
|------|-------|-----------|---------|------------|------|
| 001 | Dodaj centralne API kont i whitelistę hosta | P1 | L | — | SUPERSEDED BY 002 |
| 002 | TanStack Start, Solid 2, Cloudflare Workers i D1 | P1 | L | — | IN PROGRESS |

Dozwolone stany: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED: <powód>`,
`REJECTED: <powód>`.

## Zależności

- Plan 002 zastępuje część backendową planu 001. Część whitelisty hosta jest
  następnym etapem planu 002.
- Plan jest zapisany na podstawie brudnego drzewa roboczego przy commicie
  `8229759`. Niezacommitowane pliki funkcji Remote OpenBot są częścią stanu
  wejściowego. Wykonawca musi je zachować i sprawdzić przed zmianą.

## Odrzucone warianty

- Centralne API jako właściciel teamów i agentów: odrzucone. W pierwszej wersji
  API jest właścicielem kont i sesji. Host pozostaje właścicielem whitelisty,
  ról, agentów, rozmów i plików.
- Konto hosta z lokalnym hasłem: odrzucone. Duplikuje dane logowania i nie
  spełnia wymagania, że host nie zapisuje haseł ani nickname'ów.
- Whitelistowanie wyłącznie po tekście emaila: odrzucone. Host może przyjąć
  oczekujący email, ale po pierwszym poprawnym połączeniu musi związać wpis ze
  stałym `userId` z centralnego API.
- Długi token centralnej sesji używany bezpośrednio przez host: odrzucone. Host
  dostaje krótki, podpisany token o ograniczonym `audience`.
