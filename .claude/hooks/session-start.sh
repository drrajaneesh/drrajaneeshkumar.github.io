#!/bin/bash
set -euo pipefail

# Cloud sessions start from a clean ~/.claude, so the repo's effort-optimizer
# plugin (enabled in .claude/settings.json) has to be installed each time
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

marketplace=.claude/marketplaces/benai-effort-optimizer
plugin=effort-optimizer@benai-effort-optimizer

# Skip when already installed (the hook also runs on resume, clear and compact)
if claude plugin list 2>/dev/null | grep -q "effort-optimizer@benai-effort-optimizer"; then
  exit 0
fi

claude plugin marketplace add "./$marketplace" >&2
claude plugin install "$plugin" --scope project >&2
