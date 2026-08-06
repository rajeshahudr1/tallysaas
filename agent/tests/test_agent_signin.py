"""Tests for the agent's email + password + OTP sign-in.

The property these pin down is the one the whole design rests on: THE AGENT
DECIDES NOTHING. It does not check the email's shape, the password's length or
the code's digits — it sends what was typed and shows what came back. That is
what lets rules and wording change server-side without shipping a new exe, and
it is easy to undo by accident (one well-meaning `if not email:` and the server
is no longer the source of truth).

The single exception is a transport failure. There is no server to ask for a
message when the server could not be reached, so that one string is the agent's.

Run: python -m unittest discover -s agent/tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import requests  # noqa: E402

from api_client import ApiClient, ActivationError  # noqa: E402


class _Resp:
    """Minimal stand-in for requests.Response."""

    def __init__(self, body):
        self._body = body

    def json(self):
        return self._body


def client(handler):
    """An ApiClient whose transport is `handler(path, payload)`."""
    import logging
    api = ApiClient("https://example.test/api/v1", logging.getLogger("test"))
    api.calls = []

    def _post(path, *, json, headers=None, timeout=None):
        api.calls.append((path, json))
        return handler(path, json)

    api._post = _post
    return api


def ok(data, msg="ok"):
    return lambda path, payload: _Resp({"status": 200, "data": data, "msg": msg})


def rejected(msg, status=401):
    return lambda path, payload: _Resp({"status": status, "data": None, "msg": msg})


# ── login ────────────────────────────────────────────────────────
class LoginTests(unittest.TestCase):

    def test_login_posts_credentials_and_returns_the_challenge(self):
        api = client(ok({"challenge_id": "c-1", "email_masked": "ra***@x.com",
                         "expires_in": 600}))
        data = api.login("a@b.com", "pw", "M1", machine_name="PC-1",
                         agent_version="1.0.0")
        path, payload = api.calls[0]
        self.assertEqual(path, "agent/login")
        self.assertEqual(payload["email"], "a@b.com")
        self.assertEqual(payload["machine_id"], "M1")
        self.assertEqual(payload["machine_name"], "PC-1")
        self.assertEqual(data["challenge_id"], "c-1")

    def test_a_malformed_email_is_still_sent_to_the_server(self):
        # The agent must NOT pre-judge this. The server owns the rule, so a
        # local check would both duplicate it and freeze today's version of it
        # into every installed exe.
        api = client(rejected("Enter a valid email address.", 422))
        with self.assertRaises(ActivationError) as ctx:
            api.login("not-an-email", "pw", "M1")
        self.assertEqual(api.calls[0][0], "agent/login")
        self.assertEqual(str(ctx.exception), "Enter a valid email address.")

    def test_empty_credentials_are_still_sent(self):
        api = client(rejected("Enter your email address.", 422))
        with self.assertRaises(ActivationError):
            api.login("", "", "M1")
        self.assertEqual(len(api.calls), 1)

    def test_the_servers_message_is_surfaced_verbatim(self):
        api = client(rejected("This licence has expired. Renew it to continue.", 403))
        with self.assertRaises(ActivationError) as ctx:
            api.login("a@b.com", "pw", "M1")
        self.assertEqual(str(ctx.exception),
                         "This licence has expired. Renew it to continue.")

    def test_a_rejection_with_no_message_falls_back_rather_than_showing_nothing(self):
        api = client(lambda p, j: _Resp({"status": 401}))
        with self.assertRaises(ActivationError) as ctx:
            api.login("a@b.com", "pw", "M1")
        self.assertEqual(str(ctx.exception), "Sign-in failed.")

    def test_a_server_fault_does_not_masquerade_as_a_credential_problem(self):
        # The bug this prevents: an API that had not been deployed answered 404
        # "Route not found", and the agent showed that to a customer who had
        # typed a perfectly good email. A fault in OUR infrastructure must not
        # read as something they did wrong.
        for status in (404, 405, 500, 502, 503, 504):
            api = client(rejected("Route not found", status))
            with self.assertRaises(ActivationError) as ctx:
                api.login("a@b.com", "pw", "M1")
            message = str(ctx.exception)
            self.assertIn("server is not responding", message, f"status {status}")
            self.assertNotIn("Route not found", message)

    def test_messages_the_customer_can_act_on_still_come_through_verbatim(self):
        # The infrastructure mapping must not swallow real answers — that would
        # undo the whole reason validation lives server-side.
        for status, msg in ((401, "Email or password is incorrect."),
                            (403, "This licence has expired. Renew it to continue."),
                            (422, "Enter a valid email address."),
                            (429, "Too many sign-in attempts. Try again in 5 minute(s).")):
            api = client(rejected(msg, status))
            with self.assertRaises(ActivationError) as ctx:
                api.login("a@b.com", "pw", "M1")
            self.assertEqual(str(ctx.exception), msg)

    def test_an_unreachable_server_gets_the_agents_OWN_message(self):
        # The only message the agent authors, because there was no server to
        # ask. It must not read like a credential problem.
        def boom(path, payload):
            raise requests.ConnectionError("no route")

        api = client(boom)
        with self.assertRaises(ActivationError) as ctx:
            api.login("a@b.com", "pw", "M1")
        self.assertIn("Cannot reach the server", str(ctx.exception))


# ── verify ───────────────────────────────────────────────────────
class VerifyTests(unittest.TestCase):

    def test_verify_returns_the_token(self):
        api = client(ok({"agent_token": "tok-1", "agent_id": 5,
                         "license": {"plan": "pro"}}))
        data = api.verify_otp("c-1", "123456", "M1")
        self.assertEqual(api.calls[0][0], "agent/verify")
        self.assertEqual(data["agent_token"], "tok-1")

    def test_verify_resends_the_machine_id(self):
        # The server matches this against the challenge, so a code obtained on
        # one computer cannot be redeemed on another. Dropping it here would
        # quietly disable that check.
        api = client(ok({"agent_token": "t", "agent_id": 1}))
        api.verify_otp("c-1", "123456", "M1")
        self.assertEqual(api.calls[0][1]["machine_id"], "M1")

    def test_a_short_code_is_still_sent(self):
        api = client(rejected("Enter the 6-digit code from your email.", 422))
        with self.assertRaises(ActivationError):
            api.verify_otp("c-1", "12", "M1")
        self.assertEqual(api.calls[0][1]["code"], "12")

    def test_the_attempts_remaining_message_reaches_the_caller(self):
        api = client(rejected("That code is not right. 3 attempts left."))
        with self.assertRaises(ActivationError) as ctx:
            api.verify_otp("c-1", "999999", "M1")
        self.assertIn("3 attempts left", str(ctx.exception))


# ── resend ───────────────────────────────────────────────────────
class ResendTests(unittest.TestCase):

    def test_resend_sends_only_the_challenge_id(self):
        # No credentials are re-sent: the challenge already proves the password
        # was accepted, and re-posting a password on every resend widens the
        # window in which it can leak.
        api = client(ok({"challenge_id": "c-1", "email_masked": "ra***@x.com"}))
        api.resend_otp("c-1")
        path, payload = api.calls[0]
        self.assertEqual(path, "agent/otp/resend")
        self.assertEqual(payload, {"challenge_id": "c-1"})

    def test_the_cooldown_message_is_surfaced(self):
        # The countdown is the SERVER's decision; the agent only displays it.
        api = client(rejected("Wait 42s before asking for another code.", 429))
        with self.assertRaises(ActivationError) as ctx:
            api.resend_otp("c-1")
        self.assertIn("42s", str(ctx.exception))


# ── what was removed ─────────────────────────────────────────────
class LicenceKeyRemovalTests(unittest.TestCase):

    def test_the_client_no_longer_offers_licence_key_activation(self):
        import logging
        api = ApiClient("https://example.test/api/v1", logging.getLogger("test"))
        self.assertFalse(hasattr(api, "activate"),
                         "activate() still exists — licence-key sign-in was meant to go")

    def test_config_no_longer_carries_a_licence_key(self):
        # A retired credential that is still loaded and re-saved is a credential
        # that can still leak.
        from config import Config
        self.assertFalse(hasattr(Config("x.ini"), "license_key"))

    def test_config_can_clear_a_token(self):
        # Signing out must actually forget the token, not just hide the UI.
        from config import Config
        self.assertTrue(callable(getattr(Config("x.ini"), "clear_token", None)))


if __name__ == "__main__":
    unittest.main()
