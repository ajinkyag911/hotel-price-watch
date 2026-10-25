"""A small DOM built on the stdlib HTMLParser, enough to query booking-engine markup."""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator
from html import unescape
from html.parser import HTMLParser

_VOID = {
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
    "param", "source", "track", "wbr",
}  # fmt: skip
_WS = re.compile(r"\s+")


class Node:
    __slots__ = ("attrs", "children", "parent", "tag", "text_parts")

    def __init__(self, tag: str, attrs: dict[str, str], parent: Node | None) -> None:
        self.tag = tag
        self.attrs = attrs
        self.parent = parent
        self.children: list[Node] = []
        self.text_parts: list[str] = []

    @property
    def classes(self) -> set[str]:
        return set(self.attrs.get("class", "").split())

    def has_class(self, *names: str) -> bool:
        return all(n in self.classes for n in names)

    def iter(self) -> Iterator[Node]:
        yield self
        for child in self.children:
            yield from child.iter()

    def find_all(self, pred: Callable[[Node], bool]) -> list[Node]:
        return [n for n in self.iter() if n is not self and pred(n)]

    def find(self, pred: Callable[[Node], bool]) -> Node | None:
        return next((n for n in self.iter() if n is not self and pred(n)), None)

    def text(self) -> str:
        """Visible text, whitespace-collapsed, scripts and styles excluded."""
        parts: list[str] = []
        for n in self.iter():
            if n.tag in ("script", "style"):
                continue
            parts.extend(n.text_parts)
        return _WS.sub(" ", unescape(" ".join(parts))).strip()

    def own_text(self) -> str:
        return _WS.sub(" ", unescape(" ".join(self.text_parts))).strip()


class _TreeBuilder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.root = Node("#root", {}, None)
        self._cur = self.root

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = Node(tag, {k: v or "" for k, v in attrs}, self._cur)
        self._cur.children.append(node)
        if tag not in _VOID:
            self._cur = node

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._cur.children.append(Node(tag, {k: v or "" for k, v in attrs}, self._cur))

    def handle_endtag(self, tag: str) -> None:
        node = self._cur
        while node is not self.root and node.tag != tag:
            node = node.parent  # type: ignore[assignment]
        if node is not self.root:
            self._cur = node.parent  # type: ignore[assignment]

    def handle_data(self, data: str) -> None:
        if data.strip():
            self._cur.text_parts.append(data)

    def handle_entityref(self, name: str) -> None:
        self._cur.text_parts.append(f"&{name};")

    def handle_charref(self, name: str) -> None:
        self._cur.text_parts.append(f"&#{name};")


def parse_html(markup: str) -> Node:
    builder = _TreeBuilder()
    builder.feed(markup)
    builder.close()
    return builder.root
