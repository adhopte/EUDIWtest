# Trust anchors

Put the PEM certificates of trusted issuers here (the ANIP IACA root for the
PID mdoc, and the ANIP issuer CA / certificate used in the `x5c` header of the
Birth Certificate SD-JWT). Every `*.pem`, `*.crt` or `*.cer` file is loaded at
start-up; a file may contain several certificates.

PEM files in this folder are git-ignored on purpose — deploy them through your
hosting platform's secret files / config instead of committing them.
