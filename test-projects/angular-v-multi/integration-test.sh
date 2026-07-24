set -e
npm install
yalc add @lambda-solutions/sheriff-core @lambda-solutions/eslint-plugin-sheriff
cd node_modules/.bin # yalc doesn't create symlink in node_modules/.bin
ln -sf ../@lambda-solutions/sheriff-core/src/bin/main.js ./sheriff
cd ../../

echo 'checking app-i CLI list with its config'
npx sheriff list projects/app-i/src/main.ts > tests/actual/cli-list-app-i.txt
diff tests/actual/cli-list-app-i.txt tests/expected/cli-list-app-i.txt

echo 'checking app-ii CLI list with its config'
npx sheriff list projects/app-ii/src/main.ts > tests/actual/cli-list-app-ii.txt
diff tests/actual/cli-list-app-ii.txt tests/expected/cli-list-app-ii.txt

echo 'checking config import provenance of a workspace-linked package (--verbose)'
# Simulate a workspace-built blueprint package: symlink it into
# node_modules, exactly like pnpm/yalc/npm workspaces would.
mkdir -p node_modules/@sheriff-test
ln -sfn ../../packages/blueprint node_modules/@sheriff-test/blueprint
cp projects/app-i/sheriff.config.ts projects/app-i/sheriff.config.ts.original
cp tests/provenance-sheriff.config.ts projects/app-i/sheriff.config.ts

# Default Node resolution already resolves symlinks, so the real path of
# the workspace build shows up directly.
npx sheriff verify --verbose projects/app-i/src/main.ts > tests/actual/cli-verbose-provenance.txt || true
node ../remove-abs-paths.mjs tests/actual/cli-verbose-provenance.txt "$(pwd -P)"
diff tests/actual/cli-verbose-provenance.txt tests/expected/cli-verbose-provenance.txt

# With --preserve-symlinks the resolved path keeps the node_modules
# symlink, so the provenance output additionally marks the entry as
# symlinked — this is the workspace-link scenario made explicit.
node --preserve-symlinks node_modules/@lambda-solutions/sheriff-core/src/bin/main.js verify --verbose projects/app-i/src/main.ts > tests/actual/cli-verbose-provenance-symlinked.txt || true
node ../remove-abs-paths.mjs tests/actual/cli-verbose-provenance-symlinked.txt "$(pwd -P)" "$PWD"
diff tests/actual/cli-verbose-provenance-symlinked.txt tests/expected/cli-verbose-provenance-symlinked.txt

mv projects/app-i/sheriff.config.ts.original projects/app-i/sheriff.config.ts
rm node_modules/@sheriff-test/blueprint
