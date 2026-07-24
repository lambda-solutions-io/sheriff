import { CustomersPort } from '../../customers/contract/customers.port';
import { secret } from '../../customers/contract/data/foo/internal/secret';

export const nestedInternal = [CustomersPort, secret];
