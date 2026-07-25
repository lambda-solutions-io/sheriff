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
