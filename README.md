# Konsa Énergie & Télécom — Dummy Utility-Billing Portal (OpenID4VP login)

A fictional utility/telecom billing-company website, used to demo **"Login
with your Digital ID Wallet"** via OpenID4VP against SIGMA's PID Issuer /
Wallet (or the EUDI reference wallet, for interop testing). It:

1. Shows a billing-company login page (`/`) with a "Sign in with your
   Digital ID Wallet" button. Clicking it opens a modal with a QR code
   (cross-device) and an `openid4vp://` deep link (same-device).
2. Generates an OpenID4VP authorization request (`response_mode=direct_post`,
   `client_id_scheme=redirect_uri`, sent **plain** — no JAR/JWT — with only
   `presentation_definition` moved out via `presentation_definition_uri` to
   keep the QR short and scannable).
3. Accepts the wallet's `POST` to `response_uri` with `vp_token`.
4. Structurally decodes an SD-JWT VC (and best-effort, an mDoc CBOR
   `DeviceResponse`) and logs the user into a mock account dashboard
   showing their disclosed name / DOB and a fake bill balance.

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

## Adjusting the requested credential / branding

`buildPresentationDefinition()` in `server.js` currently asks for
`given_name`, `family_name`, `birth_date` from a PID-shaped credential
(`vc+sd-jwt` and `mso_mdoc` formats, matching SIGMA's dual-issuance
strategy). Set these env vars to match the exact identifiers your issuer
and wallet actually use — they can differ between the EUDI reference
ecosystem and a Benin-specific wallet build:

- `PID_SDJWT_VCT` — the SD-JWT VC's `vct` value (default `urn:eudi:pid:1`)
- `PID_MDOC_DOCTYPE` — the mDoc `doctype` / namespace (default `eu.europa.ec.eudi.pid.1`)
- `BILLER_NAME` — display name shown in the header, page title, and the
  presentation request's `purpose` text (default `Konsa Énergie & Télécom`)

## Notes specific to the EUDI reference wallet (eudi-app-android-wallet-ui)

If you're testing against the official EU reference wallet app rather than
your own build, two things matter beyond just QR size:

- **`client_id_scheme=redirect_uri` must be sent plain, never as a signed
  request object (JAR).** The wallet's OpenID4VP library
  (`eudi-lib-jvm-openid4vp-kt`) explicitly rejects a JAR/JWT request for
  this scheme — this app keeps the top-level request by value and only
  moves the bulky `presentation_definition` out via
  `presentation_definition_uri` (mirroring how EU's own reference verifier,
  `eudi-srv-web-verifier-endpoint-23220-4-kt`, keeps its QR codes short).
- **The stock, unmodified wallet APK may only trust `pre-registered`
  verifiers baked into its build config**, i.e. the official demo verifier
  at verifier.eudiw.dev. If a plain `redirect_uri`/`x509_san_dns` request
  from this dummy RP still isn't recognized even after the QR scans fine,
  that's the likely cause — the fixes are: (a) confirm with whoever built
  your test APK whether `redirect_uri`/`x509_san_dns` schemes are enabled
  alongside `pre-registered`, or (b) for the most faithful interop test,
  run EU's own reference verifier
  (github.com/eu-digital-identity-wallet/eudi-srv-web-verifier-endpoint-23220-4-kt)
  instead of this dummy RP — it's built and continuously tested against
  exactly this wallet.
- The wallet (per its README) speaks **OpenID4VP draft 24** and supports
  both **DIF Presentation Exchange v2.0** (`presentation_definition`, what
  this app uses) and **DCQL** — if PE-based requests get silently ignored
  on a given wallet build, DCQL is the other format worth trying.



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
