# K-04 v2 intent vectors

`intent-v2.json` is copied byte-for-byte from keep-core
`pkg/frost/signing/testdata/intent-v2.json`, source K-04 `05032bb6b`.
The vector bytes were unchanged by that head's recovery fixes.
The normative byte format is keep-core `pkg/frost/signing/INTENT-V2.md`.
Go, an independent TypeScript encoder and the Solidity encoder check the same
two commitments. Numeric uint64 fields are decimal strings; do not convert
them to JavaScript Number.

These are public test fixtures. They do not establish funded requests, approved
production policy or snapshot-to-custody correspondence.
