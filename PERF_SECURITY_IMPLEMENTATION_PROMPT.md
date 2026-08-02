# Implementation Prompt — WIMScare SPA Conversion, Caching & Security Hardening

> Hand this whole file to the implementing agent. It is written to be executed in phases,
> with a stop-and-verify checkpoint after each. Do not attempt it as a single change.

---

## 1. Context you need before you start

**WIMScare** is a multi-tenant welfare / contribution management system.

- **Backend**: Express 4 + Mongoose 8. Entry `server.js` → `app.js`. Routes in `routes/`, models in `models/`, shared logic in `utils/`, gates in `middleware/`.
- **Frontend**: 23 hand-written HTML pages under `public/`, `public/admin/`, `public/member/`, `public/developer/`. **There is no build step today** — `package.json` has no `build` script and no bundler.
- **Shared frontend code**: `public/css/app.css` (~22KB) and `public/js/app.js` (~25KB), which exposes a `WIMS` global containing `API`, `fmt`, `pill`, `requireSession`, `revealPage`, `toast`, `showPageSkeleton`.
- **Auth**: httpOnly cookie JWT (`wims_token`). `middleware/auth.js` `protect()` verifies, loads the user, and pins `req.orgId`. Roles: `superadmin`, `admin`, `supervisor`, `accountant`, `user`. Superadmin can act on another org via the `X-Org-Id` header; the frontend stores that choice in `sessionStorage` as `wims.devOrg`.
- **Storage**: `utils/storage.js` abstracts Vercel Blob (when `BLOB_READ_WRITE_TOKEN` is set) vs. local disk under `uploads/`.
- **Deploy targets**: Vercel (static `public/` at the edge, `/api/*` rewritten to a serverless function — see `vercel.json`) **and** Render (`node server.js` with a persistent disk — see `render.yaml`). Both must keep working.

### The problem being solved

Today, selecting any page or tab causes a **full document load plus a full re-fetch of session and page data**. Every page inlines a large `<style>` and `<script>` block (`public/developer/index.html` is 71KB, `public/login.html` 46KB, `public/admin/profile.html` 63KB), so nothing is reusable across navigations, `requireSession()` re-hits `/api/auth/me` on every page, and no `Cache-Control` header is set anywhere in the codebase.

### The goal

Navigating between views inside a portal should issue **no new document request and no redundant API calls**. Static assets should be cached indefinitely by content hash. Server-side repeat queries should be cached with correct invalidation. All of this without weakening tenant isolation, which is the primary risk of every change below.

---

## 2. Non-negotiable security invariants

These hold at every phase. If a phase can only be completed by violating one, stop and report instead.

1. **`/api/*` is never stored by any shared cache.** Set `Cache-Control: private, no-store` and `Vary: Cookie` on every API response. Do not rely on the absence of a header. A CDN or proxy hit that crosses tenants is the worst possible outcome of this work.
2. **The client router is not an authorization boundary.** Server-side `protect`, `requireRoles`, `requirePermission`, `requireFeature`, and `requireOrg` stay exactly as they are. A view rendering client-side must never imply the API will serve its data.
3. **Tenant data never touches `localStorage` or `sessionStorage`.** Both survive logout and are readable by any script on the origin. The client cache is **in-memory only**. The existing `sessionStorage` key `wims.devOrg` is a non-sensitive selector and may stay.
4. **Every cache key — client or server — includes the tenant and the identity.** Minimum key components: `orgId` + `userId` + `role`. Role matters concretely: `routes/contributions.js` `buildListFilter()` returns *different rows* for the same URL depending on whether the caller is staff or a member.
5. **The client cache is destroyed on**: logout, any `401`/`403` response, and any change to `wims.devOrg` (superadmin switching orgs). No exceptions, no partial flush.
6. **Cache invalidation is a security control.** `middleware/auth.js` already documents this: the org-status cache is cleared on archive so that deletion locks out live sessions immediately. Anything you cache that affects access — user status, role, permissions, license/plan — needs the same explicit clear-on-write hook, not just a TTL.
7. **No object store bucket is public.** Sensitive claim documents must not be retrievable by URL alone.
8. **CSP goes on only after inline scripts are gone**, and without `unsafe-inline`.

---

## 3. Phase 0 — Build step and asset extraction

*Prerequisite for everything else. Do this first, merge it, confirm both deploys are green.*

