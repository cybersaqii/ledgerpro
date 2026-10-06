# Dashboard UI Audit — `app/(app)/dashboard/page.tsx` (+ `components/ui.tsx`, `app/globals.css`)

Read-only audit, 2026-10-01. No code changed. Line numbers refer to the current files.

---

## A. Layout bugs (visible misplacement)

### A1. KPI "go" arrow can overlap the tile's sub-text on narrow screens
- **Where:** `app/(app)/dashboard/page.tsx` ~L290 (`<span className="kpi-tile-go">`) + `app/globals.css` L364–370 (`.kpi-tile-go { position:absolute; right:0.9rem; bottom:0.9rem; … }`) + `components/ui.tsx` `Stat` (~L74: `p-5`, sub at `mt-1 text-xs`).
- **What's wrong:** The arrow sits 14px above the card's bottom edge. On the 4 tiles that have a `sub` line (receivables, payables, low stock, profit/loss), the sub text occupies the same bottom band. On desktop the tile is wide enough that the text ends before the arrow, but at mobile 2-column width (~160px tiles) or with long Urdu subs the text runs underneath the semi-visible (opacity 0.45) arrow — text and arrow collide.
- **Fix:** In `Stat`, give the text column `pe-11` (padding-inline-end) when a `sub` is present, or move `.kpi-tile-go` to `bottom: 1.15rem` and add `pe-10` to the Stat text wrapper so text never slides under the arrow. Keep it `inset-inline-end` (see B1).

### A2. KPI grid is single-column on phones — 8 stacked cards, excessive scroll
- **Where:** `page.tsx` ~L283: `className="stagger-rise grid gap-4 sm:grid-cols-2 xl:grid-cols-4"`.
- **What's wrong:** Below `sm` (all phones) the 8 KPI tiles stack full-width, pushing the trend chart and recent sales ~900px down. Industry-standard dashboards use 2 columns on phones.
- **Fix:** Change to `grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-2 xl:grid-cols-4`. Also reduce `Stat` value to `text-[1.2rem]` below `sm` so "Rs 12,45,678" doesn't truncate as hard. Mirror the same `grid-cols-2` in the loading skeleton (~L118).

### A3. `stagger-rise` entrance animation is dead code on the KPI grid
- **Where:** `page.tsx` ~L283 + `app/globals.css` L411–419.
- **What's wrong:** The CSS comment says "composes with `.rise` on children", but the direct children are the `Link.kpi-tile` elements which have **no** `rise` class — the inner `Stat` div has it. The `animation-delay` rules therefore target elements with no animation; all 8 tiles animate simultaneously with delay 0.
- **Fix:** Add `rise` to the `Link` (`className="kpi-tile rise group …"`) and remove `rise` from `Stat`'s root div in `components/ui.tsx` (it is also used standalone elsewhere, so instead: keep `Stat` as-is and wrap — simplest is moving `rise` onto the Link and dropping it from this one call site by adding a `bare` prop, or just accept double animation). Minimal fix: `className="kpi-tile group relative block rise"`.

### A4. POS banner left content is indented 8px more than the right CTA (asymmetric)
- **Where:** `page.tsx` ~L247: `<span className="flex min-w-0 items-center gap-4 pl-2">` inside a `p-4 sm:p-5` card.
- **What's wrong:** Icon/text block starts at 24px from the left edge while the CTA button sits at 16px from the right — visibly lopsided.
- **Fix:** Remove `pl-2`.

