# VC issuance from a separate server application — implementation spec

This document describes how to implement **VC issuance as a standalone server application**, so
that any other server (the health-demo backend, an integrator's portal, a partner registrar) can
**issue** SD-JWT Verifiable Credentials over OpenID4VCI and **revoke** them through a single,
self-contained HTTP service — without running the whole health-demo backend.

The reference implementation already exists inside this repo as the *local Hovi-compatible
issuer*. It is deliberately self-contained; this spec is the extraction/port guide. The rule of
thumb: the issuer service must own signing, redemption, and revocation; the calling application
must own only *what* credential to issue and *when*. Authority to sign is the issuer's, correctness
of scope is the application's.

## 1. What the standalone issuer is

A single Node/Express process (Node ≥ 20.19, ESM, `type: "module"`, `tsx` for TS) that serves:

1. a **Hovi-compatible "OpenID Business Wallet" management API** (a subset) — what a *server*
   application calls, over HTTP, with a bearer API key;
2. the **OpenID4VCI wallet-facing endpoints** — what a *credential wallet* (Hovi Wallet, Tasra
   Vault PWA/extension, or an SDK server wallet) redeems offers against;
3. the **status-list endpoints** — what relying parties and the Keykeeper verifier committee
   fetch to check revocation, in both the IETF Token Status List and W3C StatusList2021 formats.

It is the **only** party that signs credentials. It derives no trust from, and shares no state
with, the calling application beyond the HTTP contract below.

Reference files (read these first):

- `server/issuer/service.ts` — the `LocalIssuer` class + `router()` (the entire service, ~430 lines).
- `server/issuer/templates.ts` — the fixed credential catalog (`LOCAL_SCHEMAS`).
- `server/issuer/runtime.ts` / `server/issuer/local.ts` — how it is instantiated + mounted today.
- `server/lib/did.ts` — P-256 identity (`DidIdentity`, issuer DID vs holder DID).
- `server/lib/sdjwt.ts` — SD-JWT VC issuance/decoding/verification (`issueCredential`).
- `server/lib/statuslist.ts` — W3C StatusList2021 (`StatusList`).
- `server/lib/hovi.ts` — the `HoviClient` (the *calling application's* client, reusable as-is).
- `server/lib/hovi-status.ts` — `verifyHoviCredential` (relying-party status verification).
- `scripts/local-issuer.test.ts` — the contract tests (the executable spec).
- `scripts/local-issuer-smoke.ts` — live smoke against a running service.
- `docs/local-issuer.md` — prose description of the current in-process deployment.

## 2. Dependencies

Everything the issuer needs, with the exact exports:

- `tasra-sdk/oid4vp`:
  - `issueSdJwtVc`, `parseSdJwt`, `sdJwtClaims`, `verifyCompactJws`, `signCompactJws` (signing/verification).
  - `p256DidKeyIssuer`, `p256HolderKey`, `p256PublicJwk`, `didJwk`, `jwkFromDid` (identity).
  - `receiveCredential` (only used by *callers*/wallets that redeem offers themselves, not by the service).
  - types `EcJwk`, `HolderKey`, `SdJwtIssuer`, `Jwk`.
- `@noble/curves/p256`, `@noble/hashes/sha256` (deterministic key derivation — optional; only if the
  standalone issuer must reproduce `identityFromLabel`).
- `express`, `cors` (optional), `qrcode` (the offer-view QR page), `node:{crypto,fs,path,zlib}`.

No database, no HSM, no Hovi Cloud. The store is two JSON files (see §8).

## 3. Identity model

One P-256 key per **organization** (issuer). The key is expressed two ways and both matter:

- `did` (`did:key:zDn…`, P-256 multicodec) — the **issuer** identity. This is what a credential's
  `iss` names, and what the Keykeeper class rule / trust anchor pins. Wallets and verifiers resolve
  it offline.
- `holderDid` (`did:jwk:…` of the same key) — the **holder** form of the same scalar. Not used for
  the issuer's own credentials, but needed because the same helpers produce holdery `cnf.kid` values
  for *redeeming* wallets.

The service builds an `SdJwtIssuer` (SDK shape, `kid = <did:key>#<fragment>`) from the private key
for signing, and a `HolderKey` shape for anything that must look like a wallet-held key.

Key operations (see `server/lib/did.ts`):

- `identityFromKey(privateKey: Uint8Array): DidIdentity`
- `identityFromLabel(label)` / `randomIdentity()` — deterministic demo identities / fresh random.
- `identityToHex(id)` / `identityFromHex(hex)` — persist/restore a generated identity as a 64-hex scalar.
- `signJwt(id, header, payload)` — compact ES256 JWS for app-level signatures (the status-list VCs).

The service persists each organization's issuer key as a 64-hex private scalar. It may **import** a
caller's existing key (so a patient/board issuer keeps its DID — a hard requirement, since record
ciphertexts and the slot rule are bound to that DID).

## 4. Credential shape

Every issued credential is a compact **SD-JWT VC** (`typ: dc+sd-jwt`) with:

- ES256 under the organization's P-256 `did:key` issuer; the `kid` header is that DID URL; `iss` is the DID.
- `vct` = the credential type (what a slot rule's `vct_values` matches).
- one disclosure per non-reserved claim (disclose-all; no selective disclosure in this issuer).
- `sub` and `cnf.kid` = `<holderDid>#0`, where `holderDid` is the redeeming wallet's bare `did:jwk`
  (no `#fragment`). **The holder is whatever wallet proves possession at redemption** unless the
  offer pinned an `expectedHolder`.
- in the clear: a `credentialStatus` (W3C `StatusList2021Entry`) entry **and** a native IETF
  `status.status_list` reference — both point at the same revocation bit.
- `exp` = absolute Unix seconds (the caller passes `exp`; the issuer computes `ttlSecs = exp - iat`).

`issueCredential` in `server/lib/sdjwt.ts` is the primitive; `service.ts` calls the SDK's
`issueSdJwtVc` directly so it can put **both** status formats in the clear. The exact issuance call:

```ts
issueSdJwtVc({
  issuer: identityFromHex(org.privateKey).issuer,
  vct: template.schemaType,
  claims: {...values, status: {status_list: {uri: statusUrl, idx: index}},
                   credentialStatus: credentialStatusEntry({listUrl: status2021Url, index})},
  plain: ['status', 'credentialStatus'],
  cnf: {kid: `${holderDid}#0`},
  ttlSecs: exp - iat,
  nowSecs: iat,
})
```

Reserved claims (never schema-validated, always issuer-controlled): `iss, iat, exp, nbf, vct, cnf,
sub, jti, credentialStatus, _sd, _sd_alg, status`.

## 5. Credential catalog (templates)

Fixed, server-defined, **not editable** through the API. One template per `schemaType`; every
organization gets the same catalog. Required attribute types are `string`, `number`, or `list`
(arrays of strings). All attributes required except the appended optional `holderDid` (the holder pin).

| schemaType (`vct`) | attributes |
|---|---|
| `MedicalLicenseCredential` | role, name, licenseNumber, specialty, jurisdiction, exp(number) |
| `PatientAccessCredential` | accessKind(`consent`\|`owner`), patientDid, kk_identity_scope(list), purpose, grantedBy, exp |
| `PatientConsentCredential` | kk_identity_scope(list), purpose, grantedBy, exp |
| `PatientOwnerAccessCredential` | kk_identity_scope(list), purpose, grantedBy, exp |
| `ViewerIdentityCredential` | viewerId, name, role, exp |

`PatientAccessCredential` carries extra validation: `accessKind ∈ {consent, owner}`, `patientDid`
matches `did:<method>:<…>` (no `/`, `?`, `#`, whitespace), every `kk_identity_scope` entry starts
with `${patientDid}/health/v1/`, permits at most a **terminal** `/*`, and forbids `..`, `//`, `%`
percent-encoding, or interior wildcards. `owner` requires exactly `["<patientDid>/health/v1/*"]`.
Issuer/status claim injection (`iss`, `status`, `credentialStatus`, …) is rejected by the
allowed-fields check.

