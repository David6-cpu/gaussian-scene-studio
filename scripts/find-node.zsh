# Sourced by the .command launchers. Sets NODE to a usable Node.js binary or
# explains how to fix it. Looks at PATH first (nvm, Volta, fnm, official
# installer), then the usual Homebrew locations on Apple Silicon and Intel.
find_node() {
  local candidate
  for candidate in "$(command -v node 2>/dev/null)" \
    /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    # Vite 8 needs Node 20.19+ or 22.12+.
    if "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)||(a===20&&b>=19)?0:1)' 2>/dev/null; then
      NODE="$candidate"
      return 0
    fi
  done
  return 1
}
