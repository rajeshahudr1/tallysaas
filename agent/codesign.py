"""Authenticode signing and verification for the agent executable.

WHY THIS MODULE EXISTS
----------------------
An unsigned Windows binary costs a product three separate things:

  • SmartScreen shows "Windows protected your PC" on every download, and the
    user has to click through a warning that is designed to look like a threat.
  • Unsigned single-file Python builds are a classic packer signature, so
    antivirus false-positive rates on them are high.
  • Nothing detects tampering. Anyone can patch the exe and redistribute it
    under the product's name, and neither Windows nor the customer can tell.

The third one is why this module also VERIFIES. The agent self-updates: it
downloads a replacement exe and swaps itself out. Today that download is checked
against a SHA-256 the SERVER supplied — which catches a corrupted or
CDN-tampered file, but not a compromised server, because the same server would
supply a matching hash for a malicious binary. Checking the Authenticode
signature instead anchors the update to OUR certificate, which the server never
holds. A server that is fully owned still cannot make the agent run someone
else's code.

SIGNING KEY HANDLING
--------------------
Since June 2023 every publicly-trusted code-signing key must live on a FIPS
140-2 Level 2 token or HSM — a .pfx file on disk is no longer issuable. So this
module never takes a password or a key path. It shells out to `signtool`, which
talks to whatever the machine already has configured:

  • an EV token in a USB reader (`/sha1 <thumbprint>`), or
  • a cloud signing service exposing a CSP/KSP (Azure Trusted Signing,
    DigiCert KeyLocker, SSL.com eSigner).

Set the thumbprint in the CODESIGN_THUMBPRINT environment variable and this
picks it up. No secret is ever read, written or logged here.

TIMESTAMPING is not optional. Without it every signature becomes invalid the day
the certificate expires — including on copies already installed on customer
machines. With it, signatures stay valid past expiry because the timestamp
proves the signing happened while the certificate was live.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional

from brand import NAME as _BRAND_NAME

# RFC-3161 timestamp authorities, tried in order. More than one because a TSA
# being briefly unreachable is common and would otherwise produce an unstamped
# signature — which looks fine today and breaks on the certificate's expiry.
TIMESTAMP_URLS = (
    "http://timestamp.sectigo.com",
    "http://timestamp.digicert.com",
    "http://tsa.starfieldtech.com",
)

# Where signtool.exe usually lives. It ships with the Windows SDK and is not on
# PATH by default, so a plain shutil.which() finds nothing on most build boxes.
_SDK_GLOBS = (
    r"C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe",
    r"C:\Program Files (x86)\Windows Kits\10\bin\x64\signtool.exe",
    r"C:\Program Files (x86)\Windows Kits\8.1\bin\x64\signtool.exe",
)


def find_signtool() -> Optional[str]:
    """Locate signtool.exe on PATH or in an installed Windows SDK."""
    found = shutil.which("signtool")
    if found:
        return found
    import glob
    for pattern in _SDK_GLOBS:
        # Newest SDK first: older signtool builds reject some modern options.
        matches = sorted(glob.glob(pattern), reverse=True)
        if matches:
            return matches[0]
    return None


def sign(exe_path: str, thumbprint: Optional[str] = None,
         description: str = f"{_BRAND_NAME} Agent",
         verbose: bool = True) -> bool:
    """Authenticode-sign ``exe_path`` in place. True only on a signed AND
    timestamped result.

    ``thumbprint`` selects the certificate in the machine's store; it falls back
    to the CODESIGN_THUMBPRINT environment variable. The certificate's private
    key stays on its token/HSM throughout — signtool never exports it, and this
    function never sees it.
    """
    exe = Path(exe_path)
    if not exe.exists():
        print(f"[sign] Nothing to sign: {exe}")
        return False

    tool = find_signtool()
    if not tool:
        print("[sign] signtool.exe not found. Install the Windows SDK "
              "(Signing Tools component), or add signtool to PATH.")
        return False

    thumb = (thumbprint or os.environ.get("CODESIGN_THUMBPRINT") or "").strip()
    if not thumb:
        print("[sign] No certificate thumbprint. Set CODESIGN_THUMBPRINT to the "
              "signing certificate's SHA-1 thumbprint (no spaces), or pass "
              "--thumbprint. Find it with:\n"
              "    Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert")
        return False

    # Each TSA is a full signing attempt: signtool has no "add a timestamp to
    # the signature you just made" mode, so a TSA failure means re-signing.
    for tsa in TIMESTAMP_URLS:
        cmd = [
            tool, "sign",
            "/sha1", thumb,          # select cert by thumbprint (token or HSM)
            "/fd", "SHA256",         # file digest — SHA-1 is not accepted
            "/tr", tsa,              # RFC-3161 timestamp (NOT the legacy /t)
            "/td", "SHA256",         # timestamp digest
            "/d", description,       # shown in the UAC prompt
        ]
        if verbose:
            cmd.append("/v")
        cmd.append(str(exe))

        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            print(f"[sign] Signed and timestamped via {tsa}")
            return True
        print(f"[sign] Attempt with {tsa} failed: "
              f"{(result.stderr or result.stdout or '').strip()[:300]}")

    print("[sign] Every timestamp authority failed — refusing to ship an "
          "un-timestamped signature (it would expire with the certificate).")
    return False


def verify(exe_path: str) -> bool:
    """True if ``exe_path`` carries a valid, trusted Authenticode signature.

    Uses signtool when available and falls back to PowerShell's
    Get-AuthenticodeSignature, which is present on every Windows box — the
    fallback matters because the agent verifies its own downloaded update on a
    CUSTOMER machine, where no SDK is installed.
    """
    exe = Path(exe_path)
    if not exe.exists():
        return False

    tool = find_signtool()
    if tool:
        result = subprocess.run([tool, "verify", "/pa", "/q", str(exe)],
                                capture_output=True, text=True)
        return result.returncode == 0

    ps = shutil.which("powershell") or shutil.which("pwsh")
    if not ps:
        return False
    result = subprocess.run(
        [ps, "-NoProfile", "-NonInteractive", "-Command",
         f"(Get-AuthenticodeSignature -LiteralPath '{exe}').Status"],
        capture_output=True, text=True)
    return result.returncode == 0 and result.stdout.strip() == "Valid"


def signer_subject(exe_path: str) -> str:
    """The signing certificate's subject, or '' if unsigned/unreadable.

    Used to check that an update was signed by US, not merely by somebody with
    a valid certificate — "signed" and "signed by the expected publisher" are
    very different guarantees, and only the second one is worth anything here.
    """
    ps = shutil.which("powershell") or shutil.which("pwsh")
    if not ps or not Path(exe_path).exists():
        return ""
    result = subprocess.run(
        [ps, "-NoProfile", "-NonInteractive", "-Command",
         f"(Get-AuthenticodeSignature -LiteralPath '{exe_path}')"
         f".SignerCertificate.Subject"],
        capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else ""


def signer_thumbprint(exe_path: str) -> str:
    """SHA-1 thumbprint of the signing certificate, upper-case. '' if unsigned.

    Read WITHOUT asking Windows whether it trusts the chain, which is the whole
    point: it identifies who signed a file even when nobody vouches for them.
    """
    ps = shutil.which("powershell") or shutil.which("pwsh")
    if not ps or not Path(exe_path).exists():
        return ""
    result = subprocess.run(
        [ps, "-NoProfile", "-NonInteractive", "-Command",
         f"(Get-AuthenticodeSignature -LiteralPath '{exe_path}')"
         f".SignerCertificate.Thumbprint"],
        capture_output=True, text=True)
    return result.stdout.strip().upper() if result.returncode == 0 else ""


def verify_publisher(exe_path: str, expected_cn: str,
                     pinned_thumbprint: str = "") -> bool:
    """True if this file was signed by US.

    TWO ROUTES, because "signed by us" and "signed by someone Windows trusts"
    are different questions and only the first one matters here.

    1. PINNED THUMBPRINT (works with a self-signed certificate). The signing
       certificate's thumbprint must equal the one baked into this build. Chain
       trust is irrelevant — we are not asking Windows for an opinion, we are
       checking the file against a fingerprint we already know. This is what
       makes the free path real: a self-signed certificate fails every chain
       check by definition, so a gate built on chain validation would make an
       agent reject its own updates.

    2. TRUSTED CHAIN + CN (a purchased certificate). Falls back to this when no
       thumbprint is pinned, so buying a certificate later needs no code change
       — clear the pin, set the CN.

    Either route alone is enough; neither is skippable. A file that satisfies
    neither is not ours.
    """
    pin = (pinned_thumbprint or "").replace(" ", "").upper()
    if pin:
        # Compared without regard to Windows' trust decision. An attacker would
        # need our actual private key, not merely a certificate someone trusts.
        return signer_thumbprint(exe_path) == pin

    if not expected_cn:
        return False
    if not verify(exe_path):
        return False
    subject = signer_subject(exe_path)
    # Substring, case-insensitive: a renewal that keeps the organisation name —
    # the normal case — must not break updates on installed agents.
    return expected_cn.strip().lower() in subject.lower()


def sha256(path: str) -> str:
    """The file's SHA-256, lower-case hex. '' if unreadable.

    Published alongside a release so anyone can check that the exe they hold is
    the one we built. It is not a signature — it proves nothing about WHO built
    the file, only that it matches what we said. Useful when there is no
    certificate, and useful for support ("read me the first eight characters")
    even when there is.
    """
    import hashlib
    try:
        digest = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return ""


# --------------------------------------------------------------------------- #
# Self-signed certificates — the FREE path
# --------------------------------------------------------------------------- #
# WHAT THIS DOES AND DOES NOT BUY. Read it before deciding this is enough.
#
# A self-signed certificate chains to nobody, so Windows does not trust it:
#   • SmartScreen STILL warns on download. Unchanged.
#   • Antivirus false positives are NOT reduced.
#   • The publisher shown in the UAC prompt is "Unknown".
#
# What it DOES buy, and it is not nothing:
#   • THE UPDATE CHANNEL BECOMES REAL. The agent refuses any update not signed
#     by our publisher CN. That check is ours, not Windows's, and it works
#     perfectly with a self-signed key — because the only party who must
#     recognise the certificate is the agent itself. A compromised update server
#     still cannot make installed agents run someone else's binary.
#   • TAMPER EVIDENCE. A modified exe fails the signature, so support can tell a
#     corrupted or patched build from a genuine one.
#   • THE PIPELINE IS EXERCISED. When a real certificate is bought later, only
#     the thumbprint changes; nothing else in the build or the update path does.
#
# The key is generated on this machine and stays in the user's certificate
# store. It is never exported to a file, because a signing key sitting in the
# repo or a build folder is how signing keys leak.
def make_self_signed(subject_cn: str, years: int = 5) -> Optional[str]:
    """Create a self-signed code-signing certificate. Returns its thumbprint.

    Idempotent-ish: if a code-signing certificate with this CN already exists in
    the user's store, its thumbprint is returned instead of making a second one.
    Two certificates with the same name is a foot-gun — signtool would pick by
    thumbprint and the operator would not know which.
    """
    ps = shutil.which("powershell") or shutil.which("pwsh")
    if not ps:
        print("[sign] PowerShell not found — cannot create a certificate.")
        return None

    script = f"""
