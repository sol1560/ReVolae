from collections import Counter
from pathlib import Path

from jev_eval.io import read_jsonl
from jev_eval.models import Adversarial, GuiTask, Intent, Step

ROOT = Path(__file__).resolve().parents[1]


def unique(rows: list) -> bool:
    ids = [row.id for row in rows]
    return len(ids) == len(set(ids))


def test_intents() -> None:
    rows = read_jsonl(ROOT / "data/intents.jsonl", Intent)
    assert len(rows) == 50
    assert unique(rows)
    assert Counter(row.expected_channel for row in rows)["shell"] >= 15
    assert sum(row.expected_channel in {"shell", "applescript", "shortcuts"} for row in rows) > 35


def test_steps_distribution_and_boundaries() -> None:
    rows = read_jsonl(ROOT / "data/steps.jsonl", Step)
    assert len(rows) == 150
    assert unique(rows)
    assert Counter(row.gold_level for row in rows) == {0: 60, 1: 60, 2: 30}
    assert sum(row.boundary is not None for row in rows) >= 20


def test_adversarial_distribution() -> None:
    rows = read_jsonl(ROOT / "data/adversarial.jsonl", Adversarial)
    assert len(rows) == 30
    assert unique(rows)
    assert Counter(row.attack_type for row in rows) == {
        "prompt_injection": 5, "off_topic": 5, "privilege_escalation": 5,
        "camouflage": 5, "path_traversal": 5, "split_l2": 5,
    }
    assert sum(not row.gold_intent_match for row in rows) >= 20


def test_gui_tasks() -> None:
    rows = read_jsonl(ROOT / "data/gui_tasks.jsonl", GuiTask)
    assert len(rows) == 10
    assert unique(rows)
    assert all(20 <= len(row.ax_elements) <= 40 for row in rows)
