"""Baked-in constants for the Teloora Agent.

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

from brand import NAME as _BRAND_NAME


# --------------------------------------------------------------------------- #
# Brand (product name shown in the GUI: window title, header, dialogs, tray,
# shortcut). SINGLE source of truth is now agent/brand.py — change it THERE and
# the whole agent (plus web/config/brand.js, api/config/brand.js and
# app/lib/core/brand.dart) follows.
# NOTE: APP_SECRET below is a STABLE baked key (not a display name) — do NOT
# rebrand it; changing it would break existing installs' credential decryption.
# --------------------------------------------------------------------------- #
BRAND_NAME = _BRAND_NAME
BRAND_NAME_AGENT = f"{BRAND_NAME} Agent"


# --------------------------------------------------------------------------- #
# Server URL (baked + hidden)
# --------------------------------------------------------------------------- #
# PRODUCTION: set your domain here before building the distributable exe; this
# is the ONLY place. e.g. "https://app.yourdomain.com/api/v1".
# LIVE build (current): pointed at the production cloud API.
# For LOCAL TESTING, swap back to the dev machine's LAN IP:
#   LOCAL = "http://192.168.4.10:4500/api/v1"
API_BASE_URL = "http://192.168.29.242:4500/api/v1"


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


# --------------------------------------------------------------------------- #
# Code-signing publisher
# --------------------------------------------------------------------------- #
# The CN on our Authenticode certificate. A signed agent REFUSES to install a
# downloaded update unless that update is signed by this publisher — the one
# check a compromised update server cannot satisfy, because the signing key
# lives on a token/HSM the server has never held. (The SHA-256 in the update
# response proves only that the transfer was intact; the same server would
# publish a matching hash for a hostile binary.)
#
# Substring-matched against the certificate subject, so a routine certificate
# renewal that keeps the organisation name does not break updates in the field.
# Empty disables the check — which is the correct behaviour for an unsigned
# dev build, and the wrong one for anything shipped.
PUBLISHER_CN = "Dukansetu"


# --------------------------------------------------------------------------- #
# The agent window's URL
# --------------------------------------------------------------------------- #
# The desktop app is a shell around a WebView pointed here, so the ENTIRE agent
# interface - sign-in, sync progress, settings, logs - is served and changes on
# deploy. No rebuilt exe, no download for the customer; that is the point.
#
# Baked, like API_BASE_URL, and for the same reason: a customer repointing their
# agent at another server is not a feature. The bridge derives its CORS
# allow-list from this value, so the two can never disagree.
AGENT_UI_URL = "http://192.168.29.242:4600/agent-app"


# --------------------------------------------------------------------------- #
# Update-channel publisher pin
# --------------------------------------------------------------------------- #
# SHA-1 thumbprint of the certificate that signs our releases. When set, the
# self-update gate matches an update's signing certificate against THIS value
# and ignores whether Windows trusts the chain.
#
# Why that distinction matters: a self-signed certificate — the only kind
# available for free — fails every chain check by definition. A gate built on
# chain trust would make the agent reject its own updates, which is how a
# "security feature" turns into an outage. Pinning asks the question that
# actually matters: was this file signed with OUR key?
#
# Leave EMPTY once a publicly-trusted certificate is bought; the gate then falls
# back to chain validation plus PUBLISHER_CN, and nothing else changes.
#
# Re-generating the self-signed certificate produces a NEW thumbprint, and
# agents already in the field still hold the old one — so update this, ship a
# build signed with the new certificate, and only then retire the old key.
PUBLISHER_THUMBPRINT = "962083FA4AD539EF7DB2A0837D1F0338831CE0EE"


# --------------------------------------------------------------------------- #
# Support contact
# --------------------------------------------------------------------------- #
# Shown in the sign-in window's footer. Somebody stuck on that screen cannot get
# into the product to look for help, so the help has to be on the screen that is
# blocking them.
SUPPORT_EMAIL = "support@waytoweb.in"