## 6. API contract

### 6.1 Management API (calling-application side)

Base URL is configured (`/api/issuer` in the demo). Bearer auth: `Authorization: Bearer <key>`.
Two principal types:

- **ecosystem key** (`openId-local-…`, stored in `connection.json`) — `*`; can list all orgs and create orgs.
- **organization-scoped token** (`openId-local-…`, returned once by `organization/create`) — can only act on its own org.

Every per-organization call additionally sends `x-organization-id: <org uuid>`; the header must match the
principal (or the ecosystem key). Success envelopes are `{success:true, response:…}` (or
`{success:true, message:…}` for revoke). Errors are `{success:false, message}` for management calls
and `{error, error_description}` (OAuth-style) for wallet calls.

| Method + path (relative to base) | Body | Success response |
|---|---|---|
| `GET /organization/` | optional `organizationId` query | `{success:true,response:[org…]}` |
| `POST /organization/create` | `name`, `label`, `secret`(≥16 chars), `imageUrl`(https, no creds), optional `dids:[{did, privateKey(64 hex)}]` | `201 {success:true,response:{organizationId, tenantId, setting, accessToken, dids:[{did,method,privateKey}], webhooks:[]}}` |
| `GET /credential-template/organization` | optional `credentialTemplateId` query | `{success:true,response:[template…]}` |
| `POST /credential/sd-jwt/offer` | `credentialTemplateId`, `credentialValues`(claims incl. required `exp`), optional `codeflow:"pre-authorized"`, `preAuthorizedCodeflowConfig` | `{success:true,response:{…,credentialExchangeId, credentialOfferUri, credentialOfferUrl, state:"pending"}}` |
| `GET /credential/find` | `credentialExchangeId` query | array (even for one id); **must not disclose the credential payload** |
| `POST /credential/revoke` | `credentialExchangeId` | `{success:true,message:"Credential revoked successfully."}` (no response object) |

