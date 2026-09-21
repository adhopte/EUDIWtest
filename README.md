# Dummy OpenID4VP Relying Party — Benin ASIN PoC

A minimal OpenID4VP **verifier** (relying party) for demoing credential
presentation against SIGMA's PID Issuer / Wallet. It:

1. Generates an OpenID4VP authorization request (`response_mode=direct_post`)
   and shows it as a QR code.
2. Accepts the wallet's `POST` to `response_uri` with `vp_token`.
3. Structurally decodes an SD-JWT VC (and best-effort, an mDoc CBOR
   `DeviceResponse`) and displays the disclosed claims on a live status page.

> ⚠️ **This is a demo/PoC tool, not a certified verifier.** It does not verify
> issuer signatures, trust chains, revocation status, or key binding. Do not
> point it at real citizen data without adding real cryptographic
> verification first (see "Hardening for real use" below) — this lines up
> with the security dossier / waiver step already required before real data
> enters the Benin environment.

## Run locally

```bash
npm install
cp .env.example .env   # edit BASE_URL once you have a public URL (see below)
npm start
```

Open `http://localhost:3000`.

## Getting a public URL

An OpenID4VP wallet needs to reach your `response_uri` over the public
internet (it's calling your server, not the other way round), so
`localhost` only works if the wallet is emulated on the same machine.

### Option A — quick demo tunnel (ngrok)

Good for a same-day demo; URL changes every time you restart ngrok
(unless you have a reserved domain).

```bash
npm install -g ngrok        # or use the ngrok binary directly
ngrok http 3000
```

Copy the `https://xxxx.ngrok-free.app` URL ngrok prints into `.env` as
`BASE_URL`, restart `npm start`, then use that same URL to open the page.

### Option B — persistent free hosting (Render.com) — recommended for the PoC

1. Push this folder to a Git repo (GitHub/GitLab).
2. On [render.com](https://render.com): **New → Web Service**, connect the repo.
3. Build command: `npm install`  ·  Start command: `npm start`
4. Add environment variables:
   - `CLIENT_ID=dummy-rp.benin-poc` (or whatever value fits your ARF client_id scheme)
   - `BASE_URL=https://<your-service-name>.onrender.com` — Render tells you
     the URL after first deploy; set this var and redeploy once you know it.
5. Deploy. Render gives you a stable `https://*.onrender.com` URL — share
   that with whoever is testing the wallet.

### Option C — Railway / Fly.io

Same idea as Render: `npm install && npm start`, set `BASE_URL` to the
platform-assigned public HTTPS URL, expose port from `PORT` env var
(already read from `process.env.PORT`).

## Adjusting the requested credential

`buildPresentationDefinition()` in `server.js` currently asks for
`given_name`, `family_name`, `birth_date` from a PID-shaped credential
(`vc+sd-jwt` and `mso_mdoc` formats, matching SIGMA's dual-issuance
strategy). Edit the `fields`/`format` block to match:
- the exact `vct` value the SIGMA Issuer uses for the Benin PID, and/or
- the mDoc `doctype` (`eu.europa.ec.eudi.pid.1`) and namespace claim paths.

## Hardening for real use (beyond this PoC)

- Verify the SD-JWT's issuer signature against the issuer's JWKS
  (`.well-known/jwt-vc-issuer` per SD-JWT VC, or the `x5c` header) — the
  current `lib/sdjwt.js` explicitly skips this (`signatureVerified: false`).
- Verify each disclosure actually hashes into the JWT's `_sd` array.
- Verify the Key Binding JWT: `aud` = this RP's `client_id`, `nonce` matches
  the one issued, signature matches the `cnf.jwk` in the SD-JWT.
- For mDoc: verify `IssuerAuth` (COSE_Sign1) against the issuer's DS
  certificate, and `DeviceAuth`/`SessionTranscript` binding per ISO 18013-5
  (this matches the "remote WSCD signing must bind to the reader's live
  ephemeral key via SessionTranscript" constraint for proximity flows —
  this dummy RP does not attempt that).
- Move session state out of memory (Redis/DB) once more than one instance
  or a restart-safe demo is needed.
- Register a real `client_id` per the ARF client identifier scheme you're
  targeting (e.g. `x509_san_dns`, `did:web`) instead of the bare string used
  here.