### A5. Chart Y-axis gutter wastes ~30px on mobile
- **Where:** `page.tsx` ~L312: `<YAxis … width={70} tickFormatter={v >= 1000 ? `${Math.round(v/1000)}k` : …}>`.
- **What's wrong:** Labels are at most 4 chars ("96k"), but 70px is reserved. On a ~340px phone card this steals ~12% of chart width for empty space.
- **Fix:** `width={44}` (keep `width={70}` only if values can exceed 9999k — they can't after the k-formatter).

### A6. Quick-action strip: `snap-start` with no snap container
- **Where:** `page.tsx` ~L262: parent `flex … overflow-x-auto` (no `snap-x`), children have `snap-start`.
- **What's wrong:** Dead class — no snap behaviour occurs; on swipe the strip stops mid-tile.
- **Fix:** Add `snap-x snap-mandatory` to the parent strip div.

---

## B. RTL (Urdu) direction bugs

### B1. `.kpi-tile-go` uses physical `right:` — wrong side in Urdu
- **Where:** `app/globals.css` L365: `right: 0.9rem`.
- **What's wrong:** In RTL the arrow stays bottom-right instead of mirroring to bottom-left.
- **Fix:** `right: 0.9rem` → `inset-inline-end: 0.9rem`. Same for the hover `translateY(-2px)` (fine as-is).

### B2. `ArrowRight` doesn't flip in RTL (2 places)
- **Where:** `page.tsx` ~L233 (onboarding step rows: `{!s.done && <ArrowRight …>}`) and ~L255 (POS banner CTA: `{t("dashboard.posStart")} <ArrowRight …>`).
- **What's wrong:** In the Urdu RTL layout "forward" is leftward; the arrow still points right, i.e. backwards.
- **Fix:** Add `rtl:rotate-180` to both `ArrowRight` instances.

### B3. `ArrowUpRight` "open" indicator doesn't mirror in RTL
- **Where:** `page.tsx` ~L291: `<ArrowUpRight size={15} />` inside `.kpi-tile-go`.
- **What's wrong:** Minor, but in RTL locales the diagonal "open" glyph conventionally points up-left.
- **Fix:** Add `rtl:-scale-x-100` to the icon.

### B4. Recovery-nudge gradient is physical-direction
- **Where:** `page.tsx` ~L147: `bg-gradient-to-r from-amber-50 to-orange-50`.
- **What's wrong:** Gradient direction doesn't flip in RTL (cosmetic only).
- **Fix:** `bg-gradient-to-r rtl:bg-gradient-to-l` (and same for the `dark:` variants).

---

## C. i18n / hardcoded strings

### C1. Hardcoded English error string
- **Where:** `page.tsx` L201: `setSampleError(e instanceof Error ? e.message : "Could not load sample data.")`.
- **What's wrong:** Only hardcoded English string on the dashboard; EN/UR dictionary parity is otherwise 39/39.
- **Fix:** Add `dashboard.sampleError: "Could not load sample data."` / Urdu `"نمونہ ڈیٹا لوڈ نہیں ہو سکا۔"` to `lib/i18n/en.ts` + `ur.ts` and use `t("dashboard.sampleError")`.

### C2. Label concatenation produces unnatural Urdu word order
- **Where:** `page.tsx` ~L140–141: `` `${bp.salesNav} ${t("dashboard.today")}` `` → Urdu renders "فروخت آج" instead of natural "آج کی فروخت". Same pattern for `salesMonth`.
- **What's wrong:** Concatenating translated fragments breaks Urdu adjective order.
- **Fix:** Add parameterized keys, e.g. `dashboard.salesToday: "{sales} today"` / Urdu `"آج کی {sales}"`, `dashboard.salesThisMonth: "{sales} this month"` / `"اس ماہ کی {sales}"`, and use them instead of template concatenation.

### C3. `key={q.label}` on quick actions remounts the strip on language switch
- **Where:** `page.tsx` ~L264: `{quickActions.map((q) => (<Link key={q.label} …` .
- **What's wrong:** Labels change with language, so switching EN↔UR remounts all 8 links (loses hover/focus state, wasteful).
- **Fix:** Use the stable `q.href` as key.

---

## D. Polish / unfinished feel

### D1. Inconsistent empty states: chart uses a bare `<p>`, recent-sales uses `EmptyState`
- **Where:** `page.tsx` ~L303 (`<p className="py-16 …">{t("dashboard.noSales")}</p>`) vs ~L325 (`<EmptyState …>`).
- **What's wrong:** Two different empty-state treatments on the same screen look unfinished.
- **Fix:** Use `<EmptyState title={t("dashboard.noSales")} hint={…} />` for the chart too (or at minimum add the same icon treatment).

### D2. Dismiss (X) buttons are oversized for their cards
- **Where:** `page.tsx` ~L158 (recovery nudge) and ~L185 (onboarding): `className="grid h-11 w-11 …"` with `<X size={16} />`.
- **What's wrong:** 44px button holding a 16px glyph inside a compact card — the button looks like an empty box; 36px is the standard dismiss size.
- **Fix:** `h-11 w-11` → `h-9 w-9` on both dismiss buttons.

### D3. `EmptyState` icon (`BookOpenCheck`) is semantically wrong for "no sales"
- **Where:** `components/ui.tsx` ~L86 (`EmptyState` hardcodes `<BookOpenCheck size={26} />`).
- **What's wrong:** A book icon for an empty sales list confuses; the component can't vary it.
- **Fix:** Add optional `icon?: ReactNode` prop to `EmptyState` (default keeps `BookOpenCheck`); dashboard passes `<ReceiptText size={26} />` for the recent-sales empty state.

### D4. Inconsistent tile corner radius overrides (`!rounded-xl`)
- **Where:** `page.tsx` ~L149, ~L189 (`tile … !rounded-xl`); quick actions ~L267 (`!rounded-xl`); `Stat` icon has no override.
- **What's wrong:** `.tile` is `border-radius: 1rem` (== `rounded-2xl`); the `!rounded-xl` important-overrides suggest drift — tiles render at two different radii across the same screen.
- **Fix:** Decide one radius for `.tile` (keep `1rem`) and drop all `!rounded-xl` overrides, or change `.tile` to `0.75rem` and drop overrides.

### D5. Trend subtitle hardcodes the currency symbol
- **Where:** `lib/i18n/en.ts` L168: `trendSub: "Last 6 months (Rs)"`.
- **What's wrong:** "Rs" is baked into a translated string; a future multi-currency app (or even the Urdu locale) inherits it silently.
- **Fix:** Low priority — either interpolate `{currency}` or accept as-is. Flagged for awareness.

### D6. Buttons missing `type="button"`
- **Where:** `page.tsx` ~L112 (retry), ~L158, ~L185 (dismiss), ~L195 (load-sample).
- **What's wrong:** Harmless today (no enclosing `<form>`), but a future form wrapper would turn these into submit buttons.
- **Fix:** Add `type="button"` to all four.

---

## E. Checked and OK (no action)

- Icon semantics: `ArrowDownToLine` = money in (receivables, "Receive"), `ArrowUpFromLine` = money out (payables, "Pay") — correct, not swapped.
- `metricTileTarget()` (`lib/dashboard-tiles.ts`): all 8 targets point at existing routes (`/sales`, `/reports/receivables`, `/reports/payables`, `/payments`, `/expenses`, `/stock?lowStock=1`, `/reports/profit-loss`). `cashBank → /payments` is reasonable.
- KPI tile is a real `<Link>` with `aria-label` (from `dashboard.openTile`, properly parameterized in both languages); go-arrow is `aria-hidden`.
- EN/UR dashboard dictionary parity 39/39.
- Loading skeleton column count matches the KPI grid (`sm:grid-cols-2 xl:grid-cols-4`) — update both together if A2 is applied.
- Recent-sales rows: `-mx-2 px-2` hover extension, `truncate` on docNo/party, `tabular-nums` on amounts — correct.
- `useEffect` refetch on `[t]` change (language switch) is intentional.