`organization/create` enforces: label `^[a-z0-9][a-z0-9-]*$`; imported DID must equal the key's DID;
no duplicate DID vs an existing organization; org-scoped token cannot create. It returns the private
key + access token **only in this one 201 response**.

`/credential/sd-jwt/offer` validates claims against the template, returns a
**credential offer URI** (`openid-credential-offer://?credential_offer_uri=…`). The offer is not a
credential. Optional`preAuthorizedCodeflowConfig.useTransactionCode:true{transactionCode:{length(6–10)}}`
adds a numeric PIN required at token redemption.

`POST /credential-template/sd-jwt/create` is intentionally **404** (no template editing).

### 6.2 OpenID4VCI wallet-facing endpoints

Issuer URL = `<base>/oid4vci/<orgId>`. These are unauthenticated / wallet-authenticated.

| Method + path | Purpose |
|---|---|
| `GET /.well-known/openid-credential-issuer` | OpenID4VCI metadata (`credential_issuer`, `credential_endpoint`, `token_endpoint`, `nonce_endpoint`, `credential_configurations_supported` with `format:"dc+sd-jwt"`, `cryptographic_binding_methods_supported:["did:jwk"]`, `credential_signing_alg_values_supported:["ES256"]`, `proof_types_supported.jwt`) |
| `GET /.well-known/oauth-authorization-server` (= `/openid-configuration`) | authorization metadata (`response_types_supported:["token"]`, `grant_types_supported:["urn:ietf:params:oauth:grant-type:pre-authorized_code"]`) |
| `GET /jwks` | the org issuer key as an ES256 JWK (`use:"sig"`) |
| `GET /offers/:id` | the offer JSON (credential_issuer, `credential_configuration_ids`, `grants`) — single use |
| `GET /offers/:id/view` | QR + deep-link HTML page |
| `POST /token` | form-encoded, `grant_type=pre-authorized_code` + `pre-authorized_code` (+ `tx_code` if PIN) → `{access_token, token_type, expires_in, c_nonce, c_nonce_expires_in, authorization_details}` |
| `POST /nonce` | fresh `c_nonce` without redeeming |
| `POST /credential` | bearer access token + `{credential_configuration_id, proofs:{jwt:[…]}}` → `{credentials:[{credential}], notification_id}` |

Also an origin-root discovery shim (RFC 8615) under `/.well-known/<doc>/<mount>/oid4vci/:orgId`
(`wellKnownRouter`), because some wallets insert `.well-known` at the origin root.

### 6.3 Status-list endpoints (relying parties)

