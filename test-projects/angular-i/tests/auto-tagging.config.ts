import { SheriffConfig } from "@lambda-solutions/sheriff-core";

export const config: SheriffConfig = {
  depRules: {
    'root': 'noTag',
    'noTag': 'noTag'
  }
};