- Add **esbuild** as a dev dependency and an `npm run build` script. No other bundler, no framework.
- Output to `public/dist/` with content-hashed filenames and a `manifest.json` mapping logical name → hashed path.
- Extract the inline `<style>` and `<script>` from all 23 HTML pages into per-page source modules under `src/pages/`. Each module exports `mount(container, ctx)` and optionally `unmount()`.
- **Before extracting, prune dead pages.** `public/admin/accounts-v2.html` (50KB) is not linked from any navigation — every sidebar points at `accounts.html`. Confirm it is genuinely dead and delete it rather than porting it. Sweep for other orphans the same way (grep each filename across `public/**/*.html`).
- Move `public/js/app.js` and `public/css/app.css` into the same pipeline. Keep the `WIMS` API surface identical for now — this phase is a mechanical move, not a redesign.
- Wire `npm run build` into the Vercel and Render build commands. Add `public/dist/` to `.gitignore`.
- Serve hashed assets with `Cache-Control: public, max-age=31536000, immutable`. Serve HTML with `no-cache` (revalidate every time) so a deploy is picked up instantly.

**Checkpoint**: every page still works with zero inline `<script>`. Diff the rendered DOM before/after on at least `admin/dashboard`, `member/dashboard`, `developer/index`, and `login`.

---

## 4. Phase 1 — SPA shells, one portal at a time

Convert **per portal**, in this order, merging each separately: `member/` → `admin/` → `developer/`. Portal boundaries match the role boundaries, which keeps the auth guard reasoning simple. Public pages (`login`, `register`, `activate`, `forgot-password`, `reset-password`, `welcome`, `about`, `terms`) stay as plain documents — they are unauthenticated and rarely navigated between.

For each portal:

- One shell document (e.g. `public/member/index.html`) containing the chrome — sidebar, header, toast mount — and an empty view container.
- A small hash-free client router using the History API. Route table maps path → dynamically `import()`ed page module. Preserve existing URLs so bookmarks and any hardcoded links keep working; add server rewrites so a deep link cold-loads the shell.
- `requireSession()` runs **once** at shell boot, not per view. Store the resulting session object in memory and pass it to each `mount()` via `ctx`.
- On route change: call the outgoing view's `unmount()`, clear its container, then `mount()` the incoming one. Abort in-flight `fetch`es of the outgoing view with an `AbortController` so a slow response can't paint into the wrong view.
- Keep the existing `showPageSkeleton()` / `revealPage()` behaviour, now driven by the router rather than each page.
- Prefetch the route module on link hover/focus (`link.addEventListener('mouseenter', ...)` → `import()`), so the module is warm before the click.
- In-page tab/panel switches (the `data-panel-section` panels) must read from the client cache, not re-fetch. This is the specific behaviour the user asked for.

**Checkpoint per portal**: open DevTools Network, navigate every view twice. Second pass must show **zero document requests**, **zero duplicate `/api/auth/me`**, and hashed assets served from disk cache.

---

## 5. Phase 2 — Client data cache

Add a cache layer inside `WIMS.API` (do not make callers manage it).

- **In-memory `Map` only.** Key: `` `${userId}:${orgId}:${role}:${method}:${path}` ``.
- Per-entry TTL, defaulting short. Suggested tiers: reference data that rarely changes (`/api/claim-types`, `/api/payment-modes`, `/api/fund-accounts`, org profile, plan/license summary) 5 minutes; list endpoints 30 seconds; dashboards 30 seconds. Anything involving money movement in flight should not be cached at all — err toward not caching when unsure.
- **Request coalescing**: two concurrent `GET`s to the same key share one in-flight promise. This alone removes a lot of duplicate work during shell boot.
- **Stale-while-revalidate** for list views: paint the cached copy immediately, revalidate in the background, re-render if changed. Makes tab switching feel instant while staying fresh.
- **Write-through invalidation**: any `POST`/`PATCH`/`DELETE` invalidates the cache entries for its resource prefix. Be generous — over-invalidating is a performance cost, under-invalidating is a correctness bug that will show up as a user seeing money that isn't there.
- **Hard reset** on logout, on `401`/`403`, and on `wims.devOrg` change (invariant 5). Implement this inside `API.request`'s error path so it cannot be forgotten by a caller.
- Add a manual refresh affordance on data-heavy views so a user can always force a bypass.

