set -e
npm install
yalc add @lambda-solutions/sheriff-core @lambda-solutions/eslint-plugin-sheriff
# `yalc add` copies the packages in but does not install THEIR dependencies
# (eslint-plugin needs synckit). Re-run the install so they are resolvable.
npm install
cd node_modules/.bin # yalc doesn't create symlink in node_modules/.bin
ln -sf ../@lambda-solutions/sheriff-core/src/bin/main.js ./sheriff
cd ../../

echo 'checking app-i CLI list with its config'
npx sheriff list projects/app-i/src/main.ts > tests/actual/cli-list-app-i.txt
diff tests/actual/cli-list-app-i.txt tests/expected/cli-list-app-i.txt

echo 'checking app-ii CLI list with its config'
npx sheriff list projects/app-ii/src/main.ts > tests/actual/cli-list-app-ii.txt
diff tests/actual/cli-list-app-ii.txt tests/expected/cli-list-app-ii.txt

echo 'checking doctor on a clean project'
npx sheriff doctor projects/app-i/src/main.ts > tests/actual/cli-doctor-clean.txt
diff tests/actual/cli-doctor-clean.txt tests/expected/cli-doctor-clean.txt

echo 'checking doctor findings report'
# Provoke the doctor findings: a config whose barrel policy is active plus
# two stray barrels — one turns a tagged barrel-less module (with an
# internal/ folder) into a barrel module, the other creates an untagged
# module.
cp projects/app-i/sheriff.config.ts projects/app-i/sheriff.config.ts.original
cp tests/doctor-sheriff.config.ts projects/app-i/sheriff.config.ts
echo 'export const stray = true;' > projects/app-i/src/app/non-compliant/util/index.ts
echo 'export const stray = true;' > projects/app-i/src/app/non-compliant/ui/index.ts

if npx sheriff doctor projects/app-i/src/main.ts > tests/actual/cli-doctor-findings.txt; then
  echo 'doctor was expected to exit with code 1'
  exit 1
fi
diff tests/actual/cli-doctor-findings.txt tests/expected/cli-doctor-findings.txt

echo 'checking doctor findings report (--json)'
if npx sheriff doctor projects/app-i/src/main.ts --json > tests/actual/cli-doctor-findings.json; then
  echo 'doctor --json was expected to exit with code 1'
  exit 1
fi
diff tests/actual/cli-doctor-findings.json tests/expected/cli-doctor-findings.json

rm projects/app-i/src/app/non-compliant/util/index.ts
rm projects/app-i/src/app/non-compliant/ui/index.ts
mv projects/app-i/sheriff.config.ts.original projects/app-i/sheriff.config.ts
