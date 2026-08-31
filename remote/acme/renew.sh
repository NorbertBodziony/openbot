#!/bin/sh
set -eu

lego_args="--path /acme --email ${ACME_EMAIL} --accept-tos --dns cloudflare --domains ${SIGNAL_DOMAIN} --domains ${TURN_DOMAIN}"
make_certificates_readable() {
  chgrp "${ACME_CERTIFICATE_GROUP_ID}" /acme/certificates
  chgrp "${ACME_CERTIFICATE_GROUP_ID}" "/acme/certificates/${SIGNAL_DOMAIN}.crt" "/acme/certificates/${SIGNAL_DOMAIN}.key"
  chmod 0550 /acme/certificates
  chmod 0440 "/acme/certificates/${SIGNAL_DOMAIN}.crt" "/acme/certificates/${SIGNAL_DOMAIN}.key"
}

if [ ! -f "/acme/certificates/${SIGNAL_DOMAIN}.crt" ]; then
  # shellcheck disable=SC2086
  /lego run $lego_args
fi
make_certificates_readable
while true; do
  # shellcheck disable=SC2086
  /lego run $lego_args --renew-days 30
  make_certificates_readable
  sleep 43200
done
