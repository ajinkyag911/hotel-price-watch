"""Provider for the "propertyibe2" hotel booking engine (JavaServer Faces + PrimeFaces).

Seen at booking.tolanihotels.com/propertyibe2/. How the public page gets its prices, as
observed in Oct 2026:

1. ``GET {base}?propertyId=…&onlineId=…`` starts a server session (cookies) and a JSF
   conversation; ``GET {base}rates?cid=1`` renders the results page shell, whose
   ``reservation_form`` carries a ``javax.faces.ViewState`` token and whose scripts define the
   ``updateSearchResult`` PrimeFaces remote command.
2. ``POST {base}rates?cid=1`` as a PrimeFaces partial request with the stay parameters returns
   an XML ``partial-response``; the ``rate_views_form`` update holds the rendered room list with
   per-night, tax-inclusive prices. Each response also carries a fresh ViewState.

The page shows prices per room per night *including taxes and fees*; the reading's ``price`` is
the sum over the stay, so ``price_basis`` is ``after_tax``.
"""

from __future__ import annotations

import logging
import re
import time
import urllib.parse
from datetime import timedelta
from html import unescape
from typing import Any, ClassVar

from hotelwatch.http import HtmlClient, HttpError
from hotelwatch.models import PlanQuote, Reading, Target
from hotelwatch.providers.base import ProviderError, match_one, norm
from hotelwatch.providers.htmltree import Node, parse_html

log = logging.getLogger(__name__)

_BASE_RE = re.compile(r"^(https?://[^/]+/propertyibe2/)", re.IGNORECASE)
_VIEWSTATE_RE = re.compile(
    r'name="javax\.faces\.ViewState"[^>]*?value="([^"]+)"|value="([^"]+)"[^>]*?name="javax\.faces\.ViewState"'
)
_FORM_RE = re.compile(
    r'<form[^>]*id="reservation_form"[^>]*action="([^"]+)"[^>]*>(.*?)</form>', re.S
)
_HIDDEN_RE = re.compile(r'<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"')
_COMMAND_RE = re.compile(
    r'updateSearchResult\s*=\s*function\(\)\s*\{PrimeFaces\.ab\(\{s:"([^"]+)",f:"([^"]+)",p:"([^"]+)",u:"([^"]+)"'
)
_UPDATE_RE = re.compile(r'<update id="([^"]+)"><!\[CDATA\[(.*?)\]\]></update>', re.S)
_NUM_RE = re.compile(r"[\d,]+(?:\.\d+)?")


def _num(text: str) -> float | None:
    m = _NUM_RE.search(text.replace("\xa0", " "))
    return float(m.group(0).replace(",", "")) if m else None


