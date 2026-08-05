import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

describe('lsp-server independent versioning', () => {
  it('registers the package for independent versioning and publishing', () => {
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
    // lsp-server only uses sheriff-core's public API via the ^1.0.0 caret range, without internal path access.
    const linkedComponents = releaseConfig.plugins.find(
      (plugin) => plugin.type === 'linked-versions',
    )?.components;
    expect(linkedComponents).not.toContain('lsp-server');
    expect(linkedComponents).toEqual(
      expect.arrayContaining(['core', 'eslint-plugin', 'mcp-server']),
    );
    expect(manifest['packages/lsp-server']).toBe('1.0.0');
    // The workflow publishes all four packages in one loop, so assert on the
    // loop's package list plus the publish command instead of a literal line.
    expect(workflow).toMatch(/for pkg in [^\n]*\blsp-server\b/);
    expect(workflow).toContain(
      'npm publish "dist/packages/$pkg" --access public',
    );
    expect(project.targets.publish.options.command).toContain(
      'tools/scripts/publish.mjs lsp-server',
    );
  });
});
