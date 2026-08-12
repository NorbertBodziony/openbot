# Infeld Bot

Desktopowy interfejs dla zespołu agentów AI, zbudowany na Electronie, SolidJS i Bun.

## Wymagania

- Bun 1.3.11
- Node.js 22.12+ (dla narzędzi Electron/Vite)
- macOS 12+ na Apple Silicon
- Codex CLI 0.144.1+ zalogowany przez subskrypcję ChatGPT (`codex login`)

## Komendy

```bash
bun install
bun run dev
bun run codex:doctor
bun run check
bun run package
bun run dist:mac
```

- `dev` uruchamia aplikację z HMR.
- `codex:doctor` sprawdza lokalny CLI, App Server, login i Computer Use bez uruchamiania turnu.
- `test:codex` wykonuje ten sam test w trybie ścisłym i nie zużywa tokenów modelu.
- `check` wykonuje Biome, typecheck, testy i build produkcyjny.
- `package` tworzy lokalny katalog `.app`.
- `dist:mac` tworzy niepodpisany instalator DMG dla arm64.

## Architektura

- `src/main` — cykl życia Electron, okno, zabezpieczenia i handlery IPC.
- `src/backend` — lokalny klient Codex App Server, wątki botów i host przeglądarki.
- `src/preload` — minimalny, typowany most `window.infeld`.
- `src/renderer` — interfejs SolidJS i Tailwind CSS.
- `src/shared` — kontrakty współdzielone między procesami.

Bun zarządza paczkami i uruchamia skrypty. Kod aplikacji wykonuje się w środowisku
Node.js/Chromium dostarczonym przez Electron.

## Dane lokalne

- `~/Infeld/Bots/<bot-id>` — osobny katalog roboczy każdego bota.
- `~/Infeld/Shared` — katalog współdzielony przez boty.
- `~/Infeld/Downloads` — pliki pobrane przez przeglądarkę Infeld.
- `~/.codex` — historia i sesja zarządzane wyłącznie przez Codex CLI.

Infeld nie uruchamia serwera HTTP ani nie przechowuje tokenów. Proces Electron komunikuje się z
`codex app-server` przez prywatne stdio. W tej wersji boty działają z `danger-full-access` i
`approvalPolicy: never`; zatrzymanie wszystkich aktywnych turnów jest dostępne przez `Cmd+.`.
