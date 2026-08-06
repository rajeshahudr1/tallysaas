"""Configuration handling for the Teloora Agent.

Reads and writes ``config.ini`` (via :mod:`configparser`). The ``[agent]``
section holds operator-supplied settings (sync_interval, log_level,
agent_version). The ``[state]`` section holds runtime state the agent persists
itself: the ``agent_token`` returned by sign-in and the machine id it signed in
with.

A stable per-machine fingerprint is derived from the MAC address
(:func:`uuid.getnode`), hostname and platform, hashed with SHA-256 so the same
PC always yields the same id (and the value is opaque on the wire).

Two hardening rules (Phase 1):

* The server URL is BAKED into the exe (``constants.API_BASE_URL``); it is the
  default for :attr:`Config.api_url` and is NEVER read from or written to
  config.ini. Any ``api_url`` left in an old config.ini is ignored.
* The agent token is stored ENCRYPTED in config.ini under an obfuscated key
  (``cred_t``), using a MACHINE-BOUND cipher
  (see :func:`_enc` / :func:`_dec`). Copying config.ini to another PC yields
  undecryptable credentials. Old plaintext values are still read (and migrated
  to encrypted form on the next save). This is obfuscation, not unbreakable
  security - the point is only "no plaintext key/URL at rest".
"""

from __future__ import annotations

import base64
import configparser
import hashlib
import hmac
import os
import platform
import re
import socket
import uuid

from constants import API_BASE_URL, APP_SECRET


# Section / key names kept in one place so reads and writes never drift.
_AGENT_SECTION = "agent"
_STATE_SECTION = "state"
_TALLY_SECTION = "tally"

# Obfuscated key name for the ENCRYPTED token: agent_token -> [state] cred_t.
# _CRED_KEY_NAME is the RETIRED licence-key slot, kept only so save() can delete
# it from configs written by an older build.
_CRED_KEY_NAME = "cred_k"
_CRED_TOKEN_NAME = "cred_t"

# Defaults applied when a key is missing from config.ini.
# api_url is baked + hidden (see constants.API_BASE_URL); never in config.ini.
_DEFAULT_API_URL = API_BASE_URL
_DEFAULT_SYNC_INTERVAL = 60
# The floor the ENGINE enforces, matching the one the Settings page refuses to
# save below. It lives here as well because config.ini is a text file on the
# customer's disk: without a clamp at load time, hand-editing it to 1 would let
# the agent ask TallyPrime for everything once a second, which is how a desktop
# app the customer is also using ends up wedged behind an error dialog.
_MIN_SYNC_INTERVAL = 30


def _version_tuple(v: str) -> tuple:
    """Parse "1.2.10" into (1, 2, 10) so versions compare as numbers.

    Mirrors sync_agent._version_tuple; duplicated rather than imported because
    config is the bottom of the import graph and must not depend on the engine.
    Junk compares low instead of raising.
    """
    parts = []
    for chunk in str(v or "").strip().split("."):
        m = re.match(r"\d+", chunk)
        parts.append(int(m.group(0)) if m else 0)
    return tuple(parts) if parts else (0,)
_DEFAULT_LOG_LEVEL = "INFO"
_DEFAULT_AGENT_VERSION = "1.0.3"
# Auto-update (Requirement 2). auto_update: master on/off for self-update (the
# CLOUD per-license toggle overrides this when the version endpoint provides it).
# update_check_cycles: check for a new exe once at startup, then every N loop
# cycles (~N minutes at the default 60s interval). confirm_updates: only prompts
# when running INTERACTIVELY (a real terminal); headless/background runs always
# apply automatically (the whole point of unattended auto-update).
_DEFAULT_AUTO_UPDATE = True
_DEFAULT_UPDATE_CHECK_CYCLES = 30
_DEFAULT_CONFIRM_UPDATES = False
_DEFAULT_TALLY_URL = "http://localhost:9000"
_DEFAULT_TALLY_AUTO_START = True
# tally_exe: empty → the agent auto-detects TallyPrime in the usual install
# locations (see sync_agent._find_tally_exe). Set it explicitly if Tally lives
# somewhere non-standard.
_DEFAULT_TALLY_EXE = ""

