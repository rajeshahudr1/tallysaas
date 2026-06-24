"""Baked-in constants for the Tally Cloud Sync Agent.

This module is the SINGLE source of truth for two values that must NEVER be
read from (or written to) ``config.ini``:

* :data:`API_BASE_URL` - the cloud server base URL. It is compiled INTO the
  exe so the operator never sees it and cannot point the agent at a different
  server by editing config.ini.
* :data:`APP_SECRET` - a baked secret mixed with the machine fingerprint to
  derive the local credential-encryption key (see :mod:`config`).

Both are intentionally hard-coded here. This is OBFUSCATION, not unbreakable
security: a determined reverse-engineer can extract either value from the
binary. The requirement is only that nothing sensitive sits in PLAINTEXT at
rest in config.ini, and that copying config.ini to another PC yields
undecryptable credentials (the key is machine-bound).

Dependencies: Python stdlib only (this module imports nothing).
"""

from __future__ import annotations


# --------------------------------------------------------------------------- #
# Server URL (baked + hidden)
# --------------------------------------------------------------------------- #
# PRODUCTION: set your domain here before building the distributable exe; this
# is the ONLY place. e.g. "https://app.yourdomain.com/api/v1".
# The value below is the PRODUCTION server. It is never written to config.ini.
API_BASE_URL = "https://tallysaasapi.dukansetu.in/api/v1"


# --------------------------------------------------------------------------- #
# Credential-encryption secret (baked)
# --------------------------------------------------------------------------- #
# Mixed with this machine's fingerprint to derive a 32-byte key that encrypts
# license_key / agent_token in config.ini. Changing this value AFTER a release
# would make existing installs unable to decrypt their saved credentials (they
# would simply re-activate), so treat it as stable once shipped.
#
# NOTE: this is obfuscation, not a secret store - it ships inside the exe. The
# point is only "no plaintext key/URL at rest" + "creds are machine-bound".
APP_SECRET = "TallyCloudSync::v1::cred-key::do-not-change-after-release"
