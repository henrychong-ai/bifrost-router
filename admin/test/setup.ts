import { afterAll, afterEach } from 'vitest';
import { blockedRequestsMessage, installNetworkGuard, takeBlockedRequests } from './network-guard';
import { installTransportGuard } from './transport-guard';

// No dashboard test may reach a non-local host (v1.47.0). The transport guard
// is the guarantee: every TCP or TLS connection and every DNS lookup to a
// non-loopback address or name is refused, whatever made the request. The API
// wrappers on top give clearer messages. Each refusal is recorded; the hooks
// below turn any recorded refusal into a failure, so a request a library
// swallows still fails the run loudly.
installTransportGuard();
installNetworkGuard(globalThis);
// happy-dom's window, when a file runs in it and it is not the global itself
const happyDomWindow: unknown = Reflect.get(globalThis, 'window');
if (happyDomWindow && typeof happyDomWindow === 'object' && happyDomWindow !== globalThis) {
  installNetworkGuard(happyDomWindow);
}

function failOnBlockedRequests(): void {
  const requests = takeBlockedRequests();
  if (requests.length > 0) throw new Error(blockedRequestsMessage(requests));
}

afterEach(failOnBlockedRequests);
afterAll(failOnBlockedRequests);