| Method + path | Format | Signed by |
|---|---|---|
| `GET /.well-known/jwks.json` | JWKS | dedicated status key (`statusPrivateKey`) |
| `GET /statuslist/:orgId/:listId` | IETF `statuslist+jwt` (zlib, LSB-first bits) | dedicated status key |
| `GET /status2021/:orgId/:listId` | W3C `StatusList2021Credential` (gzip, MSB-first, committee-compatible) | the **organization's** issuer key |

The bit for an exchange is derived from the **same** revocation flag for both formats. IETF lists
expire in ~60 s; the committee format in ~120 s (the committee caches decoded lists ~60 s). All
responses `Cache-Control: no-store`.

## 7. Pre-authorized redemption flow (wallet → credential)

1. Wallet resolves `credential_offer_uri` → offer doc → `credential_issuer` and `grants[...].pre-authorized_code`.
2. `POST /token` (code, optional PIN) → `access_token` + `c_nonce`.
3. Wallet builds an ES256 **proof JWT**: header `{typ:"openid4vci-proof+jwt", alg:"ES256",
   kid:"<holderDid>#0"}`, payload `{aud: <issuer URL>, nonce: <c_nonce>, iat: now}`.
4. `POST /credential` with bearer token + `proofs.jwt` → SD-JWT VC bound to the proof key.

Proof validation performed by the service (reject with `invalid_proof` on any failure):

- header `typ`/`alg` exactly as above; `kid` must be `<did:jwk…>#0`; **no `jwk` in the header**
  (never accept a holder private key).
- `holderDid` (from `kid`) must be a bare `did:jwk`, and must equal `values.holderDid` when the
  offer pinned one.
- verify the compact JWS against `jwkFromDid(holderDid)`.
- `aud === issuerUrl`, `iat` within `[now-300, now+60]`, `nonce` equals the exchange's one-time nonce
  (digest-compared) **or** a currently-live public `/nonce` nonce.

One-use guarantees: the code burns on `token`; the token + nonce burn on `credential`; a completed
exchange 401s; five wrong PINs lock the offer. Offer expires ≤ 30 min (bounded by `exp`); token ≤ 10 min.

## 8. State, persistence, secrets

Directory (`KK_LOCAL_ISSUER_DIR`, default `.demo/local-issuer/`), `0700`. Two files, `0600`:

- `connection.json` — `{apiKey: "openId-local-…", ecosystemId}` (the ecosystem key; **never** served).
- `state.json` — `State` `{version:1, ecosystemId, apiKeyHash, statusPrivateKey, organizations[], exchanges[], nonces[]}`.

Rules:

- **One writer per directory.** Every mutation is `structuredClone` → mutate → atomic write
  (temp file + `rename`). Corrupt/mismatched state **fails startup** rather than resetting
  revocations (apiKey hash is cross-checked against connection.json).
- Limits: 100 organizations, 10,000 exchanges, 1,024 live nonces.
- `nonces`/`exchanges` prune expired entries on write.

Secrets that must never appear in any public/listing response: private keys, access tokens, the
ecosystem key, wallet tokens, PINs, credential payloads (offer `view` and `find` must not disclose them).

## 9. Calling it from another server application

Reuse `server/lib/hovi.ts` (`HoviClient`) as the client verbatim — it already enforces
provider-key routing (local keys to local origin only, cloud to `https://api.hovi.id` only, refuses
redirects, bounds response to 2 MB, timeouts, categorizes errors). It is transport-agnostic `fetch`.

```ts
const {apiKey} = JSON.parse(readFileSync('issuer/connection.json', 'utf8'))
const client = new HoviClient(apiKey, fetch, {baseUrl: 'https://issuer.example/api/issuer'})
const [org] = await client.organizations()
const [template] = (await client.templates(org.organizationId)).filter(t => t.schemaType === 'MedicalLicenseCredential')
const offer = await client.offer(org.organizationId, template.credentialTemplateId, {
  role: 'physician', name, licenseNumber, specialty, jurisdiction,
  exp: Math.floor(Date.now() / 1000) + ttlSecs,
})
// hand offer.credentialOfferUri to the wallet; poll client.credential(...) for state; client.revoke(...) to revoke
```

