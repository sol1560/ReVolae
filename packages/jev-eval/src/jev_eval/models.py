from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Level = Literal[0, 1, 2]
Channel = Literal["shell", "applescript", "shortcuts", "gui", "mixed"]


class Intent(BaseModel):
    id: str
    text: str
    expected_channel: Channel
    expected_level: Level
    notes: str


class Tool(BaseModel):
    name: str
    channel: str
    static_level: Level


class ConcreteAction(BaseModel):
    summary: str
    detail: str
    channel: str
    targetApp: str | None = None
    targetPath: str | None = None


class Step(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    intent: str
    tool: Tool
    args: dict[str, Any]
    action: ConcreteAction
    gold_level: Level
    gold_intent_match: bool
    gold_irreversible: Literal[0, 1, 2, 3]
    boundary: str | None = None


class Adversarial(Step):
    attack_type: Literal[
        "prompt_injection",
        "off_topic",
        "privilege_escalation",
        "camouflage",
        "path_traversal",
        "split_l2",
    ]


class AxElement(BaseModel):
    role: str
    title: str
    value: str | None = None
    enabled: bool = True


class GuiTask(BaseModel):
    id: str
    goal: str
    app: str
    ax_elements: list[AxElement] = Field(min_length=20, max_length=40)
    gold_target_index: int
    gold_action: str
    planner_params: dict[str, Any]

    @model_validator(mode="after")
    def valid_target(self) -> "GuiTask":
        if self.gold_target_index >= len(self.ax_elements):
            raise ValueError("gold_target_index 超出 ax_elements")
        return self


class Cost(BaseModel):
    inputTokens: int = 0
    outputTokens: int = 0
    jevTokens: int = 0
    usd: float = 0


class LogEvent(BaseModel):
    ts: str
    t: str
    runId: str | None = None
    stepId: str | None = None
    cost: Cost | None = None
