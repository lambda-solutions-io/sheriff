import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

describe('lsp-server release wiring', () => {
  it('registers the package for linked versioning and publishing', () => {
    const releaseConfig = JSON.parse(
      readFileSync('release-please-config.json', 'utf8'),
    ) as {
      packages: Record<string, { component: string }>;
      plugins: { type: string; components: string[] }[];
    };
    const manifest = JSON.parse(
      readFileSync('.release-please-manifest.json', 'utf8'),
    ) as Record<string, string>;
    const workflow = readFileSync(
      '.github/workflows/release-please.yml',
      'utf8',
    );
    const project = JSON.parse(
      readFileSync('packages/lsp-server/project.json', 'utf8'),
    ) as {
      targets: { publish: { options: { command: string } } };
    };

    expect(releaseConfig.packages['packages/lsp-server']).toEqual({
      component: 'lsp-server',
    });
    expect(
      releaseConfig.plugins.find((plugin) => plugin.type === 'linked-versions')
        ?.components,
    ).toContain('lsp-server');
    expect(manifest['packages/lsp-server']).toBe('1.0.0');
    expect(workflow).toContain(
      'npm publish dist/packages/lsp-server --access public',
    );
    expect(project.targets.publish.options.command).toContain(
      'tools/scripts/publish.mjs lsp-server',
    );
  });
});