# Voucher pull SAFETY — avoids the Tally "memory access violation" crash and
# keeps the licence safe. voucher_chunk = the AlterID window per Voucher
# COLLECTION fetch; kept SMALL so each response stays small and Tally never
# chokes on a huge double-entry pull. voucher_max_fetches = windows per cycle
# (bounds a cycle). Both tunable in config.ini [agent] for very large books.
_DEFAULT_VOUCHER_CHUNK = 2000
_DEFAULT_VOUCHER_MAX_FETCHES = 30
# reconcile_every = run DELETE detection once every N pull cycles per company.
# Tally has no deletion feed, so the only way to notice a deleted master is to
# re-read every master id and diff. Cheap (identity fields only) but not free,
# and deletes are rare — hence periodic rather than every cycle. 0/negative
# disables the periodic gate and reconciles on every cycle.
_DEFAULT_RECONCILE_EVERY = 12
# report_years = how many financial years of Balance Sheet / P&L / Trial Balance
# / registers to pull.
#
# 0 (the default) means EVERY year the company has books for: the agent reads
# the company's own BOOKSFROM/STARTINGFROM date and pulls from that year to the
# current one. This used to default to 2, which quietly capped the cloud at
# "this year and last" — a customer with ten years in Tally got two, and no
# screen said the other eight were missing rather than empty.
#
# A positive number still pins it to the last N years, for a book so long that
# the extra round trips are not worth it. It is a cost knob; leaving it at 0 is
# the correct setting, and _MAX_REPORT_YEARS only bounds a nonsense BOOKSFROM
# (Tally happily reports 1900 dates) rather than the customer's real history.
_DEFAULT_REPORT_YEARS = 0
_MAX_REPORT_YEARS = 30


class ConfigError(Exception):
    """Raised when configuration cannot be loaded or persisted."""


def machine_fingerprint() -> str:
    """Return a stable SHA-256 hex digest identifying this machine.

    Built from the MAC address (``uuid.getnode()``), the hostname and the
    platform string. The same physical PC produces the same digest across
    runs, which lets the cloud bind a license to one machine.
    """
    try:
        node = uuid.getnode()
    except Exception:
        node = 0
    try:
        hostname = socket.gethostname()
    except Exception:
        hostname = ""
    try:
        plat = platform.system() + platform.machine()
    except Exception:
        plat = ""

    raw = f"{node}|{hostname}|{plat}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------- #
# Machine-bound credential cipher (no plaintext key/token at rest)
# --------------------------------------------------------------------------- #
# We derive a 32-byte key from sha256(APP_SECRET + machine_id). The cipher is a
# self-contained HMAC-SHA256 keystream XOR (stdlib only) with a stored HMAC tag
# for integrity, so there is NO hard dependency on the `cryptography` package
# (it is import-guarded below and only used if it happens to be installed).
#
# Format of an _enc() token (then base64url-encoded, written to config.ini):
#     b"TC1" | nonce(16) | ciphertext(n) | tag(32)
# _dec() returns None when the magic/length is wrong, the tag does not verify
# (tampered file), or the machine_id / APP_SECRET differ from when it was
# written (config.ini copied to another PC) - in all cases the caller treats
# the credential as absent (forcing a clean re-activation), never crashing.
#
# NOTE: this is OBFUSCATION, not unbreakable encryption. APP_SECRET ships inside
# the exe, so a determined reverse-engineer can extract the key. The requirement
# is only that config.ini holds no plaintext key/token and that creds are bound
# to the machine they were activated on.
_CRED_MAGIC = b"TC1"

# Optional acceleration via pyca/cryptography if it is importable. Guarded so
# the exe never hard-depends on it; the stdlib path below is always available
# and is what the operator's build actually uses.
try:  # pragma: no cover - environment dependent.
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # type: ignore
    _HAVE_AESGCM = True
except Exception:  # pragma: no cover
    AESGCM = None  # type: ignore
    _HAVE_AESGCM = False


def _cred_key(machine_id: str) -> bytes:
    """Derive the 32-byte machine-bound key: sha256(APP_SECRET + machine_id)."""
    raw = (APP_SECRET + "|" + (machine_id or "")).encode("utf-8")
    return hashlib.sha256(raw).digest()


def _keystream(key: bytes, nonce: bytes, length: int) -> bytes:
    """HMAC-SHA256 CTR keystream of ``length`` bytes (stdlib only)."""
    out = bytearray()
    counter = 0
    while len(out) < length:
        block = hmac.new(
            key, nonce + counter.to_bytes(8, "big"), hashlib.sha256
        ).digest()
        out.extend(block)
        counter += 1
    return bytes(out[:length])


