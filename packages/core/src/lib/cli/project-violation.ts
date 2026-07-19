import { DependencyRuleViolation } from '../checks/check-for-dependency-rule-violation';

export type Violation = {
  filePath: string;
  encapsulations: string[];
  dependencyRules: string[];
  externalRules: string[];
  dependencyRuleViolations: DependencyRuleViolation[];
};

export type ProjectViolation = {
  totalDependencyRuleViolations: number;
  totalEncapsulationViolations: number;
  totalExternalRuleViolations: number;
  totalViolatedFiles: number;
  hasError: boolean;
  violations: Violation[];
};
