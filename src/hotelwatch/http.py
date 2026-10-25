"""Tiny stdlib HTTP helpers with retries. Kept separate so providers can be tested offline."""

from __future__ import annotations

import http.cookiejar
import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from typing import Any

log = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)
BROWSER_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-GB,en;q=0.9",
    "Accept-Encoding": "identity",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
}
RETRY_STATUSES = (429, 500, 502, 503, 504)

FetchJson = Callable[..., Any]


class HttpError(RuntimeError):
    pass


def _with_retries(send: Callable[[], bytes], what: str, retries: int, backoff: float) -> bytes:
    last_exc: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            return send()
        except urllib.error.HTTPError as exc:
            if exc.code in RETRY_STATUSES and attempt < retries:
                last_exc = exc
            else:
                raise HttpError(f"HTTP {exc.code} from {what}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            last_exc = exc
        if attempt < retries:
            delay = backoff**attempt
            log.warning(
                "attempt %d/%d failed for %s: %s; retrying in %.0fs",
                attempt,
                retries,
                what,
                last_exc,
                delay,
            )
            time.sleep(delay)
    raise HttpError(f"giving up on {what}: {last_exc}")


def fetch_json(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: dict[str, Any] | None = None,
    timeout: float = 30.0,
    retries: int = 3,
    backoff: float = 2.0,
) -> Any:
    """GET/POST a URL and parse the JSON response, retrying on transient failures."""
    data = json.dumps(body).encode() if body is not None else None
    hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json, text/plain, */*"}
    if data is not None:
        hdrs["Content-Type"] = "application/json"
    hdrs.update(headers or {})

    def send() -> bytes:
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()

    raw = _with_retries(send, url, retries, backoff)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HttpError(f"non-JSON response from {url}: {raw[:200]!r}") from exc


class HtmlClient:
    """Cookie-keeping client for server-rendered booking engines.

    Providers call ``get`` and ``post`` and receive decoded text. Tests substitute a fake with
    the same two methods.
    """

    def __init__(self, timeout: float = 45.0, retries: int = 3, backoff: float = 2.0) -> None:
        self._jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self._jar))
        self._timeout = timeout
        self._retries = retries
        self._backoff = backoff

    def _request(self, url: str, data: bytes | None, headers: dict[str, str] | None) -> str:
        hdrs = {**BROWSER_HEADERS, **(headers or {})}

        def send() -> bytes:
            req = urllib.request.Request(url, data=data, headers=hdrs)
            with self._opener.open(req, timeout=self._timeout) as resp:
                return resp.read()

        raw = _with_retries(send, url, self._retries, self._backoff)
        return raw.decode("utf-8", "replace")

    def get(self, url: str, headers: dict[str, str] | None = None) -> str:
        return self._request(url, None, headers)

    def post(self, url: str, data: dict[str, str], headers: dict[str, str] | None = None) -> str:
        body = urllib.parse.urlencode(data).encode()
        hdrs = {"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"}
        hdrs.update(headers or {})
        return self._request(url, body, hdrs)
