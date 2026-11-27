import { afterAll, afterEach } from 'vitest';
import { blockedRequestsMessage, installNetworkGuard, takeBlockedRequests } from './network-guard';

// No dashboard test may reach a non-local host (v1.47.0). The guard refuses
// the request and records it; the hooks below turn any recorded refusal into a
// failure, so a request a library swallows still fails the run loudly.
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
