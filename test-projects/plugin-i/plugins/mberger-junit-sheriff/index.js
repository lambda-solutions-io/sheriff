const fs = require('fs');

class JunitReporterPlugin {
  constructor(options = {}) {
    this.name = 'junit';
    this.description = 'Generate JUnit reports';
    this.options = options;
  }

  async execute(args, api) {
    const outputPath = args[0] ?? 'junit-report.json';
    const config = api.getConfig();
    const result = api.verify();

    const report = {
      entryFile: config.entryFile,
      junitVersion: this.options.junitVersion ?? 1,
      reporters: this.options.reporters ?? [],
      success: result.success,
    };

    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
    api.log(`JUnit report written to ${outputPath}`);
  }
}

exports.JunitReporterPlugin = JunitReporterPlugin;
