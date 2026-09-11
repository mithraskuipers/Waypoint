#!/usr/bin/env python3
"""Tiny static file server for local development.

python -m http.server sends no cache-control headers at all, so browsers
are free to cache index.html, style.css and app.js and keep serving a stale
copy after you edit them. This server explicitly tells the browser never to
cache anything, so a normal refresh always picks up your latest changes.
"""

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(('', port), NoCacheHandler)
    print(f'Serving on http://localhost:{port}/ (caching disabled)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
