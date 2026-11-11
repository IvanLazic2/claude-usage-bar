# Claude Usage Bar

A VS Code extension that shows your Claude Code usage limits and context in the status bar.

```
5h: 34% - 2h10m     7d: 61% - 3d     ctx: 22%
```

- **5h / 7d**: usage of the 5-hour and weekly limits, with time until reset
- **ctx**: context usage of the Claude chat you are looking at

Text turns yellow or red as you approach a limit, and grey when the data is out of date.

## Requirements

- VS Code 1.90 or newer
- Claude Code signed in with a Claude subscription

## Installation

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/IvanLazic2/claude-usage-bar/main/install.ps1 | iex
```

Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/IvanLazic2/claude-usage-bar/main/install.sh | sh
```

Or download the `.vsix` from [Releases](https://github.com/IvanLazic2/claude-usage-bar/releases) and run **Extensions: Install from VSIX...**.

The extension checks for new releases once a day and asks before installing. To check manually, run **Claude Usage Bar: Check for updates**.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeUsageBar.limitWarning` | `70` | 5h/7d percentage at which the text turns yellow |
| `claudeUsageBar.limitCritical` | `90` | 5h/7d percentage at which the text turns red |
| `claudeUsageBar.contextWarning` | `50` | Context percentage at which the text turns yellow |
| `claudeUsageBar.contextCritical` | `70` | Context percentage at which the text turns red |
| `claudeUsageBar.contextHideAfterMinutes` | `30` | Hide context when no Claude tab is open and the last session has been idle this long |
| `claudeUsageBar.contextWindow` | `0` | Context window size in tokens; `0` detects it from the model |
| `claudeUsageBar.checkForUpdates` | `true` | Check GitHub Releases for new versions |

## Privacy

Limits are fetched with Claude Code's own sign-in from `~/.claude/.credentials.json`. The token is sent only to `api.anthropic.com` and is never stored or refreshed by the extension. Context is read from Claude Code's local session files. The extension does not modify any Claude Code files.

The usage endpoint is undocumented and may change without notice.

## Development

```sh
npm install
npm run check     # type-check
npm run package   # build a local .vsix
```
