#!/usr/bin/env python3
"""Local server for the Mocon web games.

Serves web/ like `python3 -m http.server`, but tells the browser not to cache files, so an edited
game is always picked up on reload, and listens on IPv4 and IPv6 so http://localhost always works.

Usage:  python3 tools/devserver.py [port]      (default 8080)
"""
import http.server
import socket
import sys
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


class DualStackServer(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    with DualStackServer(("::", port), Handler) as httpd:
        print(f"Serving {WEB} at http://localhost:{port}/  (Ctrl-C to stop)", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
