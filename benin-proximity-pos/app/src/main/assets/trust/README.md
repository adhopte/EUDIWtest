# Bundled trust anchors

Put the ANIP IACA certificate(s) for the PID issuer here as `*.pem` before
building the APK (e.g. `anip-iaca.pem`). Every certificate in every `.pem` /
`.crt` file is loaded at start-up and used offline to decide whether a
presented PID was issued by a trusted issuer.

Anchors can also be imported on the device (Settings → Trust anchors), or, for
a demo only, added from a presented credential ("Trust this issuer").
