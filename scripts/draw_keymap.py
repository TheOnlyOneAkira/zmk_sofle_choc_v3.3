#!/usr/bin/env python3
"""Génère le schéma des layers du Sofle à partir de config/sofle.keymap.

Sorties (dans keymap-drawer/ par défaut) :
  - sofle.yaml : représentation intermédiaire produite par keymap-drawer
  - sofle.svg  : schéma graphique de tous les layers
  - sofle.txt  : schéma ASCII de tous les layers

Les encodeurs (sensor-bindings) ne sont pas gérés par keymap-drawer : ce script
les ajoute lui-même sur les touches de clic des molettes.

Usage :
  pip install -r scripts/requirements.txt
  python scripts/draw_keymap.py [--keymap config/sofle.keymap] [--out-dir keymap-drawer]
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # PyYAML est une dépendance de keymap-drawer
    sys.exit("keymap-drawer n'est pas installé : pip install -r scripts/requirements.txt")

REPO = Path(__file__).resolve().parent.parent

# Positions (index dans les bindings) des touches de clic des encodeurs,
# dans l'ordre des sensors : molette gauche, molette droite.
ENCODER_POSITIONS = [42, 43]

# Libellés compacts pour les paires (horaire, anti-horaire) courantes.
# Valeur : (nom affiché en haut de la touche, sens de rotation affiché en bas).
SENSOR_PAIR_LABELS = {
    ("C_VOL_UP", "C_VOL_DN"): ("Vol", "↺− ↻+"),
    ("C_VOLUME_UP", "C_VOLUME_DOWN"): ("Vol", "↺− ↻+"),
    ("C_AC_SCROLL_UP", "C_AC_SCROLL_DOWN"): ("Défil", "↺↓ ↻↑"),
}

# Libellés des actions de rotation (keycodes ZMK), pour les autres paires.
SENSOR_LABELS = {
    "C_VOL_UP": "Vol+", "C_VOLUME_UP": "Vol+",
    "C_VOL_DN": "Vol−", "C_VOLUME_DOWN": "Vol−",
    "C_AC_SCROLL_UP": "Défil↑", "C_AC_SCROLL_DOWN": "Défil↓",
    "C_NEXT": "Suiv.", "C_PREVIOUS": "Préc.",
    "PAGE_UP": "PgUp", "PAGE_DOWN": "PgDn",
    "LEFT": "←", "RIGHT": "→", "UP": "↑", "DOWN": "↓",
}

# --- Géométrie ASCII du Sofle : (rangée, colonne) de chaque position -----------
# Grille de 14 colonnes : 0-6 moitié gauche, 7-13 moitié droite.
ASCII_POS: list[tuple[int, int]] = []
for _row in range(3):
    ASCII_POS += [(_row, c) for c in range(0, 6)] + [(_row, c) for c in range(8, 14)]
ASCII_POS += [(3, c) for c in range(0, 14)]
ASCII_POS += [(4, c) for c in range(2, 12)]
ASCII_CELL_W = 11  # largeur intérieure d'une case
ASCII_HALF_GAP = 2  # espaces entre les deux moitiés


def run_keymap_drawer(*args: str) -> None:
    env = dict(os.environ, PYTHONUTF8="1")
    cmd = [sys.executable, "-m", "keymap_drawer", *args]
    result = subprocess.run(cmd, env=env, cwd=REPO)
    if result.returncode != 0:
        sys.exit(f"Échec de keymap-drawer ({' '.join(args[:3])}…)")


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"//[^\n]*", "", text)


def read_with_includes(path: Path, seen: set[Path] | None = None) -> str:
    """Lit un fichier en remplaçant les #include "..." locaux par leur contenu."""
    seen = set() if seen is None else seen
    path = path.resolve()
    if path in seen:
        return ""
    seen.add(path)

    def inline(m: re.Match) -> str:
        inc = path.parent / m.group(1)
        return read_with_includes(inc, seen) if inc.is_file() else m.group(0)

    text = path.read_text(encoding="utf-8")
    return re.sub(r'^[ \t]*#include\s+"([^"]+)"', inline, text, flags=re.M)


def parse_sensor_bindings(keymap_text: str) -> list[list[tuple[str, str]] | None]:
    """Retourne, pour chaque layer (dans l'ordre), la liste (CW, CCW) par encodeur."""
    text = strip_comments(keymap_text)
    start = re.search(r"compatible\s*=\s*\"zmk,keymap\"\s*;", text)
    if not start:
        return []
    layers = []
    # Chaque layer : NOM { ... bindings = <...>; [sensor-bindings = <...>;] };
    for m in re.finditer(r"\b\w+\s*\{([^{}]*?\bbindings\s*=\s*<[^>]*>[^{}]*)\}", text[start.end():]):
        sb = re.search(r"sensor-bindings\s*=\s*<([^>]*)>", m.group(1))
        if not sb:
            layers.append(None)
            continue
        encoders = re.findall(r"&inc_dec_kp\s+(\S+)\s+(\S+)", sb.group(1))
        layers.append(encoders)
    return layers


