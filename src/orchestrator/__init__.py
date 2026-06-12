"""claude-orchestrator: drive autonomous Claude Code agents from markdown task files.

The package reads task instructions written as markdown files, then runs the Claude
Agent SDK against each named target repository inside a fixed folder scope and a fixed
time window, with no human in the loop. Each public module has a single responsibility:

    configuration          Load and validate the YAML configuration.
    data_models            Plain data containers shared across modules.
    discovery              Find and parse instruction markdown files into tasks.
    scope                  Normalize paths and decide read/write boundaries.
    permissions            Build the Agent SDK tool-permission callback.
    scheduler              Wait for the start time and guard the end time.
    usage                  Track token usage and wait for the 5-hour reset.
    task_runner            Run a single task through the Claude Agent SDK.
    git_operations         Repository helpers and safety-net commits.
    reporting              Write the per-repository REPORT_YYYYMMDD.md file.
    prompts                Build the autonomy system prompt.
    logging_setup          Configure console and file logging.
    command_line_interface The Typer command-line application.
"""

APPLICATION_NAME = "claude-orchestrator"
APPLICATION_VERSION = "0.1.0"
