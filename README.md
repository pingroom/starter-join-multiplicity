# Join multiplicity with PingRoom

Check how many rows an exact inner join will produce before using its result. A named data owner answers whether non-null join keys may repeat on each side. Code checks those declarations across two complete table exports, reports multiplicative matches and preserves every matched source row inside a nested joined record.

The paper-stock example has two stock rows and two label rows sharing code `A`, producing four joined pairs. The demo shows an allowed join, a repeat-policy violation and Unknown. It makes no database queries or changes.

## Run offline

Use Node.js 22 or newer and npm. Choose **Use this template**, clone your copy, then run:

```sh
npm ci
npm test
npm run demo
```

The starter pins `@pingroom/sdk` 0.8.0 and commits its npm lockfile. Tests and demo use the real SDK with local mock transports. After installation they need no network, account, credentials or phone. `.npmrc` requests a 14-day minimum release age where supported by npm.

## Define both exports and the join

```sh
cp examples/model.json model.json
cp config.example.json config.json
npm run validate
```

Edit `model.json` before asking for declarations:

- `joinId`: at most 32 characters; `title`: 32; `context`: 60.
- `completeExports`: must be `true`. Supply complete snapshots, not truncated samples. The program requires this flag but cannot detect whether rows were omitted upstream.
- `left` and `right`: each contains a distinct table `id`, a `label` up to 32 characters, `columns` and `rows`.
- `columns`: 1–6 records containing unique `id` values and labels up to 24 characters.
- `rows`: 1–16 records containing `id` and `values`. Row IDs are unique within each side; the same row ID may appear on the other side.
- `values`: exactly one scalar for every declared column, with no extra fields. Scalars are `null`, booleans, safe integers excluding negative zero, or well-formed strings of at most 40 UTF-16 code units. Objects, arrays, decimals and nonfinite numbers are rejected.
- `keys`: 1–3 fixed pairs of `leftColumn` and `rightColumn`. Each column must exist and may occur only once on its side of the key specification.

Table, column and row IDs allow 12 characters: a lowercase initial letter, followed by lowercase letters, digits, `_` or `-`. Reserved object names are rejected. `joinId` uses the same character grammar with its longer limit.

Payload strings retain whitespace, line breaks, case and Unicode exactly. Metadata labels and context must be nonempty, trimmed and free of control/format characters and line breaks. Limits use UTF-16 code units. Extra schema fields and sparse records are rejected. Rows, columns and key pairs canonicalize by ID; output ordering is independent of input array order.

You supply the key pairs. The starter does not infer mappings, resolve identities or choose join columns.

## Connect and declare repeat policies

Install [PingRoom](https://pingroom.io/i), create a private standard room containing the data owner, then run:

```sh
npm run connect
npm run inspect
```

Approve the printed pairing link and grant the room. Verify the person in the app, then put their exact member UUID and descriptive label in `config.json`; a name alone is insufficient. For an existing granted connection, copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and the 12-character `PINGROOM_ROOM`. Partial pairs are rejected.

```sh
npm start
```

Each invocation creates at most one direct, 15-minute Question or reads the existing one, with room/member preflight before creation. After the owner answers, run it to record the response, then again for the other side.

Each Question asks whether non-null key tuples may repeat in that complete export:

- **Yes:** repeated non-null tuples are allowed.
- **No:** every non-null tuple must be unique across that entire side.
- **Unknown:** the intended policy is not established.

Questions contain join/table/key metadata and hashes. No row IDs or cell values are sent to PingRoom. Keep sensitive content out of metadata too. Local reports and exports contain the source data and must remain private.

Both declarations are required. Unknown, missing, expired, cancelled, malformed or misattributed answers withhold all analysis. Evidence is bound to the request, owner, room, asking registration, timestamps and policy.

## Inspect and export

```sh
npm run status
npm run report
npm run export-analysis
npm run export-joined
```

These commands are local. `report` writes `.join/report.json`. `export-analysis` writes `.join/analysis.json` once both declarations are known, including policy violations. `export-joined` also requires no violations and writes `.join/joined.json`. The nested joined records are under `analysis.joinedRows`.

The join uses exact typed scalar equality without coercion: integer `1`, string `"1"` and boolean `true` are distinct. String whitespace and Unicode are never normalized. If any key component is null, that row never matches, even another null-containing key. Such rows are also exempt from repeat-policy checks. This is an explicit SQL-like null rule, not a claim of compatibility with every database's typing, collation or uniqueness behavior.

`duplicates` lists repeated non-null tuples across each whole input, including keys unmatched on the other side. A No declaration with any such duplicate produces `policy_violation`. Counts and witnesses remain available, but `joinedRows` is null and joined export is refused.

`matchedGroups` records each matching tuple's left/right row IDs and counts. A group contributes `leftCount × rightCount` pairs. `multiplicity` records how many joined copies each source row produces; `unmatched` and `nullKeyRowIds` identify rows producing none. Conservation checks compare pair totals and row coverage before returning analysis.

Successful records contain separate `left` and `right` objects, each preserving its table ID, row ID and full values. They sort by ASCII left row ID, then right row ID. At most 256 pairs are possible. A valid join with zero matches exports an empty array.

To adapt it, prepare complete bounded exports, choose explicit key pairs and ask the owner about the intended multiplicity. A passing snapshot does not prove a permanent key constraint, export completeness or data quality outside these declarations. No fuzzy matching, outer joins, database writes or schema inference are performed.

## Resume safely

Root inputs, credentials, state and exports are ignored by Git. Keep `.join/` and `.pingroom/` private and intact. A session cannot be reused after changes to values, meanings, key pairs, identity or credentials. Input/config limits are 64/16 KiB; writes are atomic under a local lock.

A lost creation response leaves `create_unknown` and is never automatically resent:

```sh
npm run status
npm run find-id
npm run recover -- EXACT-QUESTION-UUID
```

Recover only the original Question. No match in the bounded search does not prove creation failed. Resolve or revoke uncertain/expired pairing in Connected Agents before archiving its pending file. Remove a stale `.lock` only after confirming its process stopped. Resolve the original session before archiving it for revised inputs; never delete state to retry.

Run commands serially. Exit codes: `0` complete/local result, including violations; `1` invalid setup/evidence or refused export; `2` incomplete/failed answer; `3` pending/ready/interrupted; `4` uncertain creation.

Tests compare an independent nested-loop join and cover maximum output, SDK/CLI recovery, pairing and private exports. GitHub Actions checks Node.js 22 and 24. Live phone delivery is not tested. MIT licensed.
