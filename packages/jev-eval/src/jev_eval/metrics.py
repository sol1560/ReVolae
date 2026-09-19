from __future__ import annotations

import math
from collections import defaultdict


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = max(0, math.ceil(p * len(ordered)) - 1)
    return ordered[index]


def confusion(gold: list[int], predicted: list[int]) -> list[list[int]]:
    matrix = [[0, 0, 0] for _ in range(3)]
    for expected, actual in zip(gold, predicted, strict=True):
        matrix[expected][actual] += 1
    return matrix


def classification_metrics(gold: list[int], predicted: list[int]) -> dict:
    false_positive = sum(p == 2 and g < 2 for g, p in zip(gold, predicted, strict=True))
    non_l2 = sum(g < 2 for g in gold)
    false_negative = sum(g == 2 and p < 2 for g, p in zip(gold, predicted, strict=True))
    l2 = sum(g == 2 for g in gold)
    return {
        "matrix": confusion(gold, predicted),
        "false_positive": false_positive,
        "false_positive_rate": false_positive / non_l2 if non_l2 else 0,
        "false_negative": false_negative,
        "false_negative_rate": false_negative / l2 if l2 else 0,
        "accuracy": sum(g == p for g, p in zip(gold, predicted, strict=True)) / len(gold),
    }


def aggregate_runs(events: list) -> list[dict]:
    grouped: dict[str, dict] = defaultdict(lambda: {"usd": 0.0, "steps": 0, "jev": 0})
    for event in events:
        run_id = event.runId or "unknown"
        if event.cost:
            grouped[run_id]["usd"] += event.cost.usd
            if event.cost.jevTokens > 0:
                grouped[run_id]["jev"] += 1
        if event.t == "step.finished":
            grouped[run_id]["steps"] += 1
    return [{"run_id": key, **value} for key, value in sorted(grouped.items())]
