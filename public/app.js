(function () {
  const loginView = document.getElementById('login-view');
  const dashboardView = document.getElementById('dashboard-view');

  const walletLoginBtn = document.getElementById('wallet-login-btn');
  const modal = document.getElementById('wallet-modal');
  const modalClose = document.getElementById('modal-close');
  const modalPending = document.getElementById('modal-pending');
  const modalError = document.getElementById('modal-error');
  const retryBtn = document.getElementById('retry-btn');

  const qrImg = document.getElementById('qr-img');
  const sameDeviceLink = document.getElementById('same-device-link');
  const rawUri = document.getElementById('raw-uri');
  const statusBadge = document.getElementById('status-badge');
  const errorOut = document.getElementById('error-out');

  const welcomeName = document.getElementById('welcome-name');
  const accountHolder = document.getElementById('account-holder');
  const accountDob = document.getElementById('account-dob');
  const verifiedFormat = document.getElementById('verified-format');
  const claimsOut = document.getElementById('claims-out');
  const logoutBtn = document.getElementById('logout-btn');
  const billerNameEl = document.getElementById('biller-name');

  let pollTimer = null;

  fetch('/api/config').then((r) => r.json()).then((cfg) => {
    if (cfg.billerName) {
      billerNameEl.textContent = cfg.billerName;
      document.title = `${cfg.billerName} — My Account`;
    }
  }).catch(() => {});

  function openModal() {
    modal.hidden = false;
    modalPending.hidden = false;
    modalError.hidden = true;
  }
  function closeModal() {
    modal.hidden = true;
    if (pollTimer) clearInterval(pollTimer);
  }

  async function startWalletLogin() {
    openModal();
    statusBadge.textContent = 'Waiting for your wallet…';
    statusBadge.className = 'badge pending';

    let res, data;
    try {
      res = await fetch('/api/session', { method: 'POST' });
      data = await res.json();
    } catch (e) {
      showModalError(`Could not reach the verifier: ${e.message}`);
      return;
    }

    if (!res.ok || !data.qrCodeDataUrl) {
      showModalError(data.detail || data.error || `Session request failed (HTTP ${res.status})`);
      return;
    }

    qrImg.src = data.qrCodeDataUrl;
    sameDeviceLink.href = data.authorizationRequestUri;
    rawUri.value = data.authorizationRequestUri;

    pollTimer = setInterval(() => pollStatus(data.sessionId), 1500);
  }

  async function pollStatus(sessionId) {
    const res = await fetch(`/api/session/${sessionId}`);
    if (!res.ok) return;
    const session = await res.json();

    if (session.status === 'verified') {
      clearInterval(pollTimer);
      showDashboard(session);
    } else if (session.status === 'error') {
      clearInterval(pollTimer);
      showModalError(session.error || 'Unknown error');
    }
  }

  function showModalError(message) {
    modalPending.hidden = true;
    modalError.hidden = false;
    errorOut.textContent = message;
  }

  function showDashboard(session) {
    closeModal();

    const claims = {};
    let format = 'unknown';
    for (const item of session.decoded || []) {
      if (item.disclosedClaims) Object.assign(claims, item.disclosedClaims);
      if (item.format) format = item.format;
    }

    const given = claims.given_name || 'Valued';
    const family = claims.family_name || 'Customer';
    welcomeName.textContent = `Welcome, ${given} ${family}`;
    accountHolder.textContent = `${given} ${family}`;
    accountDob.textContent = claims.birth_date ? `Born ${claims.birth_date}` : '';
    verifiedFormat.textContent = format === 'vc+sd-jwt' ? 'Credential format: SD-JWT VC' : format === 'mso_mdoc' ? 'Credential format: mDoc (ISO 18013-5)' : '';
    claimsOut.textContent = JSON.stringify(session, null, 2);

    loginView.hidden = true;
    dashboardView.hidden = false;
  }

  function logout() {
    dashboardView.hidden = true;
    loginView.hidden = false;
  }

  walletLoginBtn.addEventListener('click', startWalletLogin);
  modalClose.addEventListener('click', closeModal);
  retryBtn.addEventListener('click', startWalletLogin);
  logoutBtn.addEventListener('click', logout);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
})();
