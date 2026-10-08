# After upgrading to v1.36.0 or later

v1.36.0 added a write-time guard for credential-named route targets and
credential redaction in the analytics recorders. Neither rewrites what was
stored before it, so a deployment that ran an earlier version has three
one-off jobs. Each is safe to skip on a deployment that started at v1.36.0 or
later. Nothing here runs automatically, and this template records no
deployment's progress: keep your own note of when each job was done.

Throughout, `bifrost.example.com` stands for your admin API host
(`ADMIN_API_DOMAIN`) and `bifrost-analytics` for your D1 database. Inject the
admin key from your secret manager; never type it into a shell history or a
file.

## 1. Review route targets stored before the guard

The guard examines a target only when a route is written, so a target stored
before v1.36.0 that carries a credential-named parameter (`token`, `code`,
`session` and the rest of the [credential policy](credential-redaction.md))
is still served, and copied into the click and proxy analytics, as it was.

Take a read-only inventory:

```bash
BIFROST_ADMIN_KEY=<injected> node scripts/scan-route-credentials.mjs \
  https://bifrost.example.com ./route-credential-report.json
```

The script lists every route through the admin API and writes a report (mode
`0600`) naming, for each flagged route, its domain, its path (redacted), its
type, whether it is enabled, and the parameter NAMES it found; it never writes
or prints a target value. For each finding, decide whether the parameter is a
real credential. If it is, rotate that credential with whoever issued it, then
edit the route to drop it (or disable the route). If it is not, leave the
route; the next edit asks for the usual acknowledgement.

## 2. Scrub analytics rows written before the redaction

The four per-feature tables (`link_clicks`, `page_views`, `file_downloads`,
`proxy_requests`) stored `query_string` and `referrer` as received before
v1.36.0, so a credential a visitor carried in a query string or a `Referer`
may be in them. Rows written since are redacted at write time.

1. Note the upgrade time as Unix seconds (the first deployment of v1.36.0 or
   later), and take a D1 Time Travel bookmark so the scrub can be undone for
   the next 30 days:

   ```bash
   wrangler d1 time-travel info bifrost-analytics
   ```

2. Clear the two columns on the older rows, one table at a time (here
   `1789603200` stands for your upgrade time):

   ```bash
   for table in link_clicks page_views file_downloads proxy_requests; do
     wrangler d1 execute bifrost-analytics --remote --command \
       "UPDATE $table SET query_string = NULL, referrer = NULL WHERE created_at < 1789603200"
   done
   ```

   This keeps every row and its counts but drops the campaign parameters and
   referrers of the older rows. To keep those where they are harmless, add a
   condition that matches only the parameter names you found in step 1 or in
   your own review (for example `AND (query_string LIKE '%token=%' OR referrer
   LIKE '%token=%')`); a narrower condition can miss a name you did not think
   of.

3. Check the result with a count of older rows that still hold either column,
   which should be zero (or only rows your narrower condition left on
   purpose).

## 3. Repair legacy route keys that hold `?` or `#`

Since v1.36.0 a route path cannot contain `?` or `#`, but a record stored
under such a key before then still exists and cannot be reached by any API
call: `PUT /api/routes` and `POST /api/routes/migrate` refuse the path,
`POST /api/routes/normalize-case` skips it, and **`DELETE /api/routes` is
dangerous for it**: the delete normalises the path, so `DELETE
?path=/promo?x` resolves to `/promo` and would delete a different, live
route. Repair such a record by its EXACT KV key, outside the API.

1. Find the keys (route keys are `{domain}:{path}`), per supported domain:

   ```bash
   wrangler kv key list --binding ROUTES --remote --prefix "links.example.com:/" \
     | grep -E '[?#]'
   ```

2. Read the record at the EXACT old key and keep a copy (it is also your
   rollback):

   ```bash
   wrangler kv key get --binding ROUTES --remote 'links.example.com:/promo?x' > old.json
   ```

3. Choose the canonical destination path (here `/promo-x`: no `?` or `#`,
   leading slash, as the API would store it) and make sure nothing lives
   there yet. **Stop if the destination key exists:** writing it would
   overwrite a live route.

   ```bash
   wrangler kv key get --binding ROUTES --remote 'links.example.com:/promo-x'
   ```

   Stop if it prints a stored value. A "not found" message means the
   destination is free.

4. Set the record's own `path` field to the destination. The record stores
   its path as well as its key; copying it unchanged would keep `/promo?x`
   in every listing, and a later delete of that listed path would resolve to
   `/promo`, an unrelated live route. Keep `createdAt` and every other field.

   ```bash
   jq '.path = "/promo-x"' old.json > new.json
   ```

5. Write the destination key, then read it back and check it is exactly
   `new.json`:

   ```bash
   wrangler kv key put --binding ROUTES --remote 'links.example.com:/promo-x' --path new.json
   wrangler kv key get --binding ROUTES --remote 'links.example.com:/promo-x' > check.json
   diff <(jq -S . new.json) <(jq -S . check.json) && echo verified
   ```

6. Only after it verified, delete the OLD key, exactly as stored:

   ```bash
   wrangler kv key delete --binding ROUTES --remote 'links.example.com:/promo?x'
   ```

   Then open the route in the dashboard at its new path and check it serves.

Never use the API or the dashboard for any of these steps: their ordinary
delete normalises the path (`/promo?x` resolves to `/promo`) and would remove
a different, live route, and their edit and move refuse the old path.
