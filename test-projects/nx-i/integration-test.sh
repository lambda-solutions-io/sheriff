set -e

# Nx-style monorepo layout (an app-internal domain AND an extracted lib with
# the IDENTICAL internal slice shape) exercising Sheriff in barrel-less mode.
# Modelled on a real consumer repo's sheriff.config.ts (port/infra inversion,
# feat-<x>/ private sub-slices, module-private internal/). See
# sheriff.config.ts for the full rationale.

npm install
yalc add @lambda-solutions/sheriff-core @lambda-solutions/eslint-plugin-sheriff
# `yalc add` copies the packages in but does not install THEIR dependencies
# (eslint-plugin needs synckit). Re-run the install so they are resolvable.
npm install
cd node_modules/.bin # yalc doesn't create symlink in node_modules/.bin
ln -sf ../@lambda-solutions/sheriff-core/src/bin/main.js ./sheriff
cd ../../

# (a) CLI list snapshot of the app entry point: also reaches into the
# extracted lib (main.ts -> booking.routes.ts), so this ONE snapshot proves
# checkin (apps/client/.../domains/checkin) and booking (libs/domains/booking)
# get the IDENTICAL bucket shape (api/infra/data/ui/types/utils/feat-<x>/)
# from the SAME slice() rule — extraction is a folder move, not a rule change.
echo 'checking CLI list (app + extracted lib structure snapshot)'
npx sheriff list apps/client/src/main.ts > tests/actual/cli-list.txt
diff tests/actual/cli-list.txt tests/expected/cli-list.txt

# (b) CLI verify SUCCESS on the clean tree, for BOTH entry points declared in
# sheriff.config.ts (client app + domain-booking lib) — the CLI cross-check
# gotcha: every lib needs to be independently verifiable from its own entry.
echo 'checking CLI verify success on the clean tree (both entry points)'
npx sheriff verify > tests/actual/cli-verify-success.txt
diff tests/actual/cli-verify-success.txt tests/expected/cli-verify-success.txt

# (c) FAILURE: a `type:api` file importing `type:infra` — the port naming
# its own implementation. `type:api` has no clearance towards `type:infra` in
# depRules, so this must be a structural violation, not a discipline issue.
echo 'checking CLI verify failure: api -> infra (port/infra inversion)'
cp apps/client/src/app/domains/checkin/api/checkin-api.ts apps/client/src/app/domains/checkin/api/checkin-api.ts.original
cp tests/checkin-api.port-infra-inversion.ts apps/client/src/app/domains/checkin/api/checkin-api.ts
npx sheriff verify apps/client/src/main.ts > tests/actual/cli-verify-api-infra.txt || true
diff tests/actual/cli-verify-api-infra.txt tests/expected/cli-verify-api-infra.txt
mv apps/client/src/app/domains/checkin/api/checkin-api.ts.original apps/client/src/app/domains/checkin/api/checkin-api.ts

# (d) FAILURE: cross-slice import bypassing a public port — feat-history
# reaches directly into sibling feat-checkin's data/, instead of going
# through feat-checkin's feat-port (feat-checkin/api/).
echo 'checking CLI verify failure: sibling feat bypasses feat-port'
cp apps/client/src/app/domains/checkin/feat-history/feat-history.ts apps/client/src/app/domains/checkin/feat-history/feat-history.ts.original
cp tests/feat-history.port-bypass.ts apps/client/src/app/domains/checkin/feat-history/feat-history.ts
npx sheriff verify apps/client/src/main.ts > tests/actual/cli-verify-feat-port-bypass.txt || true
diff tests/actual/cli-verify-feat-port-bypass.txt tests/expected/cli-verify-feat-port-bypass.txt
mv apps/client/src/app/domains/checkin/feat-history/feat-history.ts.original apps/client/src/app/domains/checkin/feat-history/feat-history.ts

