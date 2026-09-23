"""OpenAI Agents SDK manager delegating durable work to Chusky A2A.

Install:
    pip install openai-agents httpx

The Agents SDK does not need a custom A2A transport here. Chusky is exposed as
two narrow function tools, so the SDK keeps control of the user-facing agent,
guardrails, and final response while Chusky owns the durable mission.
"""

from __future__ import annotations

import json
import os
import hashlib
from typing import Any

import httpx
from agents import Agent, Runner, function_tool


CHUSKY_A2A_URL = os.environ["CHUSKY_A2A_URL"].rstrip("/")
CHUSKY_API_KEY = os.environ["CHUSKY_API_KEY"]
# Set this in deployment configuration. Never let the model choose it.
CHUSKY_CALLER_ID = os.environ["CHUSKY_CALLER_ID"]


def idempotency_key(title: str, objective: str, definition_of_done: str) -> str:
    body = json.dumps([title, objective, definition_of_done], separators=(",", ":"), ensure_ascii=True)
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:32]
    return f"openai-agents-{CHUSKY_CALLER_ID}-{digest}"


async def chusky_rpc(method: str, params: dict[str, Any], *, idempotency_key: str | None = None) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {CHUSKY_API_KEY}",
        "X-Chusky-User-Id": CHUSKY_CALLER_ID,
        "A2A-Version": "1.0",
        "Content-Type": "application/a2a+json",
        "Accept": "application/a2a+json, application/json",
    }
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key

    async with httpx.AsyncClient(timeout=30) as client:
        response = await client.post(
            f"{CHUSKY_A2A_URL}/a2a/rpc",
            headers=headers,
            json={"jsonrpc": "2.0", "id": f"openai-agents-{method}", "method": method, "params": params},
        )
        response.raise_for_status()
        body = response.json()
        if body.get("error"):
            raise RuntimeError(body["error"].get("message", "Chusky A2A request failed"))
        return body["result"]


@function_tool
async def chusky_start_task(objective: str, title: str, definition_of_done: str) -> str:
    """Start a durable, governed Chusky mission and return its task handle."""
    result = await chusky_rpc(
        "message/send",
        {
            "contextId": f"openai-agents-{CHUSKY_CALLER_ID}",
            "message": {"role": "ROLE_USER", "parts": [{"text": objective}]},
            "title": title,
            "definitionOfDone": definition_of_done,
        },
        idempotency_key=idempotency_key(title, objective, definition_of_done),
    )
    task = result["task"]
    return json.dumps({"taskId": task["id"], "state": task["status"]["state"]})


@function_tool
async def chusky_get_task(task_id: str) -> str:
    """Read the status of a task previously created by this caller."""
    result = await chusky_rpc("tasks/get", {"id": task_id})
    task = result["task"]
    return json.dumps({
        "taskId": task["id"],
        "state": task["status"]["state"],
        "message": task["status"].get("message"),
        "artifacts": task.get("artifacts", []),
    })


manager = Agent(
    name="Chusky delegation manager",
    instructions=(
        "Delegate browser-heavy, meeting, artifact, or long-running work to Chusky. "
        "Start a task once, retain the returned task ID, and use chusky_get_task for "
        "later status checks. Never claim completion from submission alone. Do not "
        "request credentials or change the caller identity."
    ),
    tools=[chusky_start_task, chusky_get_task],
)


async def main() -> None:
    result = await Runner.run(manager, "Ask Chusky to prepare a verified meeting brief for tomorrow's customer call.")
    print(result.final_output)


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())
