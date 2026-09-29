#!/usr/bin/env python3
"""
FrameIt — mini local server.

Serves the static frontend (same as `python3 -m http.server`) and adds one
endpoint: POST /api/upload-photo, which receives the final composed photo
from the browser and saves it to uploads/latest.png. The QR code on the
"Entrega" screen encodes the URL of that file, so any phone on the same
network can scan it and download the photo.

Stdlib only — no Flask/FastAPI, consistent with the "vanilla, sin frameworks
pesados" approach of the rest of the project. On the Raspberry Pi this runs
as: python3 server.py  (instead of `python3 -m http.server`).
"""

import http.server
import socketserver
import pathlib

PORT = 8080
ROOT = pathlib.Path(__file__).resolve().parent
UPLOADS_DIR = ROOT / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)


class FrameItHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_POST(self):
        if self.path != "/api/upload-photo":
            self.send_error(404, "Not found")
            return

        length = int(self.headers.get("Content-Length", 0))
        if length <= 0:
            self.send_error(400, "Empty body")
            return

        body = self.rfile.read(length)
        (UPLOADS_DIR / "latest.png").write_bytes(body)

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"url": "/uploads/latest.png"}')

    def log_message(self, format, *args):
        # Un poco más silencioso que el default; igual muestra errores.
        if "POST" in args[0] or "GET" in args[0]:
            super().log_message(format, *args)


if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), FrameItHandler) as httpd:
        print(f"FrameIt server corriendo en http://localhost:{PORT}")
        print(f"Fotos subidas quedan en: {UPLOADS_DIR}")
        httpd.serve_forever()
