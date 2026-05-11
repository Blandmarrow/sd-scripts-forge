#!/usr/bin/env python3
"""Start the Forge web UI server.

Usage:
    python forge.py [--host HOST] [--port PORT]
"""
import argparse
import sys

import uvicorn

from forge_server.config import settings


def main():
    parser = argparse.ArgumentParser(description="Forge — sd-scripts web UI")
    parser.add_argument("--host", default=settings.server_host)
    parser.add_argument("--port", type=int, default=settings.server_port)
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload (development)")
    args = parser.parse_args()

    print(f"[Forge] Starting server at http://{args.host}:{args.port}")
    print(f"[Forge] sd-scripts root: {settings.sd_scripts_root}")
    print(f"[Forge] Models dir:      {settings.models_dir}")
    print(f"[Forge] Datasets dir:    {settings.datasets_dir}")
    print(f"[Forge] Output dir:      {settings.output_dir}")

    uvicorn.run(
        "forge_server.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