**Checkpoint**: log in as org A, note a figure, log out, log in as org B, confirm nothing from A is ever visible. Repeat with the superadmin org switcher — that path is the easiest one to get wrong.

---

## 6. Phase 3 — Server-side caching

- Generalise the existing `orgStatusCache` in `middleware/auth.js` into a small reusable TTL-cache helper (`utils/cache.js`) with `get`, `set`, `invalidate(key)`, and `invalidatePrefix(prefix)`. Keep the existing semantics — that cache is the reference implementation.
- **`protect()` currently runs a full `User.findById` on every authenticated request.** Cache it for 15–30s keyed by user id. It exists to catch status revocation, so wire explicit invalidation into every path that changes a user's `status`, `role`, or permission grants (`routes/users.js`, `routes/auth.js`, `routes/profile.js`, `routes/developer.js`). Also `.select()` only the fields `protect` actually needs.
- **`requireFeature()` calls `currentLicense(req.orgId)` (`utils/plans.js:66`) uncached on every gated request.** Cache per org, invalidate on any license write in `routes/developer.js`.
- Set explicit `Cache-Control: private, no-store` + `Vary: Cookie` on all `/api/*` responses via middleware in `app.js` (invariant 1).
- **Move `express-rate-limit` off the default `MemoryStore`.** On Vercel each function instance keeps its own counters, so the 20-attempt login limit is effectively *20 × instance count*. Use a shared store (Redis/Upstash). **Do not "fix" this by raising the limits.** Until the shared store is in place, treat the current limits as advisory and say so in the PR description.

Note on serverless: module-scope `Map`s do not survive scale-out — each instance holds its own copy, so the TTL is your consistency bound. That is acceptable for short TTLs with write invalidation, but it must never be the *only* correctness mechanism.

---

## 7. Phase 4 — Query fixes

Each of these is independently verifiable; do them as small commits.

- **`routes/fundAccounts.js` (~line 58)** — `accounts.map(async ...)` runs one aggregate per fund account (N+1). Replace with a single `$group` by `fundAccountId` over `LedgerEntry`, then join in memory.
- **`routes/developer.js` (~line 178)** — four queries per organization inside `orgs.map(async ...)`. Replace with grouped aggregates across all orgs.
- **`routes/dashboard.js` `/admin`** — `Contribution.distinct('memberId', periodMatch)` ships every distinct member id to the app just to read `.length`. Replace with `$group` + `$count`. It also duplicates the `$match` already done by `periodAgg`; `$facet` collapses the whole thing into one pipeline pass.
- **`models/Contribution.js`** — the admin list sorts by `contributionDate` with only `organizationId` in the filter, but the existing compound indexes are `(org, memberId, date)` and `(org, year, month)`. No prefix covers `(organizationId, contributionDate)` → in-memory sort, which fails at MongoDB's 32MB limit as data grows. Add it. Check `User` sorted by `createdAt` for the same problem.
- **Add `.lean()` to read-only list/detail endpoints.** `routes/users.js`, `routes/dashboard.js`, `routes/profile.js`, `routes/reversals.js`, `routes/claimTypes.js`, and `routes/organization.js` currently use it zero times. Verify the `toJSON` transform in `models/User.js:142` (which deletes `passwordHash`) is not load-bearing for any endpoint you convert — with `.lean()` it does not run. Use explicit `.select()` instead.
- **Search**: unanchored `new RegExp(q, 'i')` cannot use an index. `routes/contributions.js` `buildListFilter()` additionally runs a `User.find` first and feeds an unbounded `$in`. Move to a text index or Atlas Search, or cap the id array.
- **Deep pagination**: `skip((page-1) * perPage)` degrades linearly. Fine now; note it for the export paths that walk many pages.

**Checkpoint**: `explain()` the contributions list query and confirm `IXSCAN` with no in-memory `SORT` stage.

---

## 8. Phase 5 — Private object storage with presigned URLs

Work entirely inside `utils/storage.js` so the calling routes barely change.

- **Bucket blocks all public access.** Today `storage.save()` writes with `access: 'public'` and a predictable key shape (`<orgId>/<subdir>/<timestamp>-<hex>`), so any leaked claim-document URL is readable forever with no auth. Claim documents in a welfare system are among the most sensitive data here.