class PropertyIbeSession:
    """One server session against a propertyibe2 engine; reusable across many searches."""

    def __init__(self, base: str, property_id: str, online_id: str, client: Any) -> None:
        self.base = base
        self.property_id = property_id
        self.online_id = online_id
        self._client = client
        self._view_state: str | None = None
        self._action: str = ""
        self._hidden: dict[str, str] = {}
        self._command: tuple[str, str, str, str] | None = None

    # -- session bootstrap ----------------------------------------------------------------

    @property
    def rates_url(self) -> str:
        return urllib.parse.urljoin(self.base, "rates?cid=1")

    def start(self, attempts: int = 3, pause: float = 8.0, sleep=time.sleep) -> None:
        """Open a session. The edge occasionally answers the first hit with a 403 that clears on
        a retry, so the bootstrap is retried a few times before giving up."""
        home = f"{self.base}?propertyId={self.property_id}&onlineId={self.online_id}"
        for attempt in range(1, attempts + 1):
            try:
                self._client.get(home)
                page = self._client.get(self.rates_url, {"Referer": home})
                break
            except HttpError as exc:
                if "403" not in str(exc) or attempt == attempts:
                    raise
                log.warning("bootstrap got %s; retrying in %.0fs", exc, pause * attempt)
                sleep(pause * attempt)
        self._load_form(page)
        cmd = _COMMAND_RE.search(page)
        if not cmd:
            raise ProviderError("results page lacks the updateSearchResult command")
        self._command = cmd.groups()  # type: ignore[assignment]

    def _load_form(self, markup: str) -> None:
        m = _FORM_RE.search(markup)
        if not m:
            raise ProviderError("reservation_form not found on results page")
        self._action = unescape(m.group(1))
        self._hidden = dict(_HIDDEN_RE.findall(m.group(2)))
        vs = _VIEWSTATE_RE.search(m.group(2))
        if not vs:
            raise ProviderError("ViewState not found in reservation_form")
        self._view_state = vs.group(1) or vs.group(2)

    # -- search ------------------------------------------------------------------------------

    def search(self, target: Target) -> str:
        """Run one availability search; return the rendered room-list HTML."""
        if self._command is None or self._view_state is None:
            self.start()
        assert self._command is not None
        source, _form, execute, render = self._command
        data = {
            "javax.faces.partial.ajax": "true",
            "javax.faces.source": source,
            "javax.faces.partial.execute": execute,
            "javax.faces.partial.render": render,
            source: source,
            "reservation_form": "reservation_form",
            "onlineId": self._hidden.get("onlineId", self.online_id),
            "s_checkin": target.check_in.isoformat(),
            "s_checkout": target.check_out.isoformat(),
            "s_numofadult": str(target.adults),
            "s_numofchild": str(len(target.children)),
            "s_numofroom": "1",
            "h_maxchild": self._hidden.get("h_maxchild", "5"),
            "s_accesscode": "",
            "javax.faces.ViewState": self._view_state or "",
        }
        headers = {
            "Faces-Request": "partial/ajax",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": self.rates_url,
            "Origin": self.base.rstrip("/").rsplit("/", 1)[0],
        }
        xml = self._client.post(urllib.parse.urljoin(self.base, self._action), data, headers)
        updates = {uid: body for uid, body in _UPDATE_RE.findall(xml)}
        if "rate_views_form" not in updates:
            if "ViewExpired" in xml or "<redirect" in xml or "<error>" in xml:
                raise ProviderError("session expired or rejected by the booking engine")
            raise ProviderError(f"no room list in response ({', '.join(updates) or 'empty'})")
        # Keep the conversation alive: the server rotates ViewState on every response.
        vs_update = next((v for k, v in updates.items() if "ViewState" in k), None)
        if vs_update:
            self._view_state = vs_update.strip()
        elif "reservation_form" in updates:
            vs = _VIEWSTATE_RE.search(updates["reservation_form"])
            if vs:
                self._view_state = vs.group(1) or vs.group(2)
        return updates["rate_views_form"]


class PropertyIbeProvider:
    name: ClassVar[str] = "propertyibe"

    def __init__(self, client: Any | None = None, delay: float = 0.6, sleep=time.sleep) -> None:
        self._client = client or HtmlClient()
        self._sessions: dict[str, PropertyIbeSession] = {}
        self._delay = delay
        self._sleep = sleep
        self._last_request = 0.0

    @classmethod
    def matches_url(cls, url: str) -> bool:
        return bool(_BASE_RE.match(url)) and "propertyId=" in url

    @staticmethod
    def parse_url(url: str) -> tuple[str, str, str]:
        m = _BASE_RE.match(url)
        if not m:
            raise ProviderError(f"not a propertyibe2 URL: {url}")
        qs = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        try:
            return m.group(1), qs["propertyId"][0], qs.get("onlineId", ["1"])[0]
        except KeyError as exc:
            raise ProviderError(f"propertyId missing from URL: {url}") from exc

    def _session(self, url: str) -> PropertyIbeSession:
        base, pid, oid = self.parse_url(url)
        key = f"{base}|{pid}|{oid}"
        if key not in self._sessions:
            self._sessions[key] = PropertyIbeSession(base, pid, oid, self._client)
        return self._sessions[key]

    def _throttle(self) -> None:
        wait = self._delay - (time.monotonic() - self._last_request)
        if wait > 0:
            self._sleep(wait)
        self._last_request = time.monotonic()

    def fetch(self, target: Target) -> Reading:
        session = self._session(target.url)
        self._throttle()
        try:
            markup = session.search(target)
        except ProviderError as exc:
            log.warning("%s; restarting session and retrying once", exc)
            session.start()
            markup = session.search(target)
        return parse_rooms(markup, target)


# -- parsing ------------------------------------------------------------------------------------


