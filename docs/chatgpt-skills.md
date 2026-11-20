# ChatGPT DTV skills packaging

This repository ships two bundled skills under `skills/`:

- `realtime-market-data`: quote session/freshness semantics, pre/post-market `rtc`, safe market-data routing.
- `desktop-operations`: reversible chart and desktop operations.

For a new ChatGPT DTV installation, first register/connect the existing DTV MCP app. Then package the skills with that app using:

```sh
python scripts/build_chatgpt_plugin.py --app-id asdk_app_YOUR_DTV_APP_ID --output dist/dtv-plugin.zip
```

Install the generated plugin archive through your plugin management workflow. The generated `.app.json` references the **existing** DTV MCP app; it does not deploy or duplicate the MCP server. Never publish your generated archive as a generic package: the app ID is installation-specific.

Treat this repository's two skills as canonical. For an **existing** app-backed DTV plugin, preserve its current `.app.json`, app identity and presentation, add `skills/` and `"skills": "./skills"` to its existing `.codex-plugin/plugin.json`, and publish a versioned plugin update. Do not replace an existing plugin with the generic archive unless deliberately creating a new plugin.

If a standalone workflow plugin is installed alongside the app-backed plugin, verify equivalent behavior and app access in a fresh chat before retiring the standalone package. Keep the existing MCP app identity.

Validation: inspect the published plugin file list for both `SKILL.md` files, verify the realtime skill includes `rtc_age_at_retrieval_ms`, and check `quote_get` can still read a valid symbol. During `pre_market`/`post_market`, `rtc` and its own timestamp govern current extended-hours freshness; stale regular-session `last` alone is not a quote failure.

Do not use the retired Official TradingView MCP as a fallback.
