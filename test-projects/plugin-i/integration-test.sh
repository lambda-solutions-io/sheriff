set -e

npm i
yalc add @lambda-solutions/sheriff-core @lambda-solutions/eslint-plugin-sheriff @lambda-solutions/sheriff-ui
mkdir -p node_modules/.bin
cd node_modules/.bin
ln -sf ../@lambda-solutions/sheriff-core/src/bin/main.js ./sheriff
cd ../../

mkdir -p tests/actual

echo 'checking plugin help output'
npx sheriff > tests/actual/help.txt
grep -F 'Plugins:' tests/actual/help.txt
grep -F 'sheriff ui: Open Sheriff UI' tests/actual/help.txt
grep -F 'sheriff junit: Generate JUnit reports' tests/actual/help.txt

echo 'checking plugin execution'
npx sheriff junit tests/actual/junit-report.json > tests/actual/junit-stdout.txt
diff tests/actual/junit-report.json tests/expected/junit-report.json
diff tests/actual/junit-stdout.txt tests/expected/junit-stdout.txt

echo 'checking sheriff ui --json graph snapshot'
npx sheriff ui --json > tests/actual/ui-graph.json
grep -F '"src/feature"' tests/actual/ui-graph.json
grep -F '"src/shared"' tests/actual/ui-graph.json
grep -F '"moduleEdges"' tests/actual/ui-graph.json
grep -F '"filesWithViolations": 0' tests/actual/ui-graph.json

echo 'checking sheriff ui http server'
npx sheriff ui --port 7677 --no-open > tests/actual/ui-server.txt 2>&1 &
UI_PID=$!
for i in $(seq 1 30); do
  sleep 0.5
  if curl -sf http://localhost:7677/api/graph > tests/actual/ui-api.json 2>/dev/null; then
    break
  fi
done
grep -F '"modules"' tests/actual/ui-api.json
curl -sf http://localhost:7677/ | grep -Fi 'sheriff'
kill $UI_PID 2>/dev/null || true
wait $UI_PID 2>/dev/null || true

npx sheriff daemon stop || true

echo 'checking built-in verify'
npx sheriff verify > tests/actual/verify.txt
grep -F 'No issues found. Well done!' tests/actual/verify.txt
