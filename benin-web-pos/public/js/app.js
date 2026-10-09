/*
 * ANIP web POS — terminal UI. Same journey and screens as the Android
 * proximity POS: home → QR code → identity result → payment → complete.
 */
'use strict';

(function () {
  /* ------------------------------------------------------------ icons */
  const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  const ICON = {
    check: svg('<polyline points="20 6 9 17 4 12"/>'),
    checkCircle: svg('<circle cx="12" cy="12" r="9"/><polyline points="8 12.5 11 15.5 16 9.5"/>'),
    xCircle: svg('<circle cx="12" cy="12" r="9"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'),
    x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
    warn: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    minusCircle: svg('<circle cx="12" cy="12" r="9"/><line x1="8" y1="12" x2="16" y2="12"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
    qr: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>'),
    store: svg('<path d="M3 9l1.5-5h15L21 9"/><path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M5 12v8h14v-8"/><path d="M10 20v-5h4v5"/>'),
    badge: svg('<rect x="3" y="5" width="18" height="15" rx="2"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16.5a3.4 3.4 0 0 1 6.4 0"/><line x1="14" y1="10" x2="18" y2="10"/><line x1="14" y1="14" x2="18" y2="14"/><path d="M9 5V3h6v2"/>'),
    phone: svg('<rect x="6" y="2" width="12" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/>'),
    flask: svg('<path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7.5 15h9"/>'),
    cloud: svg('<path d="M17.5 19H8a5 5 0 1 1 1.2-9.86A6 6 0 0 1 20.5 12 3.5 3.5 0 0 1 17.5 19z"/>'),
    cloudOff: svg('<path d="M22.6 17.4A3.5 3.5 0 0 0 19 12h-.6A6 6 0 0 0 9.3 8.2"/><path d="M5.2 7.3A5 5 0 0 0 8 19h9"/><line x1="2" y1="2" x2="22" y2="22"/>'),
    backspace: svg('<path d="M21 5H8l-6 7 6 7h13a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z"/><line x1="17" y1="9" x2="12" y2="14"/><line x1="12" y1="9" x2="17" y2="14"/>'),
    card: svg('<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/>'),
    shield: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>')
  };
  const STATUS_ICON = { PASS: 'checkCircle', FAIL: 'xCircle', WARN: 'warn', NOT_EVALUATED: 'minusCircle', NOT_CHECKED: 'info' };

  /* ----------------------------------------------------------- state */
  const DEFAULT_SETTINGS = {
    merchant: 'Supermarché Étoile — Cotonou',
    amount: 15000,
    currency: 'XOF',
    requireTrustedIssuer: true,
    requireAgeOver18: false,
    includePortrait: false
  };
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (_) { /* private mode: keep in memory */ }
    }
  };

  const state = {
    lang: store.get('anip-pos-lang', (navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en'),
    settings: { ...DEFAULT_SETTINGS, ...store.get('anip-pos-settings', {}) },
    cfg: null,
    screen: 'home',
    tx: null, // { id, key, uri, qr, qrVersion }
    view: null, // latest transaction view from the server
    error: null,
    pin: '',
    payError: null,
    busy: false,
    showDetails: false,
    issuerTrusted: false
  };
  let pollTimer = null;

  /* ---------------------------------------------------------- helpers */
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function t(key, ...args) {
    const dict = window.I18N[state.lang] || window.I18N.en;
    const s = dict[key] != null ? dict[key] : (window.I18N.en[key] != null ? window.I18N.en[key] : key);
    return s.replace(/\{(\d+)\}/g, (m, i) => (args[i] != null ? args[i] : m));
  }
  const locale = () => (state.lang === 'fr' ? 'fr-FR' : 'en-GB');
  function money(amount, currency) {
    const n = new Intl.NumberFormat('fr-FR').format(amount).replace(/ | /g, ' ');
    return `${n} ${currency === 'XOF' ? 'FCFA' : currency}`;
  }
  function claimValue(name, value) {
    if (value === undefined || value === null) return '—';
    if (typeof value === 'boolean') return value ? t('yes') : t('no');
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const d = new Date(`${value}T00:00:00Z`);
      return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString(locale(), { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
    }
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'object') return value.bytes ? '[image]' : JSON.stringify(value);
    return String(value);
  }
  const provider = () => (state.cfg ? state.cfg.paymentProvider[state.lang] || state.cfg.paymentProvider.en : '');

  async function api(method, path, body) {
    const headers = { 'content-type': 'application/json' };
    if (state.tx) headers['x-tx-key'] = state.tx.key;
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.error || json.status || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  /* ------------------------------------------------------- transaction */
  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function forgetTransaction() {
    stopPolling();
    const tx = state.tx;
    if (tx) api('DELETE', `/api/tx/${tx.id}`).catch(() => {});
    Object.assign(state, { tx: null, view: null, pin: '', payError: null, busy: false, showDetails: false, issuerTrusted: false });
  }

  async function startTransaction() {
    await forgetTransaction();
    const s = state.settings;
    const created = await api('POST', '/api/transactions', {
      merchant: s.merchant,
      amount: s.amount,
      currency: s.currency,
      requireTrustedIssuer: s.requireTrustedIssuer,
      requireAgeOver18: s.requireAgeOver18,
      includePortrait: s.includePortrait
    });
    state.tx = { id: created.id, key: created.key, uri: created.uri, qr: created.qr, qrVersion: created.qrVersion };
    state.view = created.transaction;
    go('reading');
  }

  async function start() {
    try {
      await startTransaction();
      poll();
    } catch (err) {
      showError(err);
    }
  }

  async function startDemo(tamper) {
    try {
      await startTransaction();
      // The QR code is shown briefly, then the simulated wallet answers
      await new Promise((r) => setTimeout(r, 900));
      if (!state.tx) return;
      state.view = await api('POST', `/api/tx/${state.tx.id}/simulate`, { tamper });
      onView();
    } catch (err) {
      showError(err);
    }
  }

  function poll() {
    stopPolling();
    pollTimer = setTimeout(async () => {
      if (!state.tx || state.screen !== 'reading') return;
      try {
        state.view = await api('GET', `/api/tx/${state.tx.id}`);
        onView();
      } catch (err) {
        if (err.status === 404) return showError(t('error_expired'));
        render(); // transient network error: keep waiting
      }
      if (state.screen === 'reading') poll();
    }, 1000);
  }

  function onView() {
    const v = state.view;
    if (!v) return;
    if (v.status === 'pending') return render();
    stopPolling();
    if (v.status === 'verified' || v.status === 'rejected') return go('result');
    if (v.status === 'paid' || v.status === 'payment_declined') return go('completed');
    return render();
  }

  function showError(err) {
    stopPolling();
    state.error = typeof err === 'string' ? err : err && err.status ? `${err.message}` : t('error_network');
    go('error');
  }

  async function trustIssuer() {
    try {
      await api('POST', `/api/tx/${state.tx.id}/trust-issuer`);
      state.issuerTrusted = true;
      state.cfg = await api('GET', '/api/config');
      render();
    } catch (err) {
      showError(err);
    }
  }

  async function pay() {
    if (state.busy || state.pin.length < 4) return;
    state.busy = true;
    state.payError = null;
    render();
    try {
      const pin = state.pin;
      state.pin = '';
      state.view = await api('POST', `/api/tx/${state.tx.id}/pay`, { pin });
      state.busy = false;
      const p = state.view.payment;
      if (state.view.status === 'verified' && p && p.status === 'declined') {
        // Wrong PIN with attempts left: stay on the payment screen
        state.payError = t('wrong_pin', p.attemptsLeft);
        return render();
      }
      return onView();
    } catch (err) {
      state.busy = false;
      showError(err);
    }
  }

  async function declinePayment() {
    try {
      state.view = await api('POST', `/api/tx/${state.tx.id}/decline`);
      onView();
    } catch (err) {
      showError(err);
    }
  }

  /* ----------------------------------------------------------- screens */
  function go(screen) {
    state.screen = screen;
    render();
    window.scrollTo(0, 0);
  }

  function hero(title, subtitle, extra = '') {
    return `<div class="wrap"><span class="badge">${esc(t('badge'))}</span><h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}${extra}</div>`;
  }

  function networkChip() {
    const online = navigator.onLine !== false;
    return `<span class="chip ${online ? '' : 'offline'}">${online ? ICON.cloud : ICON.cloudOff}${esc(t(online ? 'online' : 'offline'))}</span>`;
  }

  const cardTitle = (icon, title, sub) => `<div class="card-title"><div class="tile">${ICON[icon]}</div><div><h2>${esc(title)}</h2>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div></div>`;

  function elementsList() {
    const els = state.cfg ? [...state.cfg.elements, ...(state.settings.includePortrait ? [state.cfg.portrait] : [])] : [];
    return `<ul class="attr-list">${els.map((e) => `<li>${ICON.checkCircle}<span>${esc(t(`claim_${e.id}`))}</span>${e.required ? `<span class="req">${esc(t('required_mark'))}</span>` : ''}</li>`).join('')}</ul>`;
  }

  function merchantCard() {
    const s = state.settings;
    return `<section class="card">${cardTitle('store', t('merchant_label'), s.merchant)}<hr class="divider"><div class="muted">${esc(t('amount_label'))}</div><div class="amount">${esc(money(s.amount, s.currency))}</div></section>`;
  }

  function homeScreen() {
    $('#hero').innerHTML = hero(t('header_title'), t('header_subtitle'), networkChip());
    const demo = state.cfg && state.cfg.demoMode
      ? `<section class="card">${cardTitle('flask', t('demo_section'))}<p class="muted small m0">${esc(t('demo_note'))}</p>
          <button class="btn-text" data-action="demo" data-tamper="NONE">${esc(t('btn_demo_valid'))}</button>
          <button class="btn-text danger" data-action="demo" data-tamper="ALTERED_NAME">${esc(t('btn_demo_altered'))}</button>
          <button class="btn-text danger" data-action="demo" data-tamper="EXPIRED">${esc(t('btn_demo_expired'))}</button></section>`
      : '';
    return `${merchantCard()}
      <section class="card">${cardTitle('badge', t('identity_required'))}<p class="m0">${esc(t('identity_required_body'))}</p>${elementsList()}<p class="muted small m0">${esc(t('intent_note'))}</p></section>
      <section class="card">${cardTitle('phone', t('instruction_title'))}<p class="m0">${esc(t('instruction_body'))}</p>
        <button class="btn btn-primary" data-action="start">${ICON.qr}${esc(t('btn_start'))}</button></section>
      ${demo}`;
  }

  function readingScreen() {
    const s = state.settings;
    $('#hero').innerHTML = hero(t('progress_title'), `${s.merchant} · ${money(s.amount, s.currency)}`);
    const v = state.view || {};
    const fetched = v.walletStep === 'request_fetched' || v.walletStep === 'response_received';
    const received = v.walletStep === 'response_received';
    const steps = [
      ['QR', true, false],
      ...(state.cfg && state.cfg.requestMode === 'reference' ? [['FETCHED', fetched, false]] : []),
      ['CONSENT', received, !received],
      ['RECEIVED', received, false],
      ['VERIFYING', false, received]
    ];
    const stepsHtml = steps.map(([id, done, active], i) => `<li class="${done ? 'done' : active ? 'active' : ''}"><span class="dot">${done ? ICON.check : active ? '<span class="spinner"></span>' : i + 1}</span>${esc(t(`step_${id}`))}</li>`).join('');
    return `<section class="card"><h2 class="h-md">${esc(t('scan_title'))}</h2>
        <div class="qr-box" data-action="zoom" role="button" tabindex="0" aria-label="${esc(t('scan_hint'))}">${state.tx ? state.tx.qr : ''}</div>
        <div class="qr-meta muted small">${esc(t('scan_hint'))} · ${esc(t('qr_version', state.tx ? state.tx.qrVersion : '?'))}</div>
        <a class="btn-text center" href="${esc(state.tx ? state.tx.uri : '#')}">${esc(t('open_wallet_here'))}</a></section>
      <section class="card"><ul class="steps">${stepsHtml}</ul></section>
      <button class="btn btn-secondary" data-action="cancel">${esc(t('cancel'))}</button>`;
  }

  function personCard(report) {
    const c = report.claims || {};
    const name = [c.given_name, c.family_name].filter(Boolean).join(' ') || '—';
    const rows = Object.entries(c).filter(([k]) => !['family_name', 'given_name', 'portrait'].includes(k));
    const portrait = c.portrait && c.portrait.bytes ? `<img class="portrait" alt="${esc(t('claim_portrait'))}" src="data:image/jpeg;base64,${esc(c.portrait.bytes)}">` : '';
    return `<section class="card"><div class="person-label ${report.verified ? '' : 'fail'}">${esc(t(report.verified ? 'verified_person' : 'presented_person'))}</div>
      <div class="person-name">${esc(name)}</div>${portrait}
      <dl>${rows.map(([k, val]) => `<div class="kv"><dt>${esc(t(`claim_${k}`))}</dt><dd>${esc(claimValue(k, val))}</dd></div>`).join('')}</dl></section>`;
  }

  function checksCard(report) {
    const items = report.checks.map((c) => `<li class="s-${c.status}">${ICON[STATUS_ICON[c.status]]}<div><div class="name">${esc(t(`check_${c.id}`))}</div>${c.detail ? `<div class="detail">${esc(c.detail)}</div>` : ''}</div><span class="status">${esc(t(`status_${c.status}`))}</span></li>`).join('');
    return `<section class="card"><h2 class="h-sm">${esc(t('verification_details'))}</h2><ul class="checks">${items}</ul></section>`;
  }

  function walletErrorNote(report) {
    const r = report.checks.find((c) => c.id === 'RESPONSE' && c.status === 'FAIL');
    if (!r) return '';
    const m = /^wallet_error:(.+)$/.exec(r.detail || '');
    return `<div class="note fail">${esc(m ? t('reason_wallet_error', m[1]) : r.detail)}</div>`;
  }

  function resultScreen() {
    const report = state.view.report;
    $('#hero').innerHTML = hero(t(report.verified ? 'identity_verified' : 'identity_failed'), `${state.settings.merchant} · ${money(state.view.pos.amount, state.view.pos.currency)}`);
    const banner = `<div class="banner ${report.verified ? 'ok' : 'fail'}">${report.verified ? ICON.checkCircle : ICON.xCircle}${esc(t(report.verified ? 'identity_verified' : 'identity_failed'))}</div>`;
    const trustCard = report.canTrustIssuer
      ? `<section class="card">${state.issuerTrusted
        ? `<div class="note ok">${esc(t('issuer_trusted_now'))}</div><button class="btn btn-primary" data-action="start">${ICON.qr}${esc(t('run_again'))}</button>`
        : `<div class="note warn">${esc(t('trust_this_issuer_note'))}</div>${report.issuer ? `<div class="small muted">${esc(t('issuer_label'))}: ${esc(report.issuer)}</div>` : ''}<button class="btn btn-secondary" data-action="trust">${ICON.shield}${esc(t('trust_this_issuer'))}</button>`}</section>`
      : '';
    const actions = report.verified
      ? `<button class="btn btn-primary" data-action="pay-start">${ICON.card}${esc(t('continue_payment'))}</button>`
      : `<button class="btn btn-primary" data-action="new">${esc(t('retry'))}</button>`;
    return `${banner}${walletErrorNote(report)}${Object.keys(report.claims || {}).length ? personCard(report) : ''}${actions}${trustCard}${checksCard(report)}`;
  }

  function paymentScreen() {
    const req = state.view.paymentRequest;
    $('#hero').innerHTML = hero(t('payment_title'), t('payment_body'));
    const len = Math.max(4, state.pin.length);
    const dots = Array.from({ length: len }, (_, i) => `<span class="${i < state.pin.length ? 'on' : ''}"></span>`).join('');
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
    const pad = keys.map((k) => (k === '' ? '<span></span>' : k === 'del'
      ? `<button class="del" data-action="pin-del" aria-label="Delete" ${state.busy ? 'disabled' : ''}>${ICON.backspace}</button>`
      : `<button data-action="pin" data-digit="${k}" ${state.busy ? 'disabled' : ''}>${k}</button>`)).join('');
    return `<section class="card"><div class="title-sm">${esc(req.merchantName)}</div><div class="amount">${esc(money(req.amount, req.currency))}</div>
        <dl><div class="kv"><dt>${esc(t('reference'))}</dt><dd>${esc(req.reference)}</dd></div><div class="kv"><dt>${esc(t('payment_provider'))}</dt><dd>${esc(provider())}</dd></div></dl>
        <p class="muted small m0">${esc(t('payment_context'))}</p></section>
      <section class="card"><div class="title-sm">${esc(t('enter_pin'))}</div>
        <div class="pin-dots" aria-label="PIN">${dots}</div>
        ${state.payError ? `<div class="note fail">${esc(state.payError)}</div>` : ''}
        <div class="pinpad">${pad}</div>
        ${state.cfg && state.cfg.demoPin ? `<div class="muted small center">${esc(t('pin_hint', state.cfg.demoPin))}</div>` : ''}
        ${state.busy
          ? `<div class="busy-row"><span class="spinner"></span>${esc(t('authorizing'))}</div>`
          : `<button class="btn btn-primary" data-action="authorize" ${state.pin.length >= 4 ? '' : 'disabled'}>${esc(t('authorize'))}</button>
             <button class="btn-text danger center" data-action="decline">${esc(t('decline'))}</button>`}
      </section>`;
  }

  function completedScreen() {
    const v = state.view;
    const report = v.report;
    const p = v.payment || {};
    const paid = p.status === 'authorized';
    $('#hero').innerHTML = '';
    $('#hero').hidden = true;
    const line = (ok, text) => `<div class="line"><span class="mark ${ok ? '' : 'no'}">${ok ? ICON.checkCircle : ICON.xCircle}</span><span>${esc(text)}${ok ? '\u00a0✓' : ''}</span></div>`;
    const c = report.claims || {};
    const details = state.showDetails
      ? `<section class="card"><dl>
          <div class="kv"><dt>${esc(t('engagement_label'))}</dt><dd>${esc(t('engagement_value'))}</dd></div>
          <div class="kv"><dt>${esc(t('transport_label'))}</dt><dd>${esc(t('transport_value', state.cfg ? state.cfg.responseMode : ''))}</dd></div>
          ${v.durationMs != null ? `<div class="kv"><dt>${esc(t('duration_label'))}</dt><dd>${(v.durationMs / 1000).toFixed(1)} s</dd></div>` : ''}
          ${report.issuer ? `<div class="kv"><dt>${esc(t('issuer_label'))}</dt><dd>${esc(report.issuer)}</dd></div>` : ''}
          ${report.validFrom ? `<div class="kv"><dt>${esc(t('valid_label'))}</dt><dd>${esc(report.validFrom)} → ${esc(report.validUntil)}</dd></div>` : ''}
          ${report.deviceAuth ? `<div class="kv"><dt>${esc(t('device_auth_label'))}</dt><dd>${esc(report.deviceAuth)}</dd></div>` : ''}
        </dl></section>${checksCard(report)}`
      : '';
    return `<div class="final ${paid ? '' : 'failed'}">${line(report.verified, t('result_identity'))}${line(paid, t(paid ? 'result_payment' : 'result_payment_failed'))}${line(paid, t(paid ? 'result_complete' : 'result_not_complete'))}</div>
      <section class="card"><div class="title-md">${esc(v.paymentRequest.merchantName)}</div><div class="amount">${esc(money(v.paymentRequest.amount, v.paymentRequest.currency))}</div>
        <dl><div class="kv"><dt>${esc(t('verified_person'))}</dt><dd>${esc([c.given_name, c.family_name].filter(Boolean).join(' '))}</dd></div>
        <div class="kv"><dt>${esc(t('reference'))}</dt><dd>${esc(v.paymentRequest.reference)}</dd></div>
        ${paid ? `<div class="kv"><dt>${esc(t('authorization_code'))}</dt><dd>${esc(p.code)}</dd></div>` : `<div class="kv"><dt>${esc(t('result_payment_failed'))}</dt><dd>${esc(t(`reason_${p.reason}`))}</dd></div>`}
        <div class="kv"><dt>${esc(t('payment_provider'))}</dt><dd>${esc(provider())}</dd></div></dl></section>
      <button class="btn btn-secondary" data-action="details">${esc(t(state.showDetails ? 'details_hide' : 'details_show'))}</button>
      ${details}
      <button class="btn btn-primary" data-action="new">${esc(t('new_transaction'))}</button>`;
  }

  function errorScreen() {
    $('#hero').innerHTML = hero(t('error_title'));
    return `<section class="card"><div class="note fail">${esc(state.error || t('error_network'))}</div></section><button class="btn btn-primary" data-action="new">${esc(t('retry'))}</button>`;
  }

  function settingsScreen() {
    const s = state.settings;
    $('#hero').innerHTML = hero(t('settings'));
    const anchors = (state.cfg && state.cfg.trustAnchors) || [];
    const toggle = (id, label, on) => `<label class="switch"><span class="lbl">${esc(label)}</span><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span class="track"></span></label>`;
    return `<form id="settings-form" class="card" novalidate><h2 class="h-sm">${esc(t('settings_terminal'))}</h2>
        <div class="field"><label for="s-merchant">${esc(t('settings_merchant'))}</label><input id="s-merchant" maxlength="80" value="${esc(s.merchant)}"></div>
        <div class="row2"><div class="field"><label for="s-amount">${esc(t('settings_amount'))}</label><input id="s-amount" inputmode="numeric" pattern="[0-9]*" value="${esc(s.amount)}"></div>
        <div class="field"><label for="s-currency">${esc(t('settings_currency'))}</label><input id="s-currency" maxlength="3" value="${esc(s.currency)}"></div></div>
        <h2 class="h-sm">${esc(t('settings_policy'))}</h2>
        ${toggle('s-trusted', t('settings_require_trusted'), s.requireTrustedIssuer)}
        ${toggle('s-age', t('settings_require_age'), s.requireAgeOver18)}
        ${toggle('s-portrait', t('settings_portrait'), s.includePortrait)}
        <p class="muted small m0">${esc(t('settings_saved_locally'))}</p>
        <button class="btn btn-primary" type="submit">${esc(t('save'))}</button></form>
      <section class="card"><h2 class="h-sm">${esc(t('settings_trust'))}</h2>
        ${anchors.length ? `<ul class="checks">${anchors.map((a) => `<li class="s-PASS">${ICON.shield}<div><div class="name">${esc(a.label)}</div><div class="detail">${esc(a.subject)}</div></div></li>`).join('')}</ul>` : `<p class="muted m0">${esc(t('no_anchors'))}</p>`}
        <p class="muted small m0">${esc(t('settings_trust_note'))}</p></section>
      ${state.cfg ? `<section class="card"><h2 class="h-sm">${esc(t('settings_wallet'))}</h2><dl>
        <div class="kv"><dt>client_id</dt><dd>${esc(state.cfg.clientId)}</dd></div>
        <div class="kv"><dt>request</dt><dd>${esc(state.cfg.requestMode)}</dd></div>
        <div class="kv"><dt>response_mode</dt><dd>${esc(state.cfg.responseMode)}</dd></div></dl></section>` : ''}
      <button class="btn btn-secondary" data-action="home">${esc(t('back'))}</button>`;
  }

  const SCREENS = { home: homeScreen, reading: readingScreen, result: resultScreen, payment: paymentScreen, completed: completedScreen, error: errorScreen, settings: settingsScreen };

  function render() {
    document.documentElement.lang = state.lang;
    document.title = state.lang === 'fr' ? 'ANIP · Terminal de vente' : 'ANIP Web POS';
    document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
    document.querySelectorAll('.lang').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang)));
    const settingsBtn = $('#settings-btn');
    settingsBtn.innerHTML = ICON.gear;
    settingsBtn.title = t('settings');
    settingsBtn.setAttribute('aria-label', t('settings'));
    settingsBtn.hidden = state.screen !== 'home';
    $('#hero').hidden = false;
    $('#screen').innerHTML = SCREENS[state.screen]();
  }

  /* ----------------------------------------------------------- events */
  document.addEventListener('click', (e) => {
    const langBtn = e.target.closest('.lang');
    if (langBtn) {
      state.lang = langBtn.dataset.lang;
      store.set('anip-pos-lang', state.lang);
      return render();
    }
    if (e.target.closest('#settings-btn')) return go('settings');
    if (e.target.closest('#qr-full')) {
      $('#qr-full').hidden = true;
      return undefined;
    }
    const el = e.target.closest('[data-action]');
    if (!el) return undefined;
    const action = el.dataset.action;
    switch (action) {
      case 'start': return start();
      case 'demo': return startDemo(el.dataset.tamper);
      case 'cancel':
      case 'new':
        forgetTransaction();
        return go('home');
      case 'home': return go('home');
      case 'zoom':
        $('#qr-full').innerHTML = state.tx ? state.tx.qr : '';
        $('#qr-full').hidden = false;
        return undefined;
      case 'trust': return trustIssuer();
      case 'pay-start':
        state.pin = '';
        state.payError = null;
        return go('payment');
      case 'pin':
        if (state.pin.length < 8) state.pin += el.dataset.digit;
        return render();
      case 'pin-del':
        state.pin = state.pin.slice(0, -1);
        return render();
      case 'authorize': return pay();
      case 'decline': return declinePayment();
      case 'details':
        state.showDetails = !state.showDetails;
        return render();
      default: return undefined;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#qr-full').hidden) $('#qr-full').hidden = true;
    if (e.key === 'Enter' && e.target.closest && e.target.closest('[data-action="zoom"]')) e.target.click();
    if (state.screen !== 'payment' || state.busy) return;
    if (/^[0-9]$/.test(e.key) && state.pin.length < 8) {
      state.pin += e.key;
      render();
    } else if (e.key === 'Backspace') {
      state.pin = state.pin.slice(0, -1);
      render();
    } else if (e.key === 'Enter') {
      pay();
    }
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'settings-form') return;
    e.preventDefault();
    const amount = parseInt($('#s-amount').value.replace(/\s/g, ''), 10);
    const currency = $('#s-currency').value.trim().toUpperCase();
    state.settings = {
      merchant: $('#s-merchant').value.trim() || DEFAULT_SETTINGS.merchant,
      amount: Number.isInteger(amount) && amount > 0 ? amount : DEFAULT_SETTINGS.amount,
      currency: /^[A-Z]{3}$/.test(currency) ? currency : DEFAULT_SETTINGS.currency,
      requireTrustedIssuer: $('#s-trusted').checked,
      requireAgeOver18: $('#s-age').checked,
      includePortrait: $('#s-portrait').checked
    };
    store.set('anip-pos-settings', state.settings);
    go('home');
  });

  window.addEventListener('online', () => state.screen === 'home' && render());
  window.addEventListener('offline', () => state.screen === 'home' && render());

  /* ------------------------------------------------------------- boot */
  render();
  api('GET', '/api/config').then((cfg) => {
    state.cfg = cfg;
    render();
  }).catch(() => render());
})();
