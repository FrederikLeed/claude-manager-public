#!/usr/bin/env bash
# Render every diagram source in this directory to PNG.
#
# The toolchains run in containers so nothing has to be installed locally:
#   *.dot   -> graphviz
#   *.puml  -> plantuml
#
# Mermaid is deliberately absent. mermaid-cli drives headless Chrome, and four
# different images (minlag latest/10.9.0/11.4.2 and the official ghcr one) all
# failed to launch it here, so the two diagrams that used it were converted to
# PlantUML — which renders both entity and activity diagrams natively and has no
# browser dependency.
#
#   ./render.sh          render everything
#   ./render.sh schema   render only sources matching "schema"
#
# Set DOCKER=podman, or DOCKER="sudo docker", if that is how you reach a daemon.
set -euo pipefail

DOCKER="${DOCKER:-docker}"
cd "$(dirname "$0")"
filter="${1:-}"
rendered=0

for src in *.dot *.puml; do
    [ -e "$src" ] || continue
    [ -n "$filter" ] && case "$src" in *"$filter"*) ;; *) continue ;; esac
    out="${src%.*}.png"
    case "$src" in
        *.dot)  $DOCKER run --rm -i nshine/dot dot -Tpng           < "$src" > "$out" ;;
        *.puml) $DOCKER run --rm -i plantuml/plantuml -tpng -pipe  < "$src" > "$out" ;;
    esac
    # A failed render still creates the file, so check it is actually a PNG
    # rather than an empty file or a stack trace.
    if [ "$(head -c4 "$out" | od -An -tx1 | tr -d ' \n')" != "89504e47" ]; then
        echo "FAILED: $src did not produce a PNG" >&2
        exit 1
    fi
    printf '  %-28s -> %s (%s bytes)\n' "$src" "$out" "$(stat -c %s "$out")"
    rendered=$((rendered + 1))
done

echo "rendered $rendered diagram(s)"

# deployment.png comes from deployment.py, which uses the `diagrams` Python
# package and calls graphviz directly, so it needs a local install:
#   pip install diagrams && sudo apt-get install graphviz && python3 deployment.py
