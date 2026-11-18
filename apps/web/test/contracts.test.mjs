import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('browser version and registered routes match existing backend contracts', () => {
  const api = readFileSync('src/api.ts', 'utf8');
  const backend = readFileSync('../../services/verifier/src/application-api-contracts.ts', 'utf8');
  assert.match(backend, /APPLICATION_API_VERSION = "proofwork-application-api-v1"/);
  assert.match(api, /VERSION = "proofwork-application-api-v1"/);
  const routes = readFileSync('../../services/verifier/src/wallet-application-http.ts', 'utf8');
  for (const name of ['challenge','verify','logout']) assert(routes.includes('auth/' + name));
  assert.match(api, /credentials: "same-origin"/); assert.match(api, /redirect: "error"/);
  assert.match(api, /p.signMessage\(bytes, "utf8"\)/);
});
test('browser source has no transaction signing, sending, custody or token storage capabilities', () => {
  const source = ['api.ts','App.tsx','demo.ts'].map(f => readFileSync('src/' + f,'utf8')).join('\n');
  assert.doesNotMatch(source, /signTransaction|signAndSendTransaction|sendRawTransaction|localStorage|sessionStorage|privateKey|secretKey|seedPhrase/);
  assert.match(source, /rewardPayment: "not_established"/);
  assert.match(source, /Fictional records\. No live Devnet data/);
});
