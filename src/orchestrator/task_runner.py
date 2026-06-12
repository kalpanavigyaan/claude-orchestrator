"""Run a single task through the Claude Agent SDK.

This module builds the Claude Agent SDK options for one task (working directory, readable
scope, permission callback, system prompt, and turn cap), streams the agent's messages
while logging progress, and returns a :class:`~orchestrator.data_models.TaskRunResult`
that captures success, turn count, token usage, cost, and whether the run was stopped by a
usage limit.

The Claude Agent SDK drives the local ``claude`` command-line tool, which authenticates
using the existing Claude Code subscription login (no API key is required).
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from .data_models import Configuration, Task, TaskRunResult
from .logging_setup import get_logger
from .permissions import build_tool_permission_callback
from .prompts import build_system_prompt
from .usage import usage_from_sdk_usage_dictionary


def _summarize_assistant_message(message) -> None:
    """Log a concise summary of one assistant message (text and tool calls).

    Args:
        message: An ``AssistantMessage`` from the Claude Agent SDK whose ``content`` is a
            list of content blocks.

    Example:
        >>> # _summarize_assistant_message(assistant_message)  # logs text and tool names
    """
    logger = get_logger()
    for block in getattr(message, "content", []) or []:
        text_value = getattr(block, "text", None)
        if isinstance(text_value, str) and text_value.strip():
            logger.info("agent: %s", text_value.strip())
            continue
        tool_name = getattr(block, "name", None)
        if tool_name:
            logger.info("agent tool call: %s", tool_name)


async def run_single_task(
    task: Task,
    configuration: Configuration,
    now: datetime | None = None,
) -> TaskRunResult:
    """Run one task through the Claude Agent SDK and return its result.

    Builds the SDK options so the agent can read the configured scope but only write inside
    the task's repository, then streams the agent's messages and records the final usage.

    Args:
        task: The task to run.
        configuration: The validated configuration providing scope and defaults.
        now: The current time, used for the system prompt's report date. Defaults to now.

    Returns:
        A :class:`TaskRunResult` describing the outcome.

    Example:
        >>> # import asyncio
        >>> # result = asyncio.run(run_single_task(task, configuration))
        >>> # result.succeeded in (True, False)
        >>> True
        True
    """
    from claude_agent_sdk import (
        AssistantMessage,
        ClaudeAgentOptions,
        ResultMessage,
        query,
    )

    try:
        from claude_agent_sdk import RateLimitEvent
    except ImportError:  # Older SDK versions may not expose this event type.
        RateLimitEvent = ()  # type: ignore[assignment]

    logger = get_logger()
    moment = now or datetime.now()
    push_enabled = task.push_override if task.push_override is not None else configuration.defaults.push

    system_prompt = {
        "type": "preset",
        "preset": "claude_code",
        "append": build_system_prompt(task, push_enabled=push_enabled, now=moment),
    }

    option_keyword_arguments = {
        "cwd": str(task.repository_path),
        "add_dirs": [str(root) for root in configuration.scope.readable_roots],
        "system_prompt": system_prompt,
        "permission_mode": configuration.defaults.permission_mode,
        "max_turns": configuration.defaults.maximum_turns,
        "can_use_tool": build_tool_permission_callback(
            configuration.scope.readable_roots, task.repository_path
        ),
    }
    if configuration.defaults.model:
        option_keyword_arguments["model"] = configuration.defaults.model

    options = ClaudeAgentOptions(**option_keyword_arguments)

    result = TaskRunResult(task=task)
    logger.info("Starting task from %s targeting %s", task.instruction_path, task.repository_path)

    try:
        async for message in query(prompt=task.body_text, options=options):
            if RateLimitEvent and isinstance(message, RateLimitEvent):
                logger.warning("Usage limit reached during task %s.", task.instruction_path)
                result.rate_limited = True
                continue
            if isinstance(message, AssistantMessage):
                _summarize_assistant_message(message)
                continue
            if isinstance(message, ResultMessage):
                result.number_of_turns = getattr(message, "num_turns", 0) or 0
                result.usage = usage_from_sdk_usage_dictionary(
                    getattr(message, "usage", None), getattr(message, "total_cost_usd", None)
                )
                result.summary_text = getattr(message, "result", None)
                result.succeeded = not getattr(message, "is_error", False)
                if getattr(message, "api_error_status", None):
                    result.error_message = f"API error status {message.api_error_status}"
    except Exception as error:  # noqa: BLE001 - one task failing must not abort the batch
        logger.exception("Task %s failed with an exception.", task.instruction_path)
        result.succeeded = False
        result.error_message = str(error)

    logger.info(
        "Finished task %s: succeeded=%s turns=%d cost=$%.4f",
        task.instruction_path,
        result.succeeded,
        result.number_of_turns,
        result.usage.cost_usd,
    )
    return result
