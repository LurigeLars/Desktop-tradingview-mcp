#!/usr/bin/env python3
"""Build a DTV ChatGPT plugin archive with bundled skills.

Usage: python scripts/build_chatgpt_plugin.py --app-id asdk_app_... --output dist/dtv-plugin.zip
The app ID must be the ID of the user's existing DTV MCP app, not a public/shared ID.
"""
import argparse
import json
import re
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ("realtime-market-data", "desktop-operations")

def build(app_id: str, output: Path) -> None:
    if not re.fullmatch(r"asdk_app_[A-Za-z0-9_]+", app_id):
        raise ValueError("Expected an existing asdk_app_... app ID")
    manifest = {
        "name": "dtv-desktop",
        "version": "1.0.0",
        "description": "TradingView Desktop MCP connection with bundled market-data and desktop-operation skills.",
        "apps": "./.app.json",
        "skills": "./skills",
        "interface": {
            "displayName": "DTV",
            "shortDescription": "TradingView Desktop MCP",
            "longDescription": "TradingView Desktop MCP with session-aware data and desktop workflows.",
            "developerName": "App developer",
            "category": "Other",
            "capabilities": [],
        },
    }
    app_config = {"apps": {"dtv": {"id": app_id, "required": True}}}
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w", ZIP_DEFLATED) as z:
        z.writestr(".codex-plugin/plugin.json", json.dumps(manifest, indent=2) + "\n")
        z.writestr(".app.json", json.dumps(app_config, indent=2) + "\n")
        for name in SKILLS:
            path = ROOT / "skills" / name / "SKILL.md"
            if not path.is_file():
                raise FileNotFoundError(path)
            z.write(path, f"skills/{name}/SKILL.md")
    print(f"Created {output}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-id", required=True, help="Existing DTV MCP app ID")
    parser.add_argument("--output", type=Path, default=Path("dist/dtv-plugin.zip"))
    args = parser.parse_args()
    build(args.app_id, args.output)
