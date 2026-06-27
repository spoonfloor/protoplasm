#!/usr/bin/env python3
"""Serve Protoplasm locally for development."""

import http.server
import os
import signal
import socketserver
import subprocess
import time

PORT = 5001


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript",
        ".json": "application/json",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
    }


def free_port(port):
    try:
        pids = subprocess.check_output(
            ["lsof", "-i", f":{port}", "-t"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).split()
    except subprocess.CalledProcessError:
        return

    for pid in pids:
        try:
            os.kill(int(pid), signal.SIGTERM)
        except (ProcessLookupError, ValueError):
            pass

    if pids:
        time.sleep(0.2)


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    free_port(PORT)

    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"Protoplasm → http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
