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
KEY = os.environ.get("BHARATCODE_API_KEY", "")
API = "https://bharatcode.ai/api/model/v1/responses"

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/api/responses":
            self.send_error(404); return
        if not KEY:
            self.send_error(404); return  # app falls back to stored key / demo
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
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
        except Exception as e:
            self.send_error(502, str(e))

    def log_message(self, fmt, *args):
        sys.stderr.write("[swasthyasetu] " + fmt % args + "\n")

if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f"Serving SwasthyaSetu at http://localhost:{PORT}  (API proxy: {'on' if KEY else 'off - no key'})")
    http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
