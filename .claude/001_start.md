# Claude Orchestrator

Goal is to build a cli/terminal app which will run on windows host and for given set of markdowns directed to repos in windows host or wsl distros, it will read the instructions in the md file and work on the repos. These could be new repos or existing repos which need refactoring.

## Configuration

1. yaml files
2. Scope: will provide scope of folders in windows host and wsl2. Claude can see these folders but cannot modify until it is specifically instructed to do so in the markdown files.
3. Schedule: Start time and end time to run these agents
4. It is expected that there will be no user feedback during this time so Claude is expected to perform the tasks independently

## Instruction md files

1. See the folder instructions
2. This is where Claude will look for tasks to be performed
3. User will instruct which subfolder(s) to look for tasks
4. Claude will read the tasks and complete them
5. All codes need to tested, validated, documented and committed and pushed periodically
6. Claude will summarize the work and put in md file in the same subfolder(s) as REPORT_YYYYMMDD.md with dates and times and tasks and commit history. Claude can use multiple md files if needed and wire them together but one REPORT.md for one repo

## Running

1. User will run a cli command and direct to the subfolder(s) and claude will start working
2. Claude will periodically check for account usage and time to reset which is 5h and then wait for the reset if tokens are used up

## Maintenance

1. Claude will periodically document the code with md files
2. Claude will periodically commit the codes with details of what was performed
3. Claude will not abbreviate variable, function or file names. Claude will use full names
4. All functions will have docstrings with detailed example

## Python

1. Use uv only
2. Use uv add not uv pip add
3. Put scripts in scripts/
4. Make _setup_python.ps1 file to create .venv and it needs to have all the packages
5. As you add packages keep updating the ps1 file
6. Do not depend on pyproject.toml
7. If I delete the pyproject.toml, just by running scripts/_setup_python.ps1 Python should be installed with all packages
8. In the ps1 remove .venv and pyproject.toml file
9. Use Python 3.13 and put this as a variable