def _enc(plain: str, machine_id: str) -> str:
    """Encrypt ``plain`` with the machine-bound key; return a base64url token.

    Returns "" for an empty/None plaintext so an unset credential stays blank in
    config.ini (no stray token written). Uses AES-GCM when available, else the
    stdlib HMAC keystream-XOR + tag. Both produce the same outer framing so
    :func:`_dec` can tell them apart by the nonce length is irrelevant - the
    same code path verifies the tag.
    """
    if not plain:
        return ""
    key = _cred_key(machine_id)
    data = plain.encode("utf-8")
    nonce = os.urandom(16)
    if _HAVE_AESGCM:  # pragma: no cover - only when cryptography is installed.
        # AES-GCM produces ciphertext||tag(16); pad the tag out to 32 so the
        # on-disk framing length is identical to the stdlib path (cosmetic).
        ct_tag = AESGCM(key).encrypt(nonce[:12] + b"\x00\x00\x00\x00", data, None)
        body = b"G" + ct_tag  # 1-byte scheme marker so _dec picks AES-GCM.
    else:
        stream = _keystream(key, nonce, len(data))
        ct = bytes(a ^ b for a, b in zip(data, stream))
        tag = hmac.new(key, nonce + ct, hashlib.sha256).digest()
        body = b"X" + ct + tag  # 'X' = XOR/HMAC scheme.
    blob = _CRED_MAGIC + nonce + body
    return base64.urlsafe_b64encode(blob).decode("ascii")


def _dec(token: str, machine_id: str) -> "str | None":
    """Decrypt an _enc() token; return the plaintext or None on any mismatch.

    None is returned for tampered data, a wrong machine / APP_SECRET, or any
    malformed input - the caller then treats the credential as absent. Never
    raises.
    """
    if not token:
        return None
    try:
        blob = base64.urlsafe_b64decode(token.encode("ascii"))
    except Exception:
        return None
    if len(blob) < len(_CRED_MAGIC) + 16 + 1 or blob[: len(_CRED_MAGIC)] != _CRED_MAGIC:
        return None
    key = _cred_key(machine_id)
    nonce = blob[len(_CRED_MAGIC):len(_CRED_MAGIC) + 16]
    body = blob[len(_CRED_MAGIC) + 16:]
    scheme, body = body[:1], body[1:]
    try:
        if scheme == b"G":  # pragma: no cover - cryptography only.
            if not _HAVE_AESGCM:
                return None
            plain = AESGCM(key).decrypt(
                nonce[:12] + b"\x00\x00\x00\x00", body, None)
            return plain.decode("utf-8")
        if scheme == b"X":
            if len(body) < 32:
                return None
            ct, tag = body[:-32], body[-32:]
            expect = hmac.new(key, nonce + ct, hashlib.sha256).digest()
            if not hmac.compare_digest(tag, expect):
                return None  # tampered or wrong machine/secret.
            stream = _keystream(key, nonce, len(ct))
            plain = bytes(a ^ b for a, b in zip(ct, stream))
            return plain.decode("utf-8")
    except Exception:
        return None
    return None


