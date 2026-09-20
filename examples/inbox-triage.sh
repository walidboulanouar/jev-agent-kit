#!/usr/bin/env bash
# Label each line of a file of message subjects. Usage: inbox-triage.sh subjects.txt
set -euo pipefail
jev triage \
  -o billing="invoices, payments, refunds" \
  -o meeting="scheduling a call or meeting" \
  -o support="a customer needs help" \
  -o junk="unsolicited promotion" \
  --file "${1:?usage: inbox-triage.sh subjects.txt}"
