set -e

npm i
yalc add @softarc/sheriff-core @softarc/eslint-plugin-sheriff
mkdir -p node_modules/.bin
cd node_modules/.bin
ln -sf ../@softarc/sheriff-core/src/bin/main.js ./sheriff
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

echo 'checking built-in verify'
npx sheriff verify > tests/actual/verify.txt
grep -F 'No issues found. Well done!' tests/actual/verify.txt