- **⚠️ Do this one first — database backups are written to the same public store.** `utils/backupService.js:68` calls `storage.save(null, 'backups', gzipped, ...)`. With `orgId` null the key falls back to `system/backups/<filename>`, and `save()` writes it with `access: 'public'`. That is a **gzipped full-database export retrievable by URL with no authentication**, across every tenant. It is the single highest-severity finding in this codebase. Move backups to a private, versioned prefix with a lifecycle rule before anything else in this phase, and audit whether any existing backup objects need to be rotated out of the public store.
- Replace direct URL persistence with an **opaque storage key** on the document, and issue a **presigned GET at request time**, TTL ≤ 300s, scoped to the single object. The authorization check already exists — `loadClaim` in `routes/claims.js` — so issue the URL immediately after it passes.
- **`storage.serveDownload()` proxies the whole file through the function**: `readBuffer` pulls the entire object into memory, then `res.send`. That is client → function → store → function → client with the full file buffered in a serverless process. Redirect to a presigned URL instead. Note `serveInline()` already redirects correctly — match its shape.
- **`middleware/upload.js` `fileFilterFor()` trusts the client-declared `file.mimetype`.** Add magic-byte sniffing on the buffer and reject on mismatch. Keep the existing `sharp` re-encode for avatars and logos — re-encoding is itself a strong sanitiser.
- Consider direct-to-S3 presigned `PUT` for claim documents (currently up to 8MB × 10 files pass through the function body). This trades away the server-side `sharp` pass and inline validation, so if you do it, validate asynchronously on an upload event and quarantine until validated. **If that tradeoff isn't clearly worth it, skip it** — the download path is where the real win is.
- Set long `Cache-Control` on stored objects: filenames already carry a timestamp, so they are effectively immutable.

**Checkpoint**: copy a claim document URL, wait past the TTL, confirm it is denied. Confirm the bucket's public-access block is on.

---

## 9. Phase 6 — CSP and headers

Only after Phase 0 and 1 have removed every inline script.

- Turn on `helmet`'s CSP in `app.js:23` (currently `contentSecurityPolicy: false`, with a comment explaining it is off *because* everything is inlined — Phase 0 removes that reason).
- No `unsafe-inline`. Use nonces or hashes for anything genuinely unavoidable.
- Google Fonts (`fonts.googleapis.com`, `fonts.gstatic.com`) needs allowlisting — or self-host the font files and drop the third-party origin entirely, which also removes a DNS + TLS round trip on first paint.
- Verify `frame-ancestors`, `object-src 'none'`, and a `connect-src` tight enough to cover your API and object store and nothing else.

---

## 10. Acceptance criteria

- Switching between views inside a portal: **zero** document requests, **zero** duplicate `/api/auth/me`.
- Second visit to any view: hashed JS/CSS served from disk cache; no `304` revalidation round trips for hashed assets.
- `curl -I` on any `/api/*` route returns `Cache-Control: private, no-store` and `Vary: Cookie`.
- Cross-tenant test passes: org A → logout → org B shows nothing from A. Same via the superadmin org switcher.
- Role test passes: a member and an admin hitting the same cached list endpoint in the same browser session never see each other's row sets.
- A claim document URL is unusable after its TTL expires.
- `explain()` on the contributions list shows an index scan, no in-memory sort.
- Existing tests (`npm test`) pass. Add tests for: cache key construction, cache reset on 401, and presigned URL expiry.

---

## 11. Explicitly do NOT

- Do not put tenant data in `localStorage` or `sessionStorage`.
- Do not allow any CDN or shared proxy to cache `/api/*`.
- Do not remove or weaken a server-side auth check on the grounds that the client router already gates the view.
- Do not make the object store bucket public, and do not paper over the presigned-URL work by relying on unguessable key names.
- Do not raise the `express-rate-limit` numbers to compensate for the memory store.
- Do not change business logic as part of this work: the ledger double-entry posting in `routes/contributions.js`, the claim state machine, seat/plan enforcement in `utils/plans.js`, and the OTP/2FA flows in `routes/auth.js` are all out of scope. If a phase seems to require touching them, stop and raise it.
- Do not do a big-bang PR. One phase, one merge, one verification pass.

---

## 12. Report back after each phase

State: what changed, which acceptance criteria now pass, what you measured (before/after request counts and transferred bytes for a representative navigation), and any invariant you came close to breaking and how you avoided it.
