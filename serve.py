#!/usr/bin/env python3
"""
Doctorna Directory — local development server.

Plain `python -m http.server` works, but it lets the browser cache JavaScript
and JSON aggressively. During development that means a fixed file can sit behind
a stale cached copy, which looks exactly like a broken build. This server sends
`Cache-Control: no-cache` so every request is revalidated and you always
see what is on disk, while unchanged files still come from cache.

Usage:
    python serve.py            # http://localhost:8080
    python serve.py 3000       # choose a port

Standard library only — no install, no dependencies.
"""
import http.server
import socketserver
import sys
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class Handler(http.server.SimpleHTTPRequestHandler):
    """Serves this folder with correct MIME types, keep-alive and revalidation."""

    # http.server defaults to HTTP/1.0, which closes the socket after every
    # response and gives the browser no keep-alive. Downloading the 5 MB
    # doctors.json over that could stall for a long time or be dropped
    # mid-stream, which the page then reported as a load failure. HTTP/1.1
    # keeps the connection open and frames responses by Content-Length.
    protocol_version = "HTTP/1.1"

    # Some Windows Python installs read .js/.json types from the registry and
    # get them wrong, which makes browsers refuse to execute modules.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".ico": "image/x-icon",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # "no-cache" = always revalidate, but a 304 still serves from cache.
        # (Not "no-store", which would force a full 7.6 MB re-download every
        # visit.) The app additionally versions its data URLs, so changed files
        # are fetched fresh and unchanged ones come straight from cache.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        status = str(args[1]) if len(args) > 1 else ""
        # Keep failures visible; stay quiet about the hundreds of 200s and 304s
        # (a 304 is a successful "your cached copy is still good").
        if not status.startswith("2") and status != "304":
            sys.stderr.write("  %s\n" % (fmt % args))


def main():
    missing = [
        name
        for name in ("index.html", "js/main.js", "data/meta.json", "data/doctors.json")
        if not (ROOT / name).exists()
    ]
    if missing:
        sys.exit(
            "Cannot start: these required files are missing from %s\n  %s"
            % (ROOT, "\n  ".join(missing))
        )

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
        url = "http://localhost:%d/" % PORT
        print("Doctorna Directory")
        print("  serving : %s" % ROOT)
        print("  address : %s" % url)
        print("  caching : revalidate every request (no stale files)")
        print("  http    : 1.1 keep-alive")
        print("  stop    : Ctrl+C")
        try:
            webbrowser.open(url)
        except Exception:
            pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped.")


if __name__ == "__main__":
    main()
