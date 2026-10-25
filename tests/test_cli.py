from __future__ import annotations

import json
from pathlib import Path

import pytest

from hotelwatch import cli
from hotelwatch.models import Reading
from hotelwatch.providers.base import ProviderError


class FakeProvider:
    name = "swiftbook"

    def __init__(self, price: float | None = 40036.0, fail: bool = False) -> None:
        self.price = price
        self.fail = fail

    def fetch(self, target) -> Reading:
        if self.fail:
            raise ProviderError("boom")
        return Reading(
            target_id=target.id,
            observed_at=Reading.now(),
            currency="INR",
            available=True,
            price=self.price,
            price_after_tax=self.price * 1.18,
            plan_name="Plan",
            plan_rate_id="1",
            promo=None,
        )

    @classmethod
    def matches_url(cls, url: str) -> bool:
        return True


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    watchlist = {
        "targets": [
            {
                "id": "riva",
                "name": "Riva",
                "url": "https://www.swiftbook.io/inst/#home?propertyId=x==&JDRN=Y",
                "provider": "swiftbook",
                "room": "Room",
                "check_in": "2027-01-29",
                "check_out": "2027-02-02",
                "alert_below": 36000,
            }
        ]
    }
    (tmp_path / "watchlist.json").write_text(json.dumps(watchlist))
    return tmp_path


def _argv(ws: Path, *extra: str) -> list[str]:
    return [
        "--watchlist",
        str(ws / "watchlist.json"),
        "--history",
        str(ws / "data/history.jsonl"),
        *extra,
    ]


def test_validate_ok(workspace: Path, capsys) -> None:
    assert cli.main(_argv(workspace, "validate")) == 0
    assert "1 target(s) valid" in capsys.readouterr().out


def test_validate_bad_json(workspace: Path) -> None:
    (workspace / "watchlist.json").write_text("{nope")
    assert cli.main(_argv(workspace, "validate")) == 2


def test_run_writes_history_site_and_alerts(workspace: Path, monkeypatch) -> None:
    monkeypatch.setattr(cli, "get_provider", lambda name: FakeProvider(price=35000.0))
    monkeypatch.setattr(cli, "send_ntfy", lambda alerts: False)
    site = workspace / "docs/data/history.json"
    alerts = workspace / "data/alerts.json"
    rc = cli.main(_argv(workspace, "run", "--site", str(site), "--alerts", str(alerts)))
    assert rc == 0
    assert (workspace / "data/history.jsonl").read_text().count("\n") == 1
    data = json.loads(site.read_text())
    assert data["targets"][0]["stats"]["current"] == 35000.0
    assert data["targets"][0]["stats"]["below_alert"] is True
    assert [a["kind"] for a in json.loads(alerts.read_text())] == ["threshold"]


def test_run_clears_stale_alerts_file(workspace: Path, monkeypatch) -> None:
    monkeypatch.setattr(cli, "get_provider", lambda name: FakeProvider(price=40036.0))
    alerts = workspace / "data/alerts.json"
    alerts.parent.mkdir()
    alerts.write_text("[]")
    cli.main(_argv(workspace, "run", "--site", str(workspace / "s.json"), "--alerts", str(alerts)))
    assert not alerts.exists()


def test_run_dry_run_writes_nothing(workspace: Path, monkeypatch, capsys) -> None:
    monkeypatch.setattr(cli, "get_provider", lambda name: FakeProvider())
    rc = cli.main(_argv(workspace, "run", "--dry-run", "--site", str(workspace / "s.json")))
    assert rc == 0
    assert not (workspace / "data/history.jsonl").exists()
    assert '"price": 40036.0' in capsys.readouterr().out


def test_run_reports_provider_failure(workspace: Path, monkeypatch) -> None:
    monkeypatch.setattr(cli, "get_provider", lambda name: FakeProvider(fail=True))
    rc = cli.main(_argv(workspace, "run", "--site", str(workspace / "s.json")))
    assert rc == 1
    assert not (workspace / "data/history.jsonl").exists()
    # The site file is still rebuilt so the page never goes stale on a transient failure.
    assert (workspace / "s.json").exists()


def test_show_without_history(workspace: Path, capsys) -> None:
    assert cli.main(_argv(workspace, "show")) == 0
    assert "no readings yet" in capsys.readouterr().out
