(function () {
  const startBtn = document.getElementById('start-btn');
  const resetBtn = document.getElementById('reset-btn');
  const startPanel = document.getElementById('start-panel');
  const qrPanel = document.getElementById('qr-panel');
  const resultPanel = document.getElementById('result-panel');
  const qrImg = document.getElementById('qr-img');
  const rawUri = document.getElementById('raw-uri');
  const statusBadge = document.getElementById('status-badge');
  const resultBadge = document.getElementById('result-badge');
  const claimsOut = document.getElementById('claims-out');
  const debugOut = document.getElementById('debug-out');

  let pollTimer = null;

  async function startSession() {
    startPanel.hidden = true;
    resultPanel.hidden = true;
    qrPanel.hidden = false;
    statusBadge.textContent = 'Waiting for wallet…';
    statusBadge.className = 'badge pending';

    const res = await fetch('/api/session', { method: 'POST' });
    const data = await res.json();

    qrImg.src = data.qrCodeDataUrl;
    rawUri.value = data.authorizationRequestUri;

    pollTimer = setInterval(() => pollStatus(data.sessionId), 1500);
  }

  async function pollStatus(sessionId) {
    const res = await fetch(`/api/session/${sessionId}`);
    if (!res.ok) return;
    const session = await res.json();

    if (session.status === 'verified') {
      clearInterval(pollTimer);
      showResult(session, true);
    } else if (session.status === 'error') {
      clearInterval(pollTimer);
      showResult(session, false);
    }
  }

  function showResult(session, ok) {
    qrPanel.hidden = true;
    resultPanel.hidden = false;
    resultBadge.textContent = ok ? 'Verified (structurally) ✅' : 'Error ❌';
    resultBadge.className = 'badge ' + (ok ? 'ok' : 'err');

    if (ok) {
      const claims = {};
      for (const item of session.decoded || []) {
        if (item.disclosedClaims) Object.assign(claims, item.disclosedClaims);
      }
      claimsOut.textContent = JSON.stringify(claims, null, 2);
    } else {
      claimsOut.textContent = session.error || 'Unknown error';
    }
    debugOut.textContent = JSON.stringify(session, null, 2);
  }

  startBtn.addEventListener('click', startSession);
  resetBtn.addEventListener('click', () => {
    resultPanel.hidden = true;
    startPanel.hidden = false;
  });
})();
