# OpenBot UI foundation

OpenBot jest dark-first i korzysta z kompaktowej skali kontrolek: 24 px dla elementów pomocniczych, 28 px dla toolbarów, 32 px jako standard oraz 36 px dla ważnych akcji. Paleta i wszystkie globalne tokeny `--openbot-*` mieszkają w `packages/brand/src/tokens.css` — jednym pliku, który importują też web i mobile; `src/renderer/src/styles.css` tylko go importuje i dokłada zmienne animacji renderera. Reset i role bazowe są w `styles/base.css`, prymitywy w `styles/primitives.css`, a reguły ekranów w arkuszu własnego feature'a — `features/<domena>/<domena>.css`, importowanym z `styles.css` w kolejności, która jest kaskadą. Żaden z tych plików nie definiuje własnej palety.

## Publiczne API

Feature’y — katalogi `src/renderer/src/features/<domena>/` — importują wyłącznie z `components/ui`. Bezpośrednie importy z Kobalte i Lucide są zabronione. Kobalte jest silnikiem zachowania, a nie publicznym API aplikacji; dzięki temu jego aktualizacja nie wymaga zmian w feature’ach.

- `Text` i `Heading` — tekst interfejsu; dobierz semantyczne `as`, a wygląd przez `variant` lub `size`.
- `Button` — akcja z tekstem. `primary` służy jednej najważniejszej akcji w kontekście, `secondary` akcjom standardowym, `ghost` toolbarom, `danger` operacjom destrukcyjnym, a `link` akcjom osadzonym w tekście.
- `IconButton` — samodzielna ikona; zawsze podaj `label`. `tooltip` może doprecyzować skrót, ale nie zastępuje etykiety dostępnościowej.
- `Badge` — krótki, nieinteraktywny stan lub kategoria. Nie używaj go jako przycisku.
- `Input`, `Textarea`, `NativeSelect` — natywne kontrolki w jednolitej anatomii. Owijaj je w `Field`, aby automatycznie połączyć label, opis, błąd, `required` i `aria-describedby`.
- `Switch` — natychmiastowa zmiana ustawienia binarnego. Dla decyzji wymagającej zatwierdzenia formularza użyj checkboxa lub RadioGroup.
- `Card`, `Separator`, `Spinner`, `Skeleton`, `Kbd` — elementy powierzchni, struktury i feedbacku.
- `Dialog`, `AlertDialog`, `DropdownMenu`, `Popover`, `Tooltip`, `Tabs`, `RadioGroup`, `Select`, `Combobox` i `Listbox` — eksportowane adaptery Kobalte do złożonych interakcji.

## Zasady implementacji

Kolory muszą pochodzić z semantycznych zmiennych `--openbot-*`. Rozmiary tekstu, promienie i czasy animacji korzystają z tokenów. Hover stosujemy tylko w `@media (hover: hover) and (pointer: fine)`, pressable controls używają `scale(0.97)`, a animacje mieszczą się poniżej 300 ms i respektują `prefers-reduced-motion`.

`bun run check:ui` blokuje natywne buttony i switche, ręczne dialogi/menu/taby/listboxy, bezpośrednie importy Kobalte/Lucide poza warstwą UI oraz literały kolorów i nietokenizowane rozmiary tekstu, promienie i czasy przejść. Kontrola obejmuje wszystkie arkusze CSS renderera oraz deklaracje inline w TSX; jedynym miejscem, gdzie literał koloru jest dozwolony, jest wspólna paleta `packages/brand/src/tokens.css`. Sprawdza również, czy złożone namespace’y nie wracają do bezpośrednich aliasów Kobalte. Wszystkie budżety migracyjne wynoszą zero.

## Weryfikacja

Izolowane komponenty sprawdzamy w Storybooku w sekcji `Foundations`. Pełne przepływy, dialogi, menu, composer i rozmowę sprawdzamy w dev app. Każdy komponent powinien mieć stany default, hover, focus-visible, active, disabled, loading/empty (jeśli dotyczą), test klawiatury i historię a11y. A11y jest globalną bramką Storybooka (`test: "error"`). Stabilne snapshoty Chromium/macOS obejmują galerię foundations, pełny ekran aplikacji, dialog dołączania do serwera, panel hosta i picker modeli.

## Który komponent wybrać

- Akcja natychmiastowa: `Button` lub `IconButton`; nawigacja osadzona w tekście: wariant `link`.
- Stan lub metadane: `Badge`; ciągły feedback z pracy: `Spinner` albo `Skeleton`.
- Wartość binarna stosowana od razu: `Switch`; jeden wybór z krótkiej listy: `RadioGroup`; wybór z dłuższej listy: `Select`; lista wymagająca wyszukiwania lub własnej wartości: `Combobox`.
- Kilka równorzędnych widoków: `Tabs`; lista akcji przy triggerze: `DropdownMenu`; menu kontekstowe pod prawym przyciskiem: `ContextMenu`.
- Lekka informacja zakotwiczona przy elemencie: `Tooltip` lub `Popover`; zadanie wymagające skupienia: `Dialog`; nieodwracalne potwierdzenie: `AlertDialog`.

## Granice zależności

`@kobalte/core@2.0.0-alpha.0` jest przypięte dokładnie i dostępne wyłącznie przez `components/ui`. Kuratowane adaptery z `components/ui/complex.tsx` zachowują publiczne nazwy niezależnie od struktury upstreamu i kompensują utratę focusu po zamknięciu dialogów, menu oraz popoverów w wersji alpha. Lokalna poprawka kompatybilności z Solid 2 RC jest utrzymywana przez Bun w `patches/`; po przejściu Kobalte na stabilne API należy najpierw usunąć patch i potwierdzić zachowanie wrapperów bez zmiany importów feature'ów. Ikony Lucide również przechodzą przez wspólny eksport `components/ui/icons`; logo, avatary i grafiki produktowe pozostają własnymi assetami OpenBota.