def _plan_from_article(
    article: Node, target: Target, idx: int
) -> tuple[PlanQuote, str | None] | None:
    """Turn one ``article.rate-item`` into a quote plus the currency code it displayed."""
    title = article.find(lambda n: n.has_class("rate-item__title"))
    name = ""
    if title:
        link = title.find(lambda n: n.tag in ("a", "h4"))
        name = (link or title).text()
    price_box = article.find(lambda n: n.has_class("rate-item__price"))
    if not price_box:
        return None
    current = price_box.find(lambda n: n.tag == "span" and "pn" in n.classes)
    cur_span = current.find(lambda n: n.has_class("currency")) if current else None
    # The per-night value sits next to the currency code; take the number after stripping it.
    nightly = _num(current.text().replace(cur_span.text(), "")) if current and cur_span else None
    # Breakdown rows look like "Wed 06 Jan | 8,100"; the table ends with a total row to skip.
    breakdown: list[float] = []
    for tr in price_box.find_all(lambda n: n.tag == "tr"):
        tds = [c for c in tr.children if c.tag == "td"]
        if len(tds) < 2 or "total" in tds[0].text().casefold():
            continue
        v = _num(tds[-1].text())
        if v is not None and len(breakdown) < target.nights:
            breakdown.append(v)
    if breakdown:
        nights = breakdown
    elif nightly is not None:
        nights = [nightly] * target.nights
    else:
        return None
    if any(v <= 0 for v in nights):
        return None
    promo_node = article.find(lambda n: n.has_class("text-discount"))
    body = article.text().casefold()
    quote = PlanQuote(
        rate_id=article.attrs.get("data-item-id") or f"plan-{idx}",
        name=name or f"Rate {idx + 1}",
        before_tax=round(sum(nights), 2),
        after_tax=round(sum(nights), 2),
        refundable="free cancellation" in body and "non-refundable" not in body,
        promo=(promo_node.text() if promo_node else None) or None,
        nightly_before_tax={
            (target.check_in + timedelta(days=i)).isoformat(): v for i, v in enumerate(nights)
        },
    )
    return quote, (cur_span.text() if cur_span else None)


def parse_rooms(markup: str, target: Target) -> Reading:
    root = parse_html(markup)
    rooms = root.find_all(
        lambda n: n.tag == "section" and n.attrs.get("data-item-id", "").startswith("RM_")
    )
    observed = Reading.now()

    def room_name(sec: Node) -> str:
        h = sec.find(lambda n: n.tag == "h2" and n.has_class("title"))
        return h.text() if h else sec.attrs.get("data-item-id", "")

    if not rooms:
        return Reading(
            target_id=target.id, observed_at=observed, currency="", available=False,
            price=None, price_after_tax=None, plan_name=None, plan_rate_id=None, promo=None,
            note="no rooms offered for these dates", price_basis="after_tax",
        )  # fmt: skip

    try:
        room = match_one(rooms, target.room, room_name, "room")
    except ProviderError as exc:
        # The engine hides sold-out rooms entirely, so "no match" usually means sold out for
        # these dates. The note carries the rooms that were offered, which exposes a misspelt
        # room name on the first run.
        if str(exc).startswith("no match"):
            return Reading(
                target_id=target.id, observed_at=observed, currency="", available=False,
                price=None, price_after_tax=None, plan_name=None, plan_rate_id=None,
                promo=None, note=f"room not offered for these dates ({exc})",
                price_basis="after_tax",
            )  # fmt: skip
        raise

    quotes: list[PlanQuote] = []
    currency = ""
    articles = room.find_all(lambda n: n.tag == "article" and n.has_class("rate-item"))
    for idx, art in enumerate(articles):
        result = _plan_from_article(art, target, idx)
        if result is None:
            continue
        quote, cur = result
        quotes.append(quote)
        currency = currency or (cur or "")
    if target.rate_plan:
        wanted = norm(target.rate_plan)
        quotes = [q for q in quotes if wanted in norm(q.name)]
    if not quotes:
        return Reading(
            target_id=target.id, observed_at=observed, currency=currency, available=False,
            price=None, price_after_tax=None, plan_name=None, plan_rate_id=None, promo=None,
            note="no matching rate plan", price_basis="after_tax",
        )  # fmt: skip
    quotes.sort(key=lambda q: (q.after_tax, not q.refundable, q.name))
    best = quotes[0]
    return Reading(
        target_id=target.id, observed_at=observed, currency=currency or "THB", available=True,
        price=best.after_tax, price_after_tax=best.after_tax, plan_name=best.name,
        plan_rate_id=best.rate_id, promo=best.promo, plans=tuple(quotes), price_basis="after_tax",
    )  # fmt: skip
