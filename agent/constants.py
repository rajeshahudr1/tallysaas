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
# Both the API base and the agent-UI page are baked in, and they must ALWAYS
# describe the same tier — a live exe talking to a local UI (or the reverse) is
# a broken build that still starts, so the two are defined as ONE pair per
# target and selected together. They were separate constants once, and exactly
# that mismatch shipped: an exe with the live API and a LAN dev UI URL.
#
# Do NOT hand-edit BUILD_TARGET. Choose it at build time:
#     python build_exe.py --gui --local     (dev machine on the LAN)
#     python build_exe.py --gui --live      (production)
# build_exe.py stamps the line below, prints the pair it baked, and the exe
# shows the same pair in its About/log line.
#
# LIVE is HTTPS on purpose: the agent carries the licence key, the agent token
# and the customer's whole Tally dataset over this URL, and the cloud host's
# port 4500 is firewalled off anyway — the TLS vhost is the only way in.
BUILD_TARGET = "live"
_TARGETS = {
    "live": {
        "api": "https://tallysaasapi.teloora.com/api/v1",
        "ui":  "https://teloora.com/agent-app",
    },
    "local": {
        "api": "http://192.168.4.19:4500/api/v1",
        "ui":  "http://192.168.4.19:4600/agent-app",
    },
}

if BUILD_TARGET not in _TARGETS:
    raise RuntimeError(
        f"constants.BUILD_TARGET is {BUILD_TARGET!r}; expected one of {sorted(_TARGETS)}."
    )

API_BASE_URL = _TARGETS[BUILD_TARGET]["api"]


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
#
# This is the WEB tier, never the api host, and it comes from the same
# BUILD_TARGET pair as API_BASE_URL so the two always describe one environment.
AGENT_UI_URL = _TARGETS[BUILD_TARGET]["ui"]


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
