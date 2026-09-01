# The fake storage zone's certificate

A throwaway self-signed key pair, committed on purpose. It doesn't guard
anything: only the fake Bunny storage zone in `dev/bunny.ts` ever serves it, and
`dev/sandbox.ts` tells everything that reaches that zone not to check it, with
`NODE_TLS_REJECT_UNAUTHORIZED` and `RCLONE_NO_CHECK_CERTIFICATE`.

It exists because rclone's bunny backend builds an `https://` URL, so the zone
has to speak TLS.
