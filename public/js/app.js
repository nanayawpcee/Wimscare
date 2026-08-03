/* Shared frontend helpers: API client, session guard, formatting, toasts. */
(function () {
  const API = {
    async request(path, { method = 'GET', body, formData, headers = {} } = {}) {
      const opts = { method, credentials: 'include', headers: { ...headers } };
      // Superadmin "open as" support: when the developer portal has picked an
      // organization, tenant-scoped API calls carry its id.
      const devOrg = sessionStorage.getItem('wims.devOrg');
      if (devOrg && !opts.headers['X-Org-Id']) opts.headers['X-Org-Id'] = devOrg;
      if (formData) {
        opts.body = formData;
      } else if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(path, opts);
      const isJson = (res.headers.get('content-type') || '').includes('application/json');
      const data = isJson ? await res.json() : null;
      if (!res.ok) {
        const err = new Error((data && data.error) || `Request failed (${res.status})`);
        err.status = res.status;
        throw err;
      }
      return data;
    },
   get:(p) => API.request(p),
   post: (p, body)=> API.request(p, { method: 'POST', body }),
   patch: (p, body) => API.request(p, { method: 'PATCH', body }),
   del: (p) => API.request(p, { method: 'DELETE' }),
   upload: (p, formData) => API.request(p, { method: 'POST', formData }),
  };

  const fmt = {
    gh: (n) => 'GH₵ ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    date: (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    dateTime: (d) => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    initials: (u) => ((u.firstName || ' ')[0] + (u.lastName || ' ')[0]).toUpperCase(),
    name: (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '—'),
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  };

  const STATUS_PILLS = {
    paid: 'green', approved: 'green', active: 'green', submitted: 'amber',
    under_review: 'amber', review: 'amber', pending: 'blue', draft: 'gray',
    rejected: 'red', suspended: 'red', reversed: 'red', expired: 'red', sent: 'blue',
    accepted: 'green', revoked: 'gray', completed: 'green',
  };
  function pill(status) {
    const cls = STATUS_PILLS[String(status).toLowerCase()] || 'gray';
    const label = String(status).replace(/_/g, ' ').toUpperCase();
    return `<span class="pill ${cls}">${label}</span>`;
  }

  let toastEl;
  function toast(message, isError = false) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.toggle('error', isError);
    toastEl.classList.add('show');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 3500);
  }

  // Shimmer placeholders for the specific parts of a page that come from the
  // server — a stat-card grid or a table body — rather than the whole page.
  // The rest of the HTML (header, filters, buttons) stays exactly as
  // authored and is never touched. Call before the fetch that fills the
  // container; the container's own render call (.innerHTML = ...) then
  // naturally overwrites the placeholder once data arrives, so there's no
  // separate "reveal" step.
  // Stat cards keep their real chrome (border, padding) and their real
  // labels — only the value and sub-line shimmer, since those are the only
  // parts that come from the server. Pass the labels the page is going to
  // render so the card reads correctly before its number arrives.
  const skelBar = (w, h) => `<span class="pg-skel" style="display:inline-block; vertical-align:middle; width:${w}px; height:${h}px; border-radius:5px;"></span>`;
  function skeletonCards(container, labels = 4) {
    if (!container) return;
    const items = Array.isArray(labels) ? labels : Array.from({ length: labels }, () => null);
    container.innerHTML = items
      .map(
        (label) => `
      <div class="stat">
        <div class="label">${label ? fmt.esc(label) : skelBar(84, 11)}</div>
        <div class="value">${skelBar(112, 22)}</div>
        <div class="sub">${skelBar(68, 10)}</div>
      </div>`,
      )
      .join('');
  }
  function skeletonRows(tbody, cols, rows = 4) {
    if (!tbody) return;
    const cells = Array.from({ length: cols }, () => `<td><div class="pg-skel" style="height:14px; border-radius:6px;"></div></td>`).join('');
    tbody.innerHTML = Array.from({ length: rows }, () => `<tr>${cells}</tr>`).join('');
  }
  // Same idea for non-table row lists (a plain <div> of custom-rendered rows).
  function skeletonBlocks(container, count = 3, height = 64) {
    if (!container) return;
    container.innerHTML = Array.from({ length: count }, () => `<div class="pg-skel" style="height:${height}px; margin-bottom:10px;"></div>`).join('');
  }

  // ---- Session data cache -------------------------------------------------
  // Fetches a dataset once per tab, then serves it from sessionStorage across
  // page navigations (this is a multi-page app, so an in-memory cache would
  // die on every link click). Pages can compute locally and `patch()` the
  // cached copy after a write instead of re-fetching.
  //
  // The server stays the source of truth: every registered key is re-fetched
  // in the background every REFRESH_MS so another admin's changes land here,
  // and so any locally-computed figure that drifted is corrected. Anything
  // safety-critical should still be read fresh at the moment it's acted on —
  // see cache.load(key, fetcher, { force: true }).
  const CACHE_PREFIX = 'wims.cache.';
  const CACHE_REFRESH_MS = 3 * 60 * 1000;
  const cacheSubs = {};
  const cacheFetchers = {};
  const cacheInflight = {};

  function cacheRead(key) {
    try {
      const raw = sessionStorage.getItem(CACHE_PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function cacheWrite(key, data) {
    try {
      sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), data }));
    } catch {
      // quota exceeded / private mode — cache is an optimization, not a
      // requirement, so carry on uncached.
    }
  }
  function cacheNotify(key, data) {
    (cacheSubs[key] || []).forEach((cb) => {
      try {
        cb(data);
      } catch (err) {
        console.error('[cache] subscriber failed for', key, err);
      }
    });
  }

  const cache = {
    // Returns cached data immediately when present, otherwise fetches. The
    // fetcher is remembered so the background timer can refresh this key.
    async load(key, fetcher, { force = false } = {}) {
      if (fetcher) cacheFetchers[key] = fetcher;
      if (!force) {
        const hit = cacheRead(key);
        if (hit) return hit.data;
      }
      // Collapse concurrent callers for the same key into one request.
      if (cacheInflight[key]) return cacheInflight[key];
      const fn = fetcher || cacheFetchers[key];
      if (!fn) throw new Error(`No fetcher registered for cache key "${key}"`);
      cacheInflight[key] = (async () => {
        try {
          const data = await fn();
          cacheWrite(key, data);
          return data;
        } finally {
          delete cacheInflight[key];
        }
      })();
      return cacheInflight[key];
    },
    peek(key) {
      const hit = cacheRead(key);
      return hit ? hit.data : null;
    },
    set(key, data) {
      cacheWrite(key, data);
      cacheNotify(key, data);
    },
    // Apply a local change to cached data after a successful write, so the
    // UI reflects it without a round-trip. Returns the updated data.
    patch(key, mutator) {
      const hit = cacheRead(key);
      if (!hit) return null;
      const next = mutator(hit.data);
      const data = next === undefined ? hit.data : next;
      cacheWrite(key, data);
      cacheNotify(key, data);
      return data;
    },
    // Re-render hook: called whenever a key changes (background refresh,
    // set(), or patch()). Returns an unsubscribe function.
    subscribe(key, cb) {
      (cacheSubs[key] = cacheSubs[key] || []).push(cb);
      return () => {
        cacheSubs[key] = (cacheSubs[key] || []).filter((f) => f !== cb);
      };
    },
    invalidate(key) {
      sessionStorage.removeItem(CACHE_PREFIX + key);
    },
    clear() {
      Object.keys(sessionStorage)
        .filter((k) => k.startsWith(CACHE_PREFIX))
        .forEach((k) => sessionStorage.removeItem(k));
    },
    // Re-fetch every key this page registered and notify subscribers when the
    // payload actually changed (so we don't repaint on every tick).
    async refreshAll() {
      await Promise.all(
        Object.keys(cacheFetchers).map(async (key) => {
          try {
            const before = JSON.stringify(cacheRead(key)?.data);
            const data = await cacheFetchers[key]();
            cacheWrite(key, data);
            if (JSON.stringify(data) !== before) cacheNotify(key, data);
          } catch {
            // A failed background refresh keeps the last good copy; the next
            // tick tries again.
          }
        }),
      );
    },
  };

  // Only tick while the tab is actually visible, and refresh immediately on
  // return so a tab left open for an hour isn't showing hour-old numbers.
  let cacheTimer = null;
  function startCacheRefresh() {
    if (cacheTimer) return;
    cacheTimer = setInterval(() => {
      if (document.visibilityState === 'visible') cache.refreshAll();
    }, CACHE_REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const stalest = Object.keys(cacheFetchers).reduce((oldest, key) => {
        const hit = cacheRead(key);
        return hit ? Math.min(oldest, hit.at) : 0;
      }, Date.now());
      if (Date.now() - stalest >= CACHE_REFRESH_MS) cache.refreshAll();
    });
  }

  // Session guard for authenticated pages. Redirects to login if signed out.
  let currentSession = null;
  async function requireSession({ roles } = {}) {
    try {
      const { user, organization, plan, termsAccepted, mustChangePassword } = await API.get('/api/auth/me');
      // A superadmin who has opened an organization from the developer
      // portal may browse that org's admin pages; otherwise superadmins
      // stay in the portal.
      const devOrgActive = user.role === 'superadmin' && sessionStorage.getItem('wims.devOrg');
      if (roles && !roles.includes(user.role) && !devOrgActive) {
        window.location.href = user.role === 'superadmin' ? '/developer/' : user.role === 'user' ? '/member/dashboard.html' : '/admin/dashboard.html';
        return null;
      }
      currentSession = { user, organization, plan };
      // The cache is tenant-scoped. If this tab now belongs to a different
      // user or organization than the data we cached (a re-login without a
      // sign-out, or a superadmin switching orgs via "open as"), drop it all
      // before any page can read it.
      const owner = `${user._id}:${organization ? organization._id : 'none'}`;
      if (sessionStorage.getItem('wims.cacheOwner') !== owner) {
        cache.clear();
        sessionStorage.setItem('wims.cacheOwner', owner);
      }
      startCacheRefresh();
      // Pro plan: recolour the console with the organization's brand.
      if (plan && plan.features.customBranding && organization && organization.facility) {
        applyBranding(organization.facility);
      }
      // Hide navigation to modules the plan doesn't include (the backend
      // enforces with 403s regardless).
      applyPlanGates();
      setTimeout(applyPlanGates, 0);
      // A superadmin reset this account's password to the shared default
      // (routes/users.js reset-password) — block until they set their own,
      // before anything else, since a known shared password is the more
      // urgent thing to resolve.
      if (mustChangePassword) {
        await showPasswordChangeGate();
      }
      // New registrations/activations accept inline (routes/auth.js); this
      // is the catch-up path for every account that predates the gate, or
      // whenever the Terms & Data Policy version is bumped — blocks until
      // accepted (or they sign out), on every page, regardless of theme.
      if (!termsAccepted) {
        await showTermsGate();
      }
      return currentSession;
    } catch (err) {
      window.location.href =
        err && err.status === 503
          ? '/login.html?maintenance=1'
          : '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
      return null;
    }
  }

  // Blocking modal that stands alone (own injected styles) so it renders
  // consistently whether the host page uses app.css or the developer
  // console's own theme. Resolves once the user accepts; signing out
  // navigates away instead of resolving.
  function showTermsGate() {
    return new Promise((resolve) => {
      const style = document.createElement('style');
      style.textContent = `
        .wims-terms-backdrop { position:fixed; inset:0; z-index:9999; background:rgba(15,44,63,0.55); display:flex; align-items:center; justify-content:center; padding:20px; box-sizing:border-box; font-family:'Instrument Sans', system-ui, -apple-system, 'Segoe UI', sans-serif; }
        .wims-terms-modal { background:#fff; color:#12242e; border-radius:18px; padding:28px; width:100%; max-width:440px; box-sizing:border-box; box-shadow:0 24px 64px rgba(6,20,30,0.35); }
        .wims-terms-modal h3 { margin:0 0 10px; font-size:1.1rem; font-weight:700; }
        .wims-terms-modal p { margin:0 0 16px; font-size:0.9rem; line-height:1.55; color:#5a6b75; }
        .wims-terms-modal a { color:#1d6fae; }
        .wims-terms-check { display:flex; align-items:flex-start; gap:8px; margin-bottom:20px; }
        .wims-terms-check label { font-size:0.88rem; color:#5a6b75; line-height:1.4; }
        .wims-terms-actions { display:flex; justify-content:space-between; align-items:center; gap:10px; }
        .wims-terms-actions button { font-family:inherit; cursor:pointer; border-radius:10px; font-size:0.88rem; font-weight:600; padding:10px 18px; border:0; }
        .wims-terms-signout { background:none; color:#8a98a1; padding:10px 4px !important; }
        .wims-terms-continue { background:#1d6fae; color:#fff; }
        .wims-terms-continue[disabled] { opacity:0.5; cursor:not-allowed; }
      `;
      document.head.appendChild(style);

      const backdrop = document.createElement('div');
      backdrop.className = 'wims-terms-backdrop';
      backdrop.innerHTML = `
        <div class="wims-terms-modal">
          <h3>Please review our Terms &amp; Data Policy</h3>
          <p>We've updated how we describe account and data handling on WIMScare — including what happens to your records if an account is ever deleted. Please review and accept before continuing.</p>
          <div class="wims-terms-check">
            <input type="checkbox" id="wimsTermsCheck" style="margin-top:3px; flex-shrink:0;">
            <label for="wimsTermsCheck">I agree to the <a href="/terms.html" target="_blank" rel="noopener">Terms &amp; Data Policy</a>.</label>
          </div>
          <div class="wims-terms-actions">
            <button type="button" class="wims-terms-signout" id="wimsTermsSignOut">Sign out instead</button>
            <button type="button" class="wims-terms-continue" id="wimsTermsContinue" disabled>Continue</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);

      const check = backdrop.querySelector('#wimsTermsCheck');
      const continueBtn = backdrop.querySelector('#wimsTermsContinue');
      check.addEventListener('change', () => { continueBtn.disabled = !check.checked; });
      backdrop.querySelector('#wimsTermsSignOut').addEventListener('click', () => signOut());
      continueBtn.addEventListener('click', async () => {
        continueBtn.disabled = true;
        continueBtn.textContent = 'Saving…';
        try {
          await API.post('/api/auth/accept-terms', {});
          backdrop.remove();
          style.remove();
          resolve();
        } catch (err) {
          continueBtn.disabled = false;
          continueBtn.textContent = 'Continue';
          toast(err.message, true);
        }
      });
    });
  }

  // Blocking modal shown when a superadmin has reset this account's
  // password to the shared default (routes/users.js reset-password) — self
  // contained like showTermsGate, for the same reason (renders consistently
  // regardless of which theme the host page loaded). Resolves once the user
  // sets their own password via the normal change-password endpoint, which
  // clears mustChangePassword server-side.
  function showPasswordChangeGate() {
    return new Promise((resolve) => {
      const style = document.createElement('style');
      style.textContent = `
        .wims-pwgate-backdrop { position:fixed; inset:0; z-index:9999; background:rgba(15,44,63,0.55); display:flex; align-items:center; justify-content:center; padding:20px; box-sizing:border-box; font-family:'Instrument Sans', system-ui, -apple-system, 'Segoe UI', sans-serif; }
        .wims-pwgate-modal { background:#fff; color:#12242e; border-radius:18px; padding:28px; width:100%; max-width:440px; box-sizing:border-box; box-shadow:0 24px 64px rgba(6,20,30,0.35); }
        .wims-pwgate-modal h3 { margin:0 0 10px; font-size:1.1rem; font-weight:700; }
        .wims-pwgate-modal p { margin:0 0 18px; font-size:0.9rem; line-height:1.55; color:#5a6b75; }
        .wims-pwgate-field { display:block; width:100%; box-sizing:border-box; padding:11px 13px; margin-bottom:12px; border-radius:10px; border:1px solid #d1d5db; font-size:0.92rem; font-family:inherit; }
        .wims-pwgate-error { display:none; margin-bottom:12px; padding:10px 12px; border-radius:10px; background:#fbeceb; color:#a13a30; font-size:0.85rem; }
        .wims-pwgate-error.show { display:block; }
        .wims-pwgate-actions { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-top:6px; }
        .wims-pwgate-actions button { font-family:inherit; cursor:pointer; border-radius:10px; font-size:0.88rem; font-weight:600; padding:10px 18px; border:0; }
        .wims-pwgate-signout { background:none; color:#8a98a1; padding:10px 4px !important; }
        .wims-pwgate-continue { background:#1d6fae; color:#fff; }
        .wims-pwgate-continue[disabled] { opacity:0.5; cursor:not-allowed; }
      `;
      document.head.appendChild(style);

      const backdrop = document.createElement('div');
      backdrop.className = 'wims-pwgate-backdrop';
      backdrop.innerHTML = `
        <div class="wims-pwgate-modal">
          <h3>Set a new password</h3>
          <p>Your password was reset by your organization's provider. Enter it below along with a new password to continue.</p>
          <div class="wims-pwgate-error" id="wimsPwGateError"></div>
          <input type="password" class="wims-pwgate-field" id="wimsPwGateCurrent" placeholder="Current (temporary) password" autocomplete="current-password">
          <input type="password" class="wims-pwgate-field" id="wimsPwGateNew" placeholder="New password (at least 8 characters)" autocomplete="new-password">
          <input type="password" class="wims-pwgate-field" id="wimsPwGateConfirm" placeholder="Confirm new password" autocomplete="new-password">
          <div class="wims-pwgate-actions">
            <button type="button" class="wims-pwgate-signout" id="wimsPwGateSignOut">Sign out instead</button>
            <button type="button" class="wims-pwgate-continue" id="wimsPwGateContinue">Set password</button>
          </div>
        </div>`;
      document.body.appendChild(backdrop);

      const errorBox = backdrop.querySelector('#wimsPwGateError');
      const currentEl = backdrop.querySelector('#wimsPwGateCurrent');
      const newEl = backdrop.querySelector('#wimsPwGateNew');
      const confirmEl = backdrop.querySelector('#wimsPwGateConfirm');
      const continueBtn = backdrop.querySelector('#wimsPwGateContinue');
      const showError = (msg) => { errorBox.textContent = msg; errorBox.classList.add('show'); };
      backdrop.querySelector('#wimsPwGateSignOut').addEventListener('click', () => signOut());
      continueBtn.addEventListener('click', async () => {
        errorBox.classList.remove('show');
        const currentPassword = currentEl.value;
        const newPassword = newEl.value;
        if (!currentPassword || !newPassword) return showError('Enter your current and new password');
        if (newPassword.length < 8) return showError('New password must be at least 8 characters');
        if (newPassword !== confirmEl.value) return showError('New passwords do not match');
        continueBtn.disabled = true;
        continueBtn.textContent = 'Saving…';
        try {
          await API.post('/api/auth/change-password', { currentPassword, newPassword });
          backdrop.remove();
          style.remove();
          resolve();
        } catch (err) {
          continueBtn.disabled = false;
          continueBtn.textContent = 'Set password';
          showError(err.message);
        }
      });
    });
  }

  // Permission check against the signed-in user's effective permissions
  // (role defaults + explicit grants), computed server-side and attached
  // to the session user by /api/auth/me. See utils/permissions.js.
  function can(key) {
    return !!(currentSession && currentSession.user.permissions && currentSession.user.permissions.includes(key));
  }

  // License-plan feature check (plan defaults + per-license grants),
  // computed server-side and attached to the session by /api/auth/me.
  function feature(key) {
    return !!(currentSession && currentSession.plan && currentSession.plan.features[key]);
  }

  // Pro-plan interface customization: override the design-system variables
  // with the organization's brand colours, swap the WIMScare mark for the
  // organization's own logo and show its name in the console chrome.
  // Variables are set on <body> so the overrides also beat the
  // body.theme-member green block in app.css.
  let activeBranding = null;
  function applyBranding(facility = {}) {
    let { primaryColor, accentColor, backgroundColor } = facility;
    const s = document.body.style;
    // Old schema defaults that were stamped on every organization — not a
    // deliberate brand choice, so they don't count as customization.
    if (primaryColor === '#1d6fae') primaryColor = null;
    if (accentColor === '#79b843') accentColor = null;
    if (primaryColor) {
      s.setProperty('--primary', primaryColor);
      s.setProperty('--primary-dark', `color-mix(in srgb, ${primaryColor} 80%, black)`);
      s.setProperty('--primary-tint', `color-mix(in srgb, ${primaryColor} 10%, white)`);
    }
    if (accentColor) {
      s.setProperty('--navy', accentColor);
      s.setProperty('--nav-ink', `color-mix(in srgb, ${accentColor} 25%, white)`);
      s.setProperty('--nav-sub', `color-mix(in srgb, ${accentColor} 45%, #cfd8dd)`);
    }
    if (backgroundColor) {
      s.setProperty('--bg', backgroundColor);
      // Cards keep most of their white but take on a hint of the chosen
      // background so the whole console reads as one palette.
      s.setProperty('--surface', `color-mix(in srgb, ${backgroundColor} 18%, white)`);
    }
    activeBranding = facility;
    // Logo + company name live in markup that pages build right after
    // requireSession resolves, so swap now and once more a beat later.
    applyChrome();
    setTimeout(applyChrome, 0);
    setTimeout(applyChrome, 400);
  }

  // Remove nav links to plan-locked modules. Superadmins (no org plan)
  // are never gated.
  function applyPlanGates() {
    if (!currentSession || !currentSession.plan) return;
    const f = currentSession.plan.features;
    const locked = [];
    if (!f.accountsManagement) locked.push('/admin/accounts.html', '/admin/accounts-v2.html');
    if (!f.reports) locked.push('/admin/reports.html');
    for (const href of locked) {
      document.querySelectorAll(`a[href="${href}"]`).forEach((a) => {
        a.style.display = 'none';
      });
    }
  }

  function brandLogoUrl() {
    return activeBranding && activeBranding.logoPath
      ? '/api/organization/logo?v=' + encodeURIComponent(activeBranding.logoPath.slice(-24))
      : null;
  }

  function applyChrome() {
    if (!activeBranding) return;
    const logo = brandLogoUrl();
    const name = (activeBranding.shortName || '').trim();
    if (logo) {
      document.querySelectorAll('.brand img, .m-logo').forEach((img) => {
        if (img.src.indexOf('/api/organization/logo') === -1) img.src = logo;
      });
    }
    if (name) {
      document.querySelectorAll('.brand-name').forEach((el) => {
        el.textContent = name;
      });
    }
  }

  async function signOut() {
    try { await API.post('/api/auth/logout'); } catch { /* ignore */ }
    // Cached org data is tenant-scoped and must not survive into whoever
    // signs in on this tab next.
    cache.clear();
    window.location.href = '/welcome.html';
  }

  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }

  function todayLong() {
    return new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  // Mobile shell for member pages
  function memberShell(opts) {
    const mount = document.getElementById('mShell');
    if (!mount) return;
    let { user, active, title, sub, backHref } = opts;
    // Pro branding: the org's own logo and name in the mobile header.
    const brandLogo = brandLogoUrl() || '/assets/logo.png';
    if (sub === 'WIMScare' && activeBranding && activeBranding.shortName) sub = activeBranding.shortName;
    const links = [
      { key: 'dashboard', label: 'Dashboard', href: '/member/dashboard.html' },
      { key: 'claims', label: 'My claims', href: '/member/claims.html' },
      { key: 'profile', label: 'Profile', href: '/member/profile.html' },
      { key: 'preferences', label: 'Preferences', href: '/member/preferences.html' },
    ];
    const leading = backHref
      ? `<a class="m-back-btn" href="${backHref}" aria-label="Back">&#8592;</a>`
      : `<button type="button" class="m-menu-btn" aria-label="Menu" aria-expanded="false">
           <span></span><span></span><span></span>
         </button>`;
    mount.innerHTML = `
      <header class="m-header">
        ${leading}
        <div class="m-titles">
          <span class="m-title">${fmt.esc(title)}</span>
          ${sub ? `<span class="m-sub">${fmt.esc(sub)}</span>` : ''}
        </div>
        <a href="/welcome.html">
          <img class="m-logo" src="${brandLogo}" alt="${fmt.esc((activeBranding && activeBranding.shortName) || 'WIMScare')}">
        </a>
      </header>
      <div class="m-overlay"></div>
      <aside class="m-drawer" aria-label="Member navigation">
        <div class="m-who">
          <span class="m-avatar">${fmt.initials(user)}</span>
          <div style="min-width:0;">
            <strong style="display:block; font-size:0.95rem;">${fmt.esc(fmt.name(user))}</strong>
            <span style="font-size:0.78rem; color:rgba(255,255,255,0.65);">Member${user.memberNumber ? ' · ' + fmt.esc(user.memberNumber) : ''}</span>
          </div>
        </div>
        <nav>
          ${links.map((l) => `<a href="${l.href}" class="${l.key === active ? 'active' : ''}">${l.label}</a>`).join('')}
        </nav>
        <button type="button" class="m-signout">Sign out</button>
      </aside>`;

    const menuBtn = mount.querySelector('.m-menu-btn');
    const overlay = mount.querySelector('.m-overlay');
    const setOpen = (open) => {
      document.body.classList.toggle('m-drawer-open', open);
      if (menuBtn) menuBtn.setAttribute('aria-expanded', String(open));
    };
    if (menuBtn) menuBtn.addEventListener('click', () => setOpen(!document.body.classList.contains('m-drawer-open')));
    overlay.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
    mount.querySelector('.m-signout').addEventListener('click', signOut);
  }

  // Wraps a password <input> with a persistent Show/Hide toggle. The button
  // is a structural sibling of the input, never tied to :focus/:hover/
  // blur — unlike a browser's own native reveal icon (Safari Keychain,
  // Edge's built-in eye), it cannot disappear when the field loses focus
  // or the user clicks elsewhere.
  function wirePasswordToggle(input) {
    if (typeof input === 'string') input = document.getElementById(input);
    if (!input || input.dataset.wimsToggled) return null;
    input.dataset.wimsToggled = '1';
    const wrap = document.createElement('div');
    wrap.className = 'password-wrap';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    btn.textContent = 'Show';
    btn.setAttribute('aria-label', 'Show password');
    btn.addEventListener('click', () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? 'Show' : 'Hide';
      btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      input.focus();
    });
    wrap.appendChild(btn);
    return btn;
  }

  // Live per-field validation, wired to a single input + optional error
  // element. `validate(value)` returns '' when valid or an error message.
  // Negative feedback (red border + message) only appears after the field
  // is first left (blur) — so a blank form doesn't greet the user with a
  // wall of red — but positive feedback (green border) can show as soon as
  // the value becomes valid, and callers can force a full check (e.g. on
  // submit) via the returned `forceShow()`.
  function bindField(input, validate, errorEl) {
    if (typeof input === 'string') input = document.getElementById(input);
    if (typeof errorEl === 'string') errorEl = document.getElementById(errorEl);
    let touched = false;
    function message() {
      return validate(input.value) || '';
    }
    function render() {
      const msg = message();
      const ok = !msg;
      input.classList.toggle('invalid', !ok && touched);
      input.classList.toggle('valid', ok && input.value.trim() !== '');
      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.classList.toggle('show', !ok && touched);
      }
      return ok;
    }
    input.addEventListener('input', render);
    input.addEventListener('blur', () => {
      touched = true;
      render();
    });
    return {
      isValid: () => !message(),
      forceShow: () => {
        touched = true;
        return render();
      },
    };
  }

  window.WIMS = { API, fmt, pill, toast, requireSession, can, feature, applyBranding, signOut, greeting, todayLong, memberShell, wirePasswordToggle, bindField, skeletonCards, skeletonRows, skeletonBlocks, cache };
})();