# (e) ENCAPSULATION: importing a file under a TOP-LEVEL `internal/` folder
# (data/internal/checkin.mapper.ts) from outside the module that owns it
# (the slice root, not from within data/ itself) -> encapsulation violation,
# even though the type-axis layer matrix (feature -> data) would otherwise
# allow it. This is sheriff's default `encapsulationPattern: 'internal'`.
echo 'checking CLI verify failure: encapsulation, top-level internal/'
cp apps/client/src/app/domains/checkin/checkin.routes.ts apps/client/src/app/domains/checkin/checkin.routes.ts.original
cp tests/checkin-routes.internal-import.ts apps/client/src/app/domains/checkin/checkin.routes.ts
npx sheriff verify apps/client/src/main.ts > tests/actual/cli-verify-encapsulation-internal.txt || true
diff tests/actual/cli-verify-encapsulation-internal.txt tests/expected/cli-verify-encapsulation-internal.txt
mv apps/client/src/app/domains/checkin/checkin.routes.ts.original apps/client/src/app/domains/checkin/checkin.routes.ts

# (f) ENCAPSULATION (NESTED): importing a file under a NESTED `internal/`
# folder (data/foo/internal/nested-helper.ts — note "foo/internal", not a
# top-level "internal") from outside the owning module. A directory segment
# equal to the encapsulation pattern encapsulates at any depth, so this is a
# violation. Before the depth fix for
# https://github.com/lambda-solutions-io/sheriff/issues/31 finding 2 this was
# silently allowed, which is exactly the class of failure that issue reports.
echo 'checking CLI verify failure: encapsulation, NESTED internal/ (issue #31 finding 2)'
cp apps/client/src/app/domains/checkin/checkin.routes.ts apps/client/src/app/domains/checkin/checkin.routes.ts.original
cp tests/checkin-routes.nested-internal-import.ts apps/client/src/app/domains/checkin/checkin.routes.ts
npx sheriff verify apps/client/src/main.ts > tests/actual/cli-verify-nested-internal.txt || true
diff tests/actual/cli-verify-nested-internal.txt tests/expected/cli-verify-nested-internal.txt
mv apps/client/src/app/domains/checkin/checkin.routes.ts.original apps/client/src/app/domains/checkin/checkin.routes.ts

# (g) STRAY BARREL: a module in this barrel-less workspace (checkin/ui/,
# which has none by default) gains an `index.ts` and thereby BECOMES a
# barrel module. Step 1: with the existing DEEP import into ui/arrival-list
# left untouched, that import now becomes a violation purely because the
# barrel appeared -- see https://github.com/lambda-solutions-io/sheriff/
# issues/31 finding 3 (this is the reason PR #38 exists).
echo 'checking CLI verify failure: stray index.ts turns ui/ into a barrel module (deep import now blocked)'
cp tests/ui.index.ts apps/client/src/app/domains/checkin/ui/index.ts
npx sheriff verify apps/client/src/main.ts > tests/actual/cli-verify-stray-barrel-deep-import.txt || true
diff tests/actual/cli-verify-stray-barrel-deep-import.txt tests/expected/cli-verify-stray-barrel-deep-import.txt

# (g) STRAY BARREL, step 2: same barrel still present, but the consumer now
# imports the SAME symbol through the barrel path (`../ui`, resolving to
# ui/index.ts) instead of the deep file path -> allowed again.
echo 'checking CLI verify success: importing the same symbol via the (stray) barrel is allowed'
cp apps/client/src/app/domains/checkin/feat-checkin/feat-checkin.ts apps/client/src/app/domains/checkin/feat-checkin/feat-checkin.ts.original
cp tests/feat-checkin.via-barrel.ts apps/client/src/app/domains/checkin/feat-checkin/feat-checkin.ts
npx sheriff verify apps/client/src/main.ts > tests/actual/cli-verify-stray-barrel-via-barrel.txt
diff tests/actual/cli-verify-stray-barrel-via-barrel.txt tests/expected/cli-verify-stray-barrel-via-barrel.txt
mv apps/client/src/app/domains/checkin/feat-checkin/feat-checkin.ts.original apps/client/src/app/domains/checkin/feat-checkin/feat-checkin.ts
rm apps/client/src/app/domains/checkin/ui/index.ts

# Sanity: tree is restored, clean baseline still verifies.
echo 'checking CLI verify success after restore (tree back to baseline)'
npx sheriff verify apps/client/src/main.ts > tests/actual/cli-verify-restored.txt
diff tests/actual/cli-verify-restored.txt tests/expected/cli-verify-success-single.txt
