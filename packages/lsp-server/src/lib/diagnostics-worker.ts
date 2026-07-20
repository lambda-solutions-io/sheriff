import { parentPort } from 'worker_threads';
import { createSheriffDiagnostics, Diagnostic } from './diagnostics';

interface DiagnosticsRequest {
  id: number;
  uri: string;
  text: string;
}

interface DiagnosticsResponse {
  id: number;
  diagnostics: Diagnostic[];
}

const port = parentPort;
if (!port) {
  throw new Error('diagnostics worker requires a parent port');
}

port.on('message', (request: DiagnosticsRequest) => {
  const response: DiagnosticsResponse = {
    id: request.id,
    diagnostics: createSheriffDiagnostics(request.uri, request.text),
  };
  port.postMessage(response);
});
