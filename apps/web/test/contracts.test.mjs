import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AUTH_ROUTES, jobRoutes, HEALTH_PATH } from '../src/routes.ts';
test('browser paths and methods match exact backend dispatch for all seven routes', () => {
  const api = readFileSync('src/api.ts', 'utf8');
  const backend = readFileSync('../../services/verifier/src/application-api-contracts.ts', 'utf8');
  assert.match(backend, /APPLICATION_API_VERSION = "proofwork-application-api-v1"/);
  assert.match(api, /VERSION = "proofwork-application-api-v1"/);
  const routes = readFileSync('../../services/verifier/src/wallet-application-http.ts', 'utf8');
  const prefix = routes.match(/const PREFIX = "([^"]+)";/)?.[1]; assert.equal(prefix, '/api/v1/');
  assert.equal(HEALTH_PATH, prefix + 'health');
  assert.match(routes, /if \(path === PREFIX \+ \"health\"\)/);
  const declaration = routes.match(/const auth = \[([^\]]+)\]\.includes\(path\);/)?.[1]; assert(declaration);
  const authPaths = [...declaration.matchAll(/PREFIX \+ "([^"]+)"/g)].map(m => prefix + m[1]);
  assert.deepEqual(authPaths, Object.values(AUTH_ROUTES));
  assert.match(routes, /const method = auth \? "POST" : "GET";/);
  assert.match(api, /method: body \? "POST" : "GET"/);
  const pattern = routes.match(/const match = (\/[^\n]+\/)\.exec\(path\);/)?.[1]; assert(pattern);
  const matcher = new RegExp(pattern.slice(1, -1));
  const id = '11111111-1111-4111-8111-111111111111';
  for (const [resource, path] of Object.entries(jobRoutes(id))) {
    const match = matcher.exec(path); assert(match, path); assert.equal(match[1], id);
    assert.equal(match[2] ?? 'job', resource);
  }
  for (const wrong of ['/api/v1/jobs/'+id+'/other', '/api/v1/jobs/'+id+'?role=sponsor']) assert.equal(matcher.exec(wrong), null);
  assert.match(api, /credentials: "same-origin"/); assert.match(api, /redirect: "error"/);
  assert.match(api, /p.signMessage\(bytes, "utf8"\)/);
});
test('browser source has no transaction signing, sending, custody or token storage capabilities', () => {
  const source = ['api.ts','App.tsx','demo.ts','routes.ts'].map(f => readFileSync('src/' + f,'utf8')).join('\n');
  assert.doesNotMatch(source, /signTransaction|signAndSendTransaction|sendRawTransaction|localStorage|sessionStorage|privateKey|secretKey|seedPhrase/);
  assert.match(source, /rewardPayment: "not_established"/);
  assert.match(source, /Fictional records\. No live Devnet data/);
});
