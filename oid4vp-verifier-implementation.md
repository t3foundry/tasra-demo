# OID4VP presentation from a wallet — verifier-side implementation guide

This document is the implementation guide for a **different server** (a relying party / verifier)
that wants a credential wallet — the Hovi Wallet, the Tasra Vault PWA/extension, or an SDK server
wallet — to **present** a credential by scanning a QR code or pasting the `openid4vp://` URL, then
receive and verify that presentation itself.

The reference implementation is the app's own sign-in verifier in `server/lib/oid4vp-login.ts`
(and its identity/DID helpers). It is deliberately self-contained: it runs OpenID4VP **end to end
without the keeper committee** — the wallet presents directly to the server, which verifies the
presentation and makes its own authorization decision. That is the pattern this guide reproduces.
The committee-backed path (the `keykeeper-verifier-agent`) is the heavier variant described at the
end (§10) and uses the same wire.

## 1. What you are implementing (the verifier side)

The verifier is a `did:web` identity that produces a **signed Request Object**, renders it as a QR /
deep link, receives an encrypted presentation, decrypts it, and verifies:

1. the credential's **issuer signature** (the `kid` header names the issuer DID; `iss` is that DID);
2. the **Key Proof** (KB-JWT) binding that credential to the wallet key that *just proved* possession;
3. the **holder binding** (the credential's `sub`/`cnf.kid` names the same key the KB-JWT is signed with);
4. the **nonce + audience** (so the presentation is for your request, not a replay);
5. your own **trust decision** (issuer pin + status-list check) — the only part that is application-specific.

The wallet side is out of scope to *implement* here, but §7 documents exactly what a conforming
wallet does, so you can test interop.

## 2. Reference files

- `server/lib/oid4vp-login.ts` — the complete verifier (router + request object + response verification). **Read this first.**
- `server/lib/sdjwt.ts` — `verifyIssued`, `verifyPresented`, `decodeVc` (SD-JWT VC verification + holder binding).
- `server/lib/did.ts` — `identityFromLabel`/`randomIdentity`, `signJwt`, `publicJwk` (P-256 key material).
- `server/index.ts` — how `/.well-known/did.json` and the router are mounted.
- `tasra-sdk/oid4vp` — the primitives (§5 for exact exports).
- `scripts/smoke-login.ts` — proves the flow with the SDK wallet standing in for a wallet.

## 3. Identity you must publish

The verifier needs **two independent P-256 keys**:

| key | use | published as |
|---|---|---|
| `signer` (ES256) | signs the Request Object | `did:web` document `verificationMethod` (as a public JWK) |
| `enc` (ECDH-ES) | decrypts the response JWE | the Request Object's `client_metadata.jwks.keys[0]` |

**The DID document.** Serve exactly at `/.well-known/did.json` on the host a wallet reaches you at.
Shape (from `loginVerifierDidDocument`):

```json
{
  "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/suites/jws-2020/v1"],
  "id": "<did>",
  "verificationMethod": [{ "id": "<did>#login-0", "type": "JsonWebKey2020", "controller": "<did>", "publicKeyJwk": {...} }],
  "assertionMethod": ["<did>#login-0"],
  "authentication": ["<did>#login-0"]
}
```

**The DID method.** Use `did:web` so wallets can resolve it from your public URL. A port travels
percent-encoded per the method spec:

```ts
const url = new URL(walletBaseUrl())                 // the https origin the phone actually hits
const did = `did:web:${url.port ? `${url.hostname}%3A${url.port}` : url.hostname}`
```

`client_id` is the DID with the OpenID4VP prefix:

```ts
const clientId = `decentralized_identifier:${did}`
```

The verification method `id` and the JWS `kid` must agree, and **`kid` must start with `iss`** —
the SDK's `verifyRequestObject` enforces all three (`typ`, `client_id == iss`, `kid` prefix) so a
conforming wallet will reject anything else.

## 4. The QR / deep-link payload

One opaque string, rendered as a QR **or** pasted verbatim into the wallet's paste field:

```
openid4vp://?client_id=<urlencoded clientId>&request_uri=<urlencoded requestUri>
```

- `request_uri` = an **https GET** on your server returning the Request Object *only while the
  session is pending and unexpired* (pure function of the session id).
- The wallet fetches it with `Accept: application/oauth-authz-req+jwt`.
- The SDK helper that splits this URI is `parseOpenid4vpUri(uri) → {clientId?, requestUri}`.

## 5. SDK primitives you will use (all from `tasra-sdk/oid4vp`)

```ts
signCompactJws(header, payload, {alg: 'ES256', privateKey})   // sign the Request Object
parseOpenid4vpUri(uri)                                        // split QR payload
decryptJwe(compact, recipientPrivateKey)                      // decrypt response JWE (ECDH-ES/AES-GCM)
parseSdJwt(compact); sdJwtClaims(parsed)                      // decode the presented SD-JWT
verifyCompactJws(jws, jwk)                                    // low-level JWS verify
verifyKbJwt(presentation, {nonce, aud})                       // verify the KB-JWT → {holderJwk, claims}
jwkFromDid(did); didJwk(jwk)                                  // did:jwk resolution / canonicalisation
```

`server/lib/sdjwt.ts` wraps the credential verification you need:

```ts
verifyIssued(sdJwt, expectedIssuer?)      // issuer signature + expiry (offline; kid must resolve to iss)
verifyPresented(sdJwt, {nonce, aud})      // verifyIssued + verifyKbJwt + holder-binding check
```

`verifyPresented` asserts the credential's `sub`/`cnf.kid` is a bare `did:jwk` and that
`didJwk(jwkFromDid(vc.holder)) === didJwk(kb.holderJwk)` — i.e. the credential's holder **is** the
key that signed the KB-JWT for your nonce. This is the binding a stand-in or a copy cannot fake.

## 6. The Request Object

Build one signed JWT per session. Header and claims (from `oid4vp-login.ts`):

```ts
const claims = {
  iss: did,
  aud: 'https://self-issued.me/v2',            // OpenID4VP 1.0 static wallet discovery audience
  client_id: clientId,                         // decentralized_identifier:did:web:…
  response_type: 'vp_token',
  response_mode: 'direct_post.jwt',            // the response is form-encoded at response_uri
  response_uri: `${base}/api/auth/oid4vp/response/${id}`,
  nonce: crypto.randomBytes(32).toString('base64url'),
  state: crypto.randomBytes(12).toString('base64url'),
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(session.expiresAt / 1000),
  client_metadata: {
    jwks: {keys: [{...enc.publicJwk, kid: ENC_KID, use: 'enc', alg: 'ECDH-ES'}]},
    encrypted_response_enc_values_supported: ['A128GCM', 'A256GCM'],
    response_types_supported: ['vp_token'],
    vp_formats_supported: {'dc+sd-jwt': { 'sd-jwt_alg_values': ['ES256'], 'kb-jwt_alg_values': ['ES256'] }},
  },
  dcql_query: {credentials: [{id: 'licence', format: 'dc+sd-jwt', meta: {vct_values: ['MedicalLicenseCredential']}, claims: [{path: ['iss']}, {path: ['name']}]}]},
}
const requestObject = signCompactJws({typ: 'oauth-authz-req+jwt', kid: `${did}#login-0`}, claims, {alg: 'ES256', privateKey: signer.privateKey})
```

Constraints that matter (a wallet enforces them):

- `typ: 'oauth-authz-req+jwt'`; `client_id === 'decentralized_identifier:' + iss`; `kid` starts with `iss`; `nonce` and `response_uri` present; `dcql_query` present.
- `client_metadata.jwks.keys[0]` is the **encryption** key (`use: "enc"`, `alg: "ECDH-ES"`). The SDK maps this to the recipient JWK only when it is `kty: EC, crv: P-256`.
- `dcql_query` asks for **ONE credential** (`vct_values`), possibly with required disclosed claims. Keep the issuer **open on the wire** if you want wallets that speak open `["iss"]` entries; **pin it in your verification**, not in the query.

## 7. Session model (your responsibility)

Per sign-in/presentation, keep an in-memory record:

```ts
{id, nonce, state, createdAt, expiresAt, status: 'pending'|'done'|'failed', error?, token?}
```

Rules:

- `nonce` and `state` are **fresh random per session**; `state` is echoed back and must match on the response.
- `request_uri` returning the RO is only valid while `status === 'pending'` and unexpired; garbage-collect old sessions.
- The presentation is **single-use**: `status` flips to `done`/`failed` on the first response; reject a second response (`processing` guard).
- Hand out any resulting session token **once**, on poll, and only to the session's owner. Use a short `exp` (reference: 5 minutes).

## 8. Endpoints (router template)

Mounted under `/api/auth/oid4vp` in the reference; keep the paths arbitrary but stable.

| Method + path | Purpose |
|---|---|
| `GET /.well-known/did.json` | the verifier DID document (mounted at the origin root) |
| `POST /start` | create a session; return `{id, qrPayload, requestUri, clientId, expiresAt}` |
| `GET /request/:id` | return the signed Request Object, `Content-Type: application/oauth-authz-req+jwt` |
| `POST /response/:id` | receive the wallet's `direct_post.jwt`; verify; flip status; return `{redirect_uri:"openid4vp://callback"}` on success, `400 {error}` on refusal |
| `GET /status/:id` | polled by the page that opened the QR; return `{status, error, presented?, token?}` |
| (optional) `DELETE /:id` | cancel the session |

Precede the whole router with `Cache-Control: no-store`.

## 9. Receiving and verifying the presentation (step-by-step)

`direct_post.jwt` arrives as a **form body** (not JSON): the wallet posts
`response=<JWE>` (with `state` folded inside the JWE). Accept `application/x-www-form-urlencoded`
and `application/json` (the reference also tolerates a plain `vp_token` for non-encrypted testing — do not
ship that as the primary path; require the encrypted `response`).

1. **Decrypt.**

   ```ts
   const payload = JSON.parse(decryptJwe(form.response, enc.privateKey))
   // → {vp_token: string|{…}, state?: string}
   if (payload.state !== session.state) throw new Error('state mismatch')
   ```

2. **Extract the single presentation.** `vp_token` may be a bare SD-JWT string or a DCQL map
   `{queryId: [presentation]}`. Take the first string:

   ```ts
   const presentation = firstPresentation(payload.vp_token)     // helper in oid4vp-login.ts
   ```

3. **Verify the credential + holder binding.**

   ```ts
   const vc = verifyPresented(presentation, {nonce: session.nonce, aud: clientId})
   // vc = {issuer, holder, type/vct, credentialSubject, exp, status?, …}
   ```

   This does: issuer `kid`↔`iss` check → `verifyCompactJws` against `jwkFromDid(iss)`, expiry,
   `verifyKbJwt` with your nonce and `aud = clientId`, and the `did:jwk` holder-equality check.

4. **Pin the issuer + check status (application-specific).** For the licence sign-in the reference
   (a) asserts `vc.type === 'MedicalLicenseCredential'`, (b) checks `vc.issuer` against the board's
   public register, and (c) runs `verifyLocalCredential(presentation)` which fetches and verifies the
   credential's signed status list (fail-closed). Do the equivalent for *your* trust anchor:

   ```ts
   if (vc.issuer !== expectedIssuerDid) throw new Error('issued by the wrong issuer')
   await verifyLocalCredential(presentation)      // or your own IETF Status List check
   ```

5. **Authorize.** On success, mint your session token, flip `status = 'done'`, answer
   `{redirect_uri: 'openid4vp://callback'}`. On any failure, flip `status = 'failed'`, record
   `error`, and answer `400 {error}` — never include the credential or internal details.

## 10. The committee-backed variant (Verifier Agent)

For a decision the **verifier committee** must collectively make (the ADR-0064 record read), the
app is not the verifier: it signs the operation and opens a **Verifier Agent** session
(`server/lib/verifier-agent.ts`). The QR the wallet scans is byte-identical in kind
(`openid4vp://?client_id=…&request_uri=…`), but:

- the Request Object is signed by the agent's `did:web`, and its `nonce` binds the operation hash
  (ADR-0067 binding), not a login;
- the wallet posts `direct_post.jwt` to the **agent's** `response_uri`;
- the SDK does everything: `openRegisteredVerifierAgentSession({… signer: operator})` →
  `session.qrPayload` → `awaitRegisteredVerifierAgentResult(session, {intervalMs, timeoutMs, onPhase})`.

The app never sees the credential; the agent fans the presentation out to the drawn verifiers and
returns a compound token. Use this when the authorization decision belongs to the network, not to
your server. The self-contained pattern in §3–§9 is for decisions *your* server alone owns (sign-in,
portal access, introductions).

## 11. Security invariants (do not weaken)

- `nonce` and `state` are per-session, high-entropy, single-use.
- The response **must** be encrypted to your `enc` key (ECDH-ES, AES-GCM); never accept a clear
  `vp_token` in production.
- `typ`/`kid`/`client_id`/`iss` agreement is what the wallet verifies **and** what you trust — sign
  the Request Object with the key your `did:web` document publishes.
- Holder binding (`cnf.kid`/`sub` = the KB-JWT key) is checked before any authorization.
- Issuer is **pinned in verification**, not advertised open on the wire.
- Fail **closed**: expired, wrong-state, wrong-audience, missing/foreign status service, or revoked
  → refuse.
- One credential per presentation in this profile; never interpret a second entry.

## 12. Testing / smoke

```sh
npm run smoke            # server-wallet OpenID4VP read through the verifier-agent (committee path)
node --import tsx scripts/smoke-login.ts   # wallet sign-in presentation (self-contained pattern)
```

Interop target: a wallet must (1) resolve your `did:web`, (2) verify your Request Object, (3) map
`client_metadata.jwks.keys[0]` to a P-256 encryption key, (4) present **one** SD-JWT VC + KB-JWT
(`aud = client_id`, `nonce = request nonce`), JWE-encrypted, `direct_post.jwt`. Test against the
SDK wallet first, then the Hovi Wallet / Tasra Vault.

## 13. Implementation checklist

- [ ] Publish `did:web` at `/.well-known/did.json`; choose `signer` + `enc` P-256 keys.
- [ ] `POST /start` → session with fresh `nonce`/`state`, returns `openid4vp://` QR payload + `requestUri`.
- [ ] `GET /request/:id` → signed `oauth-authz-req+jwt` (claims per §6).
- [ ] `POST /response/:id` → decrypt `response` JWE → state match → `verifyPresented` → issuer pin + status check → authorize/fail.
- [ ] `GET /status/:id` → poll result; hand token once.
- [ ] `Cache-Control: no-store`; sessions GC'd; single-use; short expiry.
- [ ] QR rendering + paste-field fallback (same string everywhere).