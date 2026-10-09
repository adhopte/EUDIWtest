# Trust anchors

Put the **ANIP IACA** certificate (and any other issuer root you accept) here as
PEM files (`*.pem`, `*.crt` or `*.cer`). They are loaded at start-up.

With `DEMO_MODE=true` the simulated "DEMO ANIP IACA" is added in memory, and the
"Trust this issuer (demo)" button can add a wallet's issuer certificate until the
server restarts. Neither is meant for production.
