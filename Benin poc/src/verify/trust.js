'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

/**
 * Trust anchors for issuer certificates (PID mdoc IACA / SD-JWT issuer
 * certificates). Drop PEM files into TRUST_DIR; each file may hold several
 * certificates. The demo issuer registers itself at runtime in DEMO_MODE.
 */
const anchors = [];

function loadTrustDir(dir = config.TRUST_DIR) {
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) {
    if (!/\.(pem|crt|cer)$/i.test(file)) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    for (const pem of blocks) {
      try {
        addAnchor(new crypto.X509Certificate(pem), file);
      } catch (err) {
        console.warn(`Ignoring invalid certificate in ${file}: ${err.message}`);
      }
    }
  }
}

function addAnchor(cert, label) {
  if (anchors.some((a) => a.cert.fingerprint256 === cert.fingerprint256)) return;
  anchors.push({ cert, label });
}

function isTimeValid(cert, at = new Date()) {
  return new Date(cert.validFrom) <= at && at <= new Date(cert.validTo);
}

/**
 * Validates a leaf-first certificate chain against the configured anchors.
 * Returns { trusted, anchor, subject, reason }.
 */
function evaluateChain(chain) {
  if (!chain || chain.length === 0) {
    return { trusted: false, reason: 'no_certificate' };
  }
  const leaf = chain[0];
  const result = { trusted: false, subject: leaf.subject.replace(/\n/g, ', ') };

  for (const cert of chain) {
    if (!isTimeValid(cert)) return { ...result, reason: 'certificate_expired' };
  }
  for (let i = 0; i < chain.length - 1; i += 1) {
    if (!chain[i].checkIssued(chain[i + 1]) || !chain[i].verify(chain[i + 1].publicKey)) {
      return { ...result, reason: 'broken_chain' };
    }
  }
  if (anchors.length === 0) return { ...result, reason: 'no_trust_anchors_configured' };

  const top = chain[chain.length - 1];
  for (const anchor of anchors) {
    const same = anchor.cert.fingerprint256 === top.fingerprint256;
    const issuedBy = !same && top.checkIssued(anchor.cert) && top.verify(anchor.cert.publicKey);
    if (same || issuedBy) {
      if (!isTimeValid(anchor.cert)) return { ...result, reason: 'anchor_expired' };
      return { ...result, trusted: true, anchor: anchor.label };
    }
  }
  return { ...result, reason: 'untrusted_issuer' };
}

loadTrustDir();

module.exports = { addAnchor, evaluateChain, loadTrustDir, anchors };
