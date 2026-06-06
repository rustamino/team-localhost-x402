# Future Work

## Persistent checkout state

Currently `CheckoutStore` in `backend/src/checkout.py` is in-memory.
Any backend restart (uvicorn `reload=True` fires on file changes, container restarts, crashes)
wipes all pending checkout intents → user's Pera payment arrives but the backend
has no record of the job → printer never gets paid, user sees a 404 polling loop
and the "Timed out" message.

**Minimum viable fix**: replace `CheckoutStore._store: dict` with a SQLite table
(Python stdlib `sqlite3`, no new deps). Persist on `add()`, `update()` mutations;
read from DB in `get()` and `pending()`. A `/tmp/x402_checkouts.db` path survives
server restarts within the same run; a proper data volume makes it survive container
recreation too.

**Also remove `reload=True`** from `uvicorn.run()` in `src/main.py` for production —
or at least switch to `reload_dirs=["src"]` and a dedicated data directory outside
the watched tree so that file changes don't wipe live orders.
