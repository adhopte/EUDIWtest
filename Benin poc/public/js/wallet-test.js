'use strict';

(function () {
  const root = document.getElementById('wallet-test');
  if (!root) return;
  const rp = root.dataset.rp;
  const step = (name) => root.dataset['step' + name.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')];

  // Tap a QR code to show it full screen (dense by-value requests scan far better large)
  document.addEventListener('click', function (e) {
    const img = e.target.closest('.qr img, .wt-qr img');
    const open = document.querySelector('.qr-zoom');
    if (open) { open.remove(); return; }
    if (!img) return;
    const overlay = document.createElement('div');
    overlay.className = 'qr-zoom';
    overlay.innerHTML = '<img alt="QR code" src="' + img.src + '">';
    document.body.appendChild(overlay);
  });

  root.querySelectorAll('.wt-card').forEach(async function (card) {
    const variant = card.dataset.variant;
    const status = card.querySelector('.wt-status');
    const res = await fetch('/api/' + rp + '/transactions?variant=' + encodeURIComponent(variant), { method: 'POST', credentials: 'same-origin' });
    const tx = await res.json();

    const img = new Image();
    img.src = tx.qr;
    img.alt = 'QR code ' + variant;
    const box = card.querySelector('.wt-qr');
    box.innerHTML = '';
    box.appendChild(img);
    card.querySelector('textarea').value = tx.uri;

    const timer = setInterval(async function () {
      let body;
      try {
        body = await (await fetch('/api/tx/' + encodeURIComponent(tx.id), { credentials: 'same-origin' })).json();
      } catch (e) {
        return;
      }
      card.dataset.state = body.status === 'pending' ? (body.walletStep || 'waiting') : body.status;
      if (body.status === 'pending') {
        if (body.walletStep) status.textContent = step(body.walletStep);
        return;
      }
      clearInterval(timer);
      status.textContent = step(body.status === 'verified' || body.status === 'rejected' ? body.status : 'expired');
      card.querySelector('.wt-reasons').innerHTML = (body.reasons || []).map(function (r) {
        return '<li><code>' + r.replace(/[<>&]/g, '') + '</code></li>';
      }).join('');
      if (body.status === 'verified') {
        const result = card.querySelector('.wt-result');
        const env = Object.entries(tx.env);
        result.querySelector('p').textContent = env.length ? root.dataset.settings : root.dataset.settingsNone;
        result.querySelector('.wt-env').textContent = env.map(function (e) { return e[0] + '=' + e[1]; }).join('\n');
        result.querySelector('.wt-env').hidden = env.length === 0;
        result.querySelector('.wt-continue').href = '/' + rp + '/callback?tx=' + encodeURIComponent(tx.id);
        result.classList.remove('hidden');
      }
    }, 2000);
  });
})();
