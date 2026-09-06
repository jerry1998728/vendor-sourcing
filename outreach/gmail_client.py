"""Gmail client (D2 AM): OAuth desktop flow persisting token.json, plus an in-memory fake.

    send_message(to, subject, body) -> thread_id
    list_thread_messages(thread_id) -> [{message_id, from, date, subject, body_text}]

Secrets: GMAIL_CREDENTIALS_PATH (.env) -> OAuth client JSON (credentials.json, gitignored);
the user token is persisted next to it as token.json (gitignored).
"""
from __future__ import annotations

import base64
import os
import re
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any

SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"]
PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _header(headers: list[dict[str, str]], name: str) -> str:
    for h in headers:
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def _decode(data: str | None) -> str:
    if not data:
        return ""
    return base64.urlsafe_b64decode(data.encode("ascii") + b"=" * (-len(data) % 4)).decode("utf-8", "replace")


def _body_text(payload: dict[str, Any]) -> str:
    """Prefer text/plain; fall back to tag-stripped text/html."""
    plain, html = [], []

    def walk(part: dict[str, Any]) -> None:
        mime = part.get("mimeType", "")
        data = (part.get("body") or {}).get("data")
        if mime == "text/plain" and data:
            plain.append(_decode(data))
        elif mime == "text/html" and data:
            html.append(_decode(data))
        for sub in part.get("parts") or []:
            walk(sub)

    walk(payload)
    if plain:
        return "\n".join(plain).strip()
    if html:
        return re.sub(r"<[^>]+>", " ", " ".join(html)).strip()
    return ""


def strip_quoted_reply(text: str) -> str:
    """Drop quoted history ('On ... wrote:' / '>' lines) so inference reads only the new content."""
    out = []
    for line in (text or "").splitlines():
        if re.match(r"^\s*On .+wrote:\s*$", line) or line.strip().startswith("-----Original Message"):
            break
        if line.lstrip().startswith(">"):
            continue
        out.append(line)
    return "\n".join(out).strip()


class GmailClient:
    def __init__(self, credentials_path: str | os.PathLike | None = None,
                 token_path: str | os.PathLike | None = None) -> None:
        self.credentials_path = Path(credentials_path or os.environ.get("GMAIL_CREDENTIALS_PATH") or PROJECT_ROOT / "credentials.json")
        if not self.credentials_path.is_absolute():
            self.credentials_path = PROJECT_ROOT / self.credentials_path
        self.token_path = Path(token_path or os.environ.get("GMAIL_TOKEN_PATH") or PROJECT_ROOT / "token.json")
        self._service = None
        self._email: str | None = None

    # --- auth -----------------------------------------------------------------
    def is_authorized(self) -> bool:
        return self.token_path.exists()

    def _creds(self, interactive: bool):
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        creds = None
        if self.token_path.exists():
            creds = Credentials.from_authorized_user_file(str(self.token_path), SCOPES)
        if creds and creds.valid:
            return creds
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        elif interactive:
            from google_auth_oauthlib.flow import InstalledAppFlow
            if not self.credentials_path.exists():
                raise FileNotFoundError(f"Gmail OAuth client file not found: {self.credentials_path}")
            creds = InstalledAppFlow.from_client_secrets_file(str(self.credentials_path), SCOPES).run_local_server(port=0)
        else:
            raise PermissionError("Gmail is not authorized yet; run `python outreach/run.py --auth`")
        self.token_path.write_text(creds.to_json())
        return creds

    def authorize(self) -> str:
        """Run the OAuth desktop flow (opens a browser), persist token.json, return the account email."""
        self._service = None
        self._creds(interactive=True)
        return self.profile_email()

    @property
    def service(self):
        if self._service is None:
            from googleapiclient.discovery import build
            self._service = build("gmail", "v1", credentials=self._creds(interactive=False), cache_discovery=False)
        return self._service

    def profile_email(self) -> str:
        if self._email is None:
            self._email = self.service.users().getProfile(userId="me").execute()["emailAddress"]
        return self._email

    # --- send / read ----------------------------------------------------------
    def send(self, to: str, subject: str, body: str, thread_id: str | None = None,
             in_reply_to: str | None = None) -> dict[str, str]:
        msg = EmailMessage()
        msg["To"] = to
        msg["From"] = self.profile_email()
        msg["Subject"] = subject
        if in_reply_to:
            msg["In-Reply-To"] = in_reply_to
            msg["References"] = in_reply_to
        msg.set_content(body)
        payload: dict[str, Any] = {"raw": base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")}
        if thread_id:
            payload["threadId"] = thread_id
        sent = self.service.users().messages().send(userId="me", body=payload).execute()
        return {"message_id": sent["id"], "thread_id": sent["threadId"]}

    def send_message(self, to: str, subject: str, body: str) -> str:
        return self.send(to, subject, body)["thread_id"]

    def list_thread_messages(self, thread_id: str) -> list[dict[str, str]]:
        th = self.service.users().threads().get(userId="me", id=thread_id, format="full").execute()
        out: list[dict[str, str]] = []
        for m in th.get("messages", []):
            headers = m.get("payload", {}).get("headers", [])
            ts = int(m.get("internalDate", "0")) / 1000
            out.append({"message_id": m["id"], "from": _header(headers, "From"), "subject": _header(headers, "Subject"),
                        "body_text": _body_text(m.get("payload", {})),
                        "date": datetime.fromtimestamp(ts, tz=timezone.utc).isoformat(timespec="seconds")})
        out.sort(key=lambda x: x["date"])
        return out


class FakeGmail:
    """In-memory Gmail with the same surface, for tests and the offline demo."""

    def __init__(self, own_email: str = "sourcer@example.com") -> None:
        self.own_email = own_email
        self.threads: dict[str, list[dict[str, str]]] = {}
        self._n = 0

    def is_authorized(self) -> bool:
        return True

    def authorize(self) -> str:
        return self.own_email

    def profile_email(self) -> str:
        return self.own_email

    def _next(self, prefix: str) -> str:
        self._n += 1
        return f"{prefix}{self._n:04d}"

    def send(self, to: str, subject: str, body: str, thread_id: str | None = None,
             in_reply_to: str | None = None) -> dict[str, str]:
        tid = thread_id or self._next("thr_")
        mid = self._next("msg_")
        self.threads.setdefault(tid, []).append({"message_id": mid, "from": self.own_email, "to": to, "subject": subject,
                                                 "body_text": body, "date": datetime.now(timezone.utc).isoformat(timespec="seconds")})
        return {"message_id": mid, "thread_id": tid}

    def send_message(self, to: str, subject: str, body: str) -> str:
        return self.send(to, subject, body)["thread_id"]

    def inject_reply(self, thread_id: str, sender: str, body: str, subject: str | None = None,
                     date: str | None = None) -> dict[str, str]:
        prev = self.threads.setdefault(thread_id, [])
        m = {"message_id": self._next("msg_"), "from": sender, "to": self.own_email,
             "subject": subject or (("Re: " + prev[0]["subject"]) if prev else "Re:"), "body_text": body,
             "date": date or datetime.now(timezone.utc).isoformat(timespec="seconds")}
        prev.append(m)
        return m

    def list_thread_messages(self, thread_id: str) -> list[dict[str, str]]:
        return sorted(self.threads.get(thread_id, []), key=lambda x: x["date"])
