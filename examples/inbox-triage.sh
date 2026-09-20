#!/usr/bin/env bash
# Label each line of a file of message subjects. Usage: inbox-triage.sh subjects.txt
set -euo pipefail
jev triage \
  -o billing="invoices, payments, refunds" \
  -o meeting="scheduling a call or meeting" \
  -o bug="something is broken or crashing" \
  -o question="a customer asks how to do something" \
  -o feature="a request for something new" \
  -o junk="unsolicited promotion" \
  --file "${1:?usage: inbox-triage.sh subjects.txt}"
