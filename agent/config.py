"""Configuration handling for the Tally Cloud Sync Agent.

Reads and writes ``config.ini`` (via :mod:`configparser`). The ``[agent]``
section holds operator-supplied settings (api_url, license_key, sync_interval,
log_level, agent_version). The ``[state]`` section holds runtime state the
agent persists itself: the ``agent_token`` returned by activation and the
machine id it activated with.

A stable per-machine fingerprint is derived from the MAC address
(:func:`uuid.getnode`), hostname and platform, hashed with SHA-256 so the same
PC always yields the same id (and the value is opaque on the wire).
"""

from __future__ import annotations

import configparser
import hashlib
import os
import platform
import socket
import uuid


# Section / key names kept in one place so reads and writes never drift.
_AGENT_SECTION = "agent"
_STATE_SECTION = "state"
_TALLY_SECTION = "tally"

# Defaults applied when a key is missing from config.ini.
_DEFAULT_API_URL = "http://localhost:4500/api/v1"
_DEFAULT_SYNC_INTERVAL = 60
_DEFAULT_LOG_LEVEL = "INFO"
_DEFAULT_AGENT_VERSION = "1.0.0"
_DEFAULT_TALLY_URL = "http://localhost:9000"
_DEFAULT_TALLY_AUTO_START = True
# tally_exe: empty → the agent auto-detects TallyPrime in the usual install
# locations (see sync_agent._find_tally_exe). Set it explicitly if Tally lives
# somewhere non-standard.
_DEFAULT_TALLY_EXE = ""


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


class Config:
    """In-memory view of ``config.ini`` with typed accessors.

    Attributes:
        api_url: Base URL of the cloud API (no trailing slash needed).
        license_key: Secret license key used to activate the agent.
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
        self.license_key: str = ""
        self.sync_interval: int = _DEFAULT_SYNC_INTERVAL
        self.log_level: str = _DEFAULT_LOG_LEVEL
        self.agent_version: str = _DEFAULT_AGENT_VERSION
        self.machine_id: str = ""

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

        agent = cfg._parser[_AGENT_SECTION]
        cfg.api_url = agent.get("api_url", _DEFAULT_API_URL).strip() or _DEFAULT_API_URL
        cfg.license_key = agent.get("license_key", "").strip()
        cfg.log_level = (
            agent.get("log_level", _DEFAULT_LOG_LEVEL).strip() or _DEFAULT_LOG_LEVEL
        )
        cfg.agent_version = (
            agent.get("agent_version", _DEFAULT_AGENT_VERSION).strip()
            or _DEFAULT_AGENT_VERSION
        )

        # sync_interval must always end up an int; bad values fall back.
        try:
            cfg.sync_interval = agent.getint("sync_interval", _DEFAULT_SYNC_INTERVAL)
        except ValueError:
            cfg.sync_interval = _DEFAULT_SYNC_INTERVAL
        if cfg.sync_interval <= 0:
            cfg.sync_interval = _DEFAULT_SYNC_INTERVAL

        # Tally section — connectivity + auto-start.
        tally = cfg._parser[_TALLY_SECTION]
        cfg.tally_url = tally.get("tally_url", _DEFAULT_TALLY_URL).strip() or _DEFAULT_TALLY_URL
        cfg.tally_exe = tally.get("tally_exe", _DEFAULT_TALLY_EXE).strip()
        try:
            cfg.tally_auto_start = tally.getboolean("auto_start", _DEFAULT_TALLY_AUTO_START)
        except ValueError:
            cfg.tally_auto_start = _DEFAULT_TALLY_AUTO_START

        # Machine id: use the persisted one if present, else compute + remember.
        state = cfg._parser[_STATE_SECTION]
        saved_machine = state.get("machine_id", "").strip()
        cfg.machine_id = saved_machine or machine_fingerprint()

        return cfg

    def _ensure_sections(self) -> None:
        """Make sure all expected sections exist on the parser."""
        for section in (_AGENT_SECTION, _STATE_SECTION, _TALLY_SECTION):
            if not self._parser.has_section(section):
                self._parser.add_section(section)

    def get_token(self) -> str | None:
        """Return the saved ``agent_token`` from ``[state]`` or ``None``."""
        self._ensure_sections()
        token = self._parser[_STATE_SECTION].get("agent_token", "").strip()
        return token or None

    def set_token(self, tok: str) -> None:
        """Persist ``agent_token`` (and ``machine_id``) under ``[state]``.

        Writes the token plus the current machine id, then saves to disk so a
        restart does not require re-activation.
        """
        self._ensure_sections()
        self._parser[_STATE_SECTION]["agent_token"] = tok or ""
        self._parser[_STATE_SECTION]["machine_id"] = self.machine_id or machine_fingerprint()
        self.save()

    def save(self) -> None:
        """Write the current in-memory settings back to ``config.ini``.

        Public ``[agent]`` attributes are flushed so external edits and
        in-code changes both survive. Errors are wrapped in
        :class:`ConfigError`; this is the only place that touches disk for
        writes, so the main loop can catch and log it.
        """
        self._ensure_sections()

        agent = self._parser[_AGENT_SECTION]
        agent["api_url"] = self.api_url
        agent["license_key"] = self.license_key
        agent["sync_interval"] = str(self.sync_interval)
        agent["log_level"] = self.log_level
        agent["agent_version"] = self.agent_version

        tally = self._parser[_TALLY_SECTION]
        tally["tally_url"] = self.tally_url
        tally["tally_exe"] = self.tally_exe
        tally["auto_start"] = "true" if self.tally_auto_start else "false"

        try:
            with open(self.path, "w", encoding="utf-8") as handle:
                self._parser.write(handle)
        except OSError as exc:
            raise ConfigError(f"Failed to write config '{self.path}': {exc}") from exc
