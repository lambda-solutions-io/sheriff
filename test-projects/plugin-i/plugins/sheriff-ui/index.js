class SheriffUiPlugin {
  constructor() {
    this.name = 'ui';
    this.description = 'Open Sheriff UI';
  }

  async execute(_args, api) {
    api.log('Sheriff UI plugin started');
  }
}

exports.SheriffUiPlugin = SheriffUiPlugin;
