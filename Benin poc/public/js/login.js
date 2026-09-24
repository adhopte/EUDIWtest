'use strict';

(function () {
  const root = document.getElementById('login');
  if (!root) return;

  const rp = root.dataset.rp;
  const msg = (key) => root.dataset['msg' + key.charAt(0).toUpperCase() + key.slice(1)];
  const qr = document.getElementById('qr');
  const status = document.getElementById('status');
  const sameDevice = document.getElementById('same-device');
  const retry = document.getElementById('retry');
  const simulate = document.getElementById('simulate');

  let tx = null;
  let timer = null;

  function setStatus(text, state) {
    status.textContent = text;
    qr.classList.remove('done', 'failed');
    if (state === 'done') qr.innerHTML = '✓';
    if (state === 'failed') qr.innerHTML = '✕';
    if (state) qr.classList.add(state);
  }

  function finish(result) {
    clearInterval(timer);
    if (result.status === 'verified') {
      setStatus(msg('success'), 'done');
      window.location.href = '/' + rp + '/callback?tx=' + encodeURIComponent(tx.id);
      return;
    }
    if (result.status === 'rejected') {
      window.location.href = '/' + rp + '/callback?tx=' + encodeURIComponent(tx.id);
      return;
    }
    setStatus(msg('expired'), 'failed');
    retry.classList.remove('hidden');
    if (simulate) simulate.disabled = true;
  }

  async function poll() {
    if (!tx) return;
    try {
      const res = await fetch('/api/tx/' + encodeURIComponent(tx.id), { credentials: 'same-origin' });
      const body = await res.json();
      if (body.status !== 'pending') finish(body);
      else if (body.walletStep === 'request_fetched') setStatus(msg('connected'));
    } catch (e) {
      /* transient network error: keep polling */
    }
  }

  async function start() {
    clearInterval(timer);
    retry.classList.add('hidden');
    if (simulate) simulate.disabled = false;
    qr.innerHTML = '<div class="spinner" aria-hidden="true"></div>';
    setStatus(msg('waiting'));

    const res = await fetch('/api/' + rp + '/transactions', { method: 'POST', credentials: 'same-origin' });
    tx = await res.json();

    const img = new Image();
    img.src = tx.qr;
    img.alt = 'QR code';
    qr.innerHTML = '';
    qr.appendChild(img);
    sameDevice.href = tx.uri;
    document.getElementById('wallet-uri').value = tx.uri;
    timer = setInterval(poll, 2000);
  }

  retry.addEventListener('click', start);
  document.getElementById('copy-uri').addEventListener('click', function (e) {
    const field = document.getElementById('wallet-uri');
    field.select();
    (navigator.clipboard ? navigator.clipboard.writeText(field.value) : Promise.reject())
      .catch(function () { document.execCommand('copy'); })
      .then(function () { e.target.textContent = msg('copied'); });
  });
  if (simulate) {
    simulate.addEventListener('click', async function () {
      if (!tx) return;
      simulate.disabled = true;
      setStatus(msg('verifying'));
      const res = await fetch('/api/tx/' + encodeURIComponent(tx.id) + '/simulate', { method: 'POST', credentials: 'same-origin' });
      finish(await res.json());
    });
  }

  start().catch(function () {
    setStatus(msg('expired'), 'failed');
    retry.classList.remove('hidden');
  });
})();