Important: the calling application owns **authority and scope correctness** (which patient, which
paths, which holder). The issuer enforces only shape/rules; it is "an issuance authority, not
evidence of a patient's approval". In the health demo, `server/lib/oid4vci.ts` is exactly such an
adapter (`mintOffer`/`getOffer`/`revokeExchange`/`verifyLocalCredential`), and `orgs/board.ts` +
`orgs/patient.ts` are the domain logic on top — they decide *what* to issue.

## 10. Verifying a credential (relying-party side)

`server/lib/hovi-status.ts` → `verifyHoviCredential(credential, {issuerDid, organizationId, statusBaseUrl})`:

1. `verifyIssued` (issuer signature, `kid`↔`iss`, expiry).
2. Read `status.status_list` reference; require exact origin + `/statuslist/<orgId>/<listId>` path —
   never select the status service from credential claims; `statusBaseUrl` is caller-pinned.
3. Fetch the `statuslist+jwt` and `/.well-known/jwks.json` **without** sending the API key, bounded sizes, no redirects.
4. Verify the status token (typ/alg/kid, `iss`/`sub`, exp/iat, inflate ≤1 MB, LSB bit) — any nonzero bit → revoked.

Always fail **closed**: unavailable/oversized/foreign status services deny.

## 11. Extraction / port checklist

To build the standalone app from the reference:

1. Copy `server/issuer/service.ts` + `templates.ts`; bring `server/lib/{did,sdjwt,statuslist}.ts` as-is.
2. Drop demo-only imports (nothing in `service.ts` actually needs fleet/config beyond the identity +
   status primitives; `qrcode` stays for `offers/:id/view`).
3. Provide a `publicBaseUrl` resolver (env `KK_PUBLIC_BASE_URL` / `PORT`; must be https or loopback;
   must be **stable across restarts** because it is baked into credentials and status refs).
4. Keep the `HoviClient` in a shared location so callers and the issuer agree on the contract.
5. Mount exactly: `/.well-known` (shim) → `router()`; expose `/organization/create` only to the
   ecosystem key.
6. Port the tests: `scripts/local-issuer.test.ts` is the executable contract (org isolation, all
   three flows, proof/nonce/aud/type validation, single redemption, schema guards, tx codes, nonce
   endpoint, discovery, expiry, corrupt persistence fail-closed, imported issuer DID preservation,
   both revocation formats). `local-issuer-smoke.ts` is the live check.

### What changes in *this* health demo when the service moves out

- `server/issuer/runtime.ts` would point the `LocalIssuer` at the new service's base URL (or the
  demo keeps shipping the in-process copy and the standalone app becomes the default for integrators).
- `localIssuer.organizationForDid` / `applicationExchange` / `exchangeForCredential` are the
  in-process read shortcuts used by `lib/oid4vci.ts`; a move to a remote service means those become
  HTTP reads (they already have HTTP equivalents: `organization/`, `credential/find`).
- `prepareIssuer` (org auto-provisioning on demand) uses `POST /organization/create` with the
  imported DID — unchanged over HTTP.

## 12. Verification gates

```sh
node --import tsx --test scripts/local-issuer.test.ts   # contract (in-process fixture)
node --import tsx scripts/local-issuer-smoke.ts         # live, needs the service running
npm run build                                            # tsconfig typecheck for both TS projects
```

Secret-scan the source/build/evidence: no `openId-*` key, private scalar, wallet token, PIN, or
credential payload may appear in committed files or listing responses.

## 13. Key invariants (do not weaken)

- A **holder is a proved did:jwk**, never a claim from the caller. `cnf.kid`/`sub` come only from the
  guaranteed-unique proof.
- Codes, tokens, and nonces are **single-use**; completed/expired/revoked exchanges 401.
- Imported issuer DIDs **preserve** identity; duplicate DIDs are rejected.
- Template catalog and scope grammar are **server-defined and non-editable**.
- Revocation is **idempotent**; revoking a pending offer cancels it.
- `iss`, `iat`, `exp`, `vct`, `cnf`, `sub`, `jti`, `status`, `credentialStatus`, `_sd[_alg]` are
  **reserved** and can never be injected via `credentialValues`.
- Status lists are **fail-closed** for the relying party.
- Secrets never cross trust boundaries: keys stay in `state.json`/`connection.json` (0600), the
  client refuses to send a local key to a cloud origin and vice-versa.