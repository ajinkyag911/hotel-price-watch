"""Tiny stdlib HTTP client with retries. Kept separate so providers can be tested offline."""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any

log = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36 hotelwatch/0.1"
)

FetchJson = Callable[..., Any]


class HttpError(RuntimeError):
    pass


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

    last_exc: Exception | None = None
    for attempt in range(1, retries + 1):
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            try:
                return json.loads(raw)
            except json.JSONDecodeError as exc:
                raise HttpError(f"non-JSON response from {url}: {raw[:200]!r}") from exc
        except urllib.error.HTTPError as exc:
            if exc.code in (429, 500, 502, 503, 504) and attempt < retries:
                last_exc = exc
            else:
                raise HttpError(f"HTTP {exc.code} from {url}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            last_exc = exc
        if attempt < retries:
            delay = backoff**attempt
            log.warning(
                "attempt %d/%d failed for %s: %s; retrying in %.0fs",
                attempt,
                retries,
                url,
                last_exc,
                delay,
            )
            time.sleep(delay)
    raise HttpError(f"giving up on {url}: {last_exc}")
