import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const rootPackage = await readJson(path.join(packageDir, 'package.json'));
const corePackage = await readJson(
  path.join(packageDir, '..', 'core', 'package.json'),
);

// Core publishes independently. Release platform packages first, then the
// wrapper, and only then core after this pin has been updated and verified.
const coreEngineVersion = corePackage.optionalDependencies?.[rootPackage.name];
if (coreEngineVersion !== rootPackage.version) {
  throw new Error(
    `${corePackage.name} uses ${rootPackage.name}@${coreEngineVersion}; expected engine version ${rootPackage.version}`,
  );
}

for (const [name, version] of Object.entries(
  rootPackage.optionalDependencies,
)) {
  if (version !== rootPackage.version) {
    throw new Error(
      `${name} uses ${version}; expected engine version ${rootPackage.version}`,
    );
  }

  const triple = name.slice(`${rootPackage.name}-`.length);
  const platformPackage = await readJson(
    path.join(packageDir, 'npm', triple, 'package.json'),
  );
  if (
    platformPackage.name !== name ||
    platformPackage.version !== rootPackage.version
  ) {
    throw new Error(
      `npm/${triple} is ${platformPackage.name}@${platformPackage.version}; expected ${name}@${rootPackage.version}`,
    );
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}