def sensor_label(code: str) -> str:
    return SENSOR_LABELS.get(code, code.removeprefix("C_").replace("_", " ").title())


def add_encoders(keymap_yaml: dict, sensors: list) -> None:
    for layer_keys, encoders in zip(keymap_yaml["layers"].values(), sensors):
        if not encoders:
            continue
        for pos, (cw, ccw) in zip(ENCODER_POSITIONS, encoders):
            key = layer_keys[pos]
            key = dict(key) if isinstance(key, dict) else {"t": key}
            name, rotation = SENSOR_PAIR_LABELS.get(
                (cw, ccw), ("Molette", f"↺{sensor_label(ccw)} ↻{sensor_label(cw)}")
            )
            key["s"], key["h"] = name, rotation
            if key.get("type") != "trans":
                key["type"] = "encoder"
            layer_keys[pos] = key


# --- Rendu ASCII -------------------------------------------------------------------

def legend_lines(key) -> tuple[str, str]:
    if not isinstance(key, dict):
        return ("" if key is None else str(key), "")
    top = str(key.get("t", "") or "")
    if "↻" in str(key.get("h", "")):  # touche de molette : nom + sens de rotation
        return top, f"{key.get('s', '')} {key.get('h', '')}".strip()
    second = key.get("h") or key.get("s") or ""
    return top, str(second)


def fit(text: str, width: int) -> str:
    text = text.replace("\n", " ")
    if len(text) > width:
        text = text[: width - 1] + "…"
    return text.center(width)


def ascii_layer(name: str, keys: list) -> str:
    rows, cols = 5, 14
    cw = ASCII_CELL_W + 1  # case + bordure gauche

    def x_of(col: int) -> int:
        return col * cw + (ASCII_HALF_GAP if col >= 7 else 0)

    width = x_of(cols - 1) + cw + 1
    height = rows * 3 + 1
    canvas = [[" "] * width for _ in range(height)]
    for key, (row, col) in zip(keys, ASCII_POS):
        x, y = x_of(col), row * 3
        for dx in range(cw + 1):
            canvas[y][x + dx] = canvas[y + 3][x + dx] = "-"
        for dy in (1, 2):
            canvas[y + dy][x] = canvas[y + dy][x + cw] = "|"
        for cx, cy in ((x, y), (x + cw, y), (x, y + 3), (x + cw, y + 3)):
            canvas[cy][cx] = "+"
        for dy, line in enumerate(legend_lines(key), start=1):
            for i, ch in enumerate(fit(line, ASCII_CELL_W)):
                canvas[y + dy][x + 1 + i] = ch
    body = "\n".join("".join(r).rstrip() for r in canvas)
    return f"=== {name} ===\n{body}\n"


def write_ascii(keymap_yaml: dict, path: Path) -> None:
    out = [
        "Schéma des layers du Sofle (généré par scripts/draw_keymap.py)",
        "Légende : ligne 1 = appui, ligne 2 = maintien / Maj / molette (↺ anti-horaire, ↻ horaire),",
        "          ▽ = transparent (touche du layer inférieur), case vide = aucune action.",
        "",
    ]
    for name, keys in keymap_yaml["layers"].items():
        out.append(ascii_layer(name, keys))
    path.write_text("\n".join(out), encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--keymap", type=Path, default=REPO / "config" / "sofle.keymap")
    ap.add_argument("--config", type=Path, default=REPO / "keymap_drawer.config.yaml")
    ap.add_argument("--out-dir", type=Path, default=REPO / "keymap-drawer")
    args = ap.parse_args()

    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = args.keymap.stem
    yaml_path, svg_path, txt_path = (out_dir / f"{stem}.{ext}" for ext in ("yaml", "svg", "txt"))

    run_keymap_drawer("-c", str(args.config), "parse", "-z", str(args.keymap), "-o", str(yaml_path))

    data = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    add_encoders(data, parse_sensor_bindings(read_with_includes(args.keymap)))
    yaml_path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")

    run_keymap_drawer("-c", str(args.config), "draw", str(yaml_path), "-o", str(svg_path))
    write_ascii(data, txt_path)

    for p in (svg_path, txt_path):
        print(f"Généré : {p.relative_to(REPO) if p.is_relative_to(REPO) else p}")


if __name__ == "__main__":
    main()
