#!/usr/bin/env python3
"""Egress test collector: logs every request (method, path, headers, body, body hash).

SHA256(BODY) is logged alongside the body so judgments can be made by
cryptographic equality (compare against a separately registered hash of the
real secret) instead of value-prefix inspection.

Canonical copy: scripts/e2e-collector.py in the pi-data-masking repository.
Deployment (collector host): copy to ~/egress-test/collector.py and run it
under a systemd user service (egress-collector) listening on :8899 — see
docs/egress-scoping-test-plan.md §1.1/§4.
"""
import http.server, datetime, hashlib

class H(http.server.BaseHTTPRequestHandler):
    def _log(self):
        ts = datetime.datetime.now().isoformat(timespec="seconds")
        body = b""
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            body = self.rfile.read(n)
        with open("/home/agent/egress-test/requests.log", "a") as f:
            f.write(f"=== {ts} {self.command} {self.path} from {self.client_address[0]}\n")
            for k, v in self.headers.items():
                if k.lower() in ("host", "user-agent", "authorization", "x-api-key", "content-type"):
                    f.write(f"  {k}: {v[:200]}\n")
            if body:
                f.write("  BODY_SHA256: " + hashlib.sha256(body).hexdigest() + "\n")
                f.write("  BODY: " + body[:2000].decode("utf-8", "replace") + "\n")
        payload = b"ok\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    do_GET = do_POST = do_PUT = do_DELETE = _log
    def log_message(self, *a):
        pass

H.protocol_version = "HTTP/1.1"
http.server.HTTPServer(("0.0.0.0", 8899), H).serve_forever()
