#!/usr/bin/env python3
"""SwasthyaSetu local server: serves the static app and proxies /api/responses
to the BharatCode API with your key kept out of the browser.

Usage:
    export BHARATCODE_API_KEY=sk-...
    python3 serve.py            # then open http://localhost:8000

Without BHARATCODE_API_KEY it still serves the app; the AI reader then falls
back to a key you paste in the UI or to demo mode for the sample documents.
"""
import http.server, json, os, urllib.request, sys

PORT = int(os.environ.get("PORT", "8000"))
HOST = os.environ.get("HOST", "127.0.0.1")
if HOST not in {"127.0.0.1", "::1", "localhost"}:
    raise RuntimeError("serve.py is a local development server and only accepts a loopback HOST")
MAX_PROXY_BODY = 2 * 1024 * 1024
KEY = os.environ.get("BHARATCODE_API_KEY", "")
API = "https://bharatcode.ai/api/model/v1/responses"

class Handler(http.server.SimpleHTTPRequestHandler):
    def _valid_host(self):
        allowed = {f"{host}:{PORT}".lower() for host in ("localhost", "127.0.0.1", "::1", HOST)}
        allowed.add(f"[::1]:{PORT}")
        return self.headers.get("Host", "").lower() in allowed

    def do_GET(self):
        if not self._valid_host():
            self.send_error(421, "Unexpected Host"); return
        super().do_GET()

    def do_HEAD(self):
        if not self._valid_host():
            self.send_error(421, "Unexpected Host"); return
        super().do_HEAD()

    def translate_path(self, path):
        resolved = os.path.realpath(super().translate_path(path))
        root = os.path.realpath(os.path.dirname(__file__))
        try:
            relative = os.path.relpath(resolved, root)
        except ValueError:
            relative = ".."
        if relative == ".." or relative.startswith(".." + os.sep) or any(part.startswith(".") for part in relative.split(os.sep)):
            return os.path.join(root, "__not_found__")
        return resolved

    def list_directory(self, path):
        self.send_error(404, "Directory listing is disabled")
        return None

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://bharatcode.ai; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        super().end_headers()

    def do_POST(self):
        if not self._valid_host():
            self.send_error(421, "Unexpected Host"); return
        if self.path != "/api/responses":
            self.send_error(404); return
        if not KEY:
            self.send_error(404); return  # app falls back to stored key / demo
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length < 1 or length > MAX_PROXY_BODY:
                self.send_error(413, "Request body too large or empty"); return
            if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
                self.send_error(415, "Expected application/json"); return
            body = self.rfile.read(length)
            json.loads(body)
            req = urllib.request.Request(API, data=body, method="POST", headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + KEY,
            })
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = resp.read()
                self.send_response(resp.status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(e.read()[:2000])
        except (ValueError, json.JSONDecodeError):
            self.send_error(400, "Invalid JSON")
        except Exception:
            self.send_error(502, "Upstream request failed")

    def log_message(self, fmt, *args):
        sys.stderr.write("[swasthyasetu] " + fmt % args + "\n")

if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f"Serving SwasthyaSetu at http://{HOST}:{PORT}  (API proxy: {'on' if KEY else 'off - no key'})")
    http.server.ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()

