"""Éditeur web local du keymap et des couleurs du Sofle.

Démarre un petit serveur HTTP sur 127.0.0.1 (accessible uniquement depuis ce
PC) et ouvre la page tools/config-editor/ dans le navigateur.

Le serveur est en LECTURE SEULE : il fournit à la page le contenu de
  - config/sofle.keymap        (noms des layers, behaviors personnalisés)
  - config/sofle_layers.dtsi   (mapping des touches)
  - config/sofle_colors.dtsi   (couleurs par layer)
  - keymap_drawer.config.yaml  (libellés lisibles, comme pour le schéma)
et n'écrit jamais dans le dépôt. Les modifications s'exportent depuis la page
(copier / télécharger), à coller ensuite dans les fichiers.

Usage :
  python scripts/config_editor.py [--port 8765] [--no-browser]
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

try:
    import yaml
except ImportError:  # PyYAML est installé avec keymap-drawer
    sys.exit("PyYAML n'est pas installé : pip install -r scripts/requirements.txt")

REPO = Path(__file__).resolve().parent.parent
STATIC = REPO / "tools" / "config-editor"
FILES = {
    "keymap": REPO / "config" / "sofle.keymap",
    "layers": REPO / "config" / "sofle_layers.dtsi",
    "colors": REPO / "config" / "sofle_colors.dtsi",
}
LABELS = REPO / "keymap_drawer.config.yaml"


def load_config() -> dict:
    files = {}
    for key, path in FILES.items():
        if not path.is_file():
            raise FileNotFoundError(f"Fichier introuvable : {path.relative_to(REPO)}")
        files[key] = path.read_text(encoding="utf-8")
    labels = {}
    if LABELS.is_file():
        data = yaml.safe_load(LABELS.read_text(encoding="utf-8")) or {}
        labels = data.get("parse_config", {}) or {}
    return {
        "files": files,
        "paths": {k: str(p.relative_to(REPO)).replace("\\", "/") for k, p in FILES.items()},
        "labels": labels,
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # silencieux
        pass

    def send(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/config":
            try:
                body = json.dumps(load_config(), ensure_ascii=False).encode("utf-8")
                self.send(200, body, "application/json; charset=utf-8")
            except Exception as exc:  # erreur lisible dans la page
                body = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
                self.send(500, body, "application/json; charset=utf-8")
            return

        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (STATIC / rel).resolve()
        if not target.is_relative_to(STATIC) or not target.is_file():
            self.send(404, b"Not found", "text/plain; charset=utf-8")
            return
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self.send(200, target.read_bytes(), ctype)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true", help="ne pas ouvrir le navigateur")
    args = ap.parse_args()

    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    except OSError:
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)  # port libre au hasard
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"Éditeur de configuration : {url}")
    print("Lecture seule : rien n'est écrit dans le dépôt. Ctrl+C pour arrêter.")
    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nArrêt.")


if __name__ == "__main__":
    main()
