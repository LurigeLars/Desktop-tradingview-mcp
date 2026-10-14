# Windows: Task Scheduler-owned DTV HTTP server

## Why

The previous `TradingViewMcpHttpServer` task invokes a short-lived hidden
launcher that starts `node.exe` and then exits. A normal Task Scheduler
`restart` may therefore leave an orphaned HTTP listener on 127.0.0.1:8765;
the task records result `1` while the old server continues serving the old code.

The managed task launcher is instead **directly** `node.exe` with
`scripts/windows/http-managed.js --cdp-port=9222` (or 9333 after verification).
Stopping the Windows task terminates the actual listener process.
Neither entrypoint starts/stops TradingView Desktop or changes chart layouts.

## One-time installation

From PowerShell in the interactive account that owns the existing task:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Desktop-tradingview\scripts\windows\install-managed-http-task.ps1" -Apply -Confirm:$false
```

The installer aborts without changes unless it can verify:

- The clean `main` checkout and exact GitHub origin in LOCALAPPDATA.
- Exactly one existing task named `TradingViewMcpHttpServer`, owned by the current user.
- Its existing action is the known DTV HTTP launcher, not an arbitrary executable.
- Exactly one validated DTV Chrome DevTools chart endpoint on 9222 or 9333.
- Port 8765 is either free or owned by the expected Node DTV HTTP command.

If **both** CDP endpoints serve TradingView charts, select the correct one
explicitly with `-CdpPort 9222` or `-CdpPort 9333` after checking.

Before changing the task action, the script exports its XML to
`%LOCALAPPDATA%\DTV-Http-Task-Backups`. It changes only that task's
**action**; existing trigger, principal, run level, settings and other tasks
are preserved. It then retires only the validated old HTTP listener and
performs two launches separated by a Task Scheduler stop. The second launch
must have a different PID, with the task reporting `Running` and port 8765
rebound, otherwise the migration reports failure. If an error occurs it
attempts to restore the original task action and retains the XML backup.

## Normal remote operation (after a successful migration)

The Docker MCP host allowlist alias remains `desktop-tradingview-http`.

```text
scheduled_task_control(task="desktop-tradingview-http",operation="restart")
scheduled_task_status(task="desktop-tradingview-http")
```

Expect task status **Running** during service operation, and a new Node
listener PID following each restart. `Ready` with result `1` is no longer
considered a successful HTTP restart. Confirm DTV MCP connectivity and
that chart/source identity remains correct before resuming any automated
symbol provisioning. Restarting Docker's gateway container is not a
substitute for restarting the Windows HTTP listener.

## Rollback

Re-register the backed-up task XML from
`%LOCALAPPDATA%\DTV-Http-Task-Backups` using Windows Task Scheduler
if the action cannot be safely restored. Do not kill TradingView Desktop
or blanket-kill `node.exe`; resolve only the verified 127.0.0.1:8765 owner.