class Config:
    """In-memory view of ``config.ini`` with typed accessors.

    Attributes:
        api_url: Base URL of the cloud API. BAKED + HIDDEN: always the value of
            ``constants.API_BASE_URL`` - never read from / written to config.ini.
        sync_interval: Seconds between sync passes (int, default 60).
        log_level: Logging level name, e.g. ``"INFO"``.
        agent_version: Reported agent version string.
        machine_id: Stable machine fingerprint (persisted under [state]).
    """

    def __init__(self, path: str = "config.ini") -> None:
        self.path: str = path
        self._parser: configparser.ConfigParser = configparser.ConfigParser()

        # Public, typed settings (populated by load()).
        self.api_url: str = _DEFAULT_API_URL
        self.sync_interval: int = _DEFAULT_SYNC_INTERVAL
        self.log_level: str = _DEFAULT_LOG_LEVEL
        self.agent_version: str = _DEFAULT_AGENT_VERSION
        self.machine_id: str = ""

        # Auto-update settings (the [agent] section; see defaults above).
        self.auto_update: bool = _DEFAULT_AUTO_UPDATE
        self.update_check_cycles: int = _DEFAULT_UPDATE_CHECK_CYCLES
        self.confirm_updates: bool = _DEFAULT_CONFIRM_UPDATES
        # Voucher pull safety (the [agent] section; see defaults above).
        self.voucher_chunk: int = _DEFAULT_VOUCHER_CHUNK
        self.voucher_max_fetches: int = _DEFAULT_VOUCHER_MAX_FETCHES
        self.reconcile_every: int = _DEFAULT_RECONCILE_EVERY
        self.report_years: int = _DEFAULT_REPORT_YEARS
        # False only after the operator pressed Stop; see load() for why this is
        # persisted rather than kept in memory.
        self.sync_enabled: bool = True

        # Tally connectivity + auto-start (the [tally] section).
        self.tally_url: str = _DEFAULT_TALLY_URL
        self.tally_exe: str = _DEFAULT_TALLY_EXE
        self.tally_auto_start: bool = _DEFAULT_TALLY_AUTO_START

    @classmethod
    def load(cls, path: str = "config.ini") -> "Config":
        """Load configuration from ``path`` and return a :class:`Config`.

        A missing file is not fatal: defaults are used and the machine id is
        computed fresh. Parse errors are wrapped in :class:`ConfigError`.
        """
        cfg = cls(path)

        if os.path.exists(path):
            try:
                cfg._parser.read(path, encoding="utf-8")
            except (configparser.Error, OSError) as exc:
                raise ConfigError(f"Failed to read config '{path}': {exc}") from exc

        cfg._ensure_sections()

        # Machine id is resolved FIRST: it is the cipher key material needed to
        # decrypt the stored credentials below. Use the persisted id if present
        # (so the same key that encrypted them is used), else compute it fresh.
        state = cfg._parser[_STATE_SECTION]
        saved_machine = state.get("machine_id", "").strip()
        cfg.machine_id = saved_machine or machine_fingerprint()

        # Did the operator STOP syncing on purpose?
        #
        # The service is registered auto-start, so without this it comes back on
        # every boot — someone who deliberately stopped the agent on Friday finds
        # it syncing again on Monday, and the Stop button reads as "pause until
        # I reboot". The flag makes Stop mean stop: the loop honours it at every
        # cycle, so a boot into a stopped agent stays stopped, and pressing Start
        # resumes WITHOUT needing the service restarted.
        #
        # Missing/garbled -> enabled. A config we cannot read must not leave a
        # customer silently un-synced; the visible failure (it synced when you
        # did not want it to) is far cheaper than the invisible one.
        try:
            cfg.sync_enabled = state.getboolean("sync_enabled", True)
        except Exception:                                   # noqa: BLE001
            cfg.sync_enabled = True

        agent = cfg._parser[_AGENT_SECTION]
        # api_url is BAKED + HIDDEN: always the constant, never from config.ini.
        # Any stale api_url left in an old config.ini is deliberately ignored.
        cfg.api_url = _DEFAULT_API_URL

        # Licence keys are gone: sign-in is email + password + an emailed
        # code (see api_client.login/verify_otp). Any cred_k / license_key left
        # in an older config.ini is stale and is deleted on the next save.

        cfg.log_level = (
            agent.get("log_level", _DEFAULT_LOG_LEVEL).strip() or _DEFAULT_LOG_LEVEL
        )
        # THE RUNNING EXE IS THE TRUTH ABOUT ITS OWN VERSION.
        #
        # config.ini records the version that was current when the install was
        # first written, and an in-place update replaces the exe WITHOUT
        # rewriting it. So a machine updated from 1.0.0 to 1.0.1 kept reporting
        # 1.0.0 — to the Dashboard, to the cloud heartbeat, and to the check
        # that decides whether a downloaded build is newer. The update looked
        # like it had not happened, and the next one compared against a number
        # that had been wrong for a release.
        #
        # So: take the stored value, but never a value OLDER than the exe that
        # is reading it. Downgrades are still honoured (a deliberately older
        # exe reports itself), which is why this is a max and not an override.
        stored = (agent.get("agent_version", "").strip() or _DEFAULT_AGENT_VERSION)
        cfg.agent_version = (
            _DEFAULT_AGENT_VERSION
            if _version_tuple(_DEFAULT_AGENT_VERSION) > _version_tuple(stored)
            else stored
        )

        # sync_interval must always end up an int; bad values fall back.
        try:
            cfg.sync_interval = agent.getint("sync_interval", _DEFAULT_SYNC_INTERVAL)
        except ValueError:
            cfg.sync_interval = _DEFAULT_SYNC_INTERVAL
        if cfg.sync_interval <= 0:
            cfg.sync_interval = _DEFAULT_SYNC_INTERVAL
        elif cfg.sync_interval < _MIN_SYNC_INTERVAL:
            cfg.sync_interval = _MIN_SYNC_INTERVAL

        # Auto-update settings (booleans + the check cadence). All tolerant of a
        # bad value (fall back to the default) so a typo never stops the agent.
        try:
            cfg.auto_update = agent.getboolean("auto_update", _DEFAULT_AUTO_UPDATE)
        except ValueError:
            cfg.auto_update = _DEFAULT_AUTO_UPDATE
        try:
            cfg.confirm_updates = agent.getboolean("confirm_updates", _DEFAULT_CONFIRM_UPDATES)
        except ValueError:
            cfg.confirm_updates = _DEFAULT_CONFIRM_UPDATES
        try:
            cfg.update_check_cycles = agent.getint("update_check_cycles", _DEFAULT_UPDATE_CHECK_CYCLES)
        except ValueError:
            cfg.update_check_cycles = _DEFAULT_UPDATE_CHECK_CYCLES
        if cfg.update_check_cycles <= 0:
            cfg.update_check_cycles = _DEFAULT_UPDATE_CHECK_CYCLES

        # Voucher pull safety — a SMALL AlterID window per Voucher COLLECTION so
        # Tally never chokes (memory access violation). Tunable for big books.
        try:
            cfg.voucher_chunk = agent.getint("voucher_chunk", _DEFAULT_VOUCHER_CHUNK)
        except ValueError:
            cfg.voucher_chunk = _DEFAULT_VOUCHER_CHUNK
        if cfg.voucher_chunk <= 0:
            cfg.voucher_chunk = _DEFAULT_VOUCHER_CHUNK
        try:
            cfg.voucher_max_fetches = agent.getint("voucher_max_fetches", _DEFAULT_VOUCHER_MAX_FETCHES)
        except ValueError:
            cfg.voucher_max_fetches = _DEFAULT_VOUCHER_MAX_FETCHES
        if cfg.voucher_max_fetches <= 0:
            cfg.voucher_max_fetches = _DEFAULT_VOUCHER_MAX_FETCHES

        # Delete detection cadence (see _DEFAULT_RECONCILE_EVERY).
        try:
            cfg.reconcile_every = agent.getint("reconcile_every", _DEFAULT_RECONCILE_EVERY)
        except ValueError:
            cfg.reconcile_every = _DEFAULT_RECONCILE_EVERY
        if cfg.reconcile_every <= 0:
            cfg.reconcile_every = 1

        # How many financial years of reports to pull (see _DEFAULT_REPORT_YEARS).
        try:
            cfg.report_years = agent.getint("report_years", _DEFAULT_REPORT_YEARS)
        except ValueError:
            cfg.report_years = _DEFAULT_REPORT_YEARS
        # 0 = "every year the books cover" and is resolved at pull time from the
        # company's BOOKSFROM (see sync_agent._report_years_for). Only a positive
        # override is clamped; a negative value is a typo for 0, not for -3.
        if cfg.report_years < 0:
            cfg.report_years = 0
        elif cfg.report_years > 0:
            cfg.report_years = min(cfg.report_years, _MAX_REPORT_YEARS)

        # Tally section — connectivity + auto-start.
        tally = cfg._parser[_TALLY_SECTION]
        cfg.tally_url = tally.get("tally_url", _DEFAULT_TALLY_URL).strip() or _DEFAULT_TALLY_URL
        cfg.tally_exe = tally.get("tally_exe", _DEFAULT_TALLY_EXE).strip()
        try:
            cfg.tally_auto_start = tally.getboolean("auto_start", _DEFAULT_TALLY_AUTO_START)
        except ValueError:
            cfg.tally_auto_start = _DEFAULT_TALLY_AUTO_START

        return cfg

    def _read_credential(self, section, enc_name: str, legacy_name: str) -> str:
        """Read a credential: ENCRYPTED ``enc_name`` first, else legacy plaintext.

        Returns the decrypted/plaintext value (or "" if neither is present or the
        encrypted blob fails to decrypt - e.g. config.ini was copied from another
        PC, in which case the credential is treated as absent so the agent simply
        re-activates). ``section`` is the live configparser section proxy.
        """
        enc = section.get(enc_name, "").strip()
        if enc:
            plain = _dec(enc, self.machine_id)
            if plain is not None:
                return plain
            # Undecryptable (tampered / wrong machine) -> treat as not set.
            return ""
        # Backward-read: an old plaintext value is honoured and will be migrated
        # to the encrypted form on the next save().
        return section.get(legacy_name, "").strip()

    def _ensure_sections(self) -> None:
        """Make sure all expected sections exist on the parser."""
        for section in (_AGENT_SECTION, _STATE_SECTION, _TALLY_SECTION):
            if not self._parser.has_section(section):
                self._parser.add_section(section)

    def get_token(self) -> str | None:
        """Return the saved agent token (decrypted) or ``None``.

        Reads the ENCRYPTED ``cred_t`` first; falls back to a legacy plaintext
        ``agent_token`` (migrated to encrypted on the next save). An
        undecryptable blob (config copied to another PC) reads as absent.
        """
        self._ensure_sections()
        token = self._read_credential(
            self._parser[_STATE_SECTION], _CRED_TOKEN_NAME, "agent_token")
        return token or None

    def set_token(self, tok: str) -> None:
        """Persist the agent token (ENCRYPTED) plus ``machine_id`` under [state].

        The token is encrypted machine-bound under ``cred_t`` (never plaintext);
        any legacy plaintext ``agent_token`` is cleared. Saves to disk so a
        restart does not require re-activation.
        """
        self._ensure_sections()
        state = self._parser[_STATE_SECTION]
        mid = self.machine_id or machine_fingerprint()
        self.machine_id = mid
        state["machine_id"] = mid
        state[_CRED_TOKEN_NAME] = _enc(tok or "", mid)
        # Drop any legacy plaintext token so it does not linger on disk.
        if "agent_token" in state:
            del state["agent_token"]
        self.save()

    def clear_token(self) -> None:
        """Forget the agent token so this machine is signed out.

        Removes BOTH the encrypted credential and any legacy plaintext key. A
        half-cleared state is worse than either: the agent would look signed out
        while still holding something it could authenticate with.

        Writes to disk immediately, because the caller's next step is usually to
        stop the service or show the sign-in screen — leaving the token in a
        file that a crash could re-read would silently undo the sign-out.
        """
        self._ensure_sections()
        state = self._parser[_STATE_SECTION]
        for key in (_CRED_TOKEN_NAME, "agent_token"):
            if key in state:
                del state[key]
        self.save()

    def save(self) -> None:
        """Write the current in-memory settings back to ``config.ini``.

        Public ``[agent]`` attributes are flushed so external edits and
        in-code changes both survive. Errors are wrapped in
        :class:`ConfigError`; this is the only place that touches disk for
        writes, so the main loop can catch and log it.
        """
        self._ensure_sections()

        mid = self.machine_id or machine_fingerprint()
        self.machine_id = mid
        # Make sure the machine id (the cipher key material) is on disk so the
        # creds we write below can be decrypted on the next load.
        self._parser[_STATE_SECTION]["machine_id"] = mid
        # Persisted so a deliberate Stop survives a reboot (see load()).
        self._parser[_STATE_SECTION]["sync_enabled"] = \
            "true" if self.sync_enabled else "false"

        agent = self._parser[_AGENT_SECTION]
        # api_url is BAKED + HIDDEN - never written to config.ini. Strip any stale
        # value an older build (or a hand edit) may have left behind.
        if "api_url" in agent:
            del agent["api_url"]
        # Sweep out both spellings of the retired licence key so an upgraded
        # install stops carrying a credential nothing can use.
        for _stale in (_CRED_KEY_NAME, "license_key"):
            if _stale in agent:
                del agent[_stale]
        agent["sync_interval"] = str(self.sync_interval)
        agent["log_level"] = self.log_level
        agent["agent_version"] = self.agent_version
        agent["auto_update"] = "on" if self.auto_update else "off"
        agent["update_check_cycles"] = str(self.update_check_cycles)
        agent["confirm_updates"] = "on" if self.confirm_updates else "off"

        # agent_token migration: a plain save() (e.g. the Dashboard's "Save
        # settings", which does NOT call set_token) must never leave a legacy
        # plaintext agent_token at rest in [state]. If one is present, re-encrypt
        # whatever token is currently stored under cred_t and drop the plaintext.
        # (set_token already does this on activation; this covers the no-
        # reactivation path so "no plaintext at rest" holds after any save.)
        state = self._parser[_STATE_SECTION]
        if "agent_token" in state:
            current_token = self.get_token() or ""
            state[_CRED_TOKEN_NAME] = _enc(current_token, mid)
            del state["agent_token"]

        tally = self._parser[_TALLY_SECTION]
        tally["tally_url"] = self.tally_url
        tally["tally_exe"] = self.tally_exe
        tally["auto_start"] = "true" if self.tally_auto_start else "false"

        try:
            with open(self.path, "w", encoding="utf-8") as handle:
                self._parser.write(handle)
        except OSError as exc:
            raise ConfigError(f"Failed to write config '{self.path}': {exc}") from exc