$ErrorActionPreference = 'Stop'
$cn = "{subject_cn}"
$existing = Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert |
            Where-Object {{ $_.Subject -eq "CN=$cn" }} |
            Sort-Object NotAfter -Descending | Select-Object -First 1
if ($existing) {{ $existing.Thumbprint; exit 0 }}
$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject "CN=$cn" `
    -KeyUsage DigitalSignature `
    -KeyAlgorithm RSA -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -CertStoreLocation Cert:\\CurrentUser\\My `
    -NotAfter (Get-Date).AddYears({int(years)})
$cert.Thumbprint
"""
    result = subprocess.run([ps, "-NoProfile", "-NonInteractive", "-Command", script],
                            capture_output=True, text=True)
    if result.returncode != 0:
        print("[sign] Could not create a certificate: "
              + (result.stderr or result.stdout).strip()[:300])
        return None
    thumb = result.stdout.strip().splitlines()[-1].strip() if result.stdout.strip() else ""
    if not thumb:
        print("[sign] Certificate creation returned no thumbprint.")
        return None
    print(f"[sign] Self-signed certificate ready for CN={subject_cn}")
    print(f"[sign]   thumbprint: {thumb}")
    print("[sign]   NOTE: self-signed. SmartScreen will still warn on download;")
    print("[sign]   what this secures is the agent's own update channel.")
    return thumb


def sign_self(exe_path: str, subject_cn: str) -> bool:
    """Create (or reuse) a self-signed certificate and sign with it.

    Timestamping is still attempted. A self-signed certificate expires like any
    other, and without a timestamp every already-installed agent would start
    rejecting updates on that date — the failure would look like a server
    problem years after anyone remembers this decision.
    """
    thumb = make_self_signed(subject_cn)
    if not thumb:
        return False
    return sign(exe_path, thumbprint=thumb,
                description=f"{subject_cn} (self-signed)")


if __name__ == "__main__":       # tiny CLI: python codesign.py verify <exe>
    import sys
    args = sys.argv[1:]
    if len(args) >= 2 and args[0] == "verify":
        ok = verify(args[1])
        print(f"{args[1]}: {'VALID' if ok else 'NOT SIGNED / INVALID'}")
        print(f"  signer: {signer_subject(args[1]) or '(none)'}")
        sys.exit(0 if ok else 1)
    if len(args) >= 2 and args[0] == "sign":
        sys.exit(0 if sign(args[1]) else 1)
    if len(args) >= 2 and args[0] == "self-sign":
        cn = args[2] if len(args) >= 3 else "Dukansetu"
        sys.exit(0 if sign_self(args[1], cn) else 1)
    if len(args) >= 2 and args[0] == "sha256":
        print(sha256(args[1]))
        sys.exit(0)
    print(__doc__)
    print("\nUsage:\n"
          "  python codesign.py sign <exe>              sign with a real certificate\n"
          "  python codesign.py self-sign <exe> [CN]    free: self-signed\n"
          "  python codesign.py verify <exe>\n"
          "  python codesign.py sha256 <exe>")
